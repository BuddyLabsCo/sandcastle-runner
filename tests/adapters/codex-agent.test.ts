import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { codexWithRunnerEffort } from "../../src/adapters/codex-agent.ts";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { committed, input } from "../support/sandcastle.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

async function persistedSession(
  sessions: string,
  sessionId: string,
): Promise<string> {
  const filename = path.join(
    sessions,
    "2026",
    "10",
    "25",
    `rollout-2026-10-25T00-00-00-${sessionId}.jsonl`,
  );
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, "{}\n");
  return filename;
}

function restoreEnvironment(
  name: "CODEX_HOME" | "HOME" | "USERPROFILE",
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("Codex session lookup honors CODEX_HOME", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-codex-home-")),
  );
  const codexHome = path.join(root, "custom-codex");
  const expected = await persistedSession(
    path.join(codexHome, "sessions"),
    "probe-session",
  );
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const found = await codexWithRunnerEffort(
      "gpt-5",
      "high",
    ).sessionStorage.findByIdOnHost("probe-session");
    assert.equal(found.path, expected);
  } finally {
    restoreEnvironment("CODEX_HOME", previous);
  }
});

test("Agent execution resumes the persisted Codex session found in CODEX_HOME", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-codex-resume-")),
  );
  const codexHome = path.join(root, "custom-codex");
  const expected = await persistedSession(
    path.join(codexHome, "sessions"),
    "probe-session",
  );
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        if (options.prompt === "Reply with exactly: SESSION_READY")
          return {
            iterations: [{ sessionId: "probe-session" }],
            stdout: "SESSION_READY",
            commits: [],
            branch: input().branch,
            output: undefined,
          };
        assert.equal(options.resumeSession, "probe-session");
        assert.ok(options.resumeSession);
        const found = await options.agent.sessionStorage?.findByIdOnHost(
          options.resumeSession,
        );
        assert.equal(found?.path, expected);
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
          commits: committed.commits,
          branch: input().branch,
          output: committed,
        };
      },
      async () => {},
      async () => {},
      async () => {},
    );
    await executor.execute(input());
  } finally {
    restoreEnvironment("CODEX_HOME", previous);
  }
});

test(
  "Codex session lookup uses the Windows profile when HOME is absent",
  { skip: process.platform !== "win32" },
  async () => {
    const root = registerTempRoot(
      await mkdtemp(path.join(tmpdir(), "sandcastle-codex-profile-")),
    );
    const profile = path.join(root, "profile");
    const expected = await persistedSession(
      path.join(profile, ".codex", "sessions"),
      "profile-session",
    );
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    const previousCodexHome = process.env.CODEX_HOME;
    delete process.env.HOME;
    delete process.env.CODEX_HOME;
    process.env.USERPROFILE = profile;
    try {
      const found = await codexWithRunnerEffort(
        "gpt-5",
        "high",
      ).sessionStorage.findByIdOnHost("profile-session");
      assert.equal(found.path, expected);
    } finally {
      restoreEnvironment("HOME", previousHome);
      restoreEnvironment("USERPROFILE", previousProfile);
      restoreEnvironment("CODEX_HOME", previousCodexHome);
    }
  },
);
