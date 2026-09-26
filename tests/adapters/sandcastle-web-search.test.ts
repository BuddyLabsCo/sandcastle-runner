import assert from "node:assert/strict";
import test from "node:test";

import type { RunOptions } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  committed,
  input,
  object,
  reviewInput,
} from "../support/sandcastle.ts";

for (const disableWebSearch of [true, false, undefined]) {
  test(`Sandcastle preserves web search policy ${disableWebSearch} across implementation and review sessions`, async () => {
    const calls: RunOptions[] = [];
    const review = {
      outcome: "passed",
      summary: "Both axes pass.",
      standards: { verdict: "passed", unresolved_findings: [] },
      spec: { verdict: "passed", unresolved_findings: [] },
      checks: [],
      blocker: null,
    };
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        calls.push(options);
        const probe = options.prompt === "Reply with exactly: SESSION_READY";
        const tag = probe ? undefined : String(object(options.output).tag);
        const output = probe
          ? undefined
          : tag === "review_attempt_result"
            ? review
            : committed;
        return {
          iterations: [{ sessionId: probe ? "probe-session" : "session-id" }],
          stdout: probe
            ? "SESSION_READY"
            : `<${tag}>${JSON.stringify(output)}</${tag}>`,
          commits: [],
          branch: input().branch,
          output,
        };
      },
      async () => {},
      async () => {},
      async () => {},
      disableWebSearch,
      async () => {},
    );

    assert.deepEqual(await executor.execute(input()), committed);
    assert.deepEqual(
      await executor.execute({
        ...input(),
        resumePrompt: "Continue implementation",
      }),
      committed,
    );
    const reviewAttempt = { ...reviewInput(), logFile: "/runner/review.log" };
    assert.deepEqual(await executor.executeReview(reviewAttempt), review);
    assert.deepEqual(
      await executor.executeReview({
        ...reviewAttempt,
        resumePrompt: "Continue review",
      }),
      review,
    );
    assert.deepEqual(
      calls.map(({ resumeSession }) => resumeSession),
      [
        undefined,
        "probe-session",
        "session-id",
        undefined,
        "probe-session",
        "session-id",
      ],
    );

    for (const options of calls) {
      const generated = options.agent.buildPrintCommand({
        prompt: String(options.prompt),
        dangerouslySkipPermissions: true,
        ...(options.resumeSession === undefined
          ? {}
          : { resumeSession: options.resumeSession }),
      });
      const override = ` -c 'web_search="disabled"'`;
      assert.equal(
        generated.command.includes(override),
        disableWebSearch === true,
      );
      const resume =
        options.resumeSession === undefined
          ? ""
          : ` resume '${options.resumeSession}'`;
      assert.equal(
        generated.command.replace(override, ""),
        `codex exec${resume} --json --dangerously-bypass-approvals-and-sandbox -m '${input().model}' -c 'model_reasoning_effort="${input().effort}"'${resume ? " -" : ""}`,
      );
      assert.equal(generated.stdin, options.prompt);
      assert.equal(options.sandbox.name, "no-sandbox");
      assert.deepEqual(options.sandbox.env, {
        GIT_CONFIG_GLOBAL: input().gitConfigGlobal,
      });
    }
  });
}
