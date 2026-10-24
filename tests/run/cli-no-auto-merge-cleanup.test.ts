import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { readRecoverySnapshot, recoveryPaths } from "../../src/recovery.ts";
import {
  createCliDependencies,
  createAttemptTracker,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("a CI-ready no-auto-merge Run removes local artifacts and preserves manual handoff state", async () => {
  const root = await createProject();
  const { tracker, tickets } = createAttemptTracker(9);
  const repository = "/tmp/repo";
  const historical = {
    worktree: path.join(root, "projects/demo/worktrees/historical/ticket-9"),
    branch: "sandcastle/run-historical/ticket-9",
    repository,
  };
  const historicalLog = path.join(
    root,
    "projects/demo/logs/agent-9-historical.log",
  );
  await mkdir(path.dirname(historicalLog), { recursive: true });
  await writeFile(historicalLog, "keep");
  const workspaces = new Map<
    string,
    { worktree: string; branch: string; repository: string }
  >();
  const createdBranches = new Set<string>();
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];
  const logFiles: string[] = [];
  const orphanLogs: string[] = [];
  const checkReadsAtRemoval: number[] = [];
  let checkReads = 0;
  let agentCalls = 0;
  let mergeRequests = 0;
  let closeRequests = 0;
  let remoteHead: string | null = null;
  const implementation = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  const repair = {
    sha: "c".repeat(40),
    message: "fix: checks",
  };

  const result = await executeCli(
    ["run", "--issue", "9", "--project", "demo", "--no-auto-merge"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async closeTicket() {
          closeRequests += 1;
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          workspaces.set(input.worktree, {
            ...input,
            repository,
          });
          createdBranches.add(input.branch);
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch: workspaces.get(worktree)!.branch,
            base,
            commits: agentCalls <= 1 ? [implementation] : [repair],
            clean: true,
          };
        },
        async push() {
          remoteHead = agentCalls === 1 ? implementation.sha : repair.sha;
        },
        async listWorktrees() {
          return [historical, ...workspaces.values()];
        },
        async removeWorktree(_checkout, worktree) {
          checkReadsAtRemoval.push(checkReads);
          removedWorktrees.push(worktree);
          workspaces.delete(worktree);
        },
        async deleteBranch(_checkout, branch) {
          removedBranches.push(branch);
        },
      },
      agentExecutor: {
        async execute(input) {
          agentCalls += 1;
          logFiles.push(input.logFile);
          await writeFile(input.logFile, input.sessionName);
          if (agentCalls === 1) {
            const orphan = path.join(
              path.dirname(input.logFile),
              path.basename(input.logFile).replace(/^implement-/u, "merge-"),
            );
            orphanLogs.push(orphan);
            await writeFile(orphan, "orphaned stage log");
          }
          const commit = agentCalls === 1 ? implementation : repair;
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
          return { number: 41, url: "https://example.test/pull/41" };
        },
        async getRemoteBranchHead() {
          return remoteHead;
        },
        async getRequiredChecks() {
          checkReads += 1;
          return checkReads === 1
            ? [
                {
                  name: "checks",
                  state: "FAILURE",
                  link: "https://example.test/run/1",
                  bucket: "fail",
                },
              ]
            : [];
        },
        async getPullRequest() {
          return {
            headSha: agentCalls === 1 ? implementation.sha : repair.sha,
            createdAt: "2026-09-09T00:00:00Z",
            merged: false,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(mergeRequests, 0);
  assert.equal(closeRequests, 0);
  assert.deepEqual(result.summary.tickets, [
    {
      ticket: 9,
      kind: "delivery",
      status: "PR ready",
      pullRequest: 41,
      detail: "Pull Request #41 is CI-ready; awaiting manual merge",
      retainedWorktrees: [],
    },
  ]);
  assert.equal(workspaces.size, 0);
  assert.equal(removedWorktrees.includes(historical.worktree), false);
  assert.deepEqual(new Set(removedBranches), createdBranches);
  assert.match(
    result.summary.reasons.join("\n"),
    /reserved Delivery Tickets: 9/u,
  );
  assert.ok(tickets[0]?.labels.includes("sandcastle:reserved"));
  assert.ok(tickets[0]?.assignees.includes("runner"));
  assert.equal(tickets[0]?.state, "open");
  assert.equal(checkReads, checkReadsAtRemoval.at(-1));
  await Promise.all(
    [...logFiles, ...orphanLogs].map((logFile) =>
      assert.rejects(access(logFile)),
    ),
  );
  assert.equal(await readFile(historicalLog, "utf8"), "keep");

  const snapshot = await readRecoverySnapshot(
    recoveryPaths(path.join(root, "projects/demo"), 9, "issue").snapshot,
  );
  assert.equal(snapshot?.phase, "running");
  assert.equal(snapshot?.publications?.[0]?.pullRequest?.number, 41);
  assert.equal(snapshot?.terminalCleanup?.[9]?.status, "cleaned");
});

for (const accepted of [false, true]) {
  test(`no-auto-merge cleanup ${accepted ? "accepts residual artifacts" : "retries through Operator Pause"}`, async () => {
    const root = await createProject();
    const { tracker } = createAttemptTracker(9);
    const commit = {
      sha: "b".repeat(40),
      message: "feat: implementation",
    };
    let workspace:
      { worktree: string; branch: string; repository: string } | undefined;
    let removalAttempts = 0;
    let branchDeletes = 0;
    let mergeRequests = 0;
    const pauses: string[] = [];

    const result = await executeCli(
      ["run", "--issue", "9", "--project", "demo", "--no-auto-merge"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "a".repeat(40);
          },
          async createWorktree(input) {
            workspace = {
              worktree: input.worktree,
              branch: input.branch,
              repository: "/tmp/repo",
            };
          },
          async inspect({ worktree, base }) {
            return {
              worktree,
              branch: workspace!.branch,
              base,
              commits: [commit],
              clean: true,
            };
          },
          async listWorktrees() {
            return workspace ? [workspace] : [];
          },
          async removeWorktree() {
            removalAttempts += 1;
            if (removalAttempts === 1) throw new Error("worktree is busy");
            workspace = undefined;
          },
          async deleteBranch() {
            branchDeletes += 1;
          },
        },
        agentExecutor: {
          async execute() {
            return {
              outcome: "committed",
              summary: "implemented",
              commits: [commit],
              checks: [],
              blocker: null,
              pr_title: "feat: implementation",
              pr_body: "Implementation body.",
            };
          },
        },
        codeHost: {
          async requestSquashMerge() {
            mergeRequests += 1;
            return { outcome: "accepted" };
          },
        },
        operator: {
          async pause(message) {
            pauses.push(message);
            return accepted ? "manual cleanup required" : "";
          },
        },
      }),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(mergeRequests, 0);
    assert.equal(pauses.length, 1);
    assert.match(pauses[0]!, /cleanup for Ticket 9 failed/u);
    assert.equal(result.summary.tickets?.[0]?.status, "PR ready");
    assert.deepEqual(result.summary.tickets?.[0]?.retainedWorktrees, [
      ...(accepted ? [workspace!.worktree] : []),
    ]);
    assert.equal(removalAttempts, accepted ? 1 : 2);
    assert.equal(branchDeletes, accepted ? 0 : 1);
  });
}

test("no-auto-merge retries a failed Agent log cleanup through Operator Pause", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const commit = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  let logFile = "";
  let branch = "";
  const pauses: string[] = [];

  const result = await executeCli(
    ["run", "--issue", "9", "--project", "demo", "--no-auto-merge"],
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
            commits: [commit],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          logFile = input.logFile;
          await mkdir(logFile);
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          await rm(logFile, { recursive: true, force: true });
          return "";
        },
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(result.summary.tickets?.[0]?.status, "PR ready");
  assert.equal(pauses.length, 1);
  assert.match(pauses[0]!, /cleanup for Ticket 9 failed/u);
  await assert.rejects(access(logFile));
});
