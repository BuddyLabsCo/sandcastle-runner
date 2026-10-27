import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { StructuredOutputError } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { committed, result as agentResult } from "../support/sandcastle.ts";
import { executeCli } from "../../src/cli.ts";
import {
  createCliDependencies,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import { readRecoverySnapshot, recoveryPaths } from "../../src/recovery.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an Operator Pause retains a concurrent success and its logs before verification or delivery", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10);
  const bothStarted = deferred();
  const completeOther = deferred();
  const otherCompleted = deferred();
  const calls: number[] = [];
  const effects: string[] = [];
  let retainedLog = "";
  let effectsDuringPause: string[] = [];
  let callsDuringPause: number[] = [];
  let retainedOutput = "";
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async inspect(input) {
          effects.push(`inspect:${input.worktree.split("-").at(-1)}`);
          return delivery.gitWorkspace.inspect(input);
        },
        async push() {
          effects.push("push");
        },
      },
      agentExecutor: {
        async execute(input) {
          calls.push(input.ticket);
          if (calls.length === 2) bothStarted.resolve();
          await bothStarted.promise;
          if (input.ticket === 9 && input.resumePrompt === undefined)
            return {
              outcome: "blocked",
              summary: "needs instructions",
              commits: [],
              checks: [],
              blocker: "needs instructions",
            };
          if (input.ticket === 10) {
            retainedLog = input.logFile;
            await writeFile(retainedLog, "original successful invocation\n");
            await completeOther.promise;
            otherCompleted.resolve();
          }
          return delivery.agentExecutor.execute(input);
        },
      },
      operator: {
        async pause() {
          completeOther.resolve();
          await otherCompleted.promise;
          // Drain asynchronous local cleanup while the human prompt stays open.
          for (let turn = 0; turn < 100; turn += 1) await setImmediate();
          effectsDuringPause = [...effects];
          callsDuringPause = [...calls];
          retainedOutput = await readFile(retainedLog, "utf8").catch(
            () => "deleted",
          );
          return "continue ticket 9";
        },
      },
    }),
  );
  assert.deepEqual(effectsDuringPause, []);
  assert.deepEqual(
    [...callsDuringPause].sort((a, b) => a - b),
    [9, 10],
  );
  assert.equal(retainedOutput, "original successful invocation\n");
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(
    [...calls].sort((a, b) => a - b),
    [9, 9, 10],
  );
  assert.equal(effects.filter((effect) => effect === "inspect:10").length, 1);
  assert.deepEqual(
    result.summary.handoffs?.map(({ ticket }) => ticket),
    [9, 10],
  );
});

for (const response of ["recover ticket 10", "", "s", "q", null]) {
  test(`competing pauses retain the original failure and isolate responses (${String(response)})`, async () => {
    const root = await createProject();
    const delivery = createCommittedBatch(9, 10);
    const bothStarted = deferred();
    const calls: { ticket: number; prompt: string | undefined }[] = [];
    const messages: string[] = [];
    const effects: number[] = [];
    let activePrompts = 0;
    let maxActivePrompts = 0;
    let callsWhileSecondPaused: typeof calls = [];
    let independentOutcome = "";
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: delivery.tracker,
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async inspect(input) {
            effects.push(Number(input.worktree.split("-").at(-1)));
            return delivery.gitWorkspace.inspect(input);
          },
        },
        agentExecutor: {
          async execute(input) {
            calls.push({ ticket: input.ticket, prompt: input.resumePrompt });
            if (calls.length === 2) bothStarted.resolve();
            await bothStarted.promise;
            if (input.resumePrompt !== undefined)
              return delivery.agentExecutor.execute(input);
            if (input.ticket === 9)
              return {
                outcome: "blocked",
                summary: "original blocker 9",
                commits: [],
                checks: [],
                blocker: "original blocker 9",
                diagnostics: { provider: "codex", sessionId: "session-9" },
              };
            throw Object.assign(new Error("original failure 10"), {
              diagnostics: { provider: "codex", sessionId: "session-10" },
            });
          },
        },
        operator: {
          async pause(message) {
            activePrompts += 1;
            maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
            messages.push(message);
            const ticket = message.includes("session-9") ? 9 : 10;
            try {
              if (messages.length === 1) return `recover ticket ${ticket}`;
              // Another Run completes while both invocations in this Run stay gated.
              const independent = await executeCli(
                ["run", "--project", "demo", "--parent", "8"],
                createCliDependencies(await createProject()),
              );
              independentOutcome = independent.summary.outcome;
              callsWhileSecondPaused = [...calls];
              assert.deepEqual(effects, []);
              if (response === null || response === "q") return response;
              return response === "" || response === "s"
                ? response
                : `recover ticket ${ticket}`;
            } finally {
              activePrompts -= 1;
            }
          },
        },
      }),
    );
    assert.equal(messages.length, 2);
    assert.equal(maxActivePrompts, 1);
    assert.equal(independentOutcome, "no_work");
    assert.equal(callsWhileSecondPaused.length, 2);
    assert.ok(
      messages.some((message) => message.includes("original blocker 9")),
    );
    assert.ok(
      messages.some((message) => message.includes("original failure 10")),
    );
    for (const message of messages) {
      assert.match(message, /Invocation: [a-f0-9-]+/u);
      assert.match(message, /Working directory: .*ticket-(9|10)/u);
      assert.match(message, /Diagnostic log: .*implement-(9|10)-/u);
    }
    if (response === null || response === "q") {
      assert.equal(result.summary.outcome, "cancelled");
      assert.equal(calls.length, 2);
      assert.deepEqual(effects, []);
    } else {
      const secondTicket = messages[1]!.includes("session-9") ? 9 : 10;
      assert.equal(
        result.summary.outcome,
        response === "s" ? "incomplete" : "succeeded",
      );
      assert.equal(calls.length, response === "s" ? 3 : 4);
      for (const call of calls.filter(({ prompt }) => prompt !== undefined))
        assert.equal(
          call.prompt,
          response === "" && call.ticket === secondTicket
            ? "continue"
            : `recover ticket ${call.ticket}`,
        );
      assert.deepEqual(
        effects.sort((a, b) => a - b),
        response === "s" ? [secondTicket === 9 ? 10 : 9] : [9, 10],
      );
    }
  });
}

for (const phase of [
  "probe",
  "probe retry",
  "automatic continuation",
  "structured correction",
] as const) {
  test(`Run pause gates ${phase} while retaining in-flight output`, async () => {
    const root = await createProject();
    const delivery = createCommittedBatch(9, 10);
    const otherInFlight = deferred();
    const finishInvocation = deferred();
    const nextStepRequested = deferred();
    const calls: string[] = [];
    const waits: number[] = [];
    let gateCalls = 0;
    let callsDuringPause: string[] = [];
    let started = 0;
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        const probe = options.prompt === "Reply with exactly: SESSION_READY";
        calls.push(probe ? "probe" : "work");
        if ((phase === "probe" || phase === "probe retry") && probe) {
          otherInFlight.resolve();
          await finishInvocation.promise;
          if (phase === "probe retry" && calls.length === 1)
            throw new Error("probe failed");
        }
        if (probe)
          return {
            iterations: [{ sessionId: "session-10" }],
            stdout: "SESSION_READY",
            commits: [],
            branch: "unused",
            output: undefined,
          };
        if (
          (phase === "automatic continuation" ||
            phase === "structured correction") &&
          calls.length === 2
        ) {
          otherInFlight.resolve();
          await finishInvocation.promise;
          if (phase === "structured correction")
            throw new StructuredOutputError("invalid result", {
              tag: "agent_attempt_result",
              rawMatched: '{"outcome":"invalid"}',
              sessionId: "session-10",
              branch: "unused",
              commits: [],
              cause: [{ message: "invalid outcome" }],
            });
          return agentResult("missing output", committed);
        }
        const output = {
          ...committed,
          commits: [{ sha: "0".repeat(40), message: "feat: ticket 10" }],
        };
        return agentResult(
          `<agent_attempt_result>${JSON.stringify(output)}</agent_attempt_result>`,
          output,
        );
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
      async () => {},
      async () => {},
    );
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: delivery.tracker,
        gitWorkspace: delivery.gitWorkspace,
        agentExecutor: {
          async execute(input) {
            started += 1;
            if (input.ticket === 9) {
              if (input.resumePrompt !== undefined)
                return delivery.agentExecutor.execute(input);
              await otherInFlight.promise;
              throw new Error("pause ticket 9");
            }
            return executor.execute({
              ...input,
              advance(action) {
                gateCalls += 1;
                const target =
                  phase === "probe" || phase === "probe retry" ? 2 : 3;
                if (gateCalls === target) nextStepRequested.resolve();
                return input.advance!(action);
              },
            });
          },
        },
        operator: {
          async pause() {
            finishInvocation.resolve();
            await nextStepRequested.promise;
            callsDuringPause = [...calls];
            return "continue ticket 9";
          },
        },
      }),
    );
    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(started, 3);
    assert.deepEqual(
      callsDuringPause,
      phase === "probe" || phase === "probe retry"
        ? ["probe"]
        : ["probe", "work"],
    );
    assert.equal(calls.at(-1), "work");
    assert.deepEqual(waits, phase === "probe" ? [] : [10_000]);
  });
}

test("a CI repair pause gates concurrent publication and cancellation retains its recovery intent", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10);
  const push10Started = deferred();
  const finishPush10 = deferred();
  const effects: string[] = [];
  let effectsWhilePaused: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async push(_worktree, branch) {
          const ticket = Number(branch.split("-").at(-1));
          effects.push(`push:${ticket}`);
          if (ticket === 10) {
            push10Started.resolve();
            await finishPush10.promise;
          }
        },
      },
      agentExecutor: {
        async execute(input) {
          if (input.promptArgs.FAILED_CHECKS === undefined)
            return delivery.agentExecutor.execute(input);
          await push10Started.promise;
          throw new Error("CI repair needs operator help");
        },
      },
      codeHost: {
        async createPullRequest({ branch }) {
          const ticket = Number(branch.split("-").at(-1));
          effects.push(`pr:${ticket}`);
          return {
            number: ticket + 100,
            url: `https://github.com/owner/repo/pull/${ticket + 100}`,
          };
        },
        async getRequiredChecks() {
          return [
            {
              name: "check",
              state: "FAILURE",
              bucket: "fail",
              link: "https://github.com/owner/repo/actions/runs/1",
            },
          ];
        },
        async getPullRequest() {
          return {
            headSha: "9".repeat(40),
            createdAt: "2026-09-09T00:00:00Z",
            merged: false,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          effects.push("merge");
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /CI repair needs operator help/u);
          finishPush10.resolve();
          await executeCli(
            ["run", "--project", "demo", "--parent", "8"],
            createCliDependencies(await createProject()),
          );
          effectsWhilePaused = [...effects];
          return "q";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "cancelled");
  assert.ok(effectsWhilePaused.includes("pr:9"));
  assert.ok(effectsWhilePaused.includes("push:10"));
  assert.ok(!effects.includes("pr:10"));
  assert.ok(!effects.includes("merge"));
  const snapshot = await readRecoverySnapshot(
    recoveryPaths(path.join(root, "projects/demo"), 8).snapshot,
  );
  assert.equal(
    snapshot?.publications?.find(({ ticket }) => ticket === 10)?.phase,
    "pending_pr",
  );
});
