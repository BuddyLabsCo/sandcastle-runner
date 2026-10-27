import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import type { NoShellSandboxProvider } from "../../src/adapters/no-shell-sandbox.ts";
import type { AgentAttemptInput } from "../../src/run/contracts.ts";
import { executeCli } from "../../src/cli.ts";
import { readRecoverySnapshot, recoveryPaths } from "../../src/recovery.ts";
import {
  createCliDependencies,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { committed, result as agentResult } from "../support/sandcastle.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("overall timeout retains the original success and logs until Enter without relaunching", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    timeouts: { ...validConfig.timeouts, agentMinutes: 0.0005 },
  });
  const delivery = createCommittedBatch(9);
  let finish!: () => void;
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  let inspections = 0;
  let logFile = "";
  let activeSignal: AbortSignal | undefined;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "session-9" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: "unused",
          output: undefined,
        };
      calls += 1;
      activeSignal = options.signal;
      await complete;
      await writeFile(logFile, "late original output\n");
      return agentResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async () => {},
    async () => {},
    async () => {},
  );
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async inspect(input) {
          inspections += 1;
          return {
            ...(await delivery.gitWorkspace.inspect(input)),
            commits: committed.commits,
          };
        },
      },
      agentExecutor: {
        execute(input) {
          logFile = input.logFile;
          return executor.execute(input);
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /overall.*threshold/iu);
          assert.match(message, /Enter.*same invocation/iu);
          assert.equal(activeSignal?.aborted, false);
          finish();
          for (let turn = 0; turn < 100; turn += 1) await setImmediate();
          assert.equal(inspections, 0);
          assert.equal(
            await readFile(logFile, "utf8"),
            "late original output\n",
          );
          return "";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(calls, 1);
  assert.equal(inspections, 1);
  assert.ok(result.logPath);
  assert.match(
    await readFile(result.logPath, "utf8"),
    /"result":"acknowledged"/u,
  );
});

for (const response of ["q", null]) {
  test(`timeout ${response === null ? "EOF" : "q"} cancels the Run, preserves recovery, and cannot skip a live invocation`, async () => {
    const root = await createProject();
    await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
      ...validConfig,
      timeouts: { ...validConfig.timeouts, agentMinutes: 0.0005 },
    });
    const delivery = createCommittedBatch(9);
    let calls = 0;
    let inspections = 0;
    let settled = false;
    let prompts = 0;
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        calls += 1;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              settled = true;
              reject(
                options.signal?.reason instanceof Error
                  ? options.signal.reason
                  : new Error("cancelled"),
              );
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
      async () => {},
      async () => {},
      async () => {},
    );
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: delivery.tracker,
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async inspect(input) {
            inspections += 1;
            return delivery.gitWorkspace.inspect(input);
          },
        },
        agentExecutor: executor,
        operator: {
          async pause(message) {
            prompts += 1;
            assert.match(message, /overall threshold/u);
            assert.doesNotMatch(
              message,
              /Actions:.*skip|selected.only kill|manual takeover/iu,
            );
            return prompts === 1 ? "s" : response;
          },
        },
      }),
    );
    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(settled, true);
    assert.equal(calls, 1);
    assert.equal(inspections, 0);
    assert.equal(prompts, 2);
    const snapshot = await readRecoverySnapshot(
      recoveryPaths(path.join(root, "projects/demo"), 8).snapshot,
    );
    assert.ok(snapshot);
    assert.deepEqual(snapshot.batch, [9]);
    assert.equal(snapshot.publications, undefined);
  });
}

test("competing idle pauses retain a late failure and success until every acknowledgement, then use normal retry", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    agentRetry: 1,
    timeouts: { ...validConfig.timeouts, agentIdleMinutes: 0.0005 },
  });
  const delivery = createCommittedBatch(9, 10);
  let finish!: () => void;
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let bothPaused!: () => void;
  const registered = new Promise<void>((resolve) => {
    bothPaused = resolve;
  });
  let timeouts = 0;
  let prompts = 0;
  let inspections = 0;
  const calls: number[] = [];
  const inputs = new Map<number, AgentAttemptInput>();
  const waits: number[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: "unused",
          output: undefined,
        };
      const ticket = options.name === "implement issue 9" ? 9 : 10;
      calls.push(ticket);
      await complete;
      if (ticket === 9 && calls.filter((value) => value === 9).length === 1)
        throw new Error("original late process failure");
      const output = await delivery.agentExecutor.execute(inputs.get(ticket)!);
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
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async inspect(input) {
          inspections += 1;
          return delivery.gitWorkspace.inspect(input);
        },
      },
      agentExecutor: {
        execute(input) {
          inputs.set(input.ticket, input);
          return executor.execute({
            ...input,
            pauseForTimeout(cause) {
              timeouts += 1;
              const pause = input.pauseForTimeout(cause);
              if (timeouts === 2) bothPaused();
              return pause;
            },
          });
        },
      },
      operator: {
        async pause(message) {
          prompts += 1;
          assert.match(message, /idle threshold/u);
          await registered;
          finish();
          for (let turn = 0; turn < 100; turn += 1) await setImmediate();
          assert.equal(calls.length, 2);
          assert.equal(inspections, 0);
          assert.deepEqual(waits, []);
          return "";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(prompts, 2);
  assert.deepEqual(calls.sort(), [9, 9, 10].sort());
  assert.equal(inspections, 2);
  assert.deepEqual(waits, [10_000]);
});

test("failed settlement after timeout acknowledgement blocks fresh attempts and Worktree cleanup", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    timeouts: { ...validConfig.timeouts, agentMinutes: 0.0005 },
  });
  const delivery = createCommittedBatch(9);
  let finish!: () => void;
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  let prompts = 0;
  let removals = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: "unused",
          output: undefined,
        };
      calls += 1;
      (options.sandbox as NoShellSandboxProvider).settle = async () => ({
        outcome: "failed",
        error: "owned process settlement unknown",
      });
      await complete;
      return agentResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async () => {},
    async () => {},
    async () => {},
  );
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async removeWorktree() {
          removals += 1;
        },
      },
      agentExecutor: executor,
      operator: {
        async pause() {
          prompts += 1;
          finish();
          return prompts < 3 ? "" : "q";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "failed");
  assert.equal(prompts, 1);
  assert.equal(calls, 1);
  assert.equal(removals, 0);
  assert.ok(
    result.summary.reasons.some((reason) => reason.includes("cleanup failed")),
  );
});
