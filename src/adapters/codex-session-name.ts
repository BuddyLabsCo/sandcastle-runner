import childProcess from "node:child_process";
import { createInterface } from "node:readline";

import { spawnCommand } from "./no-shell-sandbox.ts";

export async function renameCodexSession(
  sessionId: string,
  name: string,
  input: { worktree: string; timeoutMs: number; signal: AbortSignal },
): Promise<void> {
  input.signal.throwIfAborted();
  if (
    !Number.isFinite(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 2_147_483_647
  ) {
    throw new Error("Invalid Codex session rename timeout");
  }

  // Inherit the probe's Codex configuration/storage; no thread resume or model turn.
  const launched = spawnCommand("codex", ["app-server"], process.env);
  const child = childProcess.spawn(launched.file, launched.args, {
    cwd: input.worktree,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let failure: Error | undefined;
    let expectedId = 0;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      failure = error;
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    const abort = () =>
      finish(
        new Error("Codex session rename aborted", {
          cause: input.signal.reason,
        }),
      );
    const timeout = setTimeout(
      () => finish(new Error("Codex session rename timed out")),
      input.timeoutMs,
    );
    child.once("error", finish);
    child.stdin.on("error", finish);
    child.stdout.on("error", finish);
    child.once("close", (code, signal) => {
      if (!finished)
        finish(
          new Error(
            `Codex app-server exited before rename acknowledgement (${code ?? signal})`,
          ),
        );
      if (failure) reject(failure);
      else resolve();
    });
    lines.on("line", (line) => {
      if (finished) return;
      try {
        const message: unknown = JSON.parse(line);
        if (typeof message !== "object" || message === null)
          throw new Error("Invalid Codex app-server response");
        if (!("id" in message) || message.id !== expectedId) return;
        if ("error" in message) {
          throw new Error(
            `Codex app-server request failed: ${JSON.stringify(message.error)}`,
          );
        }
        if (
          !("result" in message) ||
          typeof message.result !== "object" ||
          message.result === null ||
          Array.isArray(message.result)
        ) {
          throw new Error("Invalid Codex app-server acknowledgement");
        }
        if (expectedId === 0) {
          expectedId = 1;
          child.stdin.write(
            `${JSON.stringify({ method: "initialized", params: {} })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({ id: 1, method: "thread/name/set", params: { threadId: sessionId, name } })}\n`,
          );
        } else {
          finish();
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    else
      child.stdin.write(
        `${JSON.stringify({ id: 0, method: "initialize", params: { clientInfo: { name: "sandcastle_runner", version: "1.0.0" } } })}\n`,
      );
  });
}
