import assert from "node:assert/strict";
import test from "node:test";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  committed,
  input,
  reviewInput,
  result as makeResult,
} from "../support/sandcastle.ts";

test("renames a probe session before the substantive prompt", async () => {
  const events: string[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        events.push("probe");
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      events.push(`task:${options.resumeSession ?? "missing"}`);
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async () => {},
    async () => {},
    async () => {},
    async (received, sessionId) => {
      events.push(`rename:${sessionId}:${received.sessionName}`);
    },
  );

  await executor.execute(input());
  assert.deepEqual(events, [
    "probe",
    "rename:probe-session:implement issue 9",
    "task:probe-session",
  ]);
});

test("rename failure is warning-only and preserves the probe session", async () => {
  const statuses: string[] = [];
  let taskSession: string | undefined;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      taskSession = options.resumeSession;
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async () => {},
    async () => {},
    async (_logFile, message) => {
      statuses.push(message);
    },
    async () => {
      throw new Error("app-server unavailable");
    },
  );

  await executor.execute(input());
  assert.equal(taskSession, "probe-session");
  assert.deepEqual(statuses, [
    'Session rename failed for "implement issue 9"; continuing with session probe-session: app-server unavailable',
  ]);
});

test("review sessions use the review issue name", async () => {
  let name = "";
  const review = {
    outcome: "passed" as const,
    summary: "Both axes pass.",
    standards: { verdict: "passed" as const, unresolved_findings: [] },
    spec: { verdict: "passed" as const, unresolved_findings: [] },
    checks: [],
    blocker: null,
  };
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      return {
        iterations: [{ sessionId: "probe-session" }],
        stdout: `<review_attempt_result>${JSON.stringify(review)}</review_attempt_result>`,
        commits: [],
        branch: input().branch,
        output: review,
      };
    },
    async () => {},
    async () => {},
    async () => {},
    async (received) => {
      name = received.sessionName;
    },
  );

  await executor.executeReview(reviewInput());
  assert.equal(name, "review issue 9");
});
