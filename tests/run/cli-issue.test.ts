import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import type { Tracker } from "../../src/run/contracts.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";

test.afterEach(cleanupTempRoots);

test("parent and issue selectors are mutually exclusive and required", async () => {
  const root = await createProject();
  for (const args of [
    ["run", "--project", "demo"],
    ["run", "--project", "demo", "--parent", "8", "--issue", "9"],
  ]) {
    const result = await executeCli(args, createCliDependencies(root));
    assert.equal(result.exitCode, 1);
    assert.match(result.summary.reasons[0] ?? "", /usage:/u);
  }
});

test("standalone issue runs without Documentation Maintenance configuration", async () => {
  const root = await createProject();
  const configPath = `${root}/projects/demo/config.json`;
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    workflow: { documentationMaintenance: boolean };
    agents: Record<string, unknown>;
  };
  config.workflow.documentationMaintenance = true;
  delete config.agents.documentation;
  await writeFile(configPath, JSON.stringify(config));
  await rm(`${root}/projects/demo/prompts/documentation.md`);
  let parentReads = 0;
  let childReads = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--issue", "9"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentReads += 1;
          throw new Error("standalone mode must not read a parent");
        },
        async listChildrenPage() {
          childReads += 1;
          throw new Error("standalone mode must not list children");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.summary.issueTicket, 9);
  assert.equal(parentReads, 0);
  assert.equal(childReads, 0);
});

test("standalone issue applies ready-for-agent gating and terminal no_work", async () => {
  const root = await createProject();
  const writes: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--issue", "9"],
    createCliDependencies(root, {
      tracker: {
        async getTicket() {
          return {
            number: 9,
            state: "open",
            stateReason: null,
            assignees: [],
            labels: [],
          };
        },
        async addLabel() {
          writes.push("label");
        },
        async addAssignee() {
          writes.push("assignee");
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(writes, []);

  const terminal = await executeCli(
    ["run", "--project", "demo", "--issue", "10"],
    createCliDependencies(root, {
      tracker: {
        async getTicket() {
          return { number: 10, state: "closed", stateReason: "completed" };
        },
      },
    }),
  );
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.summary.outcome, "no_work");
});

test("standalone issue uses the selected issue as the Review specification", async () => {
  const root = await createProject();
  const configPath = `${root}/projects/demo/config.json`;
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    workflow: { review: boolean; documentationMaintenance: boolean };
  };
  config.workflow.documentationMaintenance = false;
  config.workflow.review = true;
  await writeFile(configPath, JSON.stringify(config));
  const delivery = createCommittedDelivery(9);
  let governing = "";
  const result = await executeCli(
    ["run", "--project", "demo", "--issue", "9"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: {
        ...delivery.agentExecutor,
        async executeReview(input) {
          const handoff = JSON.parse(
            String(input.promptArgs.REVIEW_HANDOFF),
          ) as {
            governingSpecification?: { source?: unknown };
          };
          governing =
            typeof handoff.governingSpecification?.source === "string"
              ? handoff.governingSpecification.source
              : "";
          return {
            outcome: "passed",
            summary: "review passed",
            standards: { verdict: "passed", unresolved_findings: [] },
            spec: { verdict: "passed", unresolved_findings: [] },
            checks: [],
            blocker: null,
          };
        },
      },
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.batch, [9]);
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(governing, "https://github.com/owner/repo/issues/9");
});

test("run accepts options in any order", async () => {
  const root = await createProject();
  const result = await executeCli(
    ["run", "--issue", "10", "--project", "demo"],
    createCliDependencies(root, {
      tracker: {
        async getTicket() {
          return { number: 10, state: "closed", stateReason: "completed" };
        },
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "no_work");
});

test("no-auto-merge publishes, repairs CI, and preserves recovery state without merging", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const worktrees: string[] = [];
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const repair = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: required checks",
  };
  let branch = "";
  let agentCalls = 0;
  let checkReads = 0;
  let pushCalls = 0;
  let createdPullRequests = 0;
  let mergeRequests = 0;
  const gitWorkspace = {
    ...delivery.gitWorkspace,
    async createWorktree(
      input: Parameters<
        NonNullable<typeof delivery.gitWorkspace.createWorktree>
      >[0],
    ) {
      branch = input.branch;
      worktrees.push(input.worktree);
      await delivery.gitWorkspace.createWorktree?.(input);
    },
    async inspect({
      worktree,
      base,
    }: Parameters<NonNullable<typeof delivery.gitWorkspace.inspect>>[0]) {
      return {
        worktree,
        branch,
        base,
        commits: agentCalls === 2 ? [repair] : [implementation],
        clean: true,
      };
    },
    async push() {
      pushCalls += 1;
    },
  };
  const result = await executeCli(
    ["run", "--issue", "9", "--project", "demo", "--no-auto-merge"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace,
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          const commit = agentCalls === 2 ? repair : implementation;
          return {
            outcome: "committed",
            summary: commit.message,
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          createdPullRequests += 1;
          return { number: 1, url: "https://github.com/owner/repo/pull/1" };
        },
        async getRequiredChecks() {
          checkReads += 1;
          return checkReads === 1
            ? [
                {
                  name: "checks",
                  state: "FAILURE",
                  link: "https://github.com/owner/repo/actions/runs/1",
                  bucket: "fail" as const,
                },
              ]
            : [];
        },
        async getPullRequest() {
          return {
            headSha: pushCalls === 2 ? repair.sha : implementation.sha,
            createdAt: "2026-09-09T00:00:00Z",
            merged: false,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "rejected", error: "merge must not be requested" };
        },
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets ?? [], []);
  assert.equal(agentCalls, 2);
  assert.equal(pushCalls, 2);
  assert.equal(createdPullRequests, 1);
  assert.equal(mergeRequests, 0);
  assert.equal(worktrees.length, 1);
  const snapshot = JSON.parse(
    await readFile(`${root}/projects/demo/state/issue-9.json`, "utf8"),
  ) as {
    phase: string;
    publications?: { ticket: number; phase: string }[];
    terminalCleanup?: unknown;
  };
  assert.equal(snapshot.phase, "running");
  assert.deepEqual(
    snapshot.publications?.map(({ ticket, phase }) => ({ ticket, phase })),
    [{ ticket: 9, phase: "pending_pr" }],
  );
  assert.equal(snapshot.terminalCleanup, undefined);
});

test("auto-merge flag forms are parsed and restricted", async () => {
  const root = await createProject();
  const tracker: Partial<Tracker> = {
    async getTicket() {
      return { number: 10, state: "closed", stateReason: "completed" };
    },
  };
  for (const args of [
    ["run", "--project", "demo", "--issue", "10", "--auto-merge"],
    ["run", "--project", "demo", "--issue", "10", "--no-auto-merge"],
    ["run", "--issue", "10", "--project", "demo"],
  ]) {
    const accepted = await executeCli(
      args,
      createCliDependencies(root, { tracker }),
    );
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.summary.outcome, "no_work");
  }

  for (const args of [
    ["run", "--project", "demo", "--issue", "10", "--auto-merge", "true"],
    ["run", "--project", "demo", "--issue", "10", "--auto-merge", "false"],
    [
      "run",
      "--project",
      "demo",
      "--issue",
      "10",
      "--auto-merge",
      "--no-auto-merge",
    ],
    ["run", "--project", "demo", "--parent", "10", "--no-auto-merge"],
    ["run", "--project", "demo", "--issue", "--no-auto-merge"],
    ["run", "--project", "demo", "--issue", "0"],
    ["run", "--project", "demo", "--issue", "1.2"],
    ["run", "--issue", "10"],
    ["run", "--project", "demo", "--issue", "10", "--project"],
    ["run", "--unknown", "demo", "--issue", "10"],
  ]) {
    const rejected = await executeCli(args, createCliDependencies(root));
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.summary.outcome, "failed");
  }
});
