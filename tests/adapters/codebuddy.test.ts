import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { nativeAgent } from "../../src/adapters/agent-provider.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

// Regression: resume must use one main transcript from the CLI's actual store.
// Seam: provider storage; observation: exact path or visible ambiguity/missing.
// Existing Sandcastle fixtures cover other providers, not CodeBuddy's layout.
test("CodeBuddy finds exact main sessions in its configured CLI home", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "codebuddy-")),
  );
  const projects = path.join(root, "projects");
  const storage = nativeAgent("codebuddy", "model", {
    env: { CODEBUDDY_CONFIG_DIR: root },
  }).sessionStorage;
  assert.ok(storage);
  assert.deepEqual(await storage.findByIdOnHost("session-1"), {
    path: undefined,
    searchedRoot: projects,
  });
  const main = path.join(projects, "unicode-项目", "session-1.jsonl");
  const child = path.join(
    projects,
    "other",
    "parent",
    "subagents",
    "session-1.jsonl",
  );
  await mkdir(path.dirname(child), { recursive: true });
  await writeFile(child, "{}\n");
  assert.equal((await storage.findByIdOnHost("session-1")).path, undefined);
  await mkdir(path.dirname(main), { recursive: true });
  await writeFile(main, "{}\n");
  assert.equal((await storage.findByIdOnHost("session-1")).path, main);
  assert.equal(await storage.existsOnHost("unused", "session-1"), true);
  assert.equal(await storage.readHostSession("unused", "session-1"), "{}\n");
  assert.equal(await storage.readHostSession("unused", "absent"), undefined);
  for (const id of ["../session-1", "", "a/b", "a\\b", "-bad", "a\n"])
    await assert.rejects(
      storage.findByIdOnHost(id),
      /invalid CodeBuddy session ID/u,
    );
  await writeFile(path.join(projects, "other", "session-1.jsonl"), "{}\n");
  await assert.rejects(
    storage.findByIdOnHost("session-1"),
    /ambiguous CodeBuddy session/u,
  );
});

// Regression: raw JSON, interim text, or success flags must not authorize work.
// Seam: provider protocol; observation: only terminal assistant output is a result.
test("CodeBuddy translates captured stream events and protects terminal failures", async () => {
  const { readFile } = await import("node:fs/promises");
  const provider = nativeAgent("codebuddy", "model");
  provider.buildPrintCommand({
    prompt: "task",
    dangerouslySkipPermissions: true,
  });
  const lines = (
    await readFile(
      new URL("../fixtures/codebuddy-stream.jsonl", import.meta.url),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  const events = lines.flatMap((line) => provider.parseStreamLine(line));
  assert.ok(
    events.some(
      (e) => e.type === "session_id" && e.sessionId === "main-session-1",
    ),
  );
  assert.deepEqual(events.at(-1), { type: "result", result: "SESSION_READY" });
  assert.ok(
    events.some((e) => e.type === "text" && e.text === "SESSION_READY"),
  );
  assert.deepEqual(provider.parseStreamLine("malformed json"), []);
  assert.deepEqual(provider.parseStreamLine('{"type":"future_event"}'), []);
  assert.deepEqual(
    provider.parseStreamLine(
      '{"type":"assistant","message":{"content":[null,1,{}]}}',
    ),
    [],
  );

  for (const failure of [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "aborted_streaming",
      result: "misleading output",
    },
    {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "turn budget exhausted",
    },
    { type: "error", error: { message: "authentication failed" } },
    { type: "result", subtype: "success", result: null },
  ]) {
    provider.buildPrintCommand({
      prompt: "task",
      dangerouslySkipPermissions: true,
    });
    provider.parseStreamLine(lines[0]!);
    const parsed = provider.parseStreamLine(JSON.stringify(failure));
    assert.ok(
      parsed.some(
        (e) =>
          e.type === "result" &&
          e.result.startsWith("CodeBuddy protocol failure:"),
      ),
    );
    const later = provider.parseStreamLine(lines.at(-1)!);
    assert.ok(
      later.some(
        (e) =>
          e.type === "result" &&
          e.result.startsWith("CodeBuddy protocol failure:"),
      ),
    );
  }
});

// Regression: configuration must preserve native options without escaping host ownership.
// Seam: provider command; observation: stdin, native flags, environment, invalid-option failures.
test("CodeBuddy preserves supported options and rejects unsafe or malformed profiles", () => {
  const provider = nativeAgent("codebuddy", "a model's name", {
    effort: "max",
    maxTurns: 8,
    permissionMode: "dontAsk",
    tools: "",
    allowedTools: ["Read", "Bash(git:*)"],
    disallowedTools: ["WebFetch"],
    systemPrompt: "system's text",
    appendSystemPrompt: "extra instructions",
    env: { EXAMPLE_SETTING: "kept" },
  });
  const prompt = "large prompt\n".repeat(20000);
  const built = provider.buildPrintCommand({
    prompt,
    resumeSession: "exact-session",
    dangerouslySkipPermissions: true,
  });
  assert.equal(built.stdin, prompt);
  assert.match(built.command, /--permission-mode 'dontAsk'/u);
  assert.match(built.command, /--max-turns '8'/u);
  assert.match(built.command, /--allowedTools 'Read' 'Bash\(git:\*\)'/u);
  assert.match(built.command, /--disallowedTools 'WebFetch'/u);
  assert.match(built.command, /--tools=''/u);
  assert.match(built.command, /--system-prompt 'system'\\''s text'/u);
  assert.match(built.command, /--append-system-prompt 'extra instructions'/u);
  assert.match(built.command, /--resume 'exact-session'/u);
  assert.doesNotMatch(
    built.command,
    /--dangerously-skip-permissions|--continue|--fork|--resume-create-missing|--bg/u,
  );
  assert.equal(provider.env.EXAMPLE_SETTING, "kept");
  assert.equal(provider.env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(provider.env.CODEBUDDY_IS_SANDBOX, undefined);
  for (const options of [
    { background: true },
    { effort: "extreme" },
    { maxTurns: 0 },
    { maxTurns: 1.5 },
    { env: { X: 1 } },
    { env: { CODEBUDDY_CONFIG_DIR: "relative-store" } },
    { tools: ["Read"] },
    { permissionMode: "invalid" },
    { allowedTools: [1] },
  ])
    assert.throws(
      () => nativeAgent("codebuddy", "model", options),
      /CodeBuddy/u,
    );
  assert.throws(
    () =>
      provider.buildPrintCommand({
        prompt: "task",
        dangerouslySkipPermissions: true,
        forkSession: true,
      }),
    /forks are unsupported/u,
  );
});

// Regression: probes must not cache a session ID from an incomplete or failed turn.
test("CodeBuddy exposes new sessions only after successful terminal output", () => {
  const provider = nativeAgent("codebuddy", "model");
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "session-1",
  });
  const error = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "aborted_streaming",
    result: "SESSION_READY",
  });
  provider.buildPrintCommand({
    prompt: "Reply with exactly: SESSION_READY",
    dangerouslySkipPermissions: true,
  });
  assert.ok(
    provider.parseStreamLine(init).every((e) => e.type !== "session_id"),
  );
  assert.ok(
    provider
      .parseStreamLine(error)
      .every((e) => e.type !== "session_id" || e.sessionId === ""),
  );
  provider.buildPrintCommand({
    prompt: "task",
    resumeSession: "session-1",
    dangerouslySkipPermissions: true,
  });
  provider.parseStreamLine(init);
  assert.ok(
    provider
      .parseStreamLine(error)
      .some((e) => e.type === "session_id" && e.sessionId === "session-1"),
  );
});

// Regression: concurrent Projects must not read a same-ID session from another CLI home.
test("CodeBuddy keeps concurrent custom session stores isolated", async () => {
  const roots = await Promise.all(
    ["one", "two"].map(async (name) => {
      const root = registerTempRoot(
        await mkdtemp(path.join(tmpdir(), `codebuddy-${name}-`)),
      );
      const file = path.join(root, "projects", name, "same-id.jsonl");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${name}\n`);
      return { root, file };
    }),
  );
  const found = await Promise.all(
    roots.map(({ root }) =>
      nativeAgent("codebuddy", "model", {
        env: { CODEBUDDY_CONFIG_DIR: root },
      }).sessionStorage!.findByIdOnHost("same-id"),
    ),
  );
  assert.deepEqual(
    found.map((session) => session.path),
    roots.map(({ file }) => file),
  );
});

test("CodeBuddy defaults to dontAsk without enabling sandbox full pass", () => {
  const provider = nativeAgent("codebuddy", "model");
  const built = provider.buildPrintCommand({
    prompt: "task",
    dangerouslySkipPermissions: true,
  });
  assert.match(built.command, /--permission-mode 'dontAsk'/u);
  assert.equal(provider.env.CODEBUDDY_IS_SANDBOX, undefined);
});

// Regression: overriding the child home must not split probe persistence and lookup.
// Seam: provider storage; a harmless Node child supplies the native home-path oracle.
test("CodeBuddy locates sessions under the effective child home", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "codebuddy-home-")),
  );
  const env = {
    HOME: path.join(root, "unix-home"),
    USERPROFILE: path.join(root, "windows-home"),
    CODEBUDDY_CONFIG_DIR: "",
  };
  const { stdout: childHome } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { homedir } from "node:os"; process.stdout.write(homedir());',
    ],
    { env: { ...process.env, ...env } },
  );
  const projects = path.join(childHome, ".codebuddy", "projects");
  const file = path.join(projects, "worktree", "home-session.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{}\n");
  const storage = nativeAgent("codebuddy", "model", { env }).sessionStorage!;
  assert.deepEqual(await storage.findByIdOnHost("home-session"), {
    path: file,
    searchedRoot: projects,
  });
  for (const value of ["", "relative-home"])
    assert.throws(
      () =>
        nativeAgent("codebuddy", "model", {
          env: {
            ...env,
            [process.platform === "win32" ? "USERPROFILE" : "HOME"]: value,
          },
        }),
      /CodeBuddy effective home must be absolute/u,
    );
});
