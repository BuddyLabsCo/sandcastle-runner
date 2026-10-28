import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import {
  validConfig,
  createProject,
  publicationIntent,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import {
  readRecoverySnapshot,
  recoveryPaths,
  writeRecoverySnapshot,
} from "../../src/recovery.ts";

test.afterEach(cleanupTempRoots);

test("disabled Documentation Maintenance allows delivery and Parent closeout without maintenance effects", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  delete config.agents.documentation;
  await writeProjectConfig(path.join(root, "demo/config.yaml"), {
    ...config,
    workflow: {
      review: false,
      docMaintainTriggerLabel: "",
    },
  });
  await rm(path.join(root, "demo/prompts/documentation.md"));
  const maintenancePublication = {
    ...publicationIntent("pr_created", 100),
    kind: "maintenance" as const,
  };
  await writeRecoverySnapshot(
    recoveryPaths(path.join(root, "demo"), 8).snapshot,
    {
      schemaVersion: 2,
      project: "demo",
      repository: "owner/repo",
      checkout: "/tmp/repo",
      parentTicket: 8,
      runId: "interrupted",
      phase: "blocked",
      targetBranch: "main",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
      batch: [9],
      completedDeliveries: [{ ticket: 9, labels: ["documentation"] }],
      maintenance: {
        phase: "blocked",
        ticket: 100,
        deliveryTickets: [9],
        barrier: true,
      },
      publications: [maintenancePublication],
    },
  );
  const delivery = createCommittedDelivery(9);
  const attempts: number[] = [];
  let parentCloses = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async listLabelsPage() {
          throw new Error("maintenance labels must not be read");
        },
        async createLabel() {
          throw new Error("maintenance labels must not be created");
        },
        async createMaintenanceTicket() {
          throw new Error("Maintenance Tickets must not be created");
        },
        async closeParent() {
          parentCloses += 1;
        },
      },
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: {
        async execute(input) {
          attempts.push(input.ticket);
          return delivery.agentExecutor.execute!(input);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.deepEqual(attempts, [9]);
  assert.equal(parentCloses, 1);
  assert.equal(
    (
      await readRecoverySnapshot(
        recoveryPaths(path.join(root, "demo"), 8).snapshot,
      )
    )?.maintenance,
    undefined,
  );
  assert.match(
    result.summary.reasons.join(" "),
    /preserved Maintenance Ticket 100, https:\/\/example\.test\/pull\/4, branch ticket-100-old, worktree \/tmp\/old-ticket-100/u,
  );
  assert.ok(result.logPath);
});

test("Review and Documentation Maintenance trigger operate independently", async () => {
  const scenarios = [
    {
      workflow: { review: true, docMaintainTriggerLabel: "" },
      reviews: 1,
      maintenance: 0,
    },
    {
      workflow: { review: false, docMaintainTriggerLabel: "documentation" },
      reviews: 0,
      maintenance: 1,
    },
    { workflow: undefined, reviews: 1, maintenance: 0 },
  ] as const;

  for (const scenario of scenarios) {
    const root = await createProject();
    const config: Omit<typeof validConfig, "workflow"> & {
      workflow?: typeof validConfig.workflow;
    } = structuredClone(validConfig);
    if (scenario.workflow === undefined) delete config.workflow;
    else config.workflow = scenario.workflow;
    await writeProjectConfig(path.join(root, "demo/config.yaml"), config);
    const delivery = createCommittedDelivery();
    if (scenario.workflow?.docMaintainTriggerLabel)
      delivery.tickets[0]!.labels.push("documentation");
    let reviews = 0;
    let maintenance = 0;

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          ...delivery.tracker,
          async listLabelsPage() {
            maintenance += 1;
            return { labels: ["doc-maintain"], nextPage: null };
          },
        },
        gitWorkspace: delivery.gitWorkspace,
        agentExecutor: {
          async execute(input) {
            return delivery.agentExecutor.execute!(input);
          },
          async executeReview() {
            reviews += 1;
            return {
              outcome: "passed",
            };
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(reviews, scenario.reviews);
    assert.equal(maintenance, scenario.maintenance);
  }
});

test("enabled Documentation Maintenance requires maintenance ticket title, body, and label", async () => {
  for (const field of ["title", "body", "label"] as const) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    config.workflow.docMaintainTriggerLabel = "documentation";
    delete config.maintenanceTicket[field];
    await writeProjectConfig(path.join(root, "demo/config.yaml"), config);
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root),
    );
    assert.equal(result.summary.outcome, "failed");
    assert.match(
      result.summary.reasons.join(" "),
      new RegExp(`maintenanceTicket\\.${field} must be set`),
    );
  }
});

test("workflow configuration rejects malformed switches, unknown fields", async () => {
  const cases = [
    {
      workflow: { review: "false", docMaintainTriggerLabel: "" },
      expected: /workflow\.review must be a boolean/u,
    },
    {
      workflow: { docMaintainTriggerLabel: false },
      expected: /workflow\.docMaintainTriggerLabel must be a string/u,
    },
    {
      workflow: { documentationMaintenance: false },
      expected: /workflow contains unknown field documentationMaintenance/u,
    },
    {
      workflow: { $comment: "legacy pseudo-comment", review: false },
      expected: /workflow contains unknown field \$comment/u,
    },
  ];

  for (const scenario of cases) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    await writeProjectConfig(path.join(root, "demo/config.yaml"), {
      ...config,
      workflow: scenario.workflow,
    });
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root),
    );

    assert.equal(result.summary.outcome, "failed");
    assert.match(result.summary.reasons[0] ?? "", scenario.expected);
    assert.equal(result.logPath, null);
  }
});

test("omitted Documentation Maintenance trigger disables automatic maintenance", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  delete config.agents.documentation;
  await writeProjectConfig(path.join(root, "demo/config.yaml"), {
    ...config,
    workflow: { review: false },
  });
  await rm(path.join(root, "demo/prompts/documentation.md"));

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "no_work");
});

test("enabled Documentation Maintenance rejects a missing profile", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.docMaintainTriggerLabel = "documentation";
  delete config.agents.documentation;
  await writeProjectConfig(path.join(root, "demo/config.yaml"), config);

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons[0] ?? "",
    /Documentation Maintenance is enabled.*agents\.documentation.*prompts\/documentation\.md/u,
  );
  assert.equal(result.logPath, null);
});

test("enabled Documentation Maintenance rejects an empty prompt", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.docMaintainTriggerLabel = "documentation";
  await writeProjectConfig(path.join(root, "demo/config.yaml"), config);
  await writeFile(path.join(root, "demo/prompts/documentation.md"), " \n");

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons[0] ?? "",
    /Documentation Maintenance is enabled.*agents\.documentation.*prompts\/documentation\.md/u,
  );
  assert.equal(result.logPath, null);
});

test("audit gap text and skip stay paused until Enter retries log creation", async () => {
  const root = await createProject();
  const logs = path.join(root, "demo", "logs");
  await writeFile(logs, "blocks directory creation");
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      operator: {
        async pause() {
          pauseCalls += 1;
          if (pauseCalls === 1) {
            await rm(logs);
            await mkdir(logs);
            return "accept this audit gap";
          }
          return pauseCalls === 2 ? "s" : "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(pauseCalls, 3);
  assert.ok(result.logPath);
  assert.match(await readFile(result.logPath, "utf8"), /read_parent/u);
});

test("invalid CLI arguments return a structured startup failure", async () => {
  let externalCalls = 0;
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo"],
    createCliDependencies("/unused", {
      env: {},
      tracker: {
        async getParent() {
          externalCalls += 1;
          throw new Error("must not run");
        },
        async listChildrenPage() {
          externalCalls += 1;
          throw new Error("must not run");
        },
        async closeParent() {
          externalCalls += 1;
        },
      },
      codeHost: {
        async resolveTargetBranch() {
          externalCalls += 1;
          return "main";
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          externalCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(result.exitCode, 1);
  assert.match(result.summary.reasons[0] ?? "", /usage:/u);
  assert.equal(result.logPath, null);
  assert.equal(externalCalls, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^Startup failed: usage:/u);
  assert.doesNotMatch(messages[0]!, /^\{/u);
});

test("an omitted Target Branch is resolved once through CodeHost and fixed for the Run", async () => {
  const root = await createProject();
  const configPath = path.join(root, "demo", "config.yaml");
  const configWithoutBranch = { ...validConfig };
  delete (configWithoutBranch as Partial<typeof validConfig>).targetBranch;
  await writeProjectConfig(configPath, configWithoutBranch);
  let branchCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      codeHost: {
        async resolveTargetBranch() {
          branchCalls += 1;
          return "trunk";
        },
      },
    }),
  );

  assert.equal(result.summary.targetBranch, "trunk");
  assert.equal(branchCalls, 1);
});

test("global Target Branch recovery rejects results and skip before retrying the read", async () => {
  const root = await createProject();
  const configPath = path.join(root, "demo", "config.yaml");
  const configWithoutBranch = { ...validConfig };
  delete (configWithoutBranch as Partial<typeof validConfig>).targetBranch;
  await writeProjectConfig(configPath, configWithoutBranch);
  let branchCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      codeHost: {
        async resolveTargetBranch() {
          branchCalls += 1;
          if (branchCalls <= 5) throw new Error("unavailable");
          return "trunk";
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return ['{"targetBranch":"trunk"}', "s", ""][pauseCalls - 1] ?? "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.summary.targetBranch, "trunk");
  assert.equal(branchCalls, 6);
  assert.equal(pauseCalls, 3);
});

test("open children return an actionable incomplete summary", async () => {
  const root = await createProject();
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "open",
                stateReason: null,
                repository: "owner/repo",
                labels: ["sandcastle:reserved"],
              } as const,
            ],
            nextPage: null,
          };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.summary.reasons, [
    "existing Reservations: 9 (partial)",
  ]);
});

test("a Run reserves the three lowest-numbered eligible Delivery Tickets", async () => {
  const root = await createProject();
  const writes: string[] = [];
  const tickets = [12, 9, 11, 10].map((number) => ({
    number,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: ["ready-for-agent"],
  }));

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return { children: tickets, nextPage: null };
        },
        async getTicket(_repository, ticket) {
          return tickets.find(({ number }) => number === ticket)!;
        },
        async addLabel(_repository, ticket, label) {
          writes.push(`label:${ticket}:${label}`);
        },
        async addAssignee(_repository, ticket, assignee) {
          writes.push(`assignee:${ticket}:${assignee}`);
        },
      },
    }),
  );

  assert.deepEqual(result.summary.batch, [9, 10, 11]);
  assert.deepEqual(writes, [
    "label:9:sandcastle:reserved",
    "assignee:9:runner",
    "label:10:sandcastle:reserved",
    "assignee:10:runner",
    "label:11:sandcastle:reserved",
    "assignee:11:runner",
  ]);
  assert.equal(result.summary.outcome, "incomplete");
});
