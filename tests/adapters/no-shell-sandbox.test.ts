import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { nativeAgent } from "../../src/adapters/agent-provider.ts";
import { noShellSandbox } from "../../src/adapters/no-shell-sandbox.ts";
import { processExists, stopProcess, waitForPid } from "../support/process.ts";

interface TestHandle {
  exec(
    command: string,
    options?: { stdin?: string },
  ): Promise<{
    stdout: string;
    exitCode: number;
  }>;
  close(): Promise<void>;
}

interface TestProvider {
  create(options: {
    worktreePath: string;
    env: Record<string, string>;
  }): Promise<TestHandle>;
  settle(): Promise<
    { outcome: "settled" } | { outcome: "failed"; error: string }
  >;
}

function createProvider(env: Record<string, string> = {}): TestProvider {
  const provider = noShellSandbox({ env }) as unknown as {
    create: TestProvider["create"];
    settle: TestProvider["settle"];
  };
  return provider;
}

async function createHandle(
  env: Record<string, string> = {},
): Promise<TestHandle> {
  return createProvider(env).create({ worktreePath: process.cwd(), env });
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

test("noShellSandbox transports a long stdin prompt", async () => {
  const handle = await createHandle();
  const prompt = "x".repeat(200_000);
  const result = await handle.exec(
    `"${process.execPath}" -e 'process.stdin.pipe(process.stdout)'`,
    { stdin: prompt },
  );
  assert.equal(result.stdout, prompt);
  assert.equal(result.exitCode, 0);
  await handle.close();
});

test("noShellSandbox passes its invocation environment to the child", async () => {
  const handle = await createHandle({ RUNNER_TEST_VALUE: "isolated" });
  const result = await handle.exec(
    `"${process.execPath}" -e 'process.stdout.write(process.env.RUNNER_TEST_VALUE ?? "missing")'`,
  );
  assert.equal(result.stdout, "isolated");
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

test("noShellSandbox preserves apostrophes inside quoted arguments", async () => {
  const handle = await createHandle();
  const path = String.raw`C:\Users\O'Brien\work tree`;
  const result = await handle.exec(
    `"${process.execPath}" -e 'process.stdout.write(process.argv[1])' "${path}"`,
  );
  assert.equal(result.stdout, path);
  assert.equal(result.exitCode, 0);
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

for (const [agent, executable, model, expected] of [
  ["codex", "codex", "gpt-5", ['model_reasoning_effort="high"']],
  ["claude-code", "claude", "claude-sonnet", ["--effort", "high"]],
  ["pi", "pi", "pi-model", ["--thinking", "high"]],
] as const) {
  test(`noShellSandbox preserves the ${agent} provider command through a command shim`, async () => {
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
          join(directory, `${executable}.cmd`),
          '@echo off\r\nnode "%~dp0record.mjs" %*\r\n',
        );
      } else {
        const shim = join(directory, executable);
        await writeFile(
          shim,
          '#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises";\nawait writeFile(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n',
        );
        await chmod(shim, 0o755);
      }
      const handle = await createHandle({
        ARGS_FILE: argsFile,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      });
      const command = nativeAgent(agent, model, {
        ...(agent === "pi" ? { thinking: "high" } : { effort: "high" }),
      }).buildPrintCommand({
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
      assert.ok(args.includes(model));
      for (const value of expected) assert.ok(args.includes(value), value);
      await handle.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

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

test("noShellSandbox reports explicit settlement after stopping its child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandcastle-process-settle-"));
  let pid: number | undefined;
  const provider = createProvider();
  try {
    const pidFile = join(directory, "pid");
    const handle = await provider.create({
      worktreePath: process.cwd(),
      env: {},
    });
    const running = handle.exec(
      `"${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)' "${pidFile}"`,
    );
    pid = await waitForPid(pidFile);
    assert.deepEqual(await provider.settle(), { outcome: "settled" });
    assert.equal(processExists(pid), false);
    await running;
  } finally {
    if (pid !== undefined) stopProcess(pid);
    await provider.settle();
    await rm(directory, { recursive: true, force: true });
  }
});

test("one noShellSandbox invocation settles only its own child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandcastle-process-scope-"));
  const pids: number[] = [];
  const first = createProvider();
  const second = createProvider();
  try {
    const running: Promise<unknown>[] = [];
    for (const [index, provider] of [first, second].entries()) {
      const pidFile = join(directory, `pid-${index}`);
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });
      running.push(
        handle.exec(
          `"${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)' "${pidFile}"`,
        ),
      );
      pids.push(await waitForPid(pidFile));
    }
    assert.deepEqual(await first.settle(), { outcome: "settled" });
    assert.equal(processExists(pids[0]!), false);
    assert.equal(processExists(pids[1]!), true);
    await running[0];
    assert.deepEqual(await second.settle(), { outcome: "settled" });
    assert.equal(processExists(pids[1]!), false);
    await running[1];
  } finally {
    for (const pid of pids) stopProcess(pid);
    await first.settle();
    await second.settle();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "noShellSandbox reports an OS process-tree termination failure",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sandcastle-process-failure-"),
    );
    const provider = createProvider();
    const previousSystemRoot = process.env.SystemRoot;
    let pid: number | undefined;
    try {
      const pidFile = join(directory, "pid");
      const handle = await provider.create({
        worktreePath: process.cwd(),
        env: {},
      });
      const running = handle.exec(
        `"${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)' "${pidFile}"`,
      );
      pid = await waitForPid(pidFile);
      process.env.SystemRoot = join(directory, "missing windows directory");
      const settlement = await provider.settle();
      assert.equal(settlement.outcome, "failed");
      if (settlement.outcome === "failed")
        assert.match(settlement.error, /taskkill|ENOENT|not found/iu);
      await running;
      assert.equal(processExists(pid), false);
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (pid !== undefined) stopProcess(pid);
      await provider.settle();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
