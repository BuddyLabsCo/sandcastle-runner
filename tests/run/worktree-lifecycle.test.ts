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

for (const failure of ["worktree", "branch"] as const) {
  test(`terminal ${failure} cleanup failure retries through Operator Pause`, async () => {
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
    let branchExists = true;
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
            if (failure === "worktree" && removalAttempts === 1)
              throw new Error("worktree is busy");
            current = undefined;
          },
          async deleteBranch() {
            deleted += 1;
            if (failure === "branch" && deleted === 1)
              throw new Error("branch is busy");
            branchExists = false;
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
    assert.equal(removalAttempts, failure === "worktree" ? 2 : 1);
    assert.equal(deleted, failure === "branch" ? 2 : 1);
    assert.equal(branchExists, false);
    assert.equal(pauses.length, 1);
    assert.match(pauses[0]!, /Terminal cleanup for Ticket 9 failed/u);
  });
}
