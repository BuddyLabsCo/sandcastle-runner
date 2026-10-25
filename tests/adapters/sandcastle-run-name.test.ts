import assert from "node:assert/strict";
import test from "node:test";

import { type RunOptions } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  committed,
  input,
  result as makeResult,
} from "../support/sandcastle.ts";

test("SandcastleAgentExecutor passes native run names and reuses the probed session", async () => {
  const calls: RunOptions[] = [];
  let taskCalls = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      calls.push(options);
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      taskCalls += 1;
      return taskCalls === 1
        ? makeResult("No structured result.", committed)
        : makeResult(
            `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
            committed,
          );
    },
    async () => {},
    async () => {},
    async () => {},
  );

  await executor.execute(input());

  assert.deepEqual(
    calls.map(({ name, resumeSession }) => [name, resumeSession]),
    [
      ["implement issue 9", undefined],
      ["implement issue 9", "probe-session"],
      ["implement issue 9", "session-id"],
    ],
  );
});
