import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StructuredOutputError } from "@ai-hero/sandcastle";

import { nativeAgent } from "../../src/adapters/agent-provider.ts";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { committed, input } from "../support/sandcastle.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

const identities = [
  { agent: "codex", model: "gpt-5", options: { effort: "max" } },
  { agent: "claude-code", model: "claude-sonnet", options: { effort: "high" } },
  { agent: "pi", model: "pi-model", options: { thinking: "high" } },
  {
    agent: "codebuddy",
    model: "deepseek-v4.1-flash",
    options: { effort: "high" },
  },
] as const;

type Identity = (typeof identities)[number];

const noRetries = {
  operationRetry: 0,
  agentRetry: 0,
  operationRetryDelay: [1],
  agentRetryDelay: [1],
};

function profile(identity: Identity) {
  return {
    ...input(),
    agent: identity.agent,
    model: identity.model,
    options: identity.options,
  };
}

function probeResult() {
  return {
    iterations: [{ sessionId: "probe-session" }],
    stdout: "SESSION_READY",
    commits: [],
    branch: input().branch,
    output: undefined,
  };
}

async function failureDiagnostics(execution: Promise<unknown>) {
  try {
    await execution;
  } catch (error) {
    const diagnostics = (
      error as {
        diagnostics?: { errorCategory?: string; provider?: string };
      }
    ).diagnostics;
    assert.ok(diagnostics, "expected failure diagnostics");
    return diagnostics;
  }
  assert.fail("expected the Agent Attempt to fail");
}

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

test("nativeAgent resolves each supported Sandcastle factory", () => {
  assert.equal(nativeAgent("codex", "gpt-5").name, "codex");
  assert.equal(nativeAgent("claude-code", "claude-sonnet").name, "claude-code");
  assert.equal(nativeAgent("claudeCode", "claude-sonnet").name, "claude-code");
  assert.equal(nativeAgent("pi", "pi-model").name, "pi");
  assert.equal(
    nativeAgent("codebuddy", "deepseek-v4.1-flash").name,
    "codebuddy",
  );
  assert.match(
    command("codebuddy", "deepseek-v4.1-flash", { effort: "high" }),
    /--model 'deepseek-v4.1-flash' --effort 'high'/u,
  );
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

test("result diagnostics attribute the selected native agent", async () => {
  for (const identity of identities) {
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        if (options.prompt === "Reply with exactly: SESSION_READY")
          return probeResult();
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

    const result = await executor.execute(profile(identity));
    assert.equal(result.diagnostics?.provider, identity.agent);
    assert.equal(result.diagnostics?.model, identity.model);
    assert.equal(result.diagnostics?.sessionId, "probe-session");
  }
});

test("probe failures attribute the selected native agent", async () => {
  for (const identity of identities) {
    const executor = new SandcastleAgentExecutor(
      async () => {
        throw new Error("probe failed");
      },
      async () => {},
      async () => {},
      async () => {},
    );
    const diagnostics = await failureDiagnostics(
      executor.execute({ ...profile(identity), retryPolicy: noRetries }),
    );
    assert.equal(diagnostics.provider, identity.agent);
    assert.equal(diagnostics.errorCategory, "operation_retry");
  }
});

test("substantive invocation failures attribute the selected native agent", async () => {
  for (const identity of identities) {
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        if (options.prompt === "Reply with exactly: SESSION_READY")
          return probeResult();
        throw new Error("agent process exited");
      },
      async () => {},
      async () => {},
      async () => {},
    );
    const diagnostics = await failureDiagnostics(
      executor.execute({ ...profile(identity), retryPolicy: noRetries }),
    );
    assert.equal(diagnostics.provider, identity.agent);
    assert.equal(diagnostics.errorCategory, "agent_retry");
  }
});

test("unavailable continuation attributes the selected native agent", async () => {
  for (const identity of identities) {
    const executor = new SandcastleAgentExecutor(
      async () => {
        throw new Error("agent must not run");
      },
      async () => {},
      async () => {},
      async () => {},
    );
    const diagnostics = await failureDiagnostics(
      executor.execute({ ...profile(identity), resumePrompt: "continue" }),
    );
    assert.equal(diagnostics.provider, identity.agent);
    assert.equal(diagnostics.errorCategory, "agent_retry");
  }
});

test("structured-output diagnostics attribute the selected native agent", async () => {
  for (const identity of identities) {
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        if (options.prompt === "Reply with exactly: SESSION_READY")
          return probeResult();
        throw new StructuredOutputError("invalid structured output", {
          tag: "agent_attempt_result",
          rawMatched: "{}",
          cause: [{ message: "outcome is required" }],
          commits: [],
          branch: input().branch,
          sessionId: "session-id",
        });
      },
      async () => {},
      async () => {},
      async () => {},
    );
    const diagnostics = await failureDiagnostics(
      executor.execute({ ...profile(identity), retryPolicy: noRetries }),
    );
    assert.equal(diagnostics.provider, identity.agent);
    assert.equal(diagnostics.errorCategory, "agent_attempt");
  }
});
