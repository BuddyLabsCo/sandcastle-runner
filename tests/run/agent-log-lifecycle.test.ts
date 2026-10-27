import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import type { Ticket } from "../../src/run/contracts.ts";
import {
  createCliDependencies,
  createAttemptTracker,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("implementation and review logs are stage-named and removed on success", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.review = true;
  await writeProjectConfig(
    path.join(root, "projects/demo/config.yaml"),
    config,
  );
  const delivery = createCommittedDelivery(9);
  const implementation = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  const logPaths: string[] = [];
  const logs = path.join(root, "projects/demo/logs");
  await mkdir(logs, { recursive: true });
  const unrelatedMarkdown = path.join(logs, "review-9-notes-round-1.md");
  await writeFile(unrelatedMarkdown, "keep Markdown");
  const historicalLog = path.join(logs, "agent-9-historical.log");
  await writeFile(historicalLog, "keep");

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async readReviewStandards() {
          return [];
        },
        async inspectReview() {
          return {
            clean: true,
            deliveryCommits: [implementation],
            reviewCommits: [],
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          logPaths.push(input.logFile);
          await writeFile(input.logFile, "implementation attempt");
          return delivery.agentExecutor.execute!(input);
        },
        async executeReview(input) {
          await access(logPaths[0]!);
          logPaths.push(input.logFile);
          await writeFile(input.logFile, "review attempt");
          return {
            outcome: "passed",
          };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.match(path.basename(logPaths[0]!), /^implement-9-.+\.log$/u);
  assert.match(path.basename(logPaths[1]!), /^review-9-.+\.log$/u);
  await Promise.all(
    logPaths.map((filename) => assert.rejects(access(filename))),
  );
  assert.equal(await readFile(historicalLog, "utf8"), "keep");
  assert.equal(await readFile(unrelatedMarkdown, "utf8"), "keep Markdown");
});

test("a cancelled implementation retains its log while paused", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  let logFile = "";
  let logExistedAtPause = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: {
        async execute(input) {
          logFile = input.logFile;
          await writeFile(logFile, "failed attempt");
          throw new Error("Sandcastle failed");
        },
      },
      operator: {
        async pause() {
          await access(logFile);
          logExistedAtPause = true;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(logExistedAtPause, true);
  assert.match(path.basename(logFile), /^implement-9-.+\.log$/u);
  assert.equal(await readFile(logFile, "utf8"), "failed attempt");
});

test("a resumed attempt reuses its owning stage log", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const logPaths: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: {
        async execute(input) {
          logPaths.push(input.logFile);
          await writeFile(input.logFile, `invocation ${logPaths.length}`);
          if (logPaths.length === 1) throw new Error("Sandcastle failed");
          return delivery.agentExecutor.execute!(input);
        },
      },
      operator: {
        async pause() {
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(logPaths.length, 2);
  assert.equal(logPaths[0], logPaths[1]);
  await assert.rejects(access(logPaths[0]!));
});

test("a log deletion failure is audited without failing a successful Run", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  let logFile = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: {
        async execute(input) {
          logFile = input.logFile;
          await mkdir(logFile);
          return delivery.agentExecutor.execute!(input);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  const cleanupFailure = (await readFile(result.logPath!, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find(
      (event) =>
        event.phase === "implement" &&
        event.operation === "delete_agent_log" &&
        event.result === "failed",
    );
  assert.ok(cleanupFailure);
  assert.equal(cleanupFailure.diagnosticLogPath, logFile);
  assert.notEqual(cleanupFailure.error, "");
});

test("a successful CI repair retry removes superseded ci logs", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  const repair = {
    sha: "c".repeat(40),
    message: "fix: checks",
  };
  const ciLogs: string[] = [];
  let branch = "";
  let agentCalls = 0;
  let checkReads = 0;
  let headSha = implementation.sha;
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
            commits:
              agentCalls >= 3
                ? [repair]
                : agentCalls === 1
                  ? [implementation]
                  : [],
            clean: true,
          };
        },
        async push() {
          headSha = repair.sha;
        },
      },
      agentExecutor: {
        async execute(input) {
          agentCalls += 1;
          if (input.runName.startsWith("fix ci")) {
            ciLogs.push(input.logFile);
            await writeFile(input.logFile, input.runName);
          }
          if (agentCalls === 1) {
            return {
              outcome: "committed",
              summary: implementation.message,
              commits: [implementation],
              checks: [],
              blocker: null,
              pr_title: "feat: implementation",
              pr_body: "Implementation body.",
            };
          }
          if (agentCalls === 2) {
            return {
              outcome: "no_change",
              summary: "first repair made no change",
              commits: [],
              checks: [],
              blocker: null,
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          return {
            outcome: "committed",
            summary: repair.message,
            commits: [repair],
            checks: [],
            blocker: null,
            pr_title: "unused",
            pr_body: "unused",
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          return { number: 41, url: "https://example.test/pull/41" };
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
            headSha,
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
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(ciLogs.length, 2);
  assert.notEqual(ciLogs[0], ciLogs[1]);
  assert.ok(
    ciLogs.every((filename) => /^ci-9-.+\.log$/u.test(path.basename(filename))),
  );
  await Promise.all(ciLogs.map((filename) => assert.rejects(access(filename))));
});

test("a successful conflict repair uses and removes a merge log", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  const repair = {
    sha: "c".repeat(40),
    message: "fix: conflict",
  };
  const targetBase = "e".repeat(40);
  let branch = "";
  let agentCalls = 0;
  let fetches = 0;
  let headSha = implementation.sha;
  let mergeRequests = 0;
  let merged = false;
  let mergeLog = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          fetches += 1;
          return fetches === 1 ? "a".repeat(40) : targetBase;
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base, requiredAncestor }) {
          assert.equal(
            requiredAncestor,
            agentCalls === 2 ? targetBase : undefined,
          );
          return {
            worktree,
            branch,
            base,
            commits: agentCalls === 1 ? [implementation] : [repair],
            clean: true,
          };
        },
        async push() {
          headSha = repair.sha;
        },
      },
      agentExecutor: {
        async execute(input) {
          agentCalls += 1;
          if (agentCalls === 1) {
            return {
              outcome: "committed",
              summary: implementation.message,
              commits: [implementation],
              checks: [],
              blocker: null,
              pr_title: "feat: implementation",
              pr_body: "Implementation body.",
            };
          }
          mergeLog = input.logFile;
          await writeFile(mergeLog, "conflict repair");
          return {
            outcome: "committed",
            summary: repair.message,
            commits: [repair],
            checks: [],
            blocker: null,
            pr_title: "unused",
            pr_body: "unused",
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          return { number: 41, url: "https://example.test/pull/41" };
        },
        async getRequiredChecks() {
          return [];
        },
        async getPullRequest() {
          return {
            headSha,
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          if (mergeRequests === 1)
            return { outcome: "conflict", error: "conflict in src/run.ts" };
          merged = true;
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.match(path.basename(mergeLog), /^merge-9-.+\.log$/u);
  await assert.rejects(access(mergeLog));
});

test("documentation maintenance uses a doc-stage log", async () => {
  const root = await createProject();
  const maintenance: Ticket = {
    number: 100,
    state: "open",
    stateReason: null,
    assignees: [],
    labels: ["doc-maintain"],
  };
  let branch = "";
  let docLog = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--document"],
    createCliDependencies(root, {
      tracker: {
        async getTicket() {
          return maintenance;
        },
        async createMaintenanceTicket() {
          return maintenance;
        },
        async closeTicket() {
          maintenance.state = "closed";
          maintenance.stateReason = "completed";
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
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
          docLog = input.logFile;
          await writeFile(docLog, "documentation attempt");
          return {
            outcome: "no_change",
            summary: "documentation is current",
            commits: [],
            checks: [],
            blocker: null,
          };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.match(path.basename(docLog), /^doc-100-.+\.log$/u);
  await assert.rejects(access(docLog));
});
