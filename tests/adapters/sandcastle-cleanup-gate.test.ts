import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StructuredOutputError, type RunOptions } from "@ai-hero/sandcastle";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { processExists, stopProcess, waitForPid } from "../support/process.ts";
import {
  committed,
  input,
  result as makeResult,
} from "../support/sandcastle.ts";

type Settlement = { outcome: "settled" } | { outcome: "failed"; error: string };
type SettleableSandbox = RunOptions["sandbox"] & {
  settle(): Promise<Settlement>;
};

function settleable(options: RunOptions): SettleableSandbox {
  return options.sandbox as SettleableSandbox;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cleanupFailure(error: unknown): boolean {
  assert.match((error as Error).message, /cleanup failed/iu);
  const diagnostics = (
    error as { diagnostics?: { errorCategory?: string; retryable?: boolean } }
  ).diagnostics;
  assert.equal(diagnostics?.errorCategory, "process_cleanup");
  assert.equal(diagnostics?.retryable, false);
  return true;
}

test("a completed probe blocks substantive work until its cleanup settles or fails", async () => {
  const prompts: string[] = [];
  const cleanupStarted = deferred();
  const cleanupResult = deferred();
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(String(options.prompt));
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        settleable(options).settle = async () => {
          cleanupStarted.resolve();
          await cleanupResult.promise;
          return { outcome: "failed", error: "host process remains alive" };
        };
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async () => {},
    async () => {},
    async () => {},
    async () => {},
  );

  const running = executor.execute(input());
  await cleanupStarted.promise;
  await Promise.resolve();
  assert.equal(prompts.length, 1);
  cleanupResult.resolve();
  await assert.rejects(running, cleanupFailure);
  assert.equal(prompts.length, 1);
});

test(
  "SandcastleAgentExecutor surfaces an actual host cleanup failure before substantive work",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-cleanup-fail-"));
    const pidFile = path.join(directory, "pid");
    const previousSystemRoot = process.env.SystemRoot;
    let child: Promise<unknown> | undefined;
    let pid: number | undefined;
    let substantiveCalls = 0;
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        if (options.prompt === "Reply with exactly: SESSION_READY") {
          const sandbox = options.sandbox as unknown as {
            create(options: {
              worktreePath: string;
              env: Record<string, string>;
            }): Promise<{
              exec(command: string): Promise<unknown>;
            }>;
          };
          const handle = await sandbox.create({
            worktreePath: directory,
            env: {},
          });
          child = handle.exec(
            `"${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)' "${pidFile}"`,
          );
          pid = await waitForPid(pidFile);
          process.env.SystemRoot = path.join(
            directory,
            "missing windows directory",
          );
          return {
            iterations: [{ sessionId: "probe-session" }],
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
      async () => {},
    );

    try {
      await assert.rejects(executor.execute(input()), cleanupFailure);
      assert.equal(substantiveCalls, 0);
      await child;
      assert.equal(processExists(pid!), false);
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (pid !== undefined) stopProcess(pid);
      await child;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("failed probe cleanup prevents operation retries", async () => {
  const prompts: string[] = [];
  const waits: number[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(String(options.prompt));
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        settleable(options).settle = async () => ({
          outcome: "failed",
          error: "probe process remains alive",
        });
        throw new Error("probe failed");
      }
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
    async () => {},
  );

  await assert.rejects(executor.execute(input()), cleanupFailure);
  assert.equal(prompts.length, 1);
  assert.deepEqual(waits, []);
});

test("failed cleanup after a substantive process error prevents agent retry", async () => {
  const prompts: string[] = [];
  const waits: number[] = [];
  let substantiveCalls = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(String(options.prompt));
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
      settleable(options).settle = async () => ({
        outcome: "failed",
        error: "agent process remains alive",
      });
      throw new Error("codex exited with code 1");
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
    async () => {},
  );

  await assert.rejects(executor.execute(input()), cleanupFailure);
  assert.equal(substantiveCalls, 1);
  assert.equal(
    prompts.filter((prompt) => prompt.startsWith("continue")).length,
    0,
  );
  assert.deepEqual(waits, []);
});

test("failed cleanup after a missing result prevents automatic continuation", async () => {
  const prompts: string[] = [];
  const waits: number[] = [];
  let substantiveCalls = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(String(options.prompt));
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
      settleable(options).settle = async () => ({
        outcome: "failed",
        error: "agent process remains alive",
      });
      return makeResult("The agent returned no result tag.", committed);
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
    async () => {},
  );

  await assert.rejects(executor.execute(input()), cleanupFailure);
  assert.equal(substantiveCalls, 1);
  assert.equal(
    prompts.filter((prompt) => prompt.startsWith("continue")).length,
    0,
  );
  assert.deepEqual(waits, []);
});

test("failed cleanup after structured output failure prevents correction", async () => {
  const waits: number[] = [];
  let substantiveCalls = 0;
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
      settleable(options).settle = async () => ({
        outcome: "failed",
        error: "agent process remains alive",
      });
      throw new StructuredOutputError("invalid structured output", {
        tag: "agent_attempt_result",
        rawMatched: "{}",
        cause: [{ message: "outcome is required" }],
        commits: [],
        branch: input().branch,
        sessionId: "session-id",
      });
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
    async () => {},
  );

  await assert.rejects(executor.execute(input()), (error: unknown) => {
    cleanupFailure(error);
    assert.equal(
      (error as { diagnostics?: { sessionId?: string } }).diagnostics
        ?.sessionId,
      "session-id",
    );
    return true;
  });
  assert.equal(substantiveCalls, 1);
  assert.deepEqual(waits, []);
});
