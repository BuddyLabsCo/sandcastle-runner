import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createAttemptTracker,
  createCliDependencies,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const kind of ["ci", "conflict"] as const) {
  test(`a successful fresh ${kind} repair replaces its predecessor and completed delivery cleans the current Worktree`, async () => {
    const root = await createProject();
    const { tracker } = createAttemptTracker(9);
    const implementation = {
      sha: "b".repeat(40),
      message: "feat: implementation",
    };
    const repair = {
      sha: "c".repeat(40),
      message: `fix: ${kind} repair`,
    };
    const worktrees = new Map<
      string,
      { branch: string; commits: (typeof implementation)[] }
    >();
    const branches = new Set<string>();
    const removedWorktrees: string[] = [];
    const deletedBranches: string[] = [];
    let initialWorkspace: { worktree: string; branch: string } | undefined;
    let repairedWorkspace: { worktree: string; branch: string } | undefined;
    let afterRepair: { worktrees: string[]; branches: string[] } | undefined;
    let remoteHead: string | null = null;
    let checks = 0;
    let mergeRequests = 0;
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
            const workspace = {
              worktree: input.worktree,
              branch: input.branch,
            };
            if (input.branch.includes("-repair-"))
              repairedWorkspace = workspace;
            else initialWorkspace = workspace;
            worktrees.set(input.worktree, {
              branch: input.branch,
              commits: [
                input.branch.includes("-repair-") ? repair : implementation,
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
            branches.delete(branch);
            deletedBranches.push(branch);
          },
        },
        agentExecutor: {
          async execute(input) {
            const commit = input.promptFile.endsWith(`${kind}-repair.md`)
              ? repair
              : implementation;
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
          async getRemoteBranchHead() {
            return remoteHead;
          },
          async getRequiredChecks() {
            checks += 1;
            if (kind === "ci" && checks === 1) {
              return [
                {
                  name: "checks",
                  state: "FAILURE",
                  link: "https://example.test/checks/1",
                  bucket: "fail",
                },
              ];
            }
            if (checks === 2) {
              afterRepair = {
                worktrees: [...worktrees.keys()],
                branches: [...branches],
              };
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
            mergeRequests += 1;
            if (kind === "conflict" && mergeRequests === 1) {
              return { outcome: "conflict", error: "merge conflict" };
            }
            merged = true;
            return { outcome: "accepted" };
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "succeeded");
    assert.ok(initialWorkspace);
    assert.ok(repairedWorkspace);
    assert.deepEqual(afterRepair, {
      worktrees: [repairedWorkspace.worktree],
      branches: [repairedWorkspace.branch],
    });
    assert.deepEqual(removedWorktrees, [
      initialWorkspace.worktree,
      repairedWorkspace.worktree,
    ]);
    assert.deepEqual(deletedBranches, [
      initialWorkspace.branch,
      repairedWorkspace.branch,
    ]);
    assert.equal(worktrees.size, 0);
    assert.equal(branches.size, 0);
  });
}

test("not_planned work retains every matching Worktree and local branch", async () => {
  const root = await createProject();
  const {
    tickets: [ticket],
    tracker,
  } = createAttemptTracker(9);
  assert.ok(ticket);
  const repository = "/tmp/repo";
  const historical = {
    worktree: path.join(
      root,
      "projects",
      "demo",
      "worktrees",
      "historical",
      "ticket-9",
    ),
    branch: "sandcastle/run-historical/ticket-9",
    repository,
  };
  let current: typeof historical | undefined;
  const removed: string[] = [];
  const deleted: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          current = {
            worktree: input.worktree,
            branch: input.branch,
            repository,
          };
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch: current!.branch,
            base,
            commits: [
              {
                sha: "b".repeat(40),
                message: "feat: implementation",
              },
            ],
            clean: true,
          };
        },
        async listWorktrees() {
          return [historical, ...(current ? [current] : [])];
        },
        async removeWorktree(_checkout, worktree) {
          removed.push(worktree);
        },
        async deleteBranch(_checkout, branch) {
          deleted.push(branch);
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [
              {
                sha: "b".repeat(40),
                message: "feat: implementation",
              },
            ],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          ticket.state = "closed";
          ticket.stateReason = "not_planned";
          return { number: 1, url: "https://example.test/pull/1" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(removed, []);
  assert.deepEqual(deleted, []);
  assert.deepEqual(result.summary.tickets?.[0]?.retainedWorktrees, [
    current?.worktree,
  ]);
});

test("failed work retains its Worktree and local branch", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  let current:
    { worktree: string; branch: string; repository: string } | undefined;
  let removed = 0;
  let deleted = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          current = {
            worktree: input.worktree,
            branch: input.branch,
            repository: "/tmp/repo",
          };
        },
        async inspect() {
          throw new Error("Git evidence unavailable");
        },
        async listWorktrees() {
          return current ? [current] : [];
        },
        async removeWorktree() {
          removed += 1;
        },
        async deleteBranch() {
          deleted += 1;
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [
              {
                sha: "b".repeat(40),
                message: "feat: implementation",
              },
            ],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      operator: {
        async pause() {
          throw new Error("operator input unavailable");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(removed, 0);
  assert.equal(deleted, 0);
  assert.deepEqual(result.summary.tickets?.[0]?.retainedWorktrees, [
    current?.worktree,
  ]);
});

test("cancelled work retains its Worktree and local branch", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  let current:
    { worktree: string; branch: string; repository: string } | undefined;
  let removed = 0;
  let deleted = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          current = {
            worktree: input.worktree,
            branch: input.branch,
            repository: "/tmp/repo",
          };
        },
        async listWorktrees() {
          return current ? [current] : [];
        },
        async removeWorktree() {
          removed += 1;
        },
        async deleteBranch() {
          deleted += 1;
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "blocked",
            summary: "needs operator input",
            commits: [],
            checks: [],
            blocker: "needs operator input",
          };
        },
      },
      operator: {
        async pause() {
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(removed, 0);
  assert.equal(deleted, 0);
  assert.deepEqual(result.summary.tickets?.[0]?.retainedWorktrees, [
    current?.worktree,
  ]);
});

test("terminal cleanup failure retries through Operator Pause", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const commit = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  let current:
    { worktree: string; branch: string; repository: string } | undefined;
  let removalAttempts = 0;
  let deleted = 0;
  const pauses: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          current = {
            worktree: input.worktree,
            branch: input.branch,
            repository: "/tmp/repo",
          };
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch: current!.branch,
            base,
            commits: [commit],
            clean: true,
          };
        },
        async listWorktrees() {
          return current ? [current] : [];
        },
        async removeWorktree() {
          removalAttempts += 1;
          if (removalAttempts === 1) throw new Error("worktree is busy");
          current = undefined;
        },
        async deleteBranch() {
          deleted += 1;
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
      operator: {
        async pause(message) {
          pauses.push(message);
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(removalAttempts, 2);
  assert.equal(deleted, 1);
  assert.equal(pauses.length, 1);
  assert.match(pauses[0]!, /Terminal cleanup for Ticket 9 failed/u);
});
