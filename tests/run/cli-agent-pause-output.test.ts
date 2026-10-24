import assert from "node:assert/strict";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createAttemptTracker,
  createCliDependencies,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";

test.afterEach(cleanupTempRoots);

test("blocked Agent Pause shows the decision without diagnostic metadata", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const pauses: string[] = [];
  let worktree = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          worktree = input.worktree;
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "blocked",
            summary: "the implementation cannot proceed",
            commits: [
              {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                message: "forbidden commit claim",
              },
            ],
            checks: [
              {
                command: "forbidden check",
                status: "failed",
                details: "forbidden check details",
              },
            ],
            blocker: "API contract is unresolved\nSecond line",
            diagnostics: {
              sessionId: "session-123",
              model: "forbidden-model",
              runId: "forbidden-run",
              agentAttemptId: "forbidden-attempt",
              assistantReply: "forbidden assistant reply",
              error: "forbidden execution error",
              diagnosticLogPath: "/forbidden/diagnostic.log",
            },
          };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pauses.length, 1);
  const message = pauses[0]!;
  assert.match(message, /^Outcome: blocked$/mu);
  assert.match(message, /^Reason: API contract is unresolved Second line$/mu);
  assert.match(message, /^Provider session: session-123$/mu);
  assert.ok(
    message.includes(`Resume command: codex resume -C ${worktree} session-123`),
  );
  assert.match(
    message,
    /^Actions: Enter to continue, q to cancel, or provide recovery instructions\.$/mu,
  );
  for (const omitted of [
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "forbidden commit claim",
    "forbidden check",
    "forbidden-model",
    "forbidden-run",
    "forbidden-attempt",
    "forbidden assistant reply",
    "the implementation cannot proceed",
    "/forbidden/diagnostic.log",
  ])
    assert.equal(message.includes(omitted), false, omitted);
});

test("Agent Pause falls back from a missing blocker to a one-line summary", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const pauses: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "blocked",
            summary: "the Agent needs\nmore context",
            commits: [],
            checks: [],
            blocker: null,
            diagnostics: {
              error: "lower-priority execution error",
            },
          };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pauses.length, 1);
  assert.match(pauses[0]!, /^Reason: the Agent needs more context$/mu);
  assert.equal(pauses[0]!.includes("lower-priority execution error"), false);
});

test("failed Agent Pause labels the failure and falls back to its diagnostic log", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const pauses: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute() {
          throw new Error("Sandcastle failed\nwith process detail");
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pauses.length, 1);
  const message = pauses[0]!;
  assert.match(message, /^Outcome: failed$/mu);
  assert.match(message, /^Reason: Sandcastle failed with process detail$/mu);
  assert.match(message, /^Provider session: unavailable$/mu);
  assert.match(message, /^Resume command: unavailable$/mu);
  assert.match(message, /^Diagnostic log: .+agent-9-.+\.log$/mu);
  assert.match(
    message,
    /^Actions: Enter to continue, q to cancel, or provide recovery instructions\.$/mu,
  );
});

test("non-retryable Agent Pause keeps the full decision summary and its accepted actions", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const pauses: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute() {
          throw Object.assign(new Error("provider session was lost"), {
            diagnostics: {
              retryable: false,
              sessionId: "session-456",
            },
          });
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pauses.length, 1);
  const message = pauses[0]!;
  assert.match(message, /^Outcome: failed$/mu);
  assert.match(message, /^Reason: provider session was lost$/mu);
  assert.match(message, /^Provider session: session-456$/mu);
  assert.match(message, /^Resume command: codex resume -C .+ session-456$/mu);
  assert.match(
    message,
    /^Actions: Enter to retry, q to cancel, or supply a trusted result\.$/mu,
  );
});
