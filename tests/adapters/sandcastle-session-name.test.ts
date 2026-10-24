import assert from "node:assert/strict";
import test from "node:test";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  committed,
  input,
  result as makeResult,
} from "../support/sandcastle.ts";

for (const renameFails of [false, true]) {
  test(
    renameFails
      ? "SandcastleAgentExecutor warns on naming failure and preserves the probed session"
      : "SandcastleAgentExecutor names the probed session once before tasks and continuations",
    async () => {
      const events: string[] = [];
      const statuses: string[] = [];
      let taskCalls = 0;
      const executor = new SandcastleAgentExecutor(
        async (options) => {
          if (options.prompt === "Reply with exactly: SESSION_READY") {
            events.push("probe");
            return {
              iterations: [{ sessionId: "named-session" }],
              stdout: "SESSION_READY",
              commits: [],
              branch: input().branch,
              output: undefined,
            };
          }
          events.push(`task:${options.resumeSession}`);
          if (++taskCalls === 1) throw new Error("codex exited with code 1");
          return {
            ...makeResult(
              `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
              committed,
            ),
            iterations: [{ sessionId: "named-session" }],
          };
        },
        async () => {},
        async () => {},
        async (_logFile, message) => {
          statuses.push(message);
        },
        async (sessionId, name) => {
          events.push(`name:${sessionId}:${name}`);
          if (renameFails) throw new Error("name unavailable");
        },
      );
      const attempt = { ...input(), sessionName: "implement issue 9" };
      await executor.execute(attempt);
      await executor.execute({
        ...attempt,
        resumePrompt: "continue after operator input",
      });
      const warnings = statuses.filter((message) =>
        message.startsWith("Warning:"),
      );
      assert.equal(warnings.length, renameFails ? 1 : 0);
      if (renameFails)
        assert.match(warnings[0]!, /named-session.*name unavailable/u);
      assert.deepEqual(events, [
        "probe",
        "name:named-session:implement issue 9",
        "task:named-session",
        "task:named-session",
        "task:named-session",
      ]);
    },
  );
}
