import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { run, type AgentProvider, type RunOptions } from "@ai-hero/sandcastle";

import { noShellSandbox } from "../../src/adapters/no-shell-sandbox.ts";
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
