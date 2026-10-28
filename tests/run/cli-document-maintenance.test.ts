import assert from "node:assert/strict";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import type { AgentConfig } from "../../src/config.ts";
import { recoveryPaths, writeRecoverySnapshot } from "../../src/recovery.ts";
import type { AgentExecutor, Ticket } from "../../src/run/contracts.ts";
import {
  createCliDependencies,
  createCommittedBatch,
  createCommittedDelivery,
  isMaintenanceWorktree,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  readProjectConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

async function createMaintenanceProject(): Promise<string> {
  const root = await createProject();
  const configPath = path.join(root, "demo/config.yaml");
  const config = await readProjectConfig<{
    workflow: { docMaintainTriggerLabel: string };
  }>(configPath);
  config.workflow.docMaintainTriggerLabel = "documentation";
  await writeProjectConfig(configPath, config);
  return root;
}

function createMatchingDelivery(ticket = 9) {
  const delivery = createCommittedDelivery(ticket);
  delivery.tickets[0]!.labels.push("documentation");
  return delivery;
}

const noChangeResult = {
  outcome: "no_change" as const,
  summary: "documentation is current",
  blocker: null,
};

test("nonmatching deliveries and Parent closeout do not trigger maintenance", async () => {
  const root = await createMaintenanceProject();
  const delivery = createCommittedBatch(9, 10, 11);
  delivery.tickets[0]!.labels.push("Documentation");
  let maintenanceCreates = 0;
  let parentCloses = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async getParent() {
          return {
            number: 8,
            state: "open",
            stateReason: null,
            labels: ["documentation"],
          };
        },
        async createMaintenanceTicket() {
          maintenanceCreates += 1;
          throw new Error(
            "nonmatching deliveries must not trigger maintenance",
          );
        },
        async closeParent() {
          parentCloses += 1;
        },
      },
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: delivery.agentExecutor,
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(maintenanceCreates, 0);
  assert.equal(parentCloses, 1);
});

test("--document starts fresh after an interrupted Parent-independent occurrence", async () => {
  const root = await createProject();
  const configPath = path.join(root, "demo/config.yaml");
  const config = await readProjectConfig<{
    issueList: number[];
    agents: Record<string, AgentConfig>;
  }>(configPath);
  config.agents.documentation = {
    agent: "pi",
    model: "claude-sonnet-4-6",
    options: { thinking: "high" },
  };
  config.issueList = [41];
  await writeProjectConfig(configPath, config);
  const tickets = new Map<number, Ticket>();
  let creates = 0;
  let parentReads = 0;
  let pullRequestCreates = 0;
  let agentCalls = 0;
  let documentationInput: Parameters<AgentExecutor["execute"]>[0] | undefined;
  let branch = "";
  const dependencies = createCliDependencies(root, {
    tracker: {
      async getParent() {
        parentReads += 1;
        throw new Error("explicit maintenance must not read a Parent Ticket");
      },
      async getTicket(_repository, ticket) {
        return tickets.get(ticket)!;
      },
      async createMaintenanceTicket() {
        const ticket: Ticket = {
          number: 100 + creates++,
          state: "open",
          stateReason: null,
          assignees: [],
          labels: ["doc-maintain"],
        };
        tickets.set(ticket.number, ticket);
        return ticket;
      },
      async closeTicket(_repository, ticket) {
        const found = tickets.get(ticket)!;
        found.state = "closed";
        found.stateReason = "completed";
      },
    },
    gitWorkspace: {
      async fetchTargetBranch() {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      async createWorktree(input) {
        branch = input.branch;
      },
      async inspect({ worktree, base }) {
        return { worktree, branch, base, commits: [], clean: true };
      },
    },
    agentExecutor: {
      async execute(input) {
        agentCalls += 1;
        documentationInput = input;
        assert.equal(input.idleTimeoutMs, 600_000);
        assert.equal(input.timeoutMs, 7_200_000);
        assert.equal(typeof input.pauseForTimeout, "function");
        return agentCalls === 1
          ? {
              outcome: "blocked",
              summary: "documentation is blocked",
              commits: [],
              checks: [],
              blocker: "missing Documentation Base",
            }
          : { ...noChangeResult, commits: [], checks: [] };
      },
    },
    operator: {
      async pause() {
        return "q";
      },
    },
    codeHost: {
      async createPullRequest() {
        pullRequestCreates += 1;
        return { number: 1, url: "https://example.test/pull/1" };
      },
    },
  });

  const first = await executeCli(
    ["run", "--project", "demo", "--document"],
    dependencies,
  );
  const second = await executeCli(
    ["run", "--project", "demo", "--document"],
    dependencies,
  );

  assert.equal(first.summary.outcome, "cancelled");
  assert.equal(second.summary.outcome, "succeeded");
  assert.equal(creates, 2);
  assert.equal(parentReads, 0);
  assert.equal(pullRequestCreates, 0);
  assert.equal(documentationInput?.agent, "pi");
  assert.equal(documentationInput?.model, "claude-sonnet-4-6");
  assert.deepEqual(documentationInput?.options, { thinking: "high" });
});

test("standalone matching delivery triggers automatic maintenance once", async () => {
  const root = await createMaintenanceProject();
  const delivery = createMatchingDelivery(9);
  const maintenance: Ticket = {
    number: 100,
    state: "open",
    stateReason: null,
    assignees: [],
    labels: ["doc-maintain"],
  };
  let creates = 0;
  let parentReads = 0;
  let maintenanceBranch = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--issue", "9", "--auto-merge"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async getParent() {
          parentReads += 1;
          throw new Error(
            "standalone maintenance must not read a Parent Ticket",
          );
        },
        async getTicket(repository, ticket) {
          return ticket === maintenance.number
            ? maintenance
            : delivery.tracker.getTicket!(repository, ticket);
        },
        async createMaintenanceTicket() {
          creates += 1;
          return maintenance;
        },
        async closeTicket(repository, ticket) {
          if (ticket === maintenance.number) {
            maintenance.state = "closed";
            maintenance.stateReason = "completed";
            return;
          }
          await delivery.tracker.closeTicket!(repository, ticket);
        },
      },
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async createWorktree(input) {
          if (isMaintenanceWorktree(input.worktree)) {
            maintenanceBranch = input.branch;
            return;
          }
          await delivery.gitWorkspace.createWorktree!(input);
        },
        async inspect(input) {
          if (isMaintenanceWorktree(input.worktree)) {
            return {
              worktree: input.worktree,
              branch: maintenanceBranch,
              base: input.base,
              commits: [],
              clean: true,
            };
          }
          return delivery.gitWorkspace.inspect!(input);
        },
      },
      agentExecutor: {
        async execute(input) {
          return input.ticket === maintenance.number
            ? { ...noChangeResult, commits: [], checks: [] }
            : delivery.agentExecutor.execute!(input);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(creates, 1);
  assert.equal(parentReads, 0);
});

test("matching unfinished automatic maintenance resumes without duplication", async () => {
  const root = await createMaintenanceProject();
  await writeRecoverySnapshot(
    recoveryPaths(path.join(root, "demo"), 8).snapshot,
    {
      schemaVersion: 2,
      project: "demo",
      repository: "owner/repo",
      checkout: "/tmp/repo",
      parentTicket: 8,
      runId: "interrupted",
      phase: "running",
      targetBranch: "main",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
      batch: [9],
      completedDeliveries: [{ ticket: 9, labels: ["documentation"] }],
      maintenance: {
        phase: "ticket_created",
        ticket: 100,
        deliveryTickets: [9],
        barrier: true,
      },
    },
  );
  const maintenance: Ticket = {
    number: 100,
    state: "open",
    stateReason: null,
    assignees: [],
    labels: ["doc-maintain"],
  };
  let creates = 0;
  let parentCloses = 0;
  let branch = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          return { number: 8, state: "open", stateReason: null };
        },
        async listChildrenPage() {
          return { children: [], nextPage: null };
        },
        async getTicket() {
          return maintenance;
        },
        async createMaintenanceTicket() {
          creates += 1;
          return maintenance;
        },
        async closeTicket() {
          maintenance.state = "closed";
          maintenance.stateReason = "completed";
        },
        async closeParent() {
          parentCloses += 1;
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return { worktree, branch, base, commits: [], clean: true };
        },
      },
      agentExecutor: {
        async execute() {
          return { ...noChangeResult, commits: [], checks: [] };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.ok(
    result.summary.reasons.includes("No pickable Delivery Tickets remain"),
  );
  assert.equal(
    result.summary.tickets?.find(({ ticket }) => ticket === 100)?.status,
    "no_change",
  );
  assert.equal(creates, 0);
  assert.equal(parentCloses, 0);
});

for (const { flags, changes } of [
  { flags: [], changes: true },
  { flags: ["--auto-merge"], changes: true },
  { flags: ["--no-auto-merge"], changes: true },
  { flags: ["--no-auto-merge"], changes: false },
]) {
  test(`--document ${flags.join(" ") || "default"} handles ${changes ? "a PR" : "no changes"} and Worktree cleanup`, async () => {
    const root = await createProject();
    const delivery = createCommittedDelivery(100);
    const ticket = delivery.tickets[0]!;
    ticket.labels = ["doc-maintain"];
    const autoMerge = !flags.includes("--no-auto-merge");
    let workspace: { worktree: string; branch: string; repository: string };
    let merges = 0;
    let pullRequests = 0;
    let checkReads = 0;
    const deletedBranches: string[] = [];
    const messages: string[] = [];
    const result = await executeCli(
      ["run", "--project", "demo", "--document", ...flags],
      createCliDependencies(root, {
        tracker: {
          ...delivery.tracker,
          async createMaintenanceTicket() {
            return ticket;
          },
        },
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async createWorktree(input) {
            workspace = {
              worktree: input.worktree,
              branch: input.branch,
              repository: input.checkout,
            };
            await mkdir(input.worktree, { recursive: true });
            await delivery.gitWorkspace.createWorktree!(input);
          },
          async inspect(input) {
            const inspected = await delivery.gitWorkspace.inspect!(input);
            return { ...inspected, commits: changes ? inspected.commits : [] };
          },
          async listWorktrees() {
            return [workspace!];
          },
          async removeWorktree(_checkout, worktree) {
            await rm(worktree, { recursive: true });
          },
          async deleteBranch(_checkout, branch) {
            deletedBranches.push(branch);
          },
        },
        agentExecutor: {
          async execute(input) {
            return changes
              ? delivery.agentExecutor.execute!(input)
              : { ...noChangeResult, commits: [], checks: [] };
          },
        },
        codeHost: {
          async createPullRequest() {
            pullRequests += 1;
            return { number: 1, url: "https://github.com/owner/repo/pull/1" };
          },
          async getRequiredChecks() {
            checkReads += 1;
            return [];
          },
          async getPullRequest() {
            return {
              headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              createdAt: "2026-09-08T00:00:00Z",
              merged: merges > 0,
              mergeFailure: null,
            };
          },
          async requestSquashMerge() {
            merges += 1;
            return { outcome: "accepted" };
          },
        },
        operator: {
          write(message) {
            messages.push(message);
          },
        },
      }),
    );
    assert.equal(result.exitCode, 0, result.summary.reasons.join("; "));
    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(pullRequests, changes ? 1 : 0);
    assert.equal(merges, changes && autoMerge ? 1 : 0);
    assert.equal(ticket.state, changes && !autoMerge ? "open" : "closed");
    const retained = changes && !autoMerge;
    assert.equal(
      result.summary.tickets?.[0]?.status,
      changes ? (autoMerge ? "completed" : "PR ready") : "no_change",
    );
    assert.deepEqual(
      result.summary.tickets?.[0]?.retainedWorktrees,
      retained ? [workspace!.worktree] : [],
    );
    assert.deepEqual(deletedBranches, retained ? [] : [workspace!.branch]);
    if (retained) {
      await access(workspace!.worktree);
      assert.ok(messages.at(-1)!.includes(workspace!.worktree));
    } else await assert.rejects(access(workspace!.worktree));
    if (changes) assert.ok(checkReads > 0);
  });
}
