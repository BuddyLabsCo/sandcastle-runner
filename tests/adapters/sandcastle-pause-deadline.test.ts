import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { NoSandboxHandle, RunOptions } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { OperatorCancelled } from "../../src/run/operations.ts";
import { RunCoordination } from "../../src/run/run-coordination.ts";
import type { NoShellSandboxProvider } from "../../src/adapters/no-shell-sandbox.ts";
import {
  committed,
  createExecutor,
  input,
  reviewInput,
  result as makeResult,
} from "../support/sandcastle.ts";

async function drain() {
  for (let turn = 0; turn < 20; turn += 1) await setImmediate();
}

for (const agent of ["codex", "claude-code", "pi", "codebuddy"]) {
  for (const review of [false, true]) {
    test(`${agent} ${review ? "review" : "implementation"} retains a timed-out probe before resuming its original session`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      const complete = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let acknowledge!: () => void;
      const acknowledged = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const calls: RunOptions[] = [];
      const executor = new SandcastleAgentExecutor(
        async (options) => {
          calls.push(options);
          assert.equal(options.idleTimeoutSeconds, Infinity);
          if (options.prompt === "Reply with exactly: SESSION_READY") {
            started();
            await complete;
            return {
              iterations: [{ sessionId: "original-probe" }],
              stdout: "SESSION_READY",
              commits: [],
              branch: "unused",
              output: undefined,
            };
          }
          assert.equal(options.resumeSession, "original-probe");
          const output = review ? { outcome: "passed" } : committed;
          const tag = review ? "review_attempt_result" : "agent_attempt_result";
          return {
            ...makeResult("", committed),
            stdout: `<${tag}>${JSON.stringify(output)}</${tag}>`,
            output,
          };
        },
        async () => {},
        async () => {},
        async () => {},
      );
      const attempt = {
        ...(review ? reviewInput() : input()),
        agent,
        timeoutMs: 100,
        idleTimeoutMs: 10,
        pauseForTimeout: () => acknowledged,
      };
      const execution = review
        ? executor.executeReview(attempt)
        : executor.execute({ ...input(), ...attempt });
      await ready;
      t.mock.timers.tick(10);
      finish();
      await drain();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.signal?.aborted, false);
      acknowledge();
      assert.equal((await execution).outcome, review ? "passed" : "committed");
      assert.equal(calls.length, 2);
    });
  }
}

test("Runner status, prompt, and diagnostic log writes do not renew idle", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "supervision-logs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const causes: string[] = [];
  const executor = createExecutor(async () => {
    started();
    await complete;
    return makeResult(
      `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
      committed,
    );
  });
  const logFile = join(directory, "agent.log");
  const execution = executor.execute({
    ...input(),
    logFile,
    idleTimeoutMs: 10,
    pauseForTimeout: async (cause) => {
      causes.push(cause);
    },
  });
  await ready;
  for (const message of [
    "Runner status",
    "Runner prompt",
    "Runner diagnostic",
  ]) {
    t.mock.timers.tick(3);
    await appendFile(logFile, `${message}\n`);
  }
  assert.deepEqual(causes, []);
  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(causes, ["idle"]);
  finish();
  assert.equal((await execution).outcome, "committed");
});

test("invocation thresholds exclude time waiting for the launch gate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const coordination = new RunCoordination(new AbortController());
  const release = coordination.intervene();
  let calls = 0;
  let pauses = 0;
  const executor = createExecutor(async () => {
    calls += 1;
    return makeResult(
      `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
      committed,
    );
  });
  const execution = executor.execute({
    ...input(),
    timeoutMs: 30,
    idleTimeoutMs: 10,
    advance: (action) => coordination.advance(action),
    pauseForTimeout: async () => {
      pauses += 1;
    },
  });
  await drain();
  t.mock.timers.tick(150);
  assert.equal(calls, 0);
  assert.equal(pauses, 0);
  release();
  assert.equal((await execution).outcome, "committed");
  assert.equal(calls, 1);
  assert.equal(pauses, 0);
});

test("Enter grants repeated full idle windows while overall time remains cumulative and notifies once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const causes: string[] = [];
  const acknowledgements: (() => void)[] = [];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let active: RunOptions | undefined;
  const executor = createExecutor(async (options) => {
    active = options;
    started();
    await completed;
    return makeResult(
      `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
      committed,
    );
  });
  const execution = executor.execute({
    ...input(),
    timeoutMs: 35,
    idleTimeoutMs: 10,
    pauseForTimeout(cause) {
      causes.push(cause);
      return new Promise<void>((resolve) => acknowledgements.push(resolve));
    },
  });
  await ready;
  assert.ok(active);
  t.mock.timers.tick(10);
  assert.deepEqual(causes, ["idle"]);
  t.mock.timers.tick(10);
  assert.deepEqual(causes, ["idle"]);
  assert.equal(active.signal?.aborted, false);
  acknowledgements.shift()!();
  await drain();
  t.mock.timers.tick(9);
  assert.deepEqual(causes, ["idle"]);
  t.mock.timers.tick(1);
  assert.deepEqual(causes, ["idle", "idle"]);
  acknowledgements.shift()!();
  await drain();
  t.mock.timers.tick(5);
  assert.deepEqual(causes, ["idle", "idle", "overall"]);
  acknowledgements.shift()!();
  await drain();
  t.mock.timers.tick(100);
  assert.deepEqual(causes, ["idle", "idle", "overall", "idle"]);
  finish();
  await drain();
  let consumed = false;
  void execution.then(() => {
    consumed = true;
  });
  assert.equal(consumed, false);
  acknowledgements.shift()!();
  assert.equal((await execution).outcome, "committed");
  assert.equal(causes.filter((cause) => cause === "overall").length, 1);
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`nonempty partial ${stream} resets idle but not overall time`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let handle: NoSandboxHandle | undefined;
    const causes: string[] = [];
    const executor = createExecutor(async (options) => {
      const provider = options.sandbox as NoShellSandboxProvider;
      handle = await provider.create({ worktreePath: process.cwd(), env: {} });
      started();
      await completed;
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    });
    const execution = executor.execute({
      ...input(),
      timeoutMs: 25,
      idleTimeoutMs: 10,
      pauseForTimeout: async (cause) => {
        causes.push(cause);
      },
    });
    await ready;
    assert.ok(handle);
    for (let iteration = 0; iteration < 4; iteration += 1) {
      t.mock.timers.tick(6);
      await handle.exec(
        `"${process.execPath}" -e 'process.${stream}.write("partial")'`,
      );
      assert.deepEqual(causes, []);
    }
    t.mock.timers.tick(1);
    await drain();
    assert.deepEqual(causes, ["overall"]);
    t.mock.timers.tick(10);
    await drain();
    assert.deepEqual(causes, ["overall", "idle"]);
    finish();
    assert.equal((await execution).outcome, "committed");
  });
}

test("shutdown during timeout settles without waiting for operator acknowledgement", async () => {
  const controller = new AbortController();
  let markPaused!: () => void;
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const executor = new SandcastleAgentExecutor(
    async (options) => {
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
    timeoutMs: 1,
    pauseForTimeout: () => {
      markPaused();
      return new Promise(() => {});
    },
  });
  await paused;
  controller.abort(new OperatorCancelled("shutdown"));
  await assert.rejects(execution, OperatorCancelled);
});
