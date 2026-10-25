import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createAttemptTracker,
  createCliDependencies,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import { AgentOutputError } from "../../src/adapters/process-errors.ts";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  agentPauseMessage,
  ticketAgentContinueActions,
  ticketAgentRetryActions,
} from "../../src/run/agent-pause.ts";

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
  assert.match(message, /^Agent: unavailable$/mu);
  assert.match(message, /^Working directory: .+/mu);
  assert.match(message, /^Diagnostic log: \/forbidden\/diagnostic\.log$/mu);
  assert.ok(message.includes(path.basename(worktree)));
  assert.match(
    message,
    /^Actions: Enter to continue, s to skip, q to cancel, or provide recovery instructions\.$/mu,
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
  ])
    assert.equal(message.includes(omitted), false, omitted);
});

test("Agent Pause identifies the selected native agent with session and log availability", () => {
  for (const agent of ["codex", "claude-code", "pi"]) {
    const message = agentPauseMessage(
      "blocked",
      {
        provider: agent,
        sessionId: "session-123",
        workingDirectory: "/diagnostic/worktree",
        diagnosticLogPath: "/runner/logs/agent.log",
      },
      String.raw`C:\Users\O'Brien\work tree`,
      undefined,
      ticketAgentContinueActions,
    );
    assert.match(message, new RegExp(`^Agent: ${agent}$`, "mu"));
    assert.match(message, /^Provider session: session-123$/mu);
    assert.match(
      message,
      /^Working directory: C:\\Users\\O'Brien\\work tree$/mu,
    );
    assert.match(message, /^Diagnostic log: \/runner\/logs\/agent\.log$/mu);
    assert.match(
      message,
      /^Actions: Enter to continue, s to skip, q to cancel, or provide recovery instructions\.$/mu,
    );
    assert.equal(message.includes("Resume command"), false);
    assert.equal(message.includes("codex resume"), false);

    const failed = agentPauseMessage(
      "failed",
      { provider: agent },
      "/runner/worktree",
      undefined,
      ticketAgentRetryActions,
    );
    assert.match(failed, new RegExp(`^Agent: ${agent}$`, "mu"));
    assert.match(failed, /^Provider session: unavailable$/mu);
    assert.match(failed, /^Working directory: \/runner\/worktree$/mu);
    assert.match(failed, /^Diagnostic log: unavailable$/mu);
    assert.match(
      failed,
      /^Actions: Enter to retry, s to skip, q to cancel, or supply a trusted result\.$/mu,
    );
  }
});

test("blocked Agent Pause renders each executed agent from its diagnostics", async () => {
  for (const agent of ["codex", "claude-code", "pi"]) {
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
              summary: "cannot proceed",
              commits: [],
              checks: [],
              blocker: "blocked by policy",
              diagnostics: {
                provider: agent,
                sessionId: `${agent}-session`,
                workingDirectory: `/diagnostic/${agent}`,
                diagnosticLogPath: `/logs/${agent}.log`,
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
    assert.match(message, new RegExp(`^Agent: ${agent}$`, "mu"));
    assert.match(
      message,
      new RegExp(`^Provider session: ${agent}-session$`, "mu"),
    );
    assert.match(message, /^Working directory: .+/mu);
    assert.match(
      message,
      new RegExp(`^Diagnostic log: /logs/${agent}\\.log$`, "mu"),
    );
  }
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
  assert.match(message, /^Agent: unavailable$/mu);
  assert.match(message, /^Working directory: .+/mu);
  assert.match(message, /^Diagnostic log: .+implement-9-.+\.log$/mu);
  assert.match(
    message,
    /^Actions: Enter to continue, s to skip, q to cancel, or provide recovery instructions\.$/mu,
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
              provider: "pi",
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
  assert.match(message, /^Agent: pi$/mu);
  assert.match(message, /^Provider session: session-456$/mu);
  assert.match(message, /^Diagnostic log: .+implement-9-.+\.log$/mu);
  assert.match(
    message,
    /^Actions: Enter to retry, s to skip, q to cancel, or supply a trusted result\.$/mu,
  );
});

test("a timed-out Agent Attempt enters one Operator Pause", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const pauses: string[] = [];
  let agentCalls = 0;

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
          agentCalls += 1;
          throw new AgentOutputError("Agent Attempt timed out", {
            errorCategory: "agent_attempt",
            retryable: true,
            sessionId: "session-789",
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
  assert.equal(agentCalls, 1);
  assert.equal(pauses.length, 1);
  assert.match(pauses[0]!, /^Reason: Agent Attempt timed out$/mu);
  assert.match(
    pauses[0]!,
    /^Actions: Enter to continue, s to skip, q to cancel, or provide recovery instructions\.$/mu,
  );
});

test("exhausted generic session recovery enters one Operator Pause", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const pauses: string[] = [];
  const resumedSessions: unknown[] = [];
  const agentExecutor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: "sandcastle/probe",
          output: undefined,
        };
      }
      resumedSessions.push(options.resumeSession);
      throw new Error("execution failed");
    },
    async () => {},
    async () => {},
    async () => {},
  );

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor,
      operator: {
        async pause(message) {
          pauses.push(message);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(resumedSessions.length, 5);
  assert.ok(resumedSessions.every((session) => session === "probe-session"));
  assert.equal(pauses.length, 1);
  assert.match(pauses[0]!, /^Reason: execution failed$/mu);
  assert.match(pauses[0]!, /^Provider session: probe-session$/mu);
  assert.match(
    pauses[0]!,
    /^Actions: Enter to continue, s to skip, q to cancel, or provide recovery instructions\.$/mu,
  );
});
