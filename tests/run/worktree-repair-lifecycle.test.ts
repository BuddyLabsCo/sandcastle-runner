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
}[] = [
  { stages: ["ci"] },
  { stages: ["conflict"] },
  { stages: ["ci", "conflict"] },
  { stages: ["conflict", "conflict"] },
  { stages: ["conflict", "ci", "conflict"] },
  { stages: ["ci"], interruptCleanup: true },
  { stages: ["ci", "conflict"], interruptCleanup: true },
];

for (const { stages, interruptCleanup = false } of repairScenarios) {
  test(`successful fresh ${stages.join(" then ")} repairs replace their predecessors before completed cleanup${interruptCleanup ? " across interrupted branch deletion" : ""}`, async () => {
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
    const afterRepairs: { worktrees: string[]; branches: string[] }[] = [];
    let repairs = 0;
    let interrupt = interruptCleanup;
    const pauses: string[] = [];
    let remoteHead: string | null = null;
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
            repairs += 1;
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
          return remoteHead;
        },
        async getRequiredChecks() {
          assert.equal(merged, false);
          if (repairs > 0) {
            afterRepairs.push({
              worktrees: [...worktrees.keys()],
              branches: [...branches],
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
          pauses.push(message);
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

    assert.equal(
      result.summary.outcome,
      "succeeded",
      [...result.summary.reasons, ...pauses].join("\n"),
    );
    assert.ok(initialWorkspace);
    const initialBranch = initialWorkspace.branch;
    assert.equal(repairedWorkspaces.length, stages.length);
    assert.deepEqual(
      afterRepairs,
      repairedWorkspaces.map((workspace) => ({
        worktrees: [workspace.worktree],
        branches: [
          ...(interruptCleanup ? [initialBranch] : []),
          workspace.branch,
        ],
      })),
    );
    assert.deepEqual(removedWorktrees, [
      initialWorkspace.worktree,
      ...repairedWorkspaces.map(({ worktree }) => worktree),
    ]);
    assert.deepEqual(
      new Set(deletedBranches),
      new Set([
        initialWorkspace.branch,
        ...repairedWorkspaces.map(({ branch }) => branch),
      ]),
    );
    assert.equal(worktrees.size, 0);
    assert.equal(branches.size, 0);
  });
}
