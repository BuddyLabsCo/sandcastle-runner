import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { renameCodexSession } from "../../src/adapters/codex-session.ts";
import { input } from "../support/sandcastle.ts";

const enabled = process.env.CODEX_SESSION_INTEGRATION === "1";

test(
  "renames and reads back a persisted Codex session",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sandcastle-codex-session-"),
    );
    const codexHome = path.join(root, "codex-home");
    const gitConfigGlobal = path.join(root, "git-config");
    await mkdir(codexHome, { recursive: true });
    await writeFile(gitConfigGlobal, "", "utf8");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;

    try {
      const sessionId = await request(codexHome, {
        id: 2,
        method: "thread/start",
        params: { cwd: input().worktree },
      }).then((message) => {
        const result = message.result as {
          thread?: { id?: unknown };
          threadId?: unknown;
        };
        const id = result.thread?.id ?? result.threadId;
        if (typeof id !== "string")
          throw new Error("thread/start returned no thread ID");
        return id;
      });

      await renameCodexSession(
        {
          ...input(),
          gitConfigGlobal,
          sessionName: "integration session name",
        },
        sessionId,
      );

      const read = await request(codexHome, {
        id: 2,
        method: "thread/read",
        params: { threadId: sessionId, includeTurns: false },
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
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    lines.on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.id === message.id) resolve(parsed);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("error", reject);
    child.once("close", (code) =>
      reject(
        new Error(
          `Codex app-server exited with code ${code ?? "unknown"}: ${stderr.trim()}`,
        ),
      ),
    );
  });
  child.stderr.resume();
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
  const result = await response;
  lines.close();
  child.kill();
  return result;
}

function waitForResponse(
  lines: ReturnType<typeof createInterface>,
  id: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onLine = (line: string) => {
      try {
        const message = JSON.parse(line) as { id?: unknown };
        if (message.id === id) {
          lines.off("line", onLine);
          resolve();
        }
      } catch (error) {
        lines.off("line", onLine);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    lines.on("line", onLine);
  });
}
