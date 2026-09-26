import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

import { renameCodexSession } from "../../src/adapters/codex-session-name.ts";
import { spawnCommand } from "../../src/adapters/no-shell-sandbox.ts";

// Opt in with CODEX_SESSION_NAME_INTEGRATION=1. Uses existing Codex credentials
// and storage, creates one disposable probe, and archives only that probe.
// Regression: a mocked protocol cannot prove that a name survives process exit
// or that the configured provider and the naming helper use the same storage.
test(
  "persists a name on one real Codex probe session",
  {
    skip: process.env.CODEX_SESSION_NAME_INTEGRATION !== "1",
    timeout: 120_000,
  },
  async (t) => {
    const signal = AbortSignal.timeout(100_000);
    const worktree = process.cwd();
    const children: { child: ChildProcess; closed: Promise<void> }[] = [];
    t.after(async () => {
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await closed;
      }
    });
    const launch = (args: string[]) => {
      const command = spawnCommand("codex", args, process.env);
      const child = spawn(command.file, command.args, {
        cwd: worktree,
        stdio: ["pipe", "pipe", "ignore"],
        signal,
        killSignal: "SIGKILL",
      });
      children.push({
        child,
        closed: new Promise<void>((resolve) =>
          child.once("close", () => resolve()),
        ),
      });
      return child;
    };

    // No --ephemeral: the production helper must find this persisted session.
    const probe = launch([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "Reply with exactly SESSION_READY",
    ]);
    const probeLines = createInterface({ input: probe.stdout });
    let sessionId: string | undefined;
    let reply: string | undefined;
    await new Promise<void>((resolve, reject) => {
      probe.once("error", () =>
        reject(new Error("Codex probe launch failed or timed out")),
      );
      probeLines.on("line", (line) => {
        try {
          const event = JSON.parse(line) as {
            type: string;
            thread_id?: string;
            item?: { type: string; text?: string };
          };
          if (event.type === "thread.started") {
            sessionId = event.thread_id;
            t.diagnostic(`Probe session ID: ${sessionId}`);
          }
          if (
            event.type === "item.completed" &&
            event.item?.type === "agent_message"
          )
            reply = event.item.text;
        } catch {
          reject(new Error("Invalid Codex probe JSON output"));
        }
      });
      probe.once("close", (code) => {
        probeLines.close();
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Codex probe failed (exit ${code}); session ${sessionId ?? "unavailable"}`,
            ),
          );
      });
      probe.stdin.end();
    });
    assert.ok(sessionId, "Probe must return its persisted session ID");
    assert.equal(reply?.trim(), "SESSION_READY");
    const name = `Issue #169 disposable rename probe ${sessionId}`;
    await renameCodexSession(sessionId, name, {
      worktree,
      timeoutMs: 15_000,
      signal,
    });

    // A fresh app server proves persistence, rather than a cached notification.
    const server = launch(["app-server"]);
    const lines = createInterface({ input: server.stdout });
    t.after(() => lines.close());
    let nextId = 0;
    const pending = new Map<
      number,
      { resolve: (result: unknown) => void; reject: (error: Error) => void }
    >();
    const fail = (error: Error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    server.once("error", () =>
      fail(new Error("Codex readback server failed or timed out")),
    );
    server.once("close", () => fail(new Error("Codex readback server closed")));
    server.stdin.on("error", () =>
      fail(new Error("Codex readback input failed")),
    );
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { code: number };
        };
        if (message.id === undefined) return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error)
          request.reject(
            new Error(`Codex readback RPC failed (${message.error.code})`),
          );
        else request.resolve(message.result);
      } catch {
        fail(new Error("Invalid Codex readback JSON output"));
      }
    });
    const request = (method: string, params: object) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    await request("initialize", {
      clientInfo: { name: "sandcastle_runner_integration", version: "1.0.0" },
    });
    server.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
    try {
      const result = (await request("thread/read", {
        threadId: sessionId,
        includeTurns: false,
      })) as { thread: { id: string; name: string | null } };
      assert.equal(result.thread.id, sessionId);
      assert.equal(result.thread.name, name);
      t.diagnostic(
        JSON.stringify({ sessionId, reply, nameReadback: result.thread.name }),
      );
    } finally {
      await request("thread/archive", { threadId: sessionId });
      t.diagnostic(`Archived disposable probe: ${sessionId}`);
    }
  },
);
