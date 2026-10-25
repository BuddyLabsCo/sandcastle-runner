import assert from "node:assert/strict";
import test from "node:test";

import { StructuredOutputError } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  committed,
  createExecutor,
  input,
  result as makeResult,
} from "../support/sandcastle.ts";

test("a probe without a usable session ID never starts substantive work", async () => {
  let substantiveCalls = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        return {
          iterations: [{ sessionId: "   " }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      substantiveCalls += 1;
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async () => {},
    async () => {},
    async () => {},
  );

  await assert.rejects(
    executor.execute({
      ...input(),
      retryPolicy: {
        operationRetry: 0,
        agentRetry: 0,
        operationRetryDelay: [1],
        agentRetryDelay: [1],
      },
    }),
    /Agent session probe failed/u,
  );
  assert.equal(substantiveCalls, 0);
});

test("invalid structured output without a usable session recovers only a validated final payload", async () => {
  let substantiveCalls = 0;
  const waits: number[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      substantiveCalls += 1;
      if (substantiveCalls === 1) {
        throw new StructuredOutputError("invalid structured output", {
          tag: "agent_attempt_result",
          rawMatched: JSON.stringify(committed),
          cause: [{ message: "retry with the same session" }],
          commits: committed.commits,
          branch: input().branch,
          sessionId: "",
        });
      }
      throw new Error("a fresh conversation must not start");
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
  );

  const result = await executor.execute({
    ...input(),
    retryPolicy: {
      operationRetry: 0,
      agentRetry: 1,
      operationRetryDelay: [1],
      agentRetryDelay: [1],
    },
  });
  assert.equal(result.outcome, "committed");
  assert.equal(substantiveCalls, 1);
  assert.deepEqual(waits, []);
});

test("generic invocation failures resume the probed session with the configured delay reused", async () => {
  const invocations: {
    prompt: unknown;
    resumeSession: unknown;
  }[] = [];
  const waits: number[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      invocations.push({
        prompt: options.prompt,
        resumeSession: options.resumeSession,
      });
      if (invocations.length < 3) throw new Error("execution failed");
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
  );

  const result = await executor.execute({
    ...input(),
    retryPolicy: {
      operationRetry: 0,
      agentRetry: 3,
      operationRetryDelay: [1],
      agentRetryDelay: [1],
    },
  });

  assert.equal(result.outcome, "committed");
  assert.equal(invocations.length, 3);
  assert.deepEqual(waits, [1_000, 1_000]);
  assert.equal(invocations[0]?.resumeSession, "probe-session");
  assert.equal(invocations[1]?.resumeSession, "probe-session");
  assert.match(String(invocations[1]?.prompt), /^continue\n\n/u);
  assert.equal(invocations[2]?.resumeSession, "probe-session");
  assert.match(String(invocations[2]?.prompt), /^continue\n\n/u);
});

for (const agentRetry of [0, 2]) {
  test(`generic invocation recovery stops at its ${agentRetry}-retry budget`, async () => {
    let substantiveCalls = 0;
    const waits: number[] = [];
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        if (options.prompt === "Reply with exactly: SESSION_READY") {
          return {
            iterations: [{ sessionId: "probe-session" }],
            stdout: "SESSION_READY",
            commits: [],
            branch: input().branch,
            output: undefined,
          };
        }
        substantiveCalls += 1;
        throw new Error("execution failed");
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
      async () => {},
      async () => {},
    );

    await assert.rejects(
      executor.execute({
        ...input(),
        retryPolicy: {
          operationRetry: 0,
          agentRetry,
          operationRetryDelay: [1],
          agentRetryDelay: [1, 2],
        },
      }),
      (error: unknown) => {
        assert.match((error as Error).message, /^execution failed$/u);
        const diagnostics = (
          error as { diagnostics?: { retryable?: boolean; sessionId?: string } }
        ).diagnostics;
        assert.equal(diagnostics?.retryable, true);
        assert.equal(diagnostics?.sessionId, "probe-session");
        return true;
      },
    );
    assert.equal(substantiveCalls, agentRetry + 1);
    assert.deepEqual(waits, [1_000, 2_000].slice(0, agentRetry));
  });
}

test("a schema-valid result is accepted without interpreting internal failure text", async () => {
  const executor = createExecutor(async () =>
    makeResult(
      `Provider event: HTTP 429 network unavailable\n<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
      committed,
    ),
  );

  const result = await executor.execute(input());
  assert.equal(result.outcome, "committed");
  assert.deepEqual(result.commits, committed.commits);
});
