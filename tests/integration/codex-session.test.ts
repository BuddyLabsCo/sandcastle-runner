import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run as runSandcastle } from "@ai-hero/sandcastle";

import { codexWithRunnerEffort } from "../../src/adapters/codex-agent.ts";
import { renameCodexSession } from "../../src/adapters/codex-session.ts";
import { noShellSandbox } from "../../src/adapters/no-shell-sandbox.ts";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { committed, input } from "../support/sandcastle.ts";

const enabled = process.env.CODEX_SESSION_INTEGRATION === "1";

test(
  "renames and reads back a probe-created persisted Codex session",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sandcastle-codex-session-"),
    );
    const codexHome = path.join(root, "codex-home");
    const gitConfigGlobal = path.join(root, "git-config");
    const logFile = path.join(root, "probe.log");
    await mkdir(codexHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      const taskPrompt = path.join(root, "task.md");
      await writeFile(taskPrompt, "Complete the integration task.", "utf8");
      let renamedSessionId = "";
      const executor = new SandcastleAgentExecutor(
        async (options) => {
          if (options.prompt === "Reply with exactly: SESSION_READY") {
            const probe = await runSandcastle({
              agent: codexWithRunnerEffort(input().model, input().effort),
              sandbox: noShellSandbox({
                env: { GIT_CONFIG_GLOBAL: gitConfigGlobal },
              }),
              cwd: process.cwd(),
              prompt: options.prompt,
              maxIterations: 1,
              completionSignal: ["SESSION_READY"],
              idleTimeoutSeconds: 120,
              branchStrategy: { type: "head" },
              logging: { type: "file", path: logFile },
            });
            return { ...probe, output: undefined };
          }
          if (options.resumeSession === undefined)
            throw new Error("task did not receive the probe session ID");
          assert.equal(options.resumeSession, renamedSessionId);
          return {
            iterations: [{ sessionId: options.resumeSession }],
            stdout: `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
            commits: [],
            branch: input().branch,
            output: committed,
          };
        },
        async () => {},
        async () => {},
        async () => {},
        async (renameInput, sessionId) => {
          renamedSessionId = sessionId;
          await renameCodexSession(renameInput, sessionId);
        },
      );

      await executor.execute({
        ...input(),
        worktree: process.cwd(),
        promptFile: taskPrompt,
        gitConfigGlobal,
        logFile,
        sessionName: "integration session name",
      });
      if (renamedSessionId === "") throw new Error("session was not renamed");

      const read = await request(codexHome, {
        id: 2,
        method: "thread/read",
        params: { threadId: renamedSessionId, includeTurns: false },
      });
      const result = read.result as { thread?: { name?: unknown } };
      assert.equal(result.thread?.name, "integration session name");
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);

async function request(
  codexHome: string,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const child = spawn("codex", ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      lines.on("line", (line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === message.id) {
            if (parsed.error !== undefined)
              reject(
                new Error(
                  `Codex request failed: ${JSON.stringify(parsed.error)}`,
                ),
              );
            else resolve(parsed);
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.once("error", (error) => reject(error));
      child.once("close", (code) =>
        reject(
          new Error(
            `Codex app-server exited with code ${code ?? "unknown"}: ${stderr.trim()}`,
          ),
        ),
      );
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "sandcastle-runner-integration-test",
            title: "Sandcastle Runner Integration Test",
            version: "0.1.0",
          },
        },
      })}\n`,
    );
    await waitForResponse(lines, 1);
    child.stdin.write('{"method":"initialized"}\n');
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return await response;
  } finally {
    lines.close();
    child.kill();
  }
}

function waitForResponse(
  lines: ReturnType<typeof createInterface>,
  id: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onLine = (line: string) => {
      try {
        const message = JSON.parse(line) as { id?: unknown; error?: unknown };
        if (message.id === id) {
          lines.off("line", onLine);
          if (message.error !== undefined)
            reject(
              new Error(
                `Codex initialize failed: ${JSON.stringify(message.error)}`,
              ),
            );
          else resolve();
        }
      } catch (error) {
        lines.off("line", onLine);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    lines.on("line", onLine);
  });
}
