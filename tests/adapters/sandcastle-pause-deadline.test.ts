import assert from "node:assert/strict";
import test from "node:test";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { RunCoordination } from "../../src/run/run-coordination.ts";
import {
  committed,
  input,
  result as makeResult,
} from "../support/sandcastle.ts";

for (const firstLaunch of [true, false]) {
  test(`the substantive deadline ${firstLaunch ? "excludes the initial pause" : "includes later continuation pauses"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const coordination = new RunCoordination(new AbortController());
    let releaseIntervention!: () => void;
    let reachedGate!: () => void;
    const gated = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let gates = 0;
    let substantiveCalls = 0;
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        if (options.prompt === "Reply with exactly: SESSION_READY") {
          if (firstLaunch) releaseIntervention = coordination.intervene();
          return {
            iterations: [{ sessionId: "probe-session" }],
            stdout: "SESSION_READY",
            commits: [],
            branch: input().branch,
            output: undefined,
          };
        }
        substantiveCalls += 1;
        if (!firstLaunch) {
          releaseIntervention = coordination.intervene();
          return makeResult("missing structured output", committed);
        }
        return makeResult(
          `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
          committed,
        );
      },
      async () => {},
      async () => {},
      async () => {},
    );
    const execution = executor.execute({
      ...input(),
      timeoutMs: 30,
      advance(action) {
        gates += 1;
        if (gates === (firstLaunch ? 2 : 3)) reachedGate();
        return coordination.advance(action);
      },
    });
    await gated;
    t.mock.timers.tick(150);
    releaseIntervention();
    if (firstLaunch) {
      assert.equal((await execution).outcome, "committed");
      assert.equal(substantiveCalls, 1);
    } else {
      await assert.rejects(execution, /Agent Attempt timed out/u);
      assert.equal(substantiveCalls, 1);
    }
  });
}
