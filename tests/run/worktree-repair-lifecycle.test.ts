import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { readRecoverySnapshot, recoveryPaths } from "../../src/recovery.ts";
import {
  createAttemptTracker,
  createCliDependencies,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

const repairScenarios: {
  stages: ("ci" | "conflict")[];
  interruptCleanup?: boolean;
  cancelRepair?: boolean;
  interruptPush?: boolean;
  advanceBeforePush?: boolean;
}[] = [
  { stages: ["ci"] },
  { stages: ["conflict"] },
  { stages: ["ci", "conflict"] },
  { stages: ["conflict", "conflict"] },
  { stages: ["conflict", "ci", "conflict"] },
  { stages: ["ci"], interruptCleanup: true },
  { stages: ["ci", "conflict"], interruptCleanup: true },
  { stages: ["ci", "conflict"], cancelRepair: true },
  { stages: ["conflict", "conflict"], cancelRepair: true },
  { stages: ["ci", "conflict"], interruptPush: true },
  { stages: ["ci"], advanceBeforePush: true },
];

for (const {
  stages,
  interruptCleanup = false,
  cancelRepair = false,
  interruptPush = false,
  advanceBeforePush = false,
} of repairScenarios) {
  test(`successful fresh ${stages.join(" then ")} repairs replace their predecessors before completed cleanup${interruptCleanup ? " across interrupted branch deletion" : ""}${cancelRepair ? " across a cancelled repair" : ""}${interruptPush ? " across uncertain push confirmation" : ""}${advanceBeforePush ? " after rejecting a remote-state override and retrying" : ""}`, async () => {
    const root = await createProject();
    const { tracker } = createAttemptTracker(9);
    const implementation = {
      sha: "b".repeat(40),
      message: "feat: implementation",
    };
    const worktrees = new Map<
      string,
      { branch: string; commits: (typeof implementation)[] }
    >();
    const branches = new Set<string>();
    const removedWorktrees: string[] = [];
    const deletedBranches: string[] = [];
    let initialWorkspace: { worktree: string; branch: string } | undefined;
    const repairedWorkspaces: { worktree: string; branch: string }[] = [];
    const acceptedWorkspaces: { worktree: string; branch: string }[] = [];
    const afterRepairs: { worktrees: Set<string>; branches: Set<string> }[] =
      [];
    const expectedAfterRepairs: typeof afterRepairs = [];
    let failedWorkspace: { worktree: string; branch: string } | undefined;
    let cancel = cancelRepair;
    let uncertainPush = interruptPush;
    let repairs = 0;
    let interrupt = interruptCleanup;
    const pauses: string[] = [];
    let remoteHead: string | null = null;
    let repairBase = "";
    let merged = false;

    const dependencies = createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          const workspace = {
            worktree: input.worktree,
            branch: input.branch,
          };
          if (input.branch.includes("-repair-"))
            repairedWorkspaces.push(workspace);
          else initialWorkspace = workspace;
          worktrees.set(input.worktree, {
            branch: input.branch,
            commits: [
              input.branch.includes("-repair-")
                ? {
                    sha: (repairs + 12).toString(16).repeat(40),
                    message: `fix: repair ${repairs + 1}`,
                  }
                : implementation,
            ],
          });
          branches.add(input.branch);
        },
        async inspect({ worktree, base }) {
          const workspace = worktrees.get(worktree)!;
          return {
            worktree,
            branch: workspace.branch,
            base,
            commits: workspace.commits,
            clean: true,
          };
        },
        async push(worktree) {
          remoteHead = worktrees.get(worktree)!.commits.at(-1)!.sha;
        },
        async listWorktrees() {
          return [...worktrees].map(([worktree, workspace]) => ({
            worktree,
            branch: workspace.branch,
            repository: "/tmp/repo",
          }));
        },
        async removeWorktree(_checkout, worktree) {
          worktrees.delete(worktree);
          removedWorktrees.push(worktree);
        },
        async deleteBranch(_checkout, branch) {
          if (interrupt) {
            interrupt = false;
            throw new Error("branch is busy");
          }
          branches.delete(branch);
          deletedBranches.push(branch);
        },
      },
      agentExecutor: {
        async execute(input) {
          const repairing = input.promptFile.endsWith("-repair.md");
          if (repairing) {
            assert.ok(
              input.promptFile.endsWith(`${stages[repairs]}-repair.md`),
            );
            if (cancel && repairs === 1) {
              cancel = false;
              failedWorkspace = repairedWorkspaces.at(-1)!;
              return {
                outcome: "blocked",
                summary: "repair blocked",
                blocker: "needs input",
                commits: [],
                checks: [],
              };
            }
            repairs += 1;
            acceptedWorkspaces.push(repairedWorkspaces.at(-1)!);
            if (advanceBeforePush) {
              repairBase = input.base;
              remoteHead = "f".repeat(40);
            }
          }
          const commit = worktrees.get(input.worktree)!.commits[0]!;
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
        async listPullRequests() {
          throw new Error(
            "published repair recovery must reuse its Pull Request",
          );
        },
        async getRemoteBranchHead() {
          if (uncertainPush && repairs > 0) {
            remoteHead = worktrees
              .get(acceptedWorkspaces.at(-1)!.worktree)!
              .commits.at(-1)!.sha;
            throw new Error("repair push confirmation unavailable");
          }
          return remoteHead;
        },
        async getRequiredChecks() {
          assert.equal(merged, false);
          if (repairs > 0) {
            afterRepairs.push({
              worktrees: new Set(worktrees.keys()),
              branches: new Set(branches),
            });
            const retained = [
              ...(failedWorkspace ? [failedWorkspace] : []),
              acceptedWorkspaces.at(-1)!,
            ];
            expectedAfterRepairs.push({
              worktrees: new Set(retained.map(({ worktree }) => worktree)),
              branches: new Set([
                ...(interruptCleanup ? [initialWorkspace!.branch] : []),
                ...retained.map(({ branch }) => branch),
              ]),
            });
          }
          if (stages[repairs] === "ci") {
            return [
              {
                name: "checks",
                state: "FAILURE",
                link: "https://example.test/checks/1",
                bucket: "fail",
              },
            ];
          }
          return [];
        },
        async getPullRequest() {
          return {
            headSha: remoteHead ?? implementation.sha,
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          if (stages[repairs] === "conflict") {
            return { outcome: "conflict", error: "merge conflict" };
          }
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause(message) {
          uncertainPush = false;
          pauses.push(message);
          if (advanceBeforePush) {
            assert.match(message, /Stable repair branch advanced/u);
            if (pauses.length === 1) return "trusted repair branch";
            remoteHead = repairBase;
            return "";
          }
          return "q";
        },
      },
    });
    const args = ["run", "--project", "demo", "--parent", "8"];
    let result = await executeCli(args, dependencies);

    if (interruptCleanup) {
      assert.equal(result.summary.outcome, "cancelled");
      assert.ok(initialWorkspace);
      const snapshot = await readRecoverySnapshot(
        recoveryPaths(path.join(root, "projects", "demo"), 8).snapshot,
      );
      assert.deepEqual(snapshot?.terminalCleanup?.[9]?.candidates, [
        `${initialWorkspace.worktree}:${initialWorkspace.branch}`,
      ]);
      assert.deepEqual(
        [...worktrees.keys()],
        [repairedWorkspaces[0]!.worktree],
      );
      assert.equal(branches.size, 2);
      result = await executeCli(args, dependencies);
    }
    if (cancelRepair) {
      assert.equal(result.summary.outcome, "cancelled");
      assert.ok(failedWorkspace);
      assert.equal(worktrees.size, 2);
      result = await executeCli(args, dependencies);
    }
    if (interruptPush) {
      assert.equal(result.summary.outcome, "cancelled");
      assert.equal(worktrees.size, 2);
      const snapshot = await readRecoverySnapshot(
        recoveryPaths(path.join(root, "projects", "demo"), 8).snapshot,
      );
      assert.equal(
        snapshot?.publications?.[0]?.repairBudgets?.ci?.pendingPush,
        remoteHead,
      );
      assert.equal(snapshot?.publications?.[0]?.repairState, undefined);
      result = await executeCli(args, dependencies);
    }

    assert.equal(
      result.summary.outcome,
      "succeeded",
      [...result.summary.reasons, ...pauses].join("\n"),
    );
    assert.ok(initialWorkspace);
    assert.equal(acceptedWorkspaces.length, stages.length);
    assert.deepEqual(afterRepairs, expectedAfterRepairs);
    assert.deepEqual(
      new Set(removedWorktrees),
      new Set([
        initialWorkspace.worktree,
        ...repairedWorkspaces.map(({ worktree }) => worktree),
      ]),
    );
    assert.deepEqual(
      new Set(deletedBranches),
      new Set([
        initialWorkspace.branch,
        ...repairedWorkspaces.map(({ branch }) => branch),
      ]),
    );
    assert.equal(worktrees.size, 0);
    assert.equal(branches.size, 0);
    if (advanceBeforePush) assert.equal(pauses.length, 2);
  });
}
