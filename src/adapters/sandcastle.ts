/* eslint-disable max-lines */
import {
  type AgentProvider,
  Output,
  StructuredOutputError,
  run as runSandcastle,
} from "@ai-hero/sandcastle";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  formatStructuredCause,
  pullRequestMetadataRule,
  recoverStructuredOutput,
  replacePromptPlaceholders,
  resultSchema,
  reviewResultSchema,
  structuredDiagnostics,
  type StandardSchema,
} from "./sandcastle-output.ts";
import type {
  AgentAttemptInput,
  AgentDiagnostics,
  AgentExecutor,
  ReviewAttemptInput,
} from "../run/contracts.ts";
import { nativeAgent } from "./agent-provider.ts";
import { AgentOutputError } from "./process-errors.ts";
import { OperatorCancelled } from "../run/operations.ts";
import { superviseInvocation } from "./agent-supervision.ts";
import {
  cleanupFailure,
  ProcessCleanupError,
  sessionFromError,
  type SandcastleRun,
} from "./process-settlement.ts";

type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type PromptLogger = (logFile: string, prompt: string) => Promise<void>;
type StatusLogger = (logFile: string, message: string) => Promise<void>;

const delay: Delay = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

const runnerPromptDirectory = join(import.meta.dirname, "../prompts");
const promptSeparator = "===================================";
const logPrompt: PromptLogger = (logFile, prompt) =>
  appendFile(logFile, `${promptSeparator}\n${prompt}\n`, "utf8");
const logStatus: StatusLogger = (logFile, message) =>
  appendFile(logFile, `${message}\n`, "utf8");

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function isUsableSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function firstUsableSessionId(...values: unknown[]): string | undefined {
  return values.find(isUsableSessionId);
}

export class SandcastleAgentExecutor implements AgentExecutor {
  private readonly run: SandcastleRun;
  private readonly wait: Delay;
  private readonly logPrompt: PromptLogger;
  private readonly logStatus: StatusLogger;
  private readonly sessions = new Map<string, string>();
  private readonly replies = new Map<string, string>();

  constructor(
    run: SandcastleRun = runSandcastle as SandcastleRun,
    wait: Delay = delay,
    promptLogger: PromptLogger = logPrompt,
    statusLogger: StatusLogger = logStatus,
  ) {
    this.run = run;
    this.wait = wait;
    this.logPrompt = promptLogger;
    this.logStatus = statusLogger;
  }

  private async waitForContinuation(
    input: ReviewAttemptInput,
    recoveryAttempt: number,
  ): Promise<number | undefined> {
    if (input.signal.aborted) return undefined;
    const policy = input.retryPolicy;
    const backoff =
      policy.agentRetryDelay[
        Math.min(recoveryAttempt, policy.agentRetryDelay.length - 1)
      ]! * 1000;
    await this.logStatus(
      input.logFile,
      `Waiting ${backoff / 1000} seconds before automatic prompt continuation (retry ${recoveryAttempt + 1}/${policy.agentRetry}).`,
    );
    if (input.signal.aborted) return undefined;
    let resolveCancellation!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancellation = () => resolve();
      if (input.signal.aborted) resolve();
      else
        input.signal.addEventListener("abort", resolveCancellation, {
          once: true,
        });
    });
    try {
      await Promise.race([this.wait(backoff, input.signal), cancelled]);
    } catch (error) {
      if (error instanceof OperatorCancelled) throw error;
      if (input.signal.aborted) return undefined;
      throw error;
    } finally {
      input.signal.removeEventListener("abort", resolveCancellation);
    }
    return input.signal.aborted ? undefined : recoveryAttempt + 1;
  }

  private agentFailure(
    input: ReviewAttemptInput,
    provider: string,
    resumeSession: string | undefined,
    error: unknown,
    preserveMessage = false,
  ): AgentOutputError {
    const diagnostics: AgentDiagnostics = {
      errorCategory: "agent_retry",
      attemptOrdinal: 1,
      retryable: input.resumePrompt !== undefined ? false : true,
      provider,
      model: input.model,
      workingDirectory: input.worktree,
      ...(isUsableSessionId(resumeSession) ? { sessionId: resumeSession } : {}),
      diagnosticLogPath: input.logFile,
      raw: error instanceof Error ? error.message : String(error),
    };
    return new AgentOutputError(
      input.resumePrompt !== undefined && !preserveMessage
        ? "Provider session unavailable or unrecoverable for continuation"
        : error instanceof Error
          ? error.message
          : String(error),
      diagnostics,
    );
  }

  private stopFailure(
    input: ReviewAttemptInput,
    provider: string,
    resumeSession: string | undefined,
  ): Error | undefined {
    if (!input.signal.aborted) return undefined;
    const reason = abortReason(input.signal, "Agent Attempt cancelled");
    return reason instanceof OperatorCancelled
      ? reason
      : this.agentFailure(input, provider, resumeSession, reason, true);
  }

  private async prepareSession(
    input: ReviewAttemptInput,
    provider: AgentProvider,
  ): Promise<string> {
    const existing = this.sessions.get(input.logFile);
    if (existing !== undefined) return existing;

    let lastError: unknown;
    const policy = input.retryPolicy;
    for (let attempt = 0; attempt <= policy.operationRetry; attempt++) {
      if (input.signal.aborted)
        throw abortReason(input.signal, "Agent Attempt cancelled");
      try {
        await this.logPrompt(
          input.logFile,
          "Reply with exactly: SESSION_READY",
        );
        if (input.signal.aborted)
          throw abortReason(input.signal, "Agent Attempt cancelled");
        const invoke = () => {
          input.signal.throwIfAborted();
          return superviseInvocation(this.run, input, {
            agent: provider,
            cwd: input.worktree,
            name: input.runName,
            prompt: "Reply with exactly: SESSION_READY",
            maxIterations: 1,
            completionSignal: ["SESSION_READY"],
            branchStrategy: { type: "head" },
            logging: { type: "file", path: input.logFile },
          });
        };
        const invocation = await (input.advance?.(invoke) ?? invoke());
        const resultSessionId = invocation.result?.iterations.at(-1)?.sessionId;
        if (invocation.settlement.outcome === "failed")
          throw cleanupFailure(
            input,
            provider.name,
            firstUsableSessionId(
              resultSessionId,
              sessionFromError(invocation.runError),
              this.sessions.get(input.logFile),
            ),
            invocation.runError,
            invocation.settlement,
          );
        if (input.signal.aborted)
          throw abortReason(input.signal, "Agent Attempt cancelled");
        if (invocation.runError !== undefined) throw invocation.runError;
        const result = invocation.result;
        if (result === undefined)
          throw new Error("Sandcastle returned no probe result");
        const sessionId = result.iterations.at(-1)?.sessionId;
        if (!isUsableSessionId(sessionId))
          throw new Error("session probe returned no session ID");
        if (input.signal.aborted)
          throw abortReason(input.signal, "Agent Attempt cancelled");
        this.sessions.set(input.logFile, sessionId);
        return sessionId;
      } catch (error) {
        if (error instanceof ProcessCleanupError) throw error;
        if (input.signal.aborted)
          throw abortReason(input.signal, "Agent Attempt cancelled");
        if (error instanceof OperatorCancelled) throw error;
        lastError = error;
        if (attempt === policy.operationRetry) break;
        const delaySeconds =
          policy.operationRetryDelay[
            Math.min(attempt, policy.operationRetryDelay.length - 1)
          ]!;
        await this.wait(delaySeconds * 1000, input.signal);
        if (input.signal.aborted)
          throw abortReason(input.signal, "Agent Attempt cancelled");
      }
    }
    throw new AgentOutputError(
      `Agent session probe failed after ${policy.operationRetry} retries`,
      {
        errorCategory: "operation_retry",
        retryable: false,
        provider: provider.name,
        model: input.model,
        workingDirectory: input.worktree,
        diagnosticLogPath: input.logFile,
        raw: lastError instanceof Error ? lastError.message : String(lastError),
      },
    );
  }

  private async runOutput<T>(
    input: ReviewAttemptInput,
    tag: string,
    schema: StandardSchema<T>,
  ): Promise<T> {
    const provider = nativeAgent(input.agent, input.model, input.options);
    let resumeSession = this.sessions.get(input.logFile);
    let prompt = input.resumePrompt;
    const pullRequestMetadata =
      "pullRequestMetadata" in input
        ? (input as AgentAttemptInput).pullRequestMetadata
        : "ignored";
    const promptKind = tag === "review_attempt_result" ? "review" : "agent";
    const outputPrompt = replacePromptPlaceholders(
      await readFile(
        join(runnerPromptDirectory, `${promptKind}-attempt-output.md`),
        "utf8",
      ),
      {
        PULL_REQUEST_METADATA_RULE:
          pullRequestMetadataRule(pullRequestMetadata),
      },
    ).trim();
    if (prompt === undefined) {
      resumeSession ??= await this.prepareSession(input, provider);
      const template =
        input.promptFile === undefined
          ? ""
          : replacePromptPlaceholders(
              await readFile(input.promptFile, "utf8"),
              {
                ...input.promptArgs,
                SOURCE_BRANCH: input.branch,
                TARGET_BRANCH: String(input.targetBranch),
              },
            );
      const context = replacePromptPlaceholders(
        await readFile(
          join(
            runnerPromptDirectory,
            input.promptArgs.TARGET_BRANCH_SHA === undefined
              ? input.promptArgs.FAILED_CHECKS === undefined
                ? `${promptKind}-attempt-input.md`
                : "ci-repair-input.md"
              : "conflict-repair-input.md",
          ),
          "utf8",
        ),
        {
          ...input.promptArgs,
          ATTEMPT_INPUT: JSON.stringify({
            ...input.promptArgs,
            TICKET_NUMBER: input.ticket,
            WORKTREE_PATH: input.worktree,
            SOURCE_BRANCH: input.branch,
            BASE_SHA: input.base,
            PROJECT_TARGET_BRANCH: input.targetBranch,
          }),
        },
      );
      prompt = [context.trimEnd(), template.trimEnd(), outputPrompt]
        .filter(Boolean)
        .join("\n\n");
    }
    if (prompt !== undefined && !isUsableSessionId(resumeSession)) {
      throw new AgentOutputError(
        "Provider session unavailable for continuation",
        {
          errorCategory: "agent_retry",
          retryable: false,
          provider: provider.name,
          model: input.model,
          workingDirectory: input.worktree,
          diagnosticLogPath: input.logFile,
        },
      );
    }
    let result: Awaited<ReturnType<SandcastleRun>>;
    let recoveryAttempt = 0;
    const policy = input.retryPolicy;
    let structuredRetryRemaining = policy.agentRetry;
    let structuredRetryAttempt = 0;
    for (;;) {
      const stopBeforePrompt = this.stopFailure(
        input,
        provider.name,
        resumeSession,
      );
      if (stopBeforePrompt !== undefined) throw stopBeforePrompt;
      const normalizedPrompt = prompt.trimEnd();
      const runPrompt = normalizedPrompt.endsWith(outputPrompt)
        ? prompt
        : `${normalizedPrompt}\n\n${outputPrompt}`;
      await this.logPrompt(input.logFile, runPrompt);
      const stopBeforeInvocation = this.stopFailure(
        input,
        provider.name,
        resumeSession,
      );
      if (stopBeforeInvocation !== undefined) throw stopBeforeInvocation;
      try {
        const invoke = () => {
          const stopped = this.stopFailure(input, provider.name, resumeSession);
          if (stopped !== undefined) throw stopped;
          return superviseInvocation(this.run, input, {
            agent: provider,
            cwd: input.worktree,
            name: input.runName,
            prompt: runPrompt,
            maxIterations: 1,
            completionSignal: [],
            branchStrategy: { type: "head" },
            logging: { type: "file", path: input.logFile },
            output: Output.object({
              tag,
              schema,
              maxRetries: 0,
            }),
            ...(isUsableSessionId(resumeSession) ? { resumeSession } : {}),
          });
        };
        const invocation = await (input.advance?.(invoke) ?? invoke());
        if (invocation.settlement.outcome === "failed")
          throw cleanupFailure(
            input,
            provider.name,
            firstUsableSessionId(
              invocation.result?.iterations.at(-1)?.sessionId,
              sessionFromError(invocation.runError),
              resumeSession,
            ),
            invocation.runError,
            invocation.settlement,
          );
        const stopped = this.stopFailure(input, provider.name, resumeSession);
        if (stopped !== undefined) throw stopped;
        if (invocation.runError !== undefined) throw invocation.runError;
        if (invocation.result === undefined)
          throw new Error("Sandcastle returned no invocation result");
        result = invocation.result;
      } catch (error) {
        if (
          error instanceof ProcessCleanupError ||
          error instanceof OperatorCancelled
        )
          throw error;
        const stopped = this.stopFailure(input, provider.name, resumeSession);
        if (stopped !== undefined) throw stopped;
        if (error instanceof StructuredOutputError) {
          await this.logStatus(
            input.logFile,
            `Structured output validation failed; retryRemaining=${structuredRetryRemaining}; raw=${error.rawMatched ?? "<none>"}; issues=${formatStructuredCause(error.cause)}`,
          );
          const stopAfterValidation = this.stopFailure(
            input,
            provider.name,
            firstUsableSessionId(error.sessionId, resumeSession),
          );
          if (stopAfterValidation !== undefined) throw stopAfterValidation;
          if (
            structuredRetryRemaining > 0 &&
            isUsableSessionId(error.sessionId)
          ) {
            structuredRetryRemaining -= 1;
            const nextRecoveryAttempt = await this.waitForContinuation(
              input,
              structuredRetryAttempt,
            );
            if (nextRecoveryAttempt === undefined) {
              const failed = this.stopFailure(
                input,
                provider.name,
                error.sessionId,
              );
              if (failed !== undefined) throw failed;
              throw this.agentFailure(
                input,
                provider.name,
                error.sessionId,
                error,
              );
            }
            structuredRetryAttempt = nextRecoveryAttempt;
            prompt = [
              `The previous structured output failed validation. Specific validation errors: ${formatStructuredCause(error.cause)}`,
              "Re-emit exactly one corrected result using the complete output protocol below.",
              outputPrompt,
            ].join("\n\n");
            resumeSession = error.sessionId;
            await this.logStatus(
              input.logFile,
              `Starting structured output retry; retryRemaining=${structuredRetryRemaining}; resumeSession=${error.sessionId}`,
            );
            continue;
          }
          const recovered = recoverStructuredOutput(error, schema);
          if (recovered !== undefined) {
            await this.logStatus(
              input.logFile,
              "Recovered the final structured output from the retry result.",
            );
            const stopped = this.stopFailure(
              input,
              provider.name,
              isUsableSessionId(error.sessionId)
                ? error.sessionId
                : resumeSession,
            );
            if (stopped !== undefined) throw stopped;
            const diagnostics = structuredDiagnostics(
              input,
              error,
              provider.name,
            );
            Object.defineProperty(recovered, "diagnostics", {
              value: diagnostics,
              enumerable: false,
              configurable: true,
            });
            return recovered;
          }
          const diagnostics = structuredDiagnostics(
            input,
            error,
            provider.name,
          );
          diagnostics.error =
            formatStructuredCause(error.cause) || error.message;
          throw new AgentOutputError(error.message, diagnostics);
        }
        if (
          // Recovery is state-based; Sandcastle error text is deliberately opaque.
          !input.signal.aborted &&
          isUsableSessionId(resumeSession) &&
          recoveryAttempt < policy.agentRetry
        ) {
          const nextRecoveryAttempt = await this.waitForContinuation(
            input,
            recoveryAttempt,
          );
          if (nextRecoveryAttempt === undefined) {
            const failed = this.stopFailure(
              input,
              provider.name,
              resumeSession,
            );
            if (failed !== undefined) throw failed;
            throw this.agentFailure(
              input,
              provider.name,
              resumeSession,
              input.signal.reason ?? error,
            );
          }
          recoveryAttempt = nextRecoveryAttempt;
          prompt = "continue";
          resumeSession = this.sessions.get(input.logFile) ?? resumeSession;
          continue;
        }
        throw this.agentFailure(input, provider.name, resumeSession, error);
      }
      const sessionId = result.iterations.at(-1)?.sessionId;
      if (isUsableSessionId(sessionId))
        this.sessions.set(input.logFile, sessionId);
      const openingTags = result.stdout.split(`<${tag}>`).length - 1;
      const closingTags = result.stdout.split(`</${tag}>`).length - 1;
      if (
        openingTags !== 0 ||
        closingTags !== 0 ||
        recoveryAttempt === policy.agentRetry
      )
        break;
      const nextRecoveryAttempt = await this.waitForContinuation(
        input,
        recoveryAttempt,
      );
      if (nextRecoveryAttempt === undefined) {
        const failed = this.stopFailure(input, provider.name, resumeSession);
        if (failed !== undefined) throw failed;
        throw this.agentFailure(
          input,
          provider.name,
          resumeSession,
          input.signal.reason,
        );
      }
      recoveryAttempt = nextRecoveryAttempt;
      prompt = "continue";
      resumeSession = this.sessions.get(input.logFile) ?? resumeSession;
    }
    const openingTags = result.stdout.split(`<${tag}>`).length - 1;
    const closingTags = result.stdout.split(`</${tag}>`).length - 1;
    const sessionId = result.iterations.at(-1)?.sessionId;
    if (isUsableSessionId(sessionId))
      this.sessions.set(input.logFile, sessionId);
    const assistantReply = result.stdout.trim() || undefined;
    const previousAssistantReply = this.replies.get(input.logFile);
    if (assistantReply) this.replies.set(input.logFile, assistantReply);
    const diagnostics: AgentDiagnostics = {
      ...(input.promptArgs.OPERATION === undefined
        ? {}
        : { operation: input.promptArgs.OPERATION.toString() }),
      errorCategory: "agent_retry",
      attemptOrdinal: 1,
      retryable: true,
      ...(input.promptArgs.RUN_ID === undefined
        ? {}
        : { runId: input.promptArgs.RUN_ID.toString() }),
      provider: provider.name,
      model: input.model,
      workingDirectory: input.worktree,
      ...(isUsableSessionId(sessionId) ? { sessionId } : {}),
      ...(assistantReply === undefined ? {} : { assistantReply }),
      ...(previousAssistantReply === undefined
        ? {}
        : { previousAssistantReply }),
      diagnosticLogPath: input.logFile,
      raw: result.stdout,
    };
    if (
      (openingTags !== 1 || closingTags !== 1) &&
      result.iterations.length === 1
    )
      throw new AgentOutputError(
        "Agent Attempt output must contain exactly one result tag",
        diagnostics,
      );
    if (typeof result.output === "object" && result.output !== null) {
      Object.defineProperty(result.output, "diagnostics", {
        value: diagnostics,
        enumerable: false,
        configurable: true,
      });
    }
    return result.output as T;
  }

  execute(input: Parameters<AgentExecutor["execute"]>[0]) {
    return this.runOutput(
      input,
      "agent_attempt_result",
      resultSchema(input.pullRequestMetadata),
    );
  }

  executeReview(input: Parameters<AgentExecutor["executeReview"]>[0]) {
    return this.runOutput(input, "review_attempt_result", reviewResultSchema());
  }
}
