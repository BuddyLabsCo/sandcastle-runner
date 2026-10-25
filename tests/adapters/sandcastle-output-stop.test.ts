import assert from "node:assert/strict";
import test from "node:test";

import { StructuredOutputError } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { OperatorCancelled } from "../../src/run/operations.ts";
import { input } from "../support/sandcastle.ts";

for (const stop of ["cancellation", "timeout"] as const) {
  test(`${stop} during exhausted output recovery takes precedence over validation`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
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
          rawMatched: "{}",
          cause: [{ message: "outcome is required" }],
          commits: [],
          branch: input().branch,
          sessionId: "session-id",
        });
      },
      async () => {},
      async () => {},
      async (_logFile, message) => {
        if (!message.startsWith("Structured output validation failed")) return;
        if (stop === "cancellation")
          controller.abort(new OperatorCancelled("operator cancelled"));
        else t.mock.timers.tick(1);
      },
    );

    await assert.rejects(
      executor.execute({
        ...input(),
        signal: controller.signal,
        timeoutMs: 1,
        retryPolicy: { ...input().retryPolicy, agentRetry: 0 },
      }),
      (error) => {
        if (stop === "cancellation")
          assert.ok(error instanceof OperatorCancelled);
        else assert.match((error as Error).message, /Agent Attempt timed out/u);
        return true;
      },
    );
    assert.equal(substantiveCalls, 1);
  });
}
