import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { codexWithRunnerEffort } from "../../src/adapters/codex-agent.ts";
import { noShellSandbox } from "../../src/adapters/no-shell-sandbox.ts";
import { processExists, stopProcess, waitForPid } from "../support/process.ts";

interface TestHandle {
  exec(command: string): Promise<{
    stdout: string;
    exitCode: number;
  }>;
  close(): Promise<void>;
}

async function createHandle(
  env: Record<string, string> = {},
): Promise<TestHandle> {
  const provider = noShellSandbox({ env }) as unknown as {
    create: (options: {
      worktreePath: string;
      env: Record<string, string>;
    }) => Promise<TestHandle>;
  };
  return provider.create({ worktreePath: process.cwd(), env });
}

test("noShellSandbox runs quoted arguments without a shell", async () => {
  const handle = await createHandle();
  const result = await handle.exec(
    "node -e 'process.stdout.write(process.argv[1])' 'hello world'",
  );
  assert.equal(result.stdout, "hello world");
  assert.equal(result.exitCode, 0);
  await handle.close();
});

test("noShellSandbox preserves Windows path separators and spaces", async () => {
  const handle = await createHandle();
  const path = String.raw`C:\work repo\src`;
  const result = await handle.exec(
    `node -e 'process.stdout.write(process.argv[1])' "${path}"`,
  );
  assert.equal(result.stdout, path);
  assert.equal(result.exitCode, 0);
  const trailingSeparator = "C:\\work repo\\";
  const trailingResult = await handle.exec(
    `node -e 'process.stdout.write(process.argv[1])' "${trailingSeparator}"`,
  );
  assert.equal(trailingResult.stdout, trailingSeparator);
  assert.equal(trailingResult.exitCode, 0);
  await handle.close();
});

test("noShellSandbox preserves UNC paths, metacharacters, and provider quoting", async () => {
  const handle = await createHandle();
  const unc = String.raw`\\server\share\repo`;
  const trailingPath = "C:\\work repo\\";
  const metacharacters = "shell & %PATH% !name!";
  const effort = 'model_reasoning_effort="high"';
  const result = await handle.exec(
    `"${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "${unc}" "${trailingPath}" "${metacharacters}" '${effort}'`,
  );
  assert.deepEqual(JSON.parse(result.stdout), [
    unc,
    trailingPath,
    metacharacters,
    effort,
  ]);
  assert.equal(result.exitCode, 0);
  await handle.close();
});

test(
  "noShellSandbox launches Windows command shims without shell mode",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-shim-"));
    try {
      const shim = join(directory, "codex shim.cmd");
      await writeFile(
        shim,
        '@echo off\r\nnode -e "process.stdout.write(process.argv[1])" "%~1"\r\n',
      );
      const handle = await createHandle({
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      });
      const path = String.raw`C:\work repo\src`;
      const result = await handle.exec(`"${shim}" "${path}"`);
      assert.equal(result.stdout, path);
      assert.equal(result.exitCode, 0);
      await handle.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("noShellSandbox preserves the Codex provider command through a command shim", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "sandcastle-provider-command-"),
  );
  try {
    const argsFile = join(directory, "args.json");
    const recorder = join(directory, "record.mjs");
    await writeFile(
      recorder,
      'import { writeFile } from "node:fs/promises";\nawait writeFile(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n',
    );
    if (process.platform === "win32") {
      await writeFile(
        join(directory, "codex.cmd"),
        '@echo off\r\nnode "%~dp0record.mjs" %*\r\n',
      );
    } else {
      const codex = join(directory, "codex");
      await writeFile(
        codex,
        '#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises";\nawait writeFile(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n',
      );
      await chmod(codex, 0o755);
    }
    const handle = await createHandle({
      ARGS_FILE: argsFile,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
    });
    const command = codexWithRunnerEffort("gpt-5", "high").buildPrintCommand({
      prompt: "controlled prompt",
      dangerouslySkipPermissions: true,
    }).command;
    const result = await handle.exec(command);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(await readFile(argsFile, "utf8")) as unknown;
    assert.ok(Array.isArray(parsed));
    const args = (parsed as unknown[]).filter(
      (value): value is string => typeof value === "string",
    );
    assert.equal(args.length, parsed.length);
    assert.ok(args.includes("gpt-5"));
    assert.ok(args.includes('model_reasoning_effort="high"'));
    await handle.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("noShellSandbox close stops and awaits its direct child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandcastle-process-close-"));
  let pid: number | undefined;
  const handle = await createHandle();
  try {
    const pidFile = join(directory, "pid");
    const running = handle.exec(
      `"${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)' "${pidFile}"`,
    );
    pid = await waitForPid(pidFile);
    await handle.close();
    assert.equal(processExists(pid), false);
    await running;
  } finally {
    if (pid !== undefined) stopProcess(pid);
    await handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "noShellSandbox close stops Windows command-shim descendants",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-shim-close-"));
    let pid: number | undefined;
    const handle = await createHandle();
    try {
      const pidFile = join(directory, "pid");
      const fakeAgent = join(directory, "agent.mjs");
      await writeFile(
        fakeAgent,
        'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n',
      );
      const shim = join(directory, "codex.cmd");
      await writeFile(shim, '@echo off\r\nnode "%~dp0agent.mjs" %*\r\n');
      const running = handle.exec(`"${shim}" "${pidFile}"`);
      pid = await waitForPid(pidFile);
      await handle.close();
      assert.equal(processExists(pid), false);
      await running;
    } finally {
      if (pid !== undefined) stopProcess(pid);
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "noShellSandbox close stops POSIX wrapper descendants",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-shim-close-"));
    let pid: number | undefined;
    const handle = await createHandle();
    try {
      const pidFile = join(directory, "pid");
      const fakeAgent = join(directory, "agent.mjs");
      await writeFile(
        fakeAgent,
        'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n',
      );
      const wrapper = join(directory, "codex");
      await writeFile(
        wrapper,
        '#!/bin/sh\nnode "$(dirname "$0")/agent.mjs" "$1"\n',
      );
      await chmod(wrapper, 0o755);
      const running = handle.exec(`"${wrapper}" "${pidFile}"`);
      pid = await waitForPid(pidFile);
      await handle.close();
      assert.equal(processExists(pid), false);
      await running;
    } finally {
      if (pid !== undefined) stopProcess(pid);
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("noShellSandbox reports a missing logical command", async () => {
  const handle = await createHandle();
  await assert.rejects(
    handle.exec("sandcastle-command-that-does-not-exist"),
    /sandcastle-command-that-does-not-exist could not be started: .*README prerequisites/u,
  );
  await handle.close();
});
