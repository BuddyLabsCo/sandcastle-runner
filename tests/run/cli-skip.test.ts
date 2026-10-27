import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createAttemptTracker,
  createCliDependencies,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  publicationIntent,
  validConfig,
  writePublicationState,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const scenario of [
  "peer",
  "later-parent",
  "later-standalone",
  "recovered",
]) {
  test(`skip releases a pre-PR ticket while independent work completes: ${scenario}`, async () => {
    const root = await createProject();
    await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
      ...validConfig,
      maxBatchSize: scenario.startsWith("later") ? 1 : 3,
      issueList: scenario === "later-standalone" ? [9, 10] : [],
    });
    const { tickets, tracker } = createAttemptTracker(9, 10);
    if (scenario === "recovered") {
      await writePublicationState(root, [publicationIntent("pending_push", 9)]);
      tickets[0]!.labels.push("sandcastle:reserved");
      tickets[0]!.assignees.push("runner");
    }
    const branches = new Map<number, string>();
    const worktrees = new Map<number, string>();
    const pauses: string[] = [];
    const agentCalls = new Map<number, number>();
    const removedWorktrees: string[] = [];
    const deletedBranches: string[] = [];
    let comments = 0;
    let parentCloses = 0;
    let merged = false;
    let checksReads = 0;
    let mergeRequests = 0;
    const logs = path.join(root, "projects", "demo", "logs");
    await mkdir(logs, { recursive: true });
    const historicalLog = path.join(logs, "agent-9-historical.log");
    const reviewLog = path.join(logs, "review-9-current.log");
    await writeFile(historicalLog, "historical");
    await writeFile(reviewLog, "review");

    const args =
      scenario === "later-standalone"
        ? ["run", "--project", "demo", "--issue"]
        : ["run", "--project", "demo", "--parent", "8"];
    const dependencies = createCliDependencies(root, {
      tracker: {
        ...tracker,
        async addComment() {
          comments += 1;
        },
        async closeParent() {
          parentCloses += 1;
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          const ticket = Number(input.branch.split("-").at(-1));
          branches.set(ticket, input.branch);
          worktrees.set(ticket, input.worktree);
        },
        async inspect({ worktree, base }) {
          const ticket = Number(worktree.split("-").at(-1));
          return {
            worktree,
            branch: branches.get(ticket)!,
            base,
            commits: [
              {
                sha: String(ticket).at(-1)!.repeat(40),
                message: `feat: ticket ${ticket}`,
              },
            ],
            clean: true,
          };
        },
        async listWorktrees() {
          return [...worktrees].map(([ticket, worktree]) => ({
            worktree,
            branch: branches.get(ticket)!,
            repository: validConfig.checkout,
          }));
        },
        async removeWorktree(_checkout, worktree) {
          removedWorktrees.push(worktree);
        },
        async deleteBranch(_checkout, branch) {
          deletedBranches.push(branch);
        },
      },
      agentExecutor: {
        async execute(input) {
          agentCalls.set(input.ticket, (agentCalls.get(input.ticket) ?? 0) + 1);
          await writeFile(input.logFile, `attempt for ${input.ticket}`);
          if (input.ticket === 9) {
            return {
              outcome: "blocked",
              summary: "implementation needs a decision",
              commits: [],
              checks: [],
              blocker: "implementation needs a decision",
            };
          }
          return {
            outcome: "committed",
            summary: "implemented 10",
            commits: [
              {
                sha: "0".repeat(40),
                message: "feat: ticket 10",
              },
            ],
            checks: [],
            blocker: null,
            pr_title: "feat: ticket 10",
            pr_body: "Implements ticket 10.",
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          return { number: 41, url: "https://example.test/pull/41" };
        },
        async getPullRequest() {
          return {
            headSha: "0".repeat(40),
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async getRequiredChecks() {
          checksReads += 1;
          return [];
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "s";
        },
      },
    });
    const result = await executeCli(args, dependencies);

    assert.equal(
      result.summary.outcome,
      "incomplete",
      result.summary.reasons.join("; "),
    );
    assert.deepEqual(result.summary.completedTickets, [10]);
    assert.deepEqual(
      result.summary.tickets?.map(({ ticket, status }) => ({ ticket, status })),
      [
        { ticket: 9, status: "failed" },
        { ticket: 10, status: "completed" },
      ],
    );
    const skipped = result.summary.tickets?.find(({ ticket }) => ticket === 9);
    assert.match(skipped?.detail ?? "", /^skipped/u);
    assert.deepEqual(skipped?.retainedWorktrees, [worktrees.get(9)]);
    assert.equal(pauses.length, 1);
    assert.match(pauses[0]!, /s to skip/u);
    assert.equal(agentCalls.get(9), 1);
    assert.equal(comments, 0);
    assert.equal(parentCloses, 0);
    assert.equal(checksReads, 1);
    assert.equal(mergeRequests, 1);
    assert.equal(tickets[0]!.state, "open");
    assert.deepEqual(tickets[0]!.labels, ["ready-for-agent"]);
    assert.deepEqual(tickets[0]!.assignees, []);
    assert.equal(removedWorktrees.includes(worktrees.get(9)!), false);
    assert.equal(deletedBranches.includes(branches.get(9)!), false);
    assert.deepEqual(removedWorktrees, [worktrees.get(10)]);
    assert.deepEqual(deletedBranches, [branches.get(10)]);
    assert.equal(tickets[1]!.state, "closed");
    assert.equal(tickets[1]!.stateReason, "completed");
    await assert.rejects(access(reviewLog));
    assert.equal(await readFile(historicalLog, "utf8"), "historical");

    const laterRun = await executeCli(args, dependencies);
    assert.equal(laterRun.summary.outcome, "incomplete");
    assert.equal(
      agentCalls.get(9),
      2,
      "a later Run must retry the skipped ticket",
    );
    assert.match(laterRun.summary.tickets?.[0]?.detail ?? "", /^skipped/u);
  });
}

for (const instruction of ["S", "skip"]) {
  test(`"${instruction}" is recovery input rather than a skip token`, async () => {
    const root = await createProject();
    const { tickets, tracker } = createAttemptTracker(9);
    const pauses: string[] = [];
    let agentCalls = 0;
    let branch = "";
    let merged = false;

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "a".repeat(40);
          },
          async createWorktree(input) {
            branch = input.branch;
          },
          async inspect({ worktree, base }) {
            return {
              worktree,
              branch,
              base,
              commits: [
                {
                  sha: "b".repeat(40),
                  message: "feat: ticket 9",
                },
              ],
              clean: true,
            };
          },
        },
        agentExecutor: {
          async execute() {
            agentCalls += 1;
            return agentCalls <= 2
              ? {
                  outcome: "blocked",
                  summary: "needs recovery input",
                  commits: [],
                  checks: [],
                  blocker: "needs recovery input",
                }
              : {
                  outcome: "committed",
                  summary: "recovered",
                  commits: [
                    {
                      sha: "b".repeat(40),
                      message: "feat: ticket 9",
                    },
                  ],
                  checks: [],
                  blocker: null,
                  pr_title: "feat: ticket 9",
                  pr_body: "Implements ticket 9.",
                };
          },
        },
        codeHost: {
          async createPullRequest() {
            return { number: 41, url: "https://example.test/pull/41" };
          },
          async getPullRequest() {
            return {
              headSha: "b".repeat(40),
              createdAt: "2026-09-09T00:00:00Z",
              merged,
              mergeFailure: null,
            };
          },
          async requestSquashMerge() {
            merged = true;
            return { outcome: "accepted" };
          },
        },
        operator: {
          async pause(message) {
            pauses.push(message);
            return instruction;
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(agentCalls, 3);
    assert.equal(pauses.length, 2);
    assert.equal(result.summary.tickets?.[0]?.status, "completed");
    assert.equal(tickets[0]!.state, "closed");
  });
}

test("a non-Agent pause does not accept s as skip", async () => {
  const root = await createProject();
  let pauses = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          throw new Error("Parent unavailable");
        },
      },
      operator: {
        async pause() {
          pauses += 1;
          return pauses === 1 ? "s" : "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pauses, 2);
});

test("a log deletion failure is audited without changing skip", async () => {
  const root = await createProject();
  const { tickets, tracker } = createAttemptTracker(9);
  let logFile = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
      },
      agentExecutor: {
        async execute(input) {
          logFile = input.logFile;
          await mkdir(logFile);
          throw new Error("skip this failed Attempt");
        },
      },
      operator: {
        async pause() {
          return "s";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.summary.tickets?.[0]?.status, "failed");
  assert.match(result.summary.tickets?.[0]?.detail ?? "", /^skipped/u);
  assert.equal(tickets[0]!.state, "open");
  const cleanupFailure = (await readFile(result.logPath!, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find(
      (event) =>
        event.operation === "delete_agent_log" && event.result === "failed",
    );
  assert.ok(cleanupFailure);
  assert.equal(cleanupFailure.diagnosticLogPath, logFile);
});

test("a blocked Review can also skip its pre-PR ticket", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    workflow: { ...validConfig.workflow, review: true },
  });
  const { tickets, tracker } = createAttemptTracker(9);
  const logFiles: string[] = [];
  let worktree = "";
  let branch = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          worktree = input.worktree;
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch,
            base,
            commits: [
              {
                sha: "b".repeat(40),
                message: "feat: ticket 9",
              },
            ],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          logFiles.push(input.logFile);
          await writeFile(input.logFile, "implementation");
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [
              {
                sha: "b".repeat(40),
                message: "feat: ticket 9",
              },
            ],
            checks: [],
            blocker: null,
            pr_title: "feat: ticket 9",
            pr_body: "Implements ticket 9.",
          };
        },
        async executeReview(input) {
          logFiles.push(input.logFile);
          await writeFile(input.logFile, "review");
          return {
            outcome: "blocked",
            blocker: "review needs a decision",
          };
        },
      },
      operator: {
        async pause() {
          return "s";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.summary.tickets?.[0]?.status, "failed");
  assert.match(result.summary.tickets?.[0]?.detail ?? "", /^skipped/u);
  assert.deepEqual(result.summary.tickets?.[0]?.retainedWorktrees, [worktree]);
  assert.equal(tickets[0]!.state, "open");
  await Promise.all(logFiles.map((logFile) => assert.rejects(access(logFile))));
});
