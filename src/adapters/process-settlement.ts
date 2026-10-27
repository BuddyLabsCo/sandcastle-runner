import type { RunOptions, RunResult } from "@ai-hero/sandcastle";

import type { ReviewAttemptInput } from "../run/contracts.ts";
import type {
  NoShellSandboxProvider,
  ProcessSettlement,
} from "./no-shell-sandbox.ts";
import { AgentOutputError } from "./process-errors.ts";

export type SandcastleRun = (
  options: RunOptions,
) => Promise<RunResult & { output: unknown }>;

export interface Invocation {
  result?: RunResult & { output: unknown };
  runError?: Error;
  settlement: ProcessSettlement;
  takeoverSession?: string;
}

export class ProcessCleanupError extends AgentOutputError {}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("Sandcastle rejected with a non-Error value");
}

export async function invokeSandbox(
  run: SandcastleRun,
  options: RunOptions,
): Promise<Invocation> {
  const sandbox = options.sandbox as NoShellSandboxProvider;
  let result: Invocation["result"];
  let runError: Error | undefined;
  try {
    result = await run(options);
  } catch (error) {
    runError = asError(error);
  }
  let settlement: ProcessSettlement;
  try {
    settlement = await sandbox.settle();
  } catch (error) {
    settlement = { outcome: "failed", error: asError(error).message };
  }
  return {
    ...(result === undefined ? {} : { result }),
    ...(runError === undefined ? {} : { runError }),
    settlement,
  };
}

export function cleanupFailure(
  input: ReviewAttemptInput,
  provider: string,
  sessionId: string | undefined,
  runError: Error | undefined,
  settlement: Extract<ProcessSettlement, { outcome: "failed" }>,
): ProcessCleanupError {
  const message = `Agent process cleanup failed; automatic continuation blocked: ${settlement.error}`;
  return new ProcessCleanupError(message, {
    errorCategory: "process_cleanup",
    retryable: false,
    provider,
    model: input.model,
    workingDirectory: input.worktree,
    ...(sessionId === undefined ? {} : { sessionId }),
    diagnosticLogPath: input.logFile,
    error: message,
    raw: [runError?.message, `cleanup: ${settlement.error}`]
      .filter((value): value is string => value !== undefined)
      .join("\n"),
  });
}

export function sessionFromError(error: Error | undefined): string | undefined {
  if (error === undefined) return undefined;
  const sessionId = (error as Error & { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}
