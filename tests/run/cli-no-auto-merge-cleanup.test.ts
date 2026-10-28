import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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

test("a CI-ready no-auto-merge Run retains the repaired Worktree and manual handoff state", async () => {
  const root = await createProject();
  const { tracker, tickets } = createAttemptTracker(9);
  const repository = "/tmp/repo";
  const historical = {
    worktree: path.join(root, "demo/worktrees/historical/ticket-9"),
    branch: "sandcastle/run-historical/ticket-9",
    repository,
  };
  const historicalLogs = ["agent", "merge", "doc"].map((stage) =>
    path.join(root, `demo/logs/${stage}-9-historical.log`),
  );
  await mkdir(path.dirname(historicalLogs[0]!), { recursive: true });
  for (const logFile of historicalLogs) await writeFile(logFile, "keep");
  const workspaces = new Map<
    string,
    { worktree: string; branch: string; repository: string }
  >();
  const createdBranches = new Set<string>();
  const localBranches = new Set<string>();
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
          localBranches.add(input.branch);
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
          assert.ok(
            localBranches.delete(branch),
            `branch not found: ${branch}`,
          );
          removedBranches.push(branch);
        },
      },
      agentExecutor: {
        async execute(input) {
          agentCalls += 1;
          logFiles.push(input.logFile);
          await writeFile(input.logFile, input.runName);
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
  assert.equal(workspaces.size, 1);
  const retained = [...workspaces.values()][0]!;
  assert.deepEqual(result.summary.tickets, [
    {
      ticket: 9,
      kind: "delivery",
      status: "PR ready",
      pullRequest: 41,
      pullRequestUrl: "https://example.test/pull/41",
      detail: "Pull Request #41 is CI-ready; awaiting manual merge",
      retainedWorktrees: [retained.worktree],
    },
  ]);
  assert.equal(removedWorktrees.includes(historical.worktree), false);
  assert.deepEqual(localBranches, new Set([retained.branch]));
  assert.deepEqual(
    new Set(removedBranches),
    new Set(
      [...createdBranches].filter((branch) => branch !== retained.branch),
    ),
  );
  assert.match(
    result.summary.reasons.join("\n"),
    /reserved Delivery Tickets: 9/u,
  );
  assert.ok(tickets[0]?.labels.includes("sandcastle:reserved"));
  assert.ok(tickets[0]?.assignees.includes("runner"));
  assert.equal(tickets[0]?.state, "open");
  assert.ok(checkReads > checkReadsAtRemoval.at(-1)!);
  await Promise.all(logFiles.map((logFile) => assert.rejects(access(logFile))));
  for (const logFile of historicalLogs)
    assert.equal(await readFile(logFile, "utf8"), "keep");

  for (const logFile of orphanLogs) await access(logFile);

  const snapshot = await readRecoverySnapshot(
    recoveryPaths(path.join(root, "demo"), 9, "issue").snapshot,
  );
  assert.equal(snapshot?.phase, "running");
  assert.equal(snapshot?.publications?.[0]?.pullRequest?.number, 41);
  assert.notEqual(snapshot?.terminalCleanup?.[9]?.status, "cleaned");
});
