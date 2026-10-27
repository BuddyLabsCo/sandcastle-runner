import assert from "node:assert/strict";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createAttemptTracker,
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("Reasons report the final pause reason of a manually skipped ticket", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const messages: string[] = [];
  let calls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      agentExecutor: {
        async execute() {
          calls += 1;
          return {
            outcome: "blocked",
            summary: `attempt ${calls} needs a decision`,
            commits: [],
            checks: [],
            blocker: `attempt ${calls} needs a decision`,
          };
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          return calls === 1 ? "" : "s";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(calls, 2);
  assert.match(
    messages.at(-1)!,
    /^Reasons:$/mu,
    `expected a Reasons section in:\n${messages.at(-1)}`,
  );
  assert.match(messages.at(-1)!, /^- issue-9: attempt 2 needs a decision$/mu);
  assert.doesNotMatch(messages.at(-1)!, /attempt 1 needs a decision/u);
  assert.doesNotMatch(messages.at(-1)!, /^Audit Log:/mu);
});

test("a retried ticket that succeeds produces no Reasons section", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const messages: string[] = [];
  let calls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      agentExecutor: {
        async execute(input) {
          calls += 1;
          return calls === 1
            ? {
                outcome: "blocked",
                summary: "needs recovery",
                commits: [],
                checks: [],
                blocker: "needs recovery",
              }
            : delivery.agentExecutor.execute!(input);
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.doesNotMatch(messages.at(-1)!, /^Reasons:$/mu);
});

test("an automatic eligibility skip produces no Reasons section", async () => {
  const root = await createProject();
  const { tickets, tracker } = createAttemptTracker(9);
  tickets[0]!.assignees.push("someone-else");
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      operator: {
        write(message) {
          messages.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.ok(result.summary.reasons.length > 0);
  assert.doesNotMatch(messages.at(-1)!, /^Reasons:$/mu);
});

test("a completed ticket's skipped cleanup produces no Reasons section", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async listWorktrees() {
          throw new Error("worktree enumeration failed");
        },
        async removeWorktree() {},
        async deleteBranch() {},
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          return "s";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.summary.tickets?.[0]?.status, "completed");
  assert.ok(
    result.summary.reasons.some((reason) =>
      reason.includes("Terminal cleanup pending"),
    ),
  );
  assert.doesNotMatch(messages.at(-1)!, /^Reasons:$/mu);
});
