import type { AgentProvider, RunOptions } from "@ai-hero/sandcastle";

import type {
  AgentTimeoutIntervention,
  ReviewAttemptInput,
} from "../run/contracts.ts";
import { noShellSandbox } from "./no-shell-sandbox.ts";
import {
  cleanupFailure,
  invokeSandbox,
  type Invocation,
  type SandcastleRun,
} from "./process-settlement.ts";

async function prepareNativeTakeover(
  input: ReviewAttemptInput,
  provider: AgentProvider,
  sessionId: string | undefined,
  invocation: Invocation,
): ReturnType<AgentTimeoutIntervention["kill"]> {
  if (invocation.settlement.outcome === "failed")
    throw cleanupFailure(
      input,
      provider.name,
      sessionId,
      invocation.runError,
      invocation.settlement,
    );
  let transcript: string | undefined;
  try {
    if (sessionId)
      transcript = (await provider.sessionStorage?.findByIdOnHost(sessionId))
        ?.path;
  } catch {
    return {
      continuable: false,
      message:
        "Selected CLI and owned descendants settled, but the native session is unavailable because lookup in the configured storage failed. Check the selected agent profile and missing or ambiguous native transcripts. Manual takeover and continuation are blocked.",
    };
  }
  return {
    continuable: Boolean(sessionId && transcript),
    message:
      sessionId && transcript
        ? [
            "Selected CLI and owned descendants settled. Runner remains paused for manual native resume.",
            `Provider: ${provider.name}`,
            `Exact native session: ${sessionId}`,
            `Working directory: ${input.worktree}`,
            `Native transcript: ${transcript}`,
            "Native storage: reuse the Project agent profile's storage/home overrides and environment.",
            `GIT_CONFIG_GLOBAL: ${input.gitConfigGlobal}`,
            `Diagnostic log: ${input.logFile}`,
            "Keep only one session writer. This does not answer the terminated process's approval request.",
          ].join("\n")
        : "Selected CLI and owned descendants settled, but the native session is unavailable or its configured storage is missing or ambiguous. Manual takeover and continuation are blocked.",
  };
}

async function waitForPauses(
  pauses: Set<Promise<void>>,
  signal: AbortSignal,
): Promise<void> {
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
}

export async function superviseInvocation(
  run: SandcastleRun,
  input: ReviewAttemptInput,
  options: Omit<RunOptions, "sandbox" | "signal" | "idleTimeoutSeconds">,
): Promise<Invocation> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const pauses = new Set<Promise<void>>();
  let sessionId = options.resumeSession;
  let killed = false;
  let invocationPromise: Promise<Invocation>;
  const started = Date.now();
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
      .pauseForTimeout(cause, {
        describe: () =>
          `Invocation: ${input.runName}. Provider: ${options.agent.name}. Native session: ${sessionId ?? "unavailable"}. State: ${finished ? "retained outcome" : "running"}; elapsed ${Date.now() - started} ms; idle threshold ${input.idleTimeoutMs} ms; overall threshold ${input.timeoutMs} ms.`,
        kill: async () => {
          killed = true;
          controller.abort(new Error("operator stopped selected invocation"));
          const stopped = await invocationPromise;
          sessionId ??= stopped.result?.iterations.at(-1)?.sessionId;
          return prepareNativeTakeover(
            input,
            options.agent,
            sessionId,
            stopped,
          );
        },
      })
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
    invocationPromise = invokeSandbox(run, {
      ...options,
      agent: {
        ...options.agent,
        parseStreamLine(line) {
          const events = options.agent.parseStreamLine(line);
          for (const event of events)
            if (event.type === "session_id" && event.sessionId.trim())
              sessionId ??= event.sessionId;
          return events;
        },
      },
      sandbox,
      signal,
      idleTimeoutSeconds: Infinity,
    });
    invocation = await invocationPromise;
  } finally {
    finished = true;
    clearTimeout(idleTimer!);
    clearTimeout(overallTimer);
  }
  await waitForPauses(pauses, input.signal);
  if (invocation.settlement.outcome === "failed") return invocation;
  if (pauseError) return { ...invocation, runError: pauseError };
  await input.advance?.(() => Promise.resolve());
  return killed && sessionId
    ? { ...invocation, takeoverSession: sessionId }
    : invocation;
}
