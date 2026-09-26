import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { input } from "../support/sandcastle.ts";

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
      await writeFile(
        taskPrompt,
        'Do not modify files. Return a no_change result with summary "integration check".',
        "utf8",
      );
      const executor = new SandcastleAgentExecutor();
      await executor.execute({
        ...input(),
        worktree: process.cwd(),
        promptFile: taskPrompt,
        gitConfigGlobal,
        logFile,
        sessionName: "integration session name",
      });
      const listed = await request(codexHome, {
        id: 2,
        method: "thread/list",
        params: { limit: 20 },
      });
      const threads = (listed.result as { data?: unknown[] }).data ?? [];
      const session = threads.find(
        (thread): thread is { id?: unknown; name?: unknown } =>
          typeof thread === "object" &&
          thread !== null &&
          (thread as { name?: unknown }).name === "integration session name",
      );
      if (session === undefined || typeof session.id !== "string")
        throw new Error("renamed integration session was not listed");

      const read = await request(codexHome, {
        id: 2,
        method: "thread/read",
        params: { threadId: session.id, includeTurns: false },
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
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error("Codex app-server request timed out")),
        10_000,
      );
    });
    try {
      return await Promise.race([response, deadline]);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  } finally {
    await stopChild(child, lines);
  }
}

async function stopChild(
  child: ReturnType<typeof spawn>,
  lines: ReturnType<typeof createInterface>,
): Promise<void> {
  lines.close();
  child.stdin?.destroy();
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
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
