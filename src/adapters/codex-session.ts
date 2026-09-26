import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ReviewAttemptInput } from "../run/contracts.ts";

export type SessionRenamer = (
  input: ReviewAttemptInput,
  sessionId: string,
) => Promise<void>;

function protocolError(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(value);
}

export const renameCodexSession: SessionRenamer = (input, sessionId) =>
  new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      cwd: input.worktree,
      env: { ...process.env, GIT_CONFIG_GLOBAL: input.gitConfigGlobal },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Codex app-server session rename timed out")),
      Math.min(input.timeoutMs, 10_000),
    );

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      lines.close();
      const settle = () => {
        if (error === undefined) resolve();
        else reject(error);
      };
      if (child.exitCode !== null) settle();
      else {
        child.once("close", settle);
        child.kill();
      }
    };

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const onAbort = () =>
      finish(
        input.signal.reason instanceof Error
          ? input.signal.reason
          : new Error("session rename aborted"),
      );

    input.signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.resume();
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (!settled)
        finish(
          new Error(
            `Codex app-server exited before session rename (code ${code ?? "unknown"})`,
          ),
        );
    });
    lines.on("line", (line) => {
      if (settled) return;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null)
          throw new Error("invalid app-server response");
        message = parsed as Record<string, unknown>;
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error !== undefined) {
        finish(
          new Error(
            `Codex app-server request failed: ${protocolError(message.error)}`,
          ),
        );
        return;
      }
      if (message.id === 1) {
        send({ method: "initialized" });
        send({
          id: 2,
          method: "thread/name/set",
          params: { threadId: sessionId, name: input.sessionName },
        });
      } else {
        finish();
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "sandcastle-runner",
          title: "Sandcastle Runner",
          version: "0.1.0",
        },
      },
    });
  });
