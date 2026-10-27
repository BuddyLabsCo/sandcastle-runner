import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { run, type AgentProvider, type RunOptions } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  ProcessCleanupError,
  type SandcastleRun,
} from "../../src/adapters/process-settlement.ts";
import { OperatorCancelled } from "../../src/run/operations.ts";
import { committed, input } from "../support/sandcastle.ts";
import {
  noShellSandbox,
  type NoShellSandboxProvider,
} from "../../src/adapters/no-shell-sandbox.ts";
import { processExists, stopProcess, waitForPid } from "../support/process.ts";

const execFileAsync = promisify(execFile);

async function createRepository(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "# Fake Agent\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Sandcastle Runner Test",
      "-c",
      "user.email=sandcastle@example.test",
      "commit",
      "-qm",
      "initial",
    ],
    { cwd: repository },
  );
  return repository;
}

function fakeAgent(pidFile: string): AgentProvider {
  const script =
    'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';
  return {
    name: "fake-agent",
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({
      command: `"${process.execPath}" -e '${script}' "${pidFile}"`,
    }),
    parseStreamLine: () => [],
  };
}

function options(
  cwd: string,
  pidFile: string,
  signal: AbortSignal,
  idleTimeoutSeconds: number,
): RunOptions {
  return {
    agent: fakeAgent(pidFile),
    sandbox: noShellSandbox(),
    cwd,
    prompt: "Run the fake agent.",
    maxIterations: 1,
    completionSignal: [],
    idleTimeoutSeconds,
    branchStrategy: { type: "head" },
    signal,
  };
}

test("Sandcastle cancellation returns only after the owned Agent exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandcastle-cancel-agent-"));
  let pid: number | undefined;
  try {
    const repository = await createRepository(directory);
    const pidFile = path.join(directory, "pid");
    const controller = new AbortController();
    const running = run(options(repository, pidFile, controller.signal, 30));
    pid = await waitForPid(pidFile);
    controller.abort(new Error("Operator cancelled"));
    await assert.rejects(running, /Operator cancelled/u);
    assert.equal(processExists(pid), false);
  } finally {
    if (pid !== undefined) stopProcess(pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Sandcastle timeout returns only after the owned Agent exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandcastle-timeout-agent-"));
  let pid: number | undefined;
  try {
    const repository = await createRepository(directory);
    const pidFile = path.join(directory, "pid");
    const running = run(
      options(repository, pidFile, new AbortController().signal, 0.2),
    );
    pid = await waitForPid(pidFile);
    await assert.rejects(running, /idle|timed out|timeout/iu);
    assert.equal(processExists(pid), false);
  } finally {
    if (pid !== undefined) stopProcess(pid);
    await rm(directory, { recursive: true, force: true });
  }
});

async function supervisedFixture(directory: string, mode: "complete" | "hang") {
  const repository = await createRepository(directory);
  const script = path.join(directory, "agent.cjs");
  const pidFile = path.join(directory, "pid");
  const childFile = path.join(directory, "child");
  const releaseFile = path.join(directory, "release");
  const logFile = path.join(directory, "agent.log");
  const gitConfigGlobal = path.join(directory, "gitconfig");
  await writeFile(gitConfigGlobal, "");
  await writeFile(
    script,
    `
const fs = require("node:fs");
const {spawn} = require("node:child_process");
if (process.argv[2] === "probe") { console.log("SESSION_READY"); }
else {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  ${mode === "hang" ? `spawn(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', ${JSON.stringify(childFile)}], {stdio:"ignore"});` : ""}
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
    clearInterval(timer);
    console.log("late original output");
    console.log(${JSON.stringify(`<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`)});
  }, 10);
}
`,
  );
  let naturalFinish!: () => void;
  const finished = new Promise<void>((resolve) => {
    naturalFinish = resolve;
  });
  let calls = 0;
  let failCleanup = false;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      calls += 1;
      const probe = options.prompt === "Reply with exactly: SESSION_READY";
      const provider: AgentProvider = {
        name: "harmless-agent",
        env: {},
        captureSessions: false,
        buildPrintCommand: () => ({
          command: `"${process.execPath}" "${script}" ${probe ? "probe" : "work"}`,
        }),
        parseStreamLine: (line) => [
          { type: "session_id", sessionId: "harmless-session" },
          { type: "text", text: `${line}\n` },
        ],
      };
      const { resumeSession, ...nativeOptions } = options;
      void resumeSession;
      if (failCleanup && !probe) {
        const sandbox = options.sandbox as NoShellSandboxProvider;
        const settle = sandbox.settle.bind(sandbox);
        sandbox.settle = async () => {
          await settle();
          return { outcome: "failed", error: "injected settlement failure" };
        };
      }
      try {
        return (await run({ ...nativeOptions, agent: provider })) as Awaited<
          ReturnType<SandcastleRun>
        >;
      } finally {
        if (!probe) naturalFinish();
      }
    },
    async () => {},
    async () => {},
    async () => {},
  );
  const { promptFile, ...attempt } = input();
  void promptFile;
  return {
    executor,
    pidFile,
    childFile,
    releaseFile,
    logFile,
    finished,
    calls: () => calls,
    failCleanup: () => {
      failCleanup = true;
    },
    attempt: {
      ...attempt,
      worktree: repository,
      gitConfigGlobal,
      logFile,
      idleTimeoutMs: 200,
      timeoutMs: 10_000,
      retryPolicy: { ...attempt.retryPolicy, agentRetry: 0 },
    },
  };
}

test("integrated supervision disables native idle kill and retains natural completion and late output through pause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervised-agent-"));
  let pid: number | undefined;
  try {
    const fixture = await supervisedFixture(directory, "complete");
    let pauses = 0;
    const output = await fixture.executor.execute({
      ...fixture.attempt,
      pauseForTimeout: async (cause) => {
        pauses += 1;
        assert.equal(cause, "idle");
        pid = await waitForPid(fixture.pidFile);
        assert.equal(processExists(pid), true);
        // Survive multiple configured idle windows with the native lifecycle active.
        await new Promise((resolve) => setTimeout(resolve, 450));
        assert.equal(processExists(pid), true);
        await writeFile(fixture.releaseFile, "complete");
        await fixture.finished;
        assert.equal(processExists(pid), false);
        assert.match(
          await readFile(fixture.logFile, "utf8"),
          /late original output/u,
        );
      },
    });
    assert.equal(output.outcome, "committed");
    assert.equal(pauses, 1);
    assert.equal(fixture.calls(), 2);
  } finally {
    if (pid !== undefined) stopProcess(pid);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const stop of ["q", "shutdown", "cleanup failure"] as const) {
  test(`timeout ${stop} settles the real Agent and descendants before returning`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "supervised-cancel-"));
    const pids: number[] = [];
    const controller = new AbortController();
    try {
      const fixture = await supervisedFixture(directory, "hang");
      if (stop === "cleanup failure") fixture.failCleanup();
      const execution = fixture.executor.execute({
        ...fixture.attempt,
        signal: controller.signal,
        pauseForTimeout: async () => {
          pids.push(
            await waitForPid(fixture.pidFile),
            await waitForPid(fixture.childFile),
          );
          for (const pid of pids) assert.equal(processExists(pid), true);
          if (stop === "shutdown") {
            controller.abort(new OperatorCancelled("shutdown"));
            return new Promise(() => {});
          }
          throw new OperatorCancelled("operator cancelled");
        },
      });
      await assert.rejects(
        execution,
        stop === "cleanup failure" ? ProcessCleanupError : OperatorCancelled,
      );
      for (const pid of pids) assert.equal(processExists(pid), false);
      assert.equal(fixture.calls(), 2);
    } finally {
      controller.abort(new OperatorCancelled("test cleanup"));
      for (const pid of pids) stopProcess(pid);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
