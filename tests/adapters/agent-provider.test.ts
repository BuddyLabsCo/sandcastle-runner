import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { nativeAgent } from "../../src/adapters/agent-provider.ts";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { committed, input } from "../support/sandcastle.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

function command(
  agent: string,
  model = "model",
  options?: Record<string, unknown>,
) {
  return nativeAgent(agent, model, options).buildPrintCommand({
    prompt: "prompt",
    dangerouslySkipPermissions: true,
  }).command;
}

test("nativeAgent selects each supported Sandcastle factory", () => {
  assert.equal(nativeAgent("codex", "gpt-5").name, "codex");
  assert.equal(nativeAgent("claude-code", "claude-sonnet").name, "claude-code");
  assert.equal(nativeAgent("pi", "pi-model").name, "pi");
  assert.match(
    command("codex", "gpt-5", { effort: "max" }),
    /-m 'gpt-5'.*model_reasoning_effort="max"/u,
  );
  assert.match(
    command("claude-code", "claude-sonnet", { effort: "max" }),
    /--model 'claude-sonnet' --effort max/u,
  );
  assert.match(
    command("pi", "pi-model", { thinking: "high" }),
    /--model 'pi-model' --thinking high/u,
  );
});

test("nativeAgent forwards nested session storage unchanged", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-native-session-")),
  );
  const sessions = path.join(root, "explicit sessions");
  const sessionId = "explicit-session";
  const file = path.join(
    sessions,
    "2026",
    "10",
    "25",
    `rollout-2026-10-25-${sessionId}.jsonl`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{}\n");

  const found = await nativeAgent("codex", "gpt-5", {
    sessionStorage: { hostSessionsDir: sessions },
  }).sessionStorage?.findByIdOnHost(sessionId);
  assert.equal(found?.path, file);
});

test("probe and task use the same selected profile and session", async () => {
  const calls: { agent: string; resumeSession: string | undefined }[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      calls.push({
        agent: options.agent.name,
        resumeSession: options.resumeSession,
      });
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
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

  await executor.execute({
    ...input(),
    agent: "claude-code",
    model: "claude-sonnet",
    options: { effort: "high" },
  });
  assert.deepEqual(calls, [
    { agent: "claude-code", resumeSession: undefined },
    { agent: "claude-code", resumeSession: "probe-session" },
  ]);
});

test("diagnostics attribute the selected native agent", async () => {
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
      return {
        iterations: [{ sessionId: "probe-session" }],
        stdout: `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        commits: committed.commits,
        branch: input().branch,
        output: { ...committed },
      };
    },
    async () => {},
    async () => {},
    async () => {},
  );

  const result = await executor.execute({
    ...input(),
    agent: "pi",
    model: "pi-model",
    options: { thinking: "high" },
  });
  assert.equal(result.diagnostics?.provider, "pi");
  assert.equal(result.diagnostics?.model, "pi-model");
});
