import type { RunOptions } from "@ai-hero/sandcastle";

import type { ReviewAttemptInput } from "../run/contracts.ts";
import { noShellSandbox } from "./no-shell-sandbox.ts";
import {
  invokeSandbox,
  type Invocation,
  type SandcastleRun,
} from "./process-settlement.ts";

export async function superviseInvocation(
  run: SandcastleRun,
  input: ReviewAttemptInput,
  options: Omit<RunOptions, "sandbox" | "signal" | "idleTimeoutSeconds">,
): Promise<Invocation> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const pauses = new Set<Promise<void>>();
  let pauseError: Error | undefined;
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout>;
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (!finished && !signal.aborted && pauses.size === 0)
      idleTimer = setTimeout(() => requestPause("idle"), input.idleTimeoutMs);
  };
  const requestPause = (cause: "idle" | "overall") => {
    if (finished || signal.aborted) return;
    clearTimeout(idleTimer);
    // Register the intervention synchronously, before a racing result can advance.
    const pause = input
      .pauseForTimeout(cause)
      .catch((error: unknown) => {
        pauseError = error instanceof Error ? error : new Error(String(error));
        controller.abort(pauseError);
      })
      .finally(() => {
        pauses.delete(pause);
        armIdle();
      });
    pauses.add(pause);
  };
  const sandbox = noShellSandbox({
    env: { GIT_CONFIG_GLOBAL: input.gitConfigGlobal },
    onActivity: armIdle,
  });
  const overallTimer = setTimeout(
    () => requestPause("overall"),
    input.timeoutMs,
  );
  armIdle();
  let invocation: Invocation;
  try {
    invocation = await invokeSandbox(run, {
      ...options,
      sandbox,
      signal,
      idleTimeoutSeconds: Infinity,
    });
  } finally {
    finished = true;
    clearTimeout(idleTimer!);
    clearTimeout(overallTimer);
  }
  let onAbort!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    onAbort = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.all(pauses), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (invocation.settlement.outcome === "failed") return invocation;
  if (pauseError) return { ...invocation, runError: pauseError };
  await input.advance?.(() => Promise.resolve());
  return invocation;
}
