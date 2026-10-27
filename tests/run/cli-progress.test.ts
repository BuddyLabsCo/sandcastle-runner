import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createCliDependencies,
  createCommittedBatch,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("a retried implementation prints its issue and phase once per start", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const progress: string[] = [];
  let calls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      agentExecutor: {
        async execute(input) {
          calls += 1;
          if (calls === 1)
            return {
              outcome: "blocked",
              summary: "needs recovery",
              commits: [],
              checks: [],
              blocker: "needs recovery",
            };
          return delivery.agentExecutor.execute!(input);
        },
      },
      operator: {
        write(message) {
          progress.push(message);
        },
        async pause() {
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(progress.slice(0, -1), [
    "issue-9: implement",
    "issue-9: implement retry",
  ]);
  assert.doesNotMatch(progress.at(-1)!, /^issue-9:/mu);
});

test("numbered review rounds and their fixes print distinct phase lines", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    workflow: { ...validConfig.workflow, review: true, maxReviewRounds: 2 },
  });
  const delivery = createCommittedDelivery(9);
  const implementation = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  const fix = { sha: "c".repeat(40), message: "fix: finding" };
  const commits = [implementation];
  const progress: string[] = [];
  let branch = "";
  let round = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          const index =
            base === "a".repeat(40)
              ? -1
              : commits.findIndex(({ sha }) => sha === base);
          return {
            worktree,
            branch,
            base,
            clean: true,
            commits: commits.slice(index + 1),
          };
        },
        async inspectReview() {
          return {
            clean: true,
            deliveryCommits: [...commits],
            reviewCommits: [],
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          if (input.resumePrompt === undefined) {
            await writeFile(input.logFile, "implementation");
            return delivery.agentExecutor.execute!(input);
          }
          commits.push(fix);
          return {
            outcome: "committed",
            summary: "fixed finding",
            commits: [fix],
            checks: [],
            blocker: null,
          };
        },
        async executeReview(input) {
          round += 1;
          if (round === 1) {
            const review = JSON.parse(
              String(input.promptArgs.REVIEW_INPUT),
            ) as {
              findingsFile: string;
            };
            await writeFile(review.findingsFile, "# P1 finding");
            return {
              outcome: "findings",
              findings_file: review.findingsFile,
            };
          }
          return { outcome: "passed" };
        },
      },
      operator: {
        write(message) {
          progress.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(progress.slice(0, -1), [
    "issue-9: implement",
    "issue-9: review round 1",
    "issue-9: fix review round 1",
    "issue-9: review round 2",
  ]);
});

test("a retried CI repair prints its phase once per start", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const implementation = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  const repair = {
    sha: "c".repeat(40),
    message: "fix: required checks",
  };
  const progress: string[] = [];
  let branch = "";
  let checks = 0;
  let repairAttempts = 0;
  let merged = false;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
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
            clean: true,
            commits: base === implementation.sha ? [repair] : [implementation],
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          if (input.promptArgs.FAILED_CHECKS === undefined)
            return delivery.agentExecutor.execute!(input);
          repairAttempts += 1;
          if (repairAttempts === 1)
            return {
              outcome: "blocked",
              summary: "repair needs recovery",
              commits: [],
              checks: [],
              blocker: "repair needs recovery",
            };
          return {
            outcome: "committed",
            summary: "fixed required checks",
            commits: [repair],
            checks: [],
            blocker: null,
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          return { number: 41, url: "https://example.test/pull/41" };
        },
        async getRequiredChecks() {
          checks += 1;
          return checks === 1
            ? [
                {
                  name: "checks",
                  state: "FAILURE",
                  link: "https://example.test/checks/1",
                  bucket: "fail",
                },
              ]
            : [];
        },
        async getPullRequest() {
          return {
            headSha: implementation.sha,
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
        write(message) {
          progress.push(message);
        },
        async pause() {
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(progress.slice(0, -1), [
    "issue-9: implement",
    "issue-9: ci repair",
    "issue-9: ci repair retry",
  ]);
});

test("Documentation Maintenance prints its issue and phase", async () => {
  const root = await createProject();
  const progress: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--document"],
    createCliDependencies(root, {
      operator: {
        write(message) {
          progress.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(progress.slice(0, -1), ["issue-1000: doc maintain"]);
});

test("concurrent progress stays associated with its issue", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10);
  const progress: string[] = [];
  const executed: number[] = [];
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      agentExecutor: {
        async execute(input) {
          executed.push(input.ticket);
          started += 1;
          if (started === 2) release();
          await bothStarted;
          return delivery.agentExecutor.execute(input);
        },
      },
      operator: {
        write(message) {
          progress.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  const starts = progress.slice(0, -1);
  assert.equal(starts.length, executed.length);
  assert.deepEqual(
    starts.map((line) => line.replace("issue-", "").replace(": implement", "")),
    executed.map(String),
  );
  assert.ok(starts.includes("issue-9: implement"));
  assert.ok(starts.includes("issue-10: implement"));
});
