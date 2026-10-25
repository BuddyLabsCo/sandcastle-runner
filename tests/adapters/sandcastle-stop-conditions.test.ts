import assert from "node:assert/strict";
import test from "node:test";

import { StructuredOutputError, type RunOptions } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { ProcessCleanupError } from "../../src/adapters/process-settlement.ts";
import { OperatorCancelled } from "../../src/run/operations.ts";
import {
  committed,
  input,
  result as makeResult,
} from "../support/sandcastle.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Settlement = { outcome: "settled" } | { outcome: "failed"; error: string };
type SettleableSandbox = RunOptions["sandbox"] & {
  settle(): Promise<Settlement>;
};

function settleable(options: RunOptions): SettleableSandbox {
  return options.sandbox as SettleableSandbox;
}

test("cancellation after session probing prevents substantive execution", async () => {
  const controller = new AbortController();
  const probeStarted = deferred();
  const releaseProbe = deferred();
  const prompts: string[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(String(options.prompt));
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        probeStarted.resolve();
        await releaseProbe.promise;
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      throw new Error("substantive invocation must not start");
    },
    async () => {},
    async () => {},
    async () => {},
  );

  const execution = executor.execute({
    ...input(),
    signal: controller.signal,
  });
  await probeStarted.promise;
  controller.abort(new OperatorCancelled("operator cancelled"));
  releaseProbe.resolve();

  await assert.rejects(
    execution,
    (error) => error instanceof OperatorCancelled,
  );
  assert.equal(prompts.length, 1);
});

test("cancellation during probe backoff prevents another probe", async () => {
  const controller = new AbortController();
  let probes = 0;
  let waits = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        probes += 1;
        throw new Error("probe failed");
      }
      throw new Error("substantive invocation must not start");
    },
    async () => {
      waits += 1;
      controller.abort(new OperatorCancelled("operator cancelled"));
    },
    async () => {},
    async () => {},
  );

  await assert.rejects(
    executor.execute({ ...input(), signal: controller.signal }),
    (error) => error instanceof OperatorCancelled,
  );
  assert.equal(probes, 1);
  assert.equal(waits, 1);
});

test("timeout prevents a settled substantive result from being accepted", async () => {
  let substantiveCalls = 0;
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
      substantiveCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    executor.execute({ ...input(), timeoutMs: 1 }),
    (error) => {
      const failure = error as Error & {
        diagnostics?: { sessionId?: string };
      };
      assert.match(failure.message, /Agent Attempt timed out/u);
      assert.equal(failure.diagnostics?.sessionId, "probe-session");
      return true;
    },
  );
  assert.equal(substantiveCalls, 1);
});

test("timeout after operator continuation reports the timeout", async () => {
  let taskCalls = 0;
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
      taskCalls += 1;
      if (taskCalls === 1)
        return makeResult(
          `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
          committed,
        );
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () =>
            reject(
              options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("timed out"),
            ),
          { once: true },
        );
      });
    },
    async () => {},
    async () => {},
    async () => {},
  );

  await executor.execute(input());
  await assert.rejects(
    executor.execute({
      ...input(),
      resumePrompt: "operator instruction",
      timeoutMs: 1,
    }),
    /Agent Attempt timed out/u,
  );
  assert.equal(taskCalls, 2);
});

test("cancellation during missing-output backoff prevents continuation", async () => {
  const controller = new AbortController();
  let substantiveCalls = 0;
  let waits = 0;
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
      substantiveCalls += 1;
      return makeResult("No structured result.", committed);
    },
    async () => {
      waits += 1;
      controller.abort(new OperatorCancelled("operator cancelled"));
    },
    async () => {},
    async () => {},
  );

  await assert.rejects(
    executor.execute({ ...input(), signal: controller.signal }),
    (error) => error instanceof OperatorCancelled,
  );
  assert.equal(substantiveCalls, 1);
  assert.equal(waits, 1);
});

test("cancellation during process-failure backoff prevents continuation", async () => {
  const controller = new AbortController();
  let substantiveCalls = 0;
  let waits = 0;
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
      substantiveCalls += 1;
      throw new Error("execution failed");
    },
    async () => {
      waits += 1;
      controller.abort(new OperatorCancelled("operator cancelled"));
    },
    async () => {},
    async () => {},
  );

  await assert.rejects(
    executor.execute({ ...input(), signal: controller.signal }),
    (error) => error instanceof OperatorCancelled,
  );
  assert.equal(substantiveCalls, 1);
  assert.equal(waits, 1);
});

test("cancellation during structured-output backoff prevents correction", async () => {
  const controller = new AbortController();
  let substantiveCalls = 0;
  let waits = 0;
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
      substantiveCalls += 1;
      throw new StructuredOutputError("invalid structured output", {
        tag: "agent_attempt_result",
        rawMatched: "{}",
        cause: [{ message: "outcome is required" }],
        commits: [],
        branch: input().branch,
        sessionId: "session-id",
      });
    },
    async () => {
      waits += 1;
      controller.abort(new OperatorCancelled("operator cancelled"));
    },
    async () => {},
    async () => {},
  );

  await assert.rejects(
    executor.execute({ ...input(), signal: controller.signal }),
    (error) => error instanceof OperatorCancelled,
  );
  assert.equal(substantiveCalls, 1);
  assert.equal(waits, 1);
});

test("total deadline expires during structured-output correction", async () => {
  let substantiveCalls = 0;
  let waits = 0;
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
      substantiveCalls += 1;
      throw new StructuredOutputError("invalid structured output", {
        tag: "agent_attempt_result",
        rawMatched: "{}",
        cause: [{ message: "outcome is required" }],
        commits: [],
        branch: input().branch,
        sessionId: "session-id",
      });
    },
    async () => {
      waits += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    async () => {},
    async () => {},
  );

  await assert.rejects(
    executor.execute({ ...input(), timeoutMs: 1 }),
    (error) => {
      const failure = error as Error & {
        diagnostics?: { sessionId?: string };
      };
      assert.match(failure.message, /Agent Attempt timed out/u);
      assert.equal(failure.diagnostics?.sessionId, "session-id");
      return true;
    },
  );
  assert.equal(substantiveCalls, 1);
  assert.equal(waits, 1);
});

test("cancellation cannot be bypassed by recovered structured output", async () => {
  const controller = new AbortController();
  let substantiveCalls = 0;
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
      substantiveCalls += 1;
      throw new StructuredOutputError("invalid structured output", {
        tag: "agent_attempt_result",
        rawMatched: JSON.stringify(committed),
        cause: [{ message: "retry exhausted" }],
        commits: committed.commits,
        branch: input().branch,
        sessionId: "session-id",
      });
    },
    async () => {},
    async () => {},
    async (_logFile, message) => {
      if (message.startsWith("Recovered the final structured output"))
        controller.abort(new OperatorCancelled("operator cancelled"));
    },
  );

  await assert.rejects(
    executor.execute({
      ...input(),
      signal: controller.signal,
      retryPolicy: {
        operationRetry: 4,
        agentRetry: 0,
        operationRetryDelay: [10, 20, 40, 80],
        agentRetryDelay: [10, 20, 40, 80],
      },
    }),
    (error) => error instanceof OperatorCancelled,
  );
  assert.equal(substantiveCalls, 1);
});

test("cancellation waits for owned-process settlement", async () => {
  const controller = new AbortController();
  const substantiveStarted = deferred();
  const cleanupStarted = deferred();
  const cleanupResult = deferred();
  let substantiveCalls = 0;
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
      substantiveCalls += 1;
      settleable(options).settle = async () => {
        cleanupStarted.resolve();
        await cleanupResult.promise;
        return { outcome: "settled" };
      };
      substantiveStarted.resolve();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () =>
            reject(
              options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("cancelled"),
            ),
          { once: true },
        );
      });
    },
    async () => {},
    async () => {},
    async () => {},
  );

  const execution = executor.execute({
    ...input(),
    signal: controller.signal,
  });
  await substantiveStarted.promise;
  controller.abort(new OperatorCancelled("operator cancelled"));
  await cleanupStarted.promise;
  const observed = execution.then(
    () => "resolved",
    (error: unknown) => error,
  );
  assert.equal(
    await Promise.race([observed, Promise.resolve("pending")]),
    "pending",
  );

  cleanupResult.resolve();
  assert.ok((await observed) instanceof OperatorCancelled);
  assert.equal(substantiveCalls, 1);
});

test("cancellation surfaces failed cleanup without retrying the agent", async () => {
  const controller = new AbortController();
  const substantiveStarted = deferred();
  let substantiveCalls = 0;
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
      substantiveCalls += 1;
      settleable(options).settle = async () => ({
        outcome: "failed",
        error: "agent process remains alive",
      });
      substantiveStarted.resolve();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () =>
            reject(
              options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("cancelled"),
            ),
          { once: true },
        );
      });
    },
    async () => {},
    async () => {},
    async () => {},
  );

  const execution = executor.execute({
    ...input(),
    signal: controller.signal,
  });
  await substantiveStarted.promise;
  controller.abort(new OperatorCancelled("operator cancelled"));

  await assert.rejects(execution, (error) => {
    assert.ok(error instanceof ProcessCleanupError);
    assert.match(error.message, /cleanup failed/iu);
    return true;
  });
  assert.equal(substantiveCalls, 1);
});
