import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuditEvent } from "../audit.ts";
import type { AgentConfig } from "../config.ts";
import { agentLogFile, agentLogStage } from "./agent-logs.ts";
import {
  agentPauseMessage,
  pauseAgentAttempt,
  skipTicketAgentAttempt,
  TicketSkipped,
  ticketAgentContinueActions,
  ticketAgentRetryActions,
} from "./agent-pause.ts";
import type {
  AgentAttemptResult,
  AgentDiagnostics,
  AgentExecutor,
  CommitEvidence,
  GitWorkspace,
} from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  type DiscoveryInput,
  revalidateActiveTicket,
  revalidateMergedTicket,
  releaseTerminalTicket,
} from "./discovery.ts";
import {
  advance,
  externalRead,
  OperatorCancelled,
  pauseForAgentTimeout,
  workflowWrite,
} from "./operations.ts";
import { appendOperation, discardAgentLogs } from "./operation-audit.ts";
import { showProgress, type ProgressPhase } from "./progress.ts";

export { agentPauseMessage } from "./agent-pause.ts";

export interface VerifiedHandoff {
  ticket: number;
  worktree: string;
  branch: string;
  base: string;
  commits: CommitEvidence[];
  checks: AgentAttemptResult["checks"];
  prTitle: string;
  prBody: string;
  verification: "verified" | "operator_override";
  implementationCommits?: CommitEvidence[];
  reviewCommits?: CommitEvidence[];
  reviewChecks?: AgentAttemptResult["checks"];
  reviewVerification?: "verified" | "operator_override";
  remoteBranch?: string;
}

export interface AgentOperationInput extends DiscoveryInput {
  runId: string;
  targetBranch: string;
  projectDirectory: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  gitWorkspace: GitWorkspace;
  agentExecutor: AgentExecutor;
}

export interface AgentSession {
  logFile?: string;
  resumePrompt?: string;
}

export interface AttemptInput extends AgentOperationInput {
  batch: number[];
  checkout: string;
  promptFile: string;
  agent: AgentConfig;
  review: boolean;
  maxReviewRounds?: number;
  reviewPrompt: string;
  reviewAgent?: AgentConfig;
}

export interface AttemptBatchResult {
  outcome: "incomplete" | "cancelled" | "failed";
  reasons: string[];
  handoffs: VerifiedHandoff[];
  tickets: TicketAttemptOutcome[];
}

export interface TicketAttemptOutcome {
  ticket: number;
  outcome:
    "handoff" | "no_change" | "blocked" | "failed" | "cancelled" | "skipped";
  detail: string;
  skipReason?: string;
  handoff?: VerifiedHandoff;
}

type AgentStop =
  | { outcome: "blocked"; reason: string }
  | { outcome: "no_change"; reason: string };

export type MaintenanceAttemptResult =
  | { outcome: "committed"; handoff: VerifiedHandoff }
  | AgentStop
  | { outcome: "skipped"; reason: string; skipReason: string }
  | {
      outcome: "boundary";
      boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;
    };

export class BoundaryStop extends Error {
  readonly result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;

  constructor(result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>) {
    super(result.reason);
    this.result = result;
  }
}

export async function boundary(
  input: AgentOperationInput,
  ticket: number,
): Promise<void> {
  const result = await advance(input.operator, () =>
    revalidateActiveTicket(input, ticket),
  );
  if (result.outcome !== "ready") throw new BoundaryStop(result);
}

export async function observePausedAttempt(
  input: AgentOperationInput,
  ticket: number,
  releaseIntervention?: () => void,
): Promise<void> {
  // Observe without terminal cleanup, which must wait until this pause is released.
  const result = await revalidateMergedTicket(input, ticket);
  if (result.outcome === "ready") return;
  releaseIntervention?.();
  if (result.outcome === "terminal") {
    await releaseTerminalTicket(input, result.ticket);
    throw new BoundaryStop({
      outcome: "stopped",
      reason: `${input.ticketKind ?? "Delivery Ticket"} ${ticket} became terminal`,
    });
  }
  throw new BoundaryStop(result);
}

function sameCommits(
  claimed: CommitEvidence[],
  actual: CommitEvidence[],
): boolean {
  return (
    claimed.length === actual.length &&
    claimed.every(
      (commit, index) =>
        commit.sha === actual[index]?.sha &&
        commit.message === actual[index]?.message,
    )
  );
}

export async function runAgentOperation(
  input: AgentOperationInput,
  operation: {
    phase: "implement" | "ci_repair" | "conflict_repair" | "maintenance";
    progress: ProgressPhase;
    runName: string;
    ticket: number;
    worktree: string;
    branch: string;
    base: string;
    requiredAncestor?: string;
    promptFile?: string;
    promptArgs: Record<string, string | number>;
    pullRequestMetadata: "required" | "required_for_committed" | "ignored";
    existingPrMetadata?: Pick<VerifiedHandoff, "prTitle" | "prBody">;
    agent: AgentConfig;
    signal: AbortSignal;
    attemptCounter: { value: number };
    session?: AgentSession;
  },
): Promise<VerifiedHandoff | AgentStop> {
  let continuationPrompt = operation.session?.resumePrompt;
  let executions = 0;
  let attemptNumber!: number;
  let attemptId = "";
  let logFile = "";
  let event!: Omit<AuditEvent, "result" | "error">;
  const pause = (message: string, continuable = true) =>
    pauseAgentAttempt(input, event, message, continuable);
  for (;;) {
    await boundary(input, operation.ticket);
    const resumePrompt = continuationPrompt;
    continuationPrompt = undefined;
    if (attemptNumber === undefined || resumePrompt === undefined) {
      operation.attemptCounter.value += 1;
      attemptNumber = operation.attemptCounter.value;
      attemptId = randomUUID();
      logFile =
        (resumePrompt === undefined ? undefined : operation.session?.logFile) ??
        agentLogFile(
          input.projectDirectory,
          operation.ticket,
          agentLogStage(operation.phase),
          `${input.runId}-${attemptId}`,
        );
      if (operation.session) operation.session.logFile = logFile;
      event = input.event(
        operation.phase,
        "agent_attempt",
        `ticket:${operation.ticket}`,
      )(attemptNumber);
    }
    await appendOperation(
      input,
      event,
      "started",
      null,
      undefined,
      resumePrompt === undefined ? undefined : "resumed",
    );
    let resultDiagnostics: AgentDiagnostics | undefined;
    let releaseIntervention: (() => void) | undefined;
    try {
      const gitDirectory = await mkdtemp(
        path.join(tmpdir(), "sandcastle-runner-git-"),
      );
      let result: AgentAttemptResult;
      try {
        const gitConfigGlobal = path.join(gitDirectory, "config");
        await writeFile(gitConfigGlobal, "");
        result = await advance(input.operator, () => {
          executions += 1;
          showProgress(
            input.operator,
            operation.ticket,
            operation.progress,
            attemptNumber > 1 || executions > 1,
          );
          return input.agentExecutor.execute({
            ticket: operation.ticket,
            runName: operation.runName,
            worktree: operation.worktree,
            branch: operation.branch,
            base: operation.base,
            targetBranch: input.targetBranch,
            ...(operation.promptFile === undefined
              ? {}
              : { promptFile: operation.promptFile }),
            promptArgs: operation.promptArgs,
            pullRequestMetadata: operation.pullRequestMetadata,
            agent: operation.agent.agent,
            model: operation.agent.model,
            ...(operation.agent.options === undefined
              ? {}
              : { options: operation.agent.options }),
            gitConfigGlobal,
            logFile,
            timeoutMs: input.timeoutMs,
            idleTimeoutMs: input.idleTimeoutMs,
            pauseForTimeout: (cause, intervention) =>
              pauseForAgentTimeout(
                input.audit,
                event,
                input.operator,
                `Agent ${cause} threshold reached for ${operation.runName}. Working directory: ${operation.worktree}. Diagnostic log: ${logFile}.`,
                intervention,
              ),
            retryPolicy: input.retryPolicy,
            signal: input.operator.coordination
              ? AbortSignal.any([
                  operation.signal,
                  input.operator.coordination.controller.signal,
                ])
              : operation.signal,
            advance: (action) => advance(input.operator, action),
            ...(resumePrompt === undefined ? {} : { resumePrompt }),
          });
        });
        resultDiagnostics = {
          provider: operation.agent.agent,
          workingDirectory: operation.worktree,
          diagnosticLogPath: logFile,
          ...result.diagnostics,
          agentAttemptId: attemptId,
          attemptOrdinal: attemptNumber,
        };
        if (result.outcome === "blocked")
          releaseIntervention = input.operator.coordination?.intervene();
      } catch (error) {
        releaseIntervention ??= input.operator.coordination?.intervene();
        throw error;
      } finally {
        await rm(gitDirectory, { recursive: true, force: true });
      }

      if (result.outcome === "blocked") {
        await observePausedAttempt(
          input,
          operation.ticket,
          releaseIntervention,
        );
        await appendOperation(input, event, "blocked", null, resultDiagnostics);
        const continuable = resultDiagnostics?.retryable !== false;
        const decision = await pause(
          agentPauseMessage(
            "blocked",
            resultDiagnostics,
            operation.worktree,
            result,
            continuable ? ticketAgentContinueActions : ticketAgentRetryActions,
          ),
          continuable,
        );
        releaseIntervention?.();
        releaseIntervention = undefined;
        if (decision.decision === "skip")
          return await skipTicketAgentAttempt(
            input,
            operation.phase,
            event,
            operation.ticket,
            attemptNumber,
            result.blocker ?? result.summary,
          );
        if (continuable)
          continuationPrompt =
            decision.decision === "retry" ? "continue" : decision.response;
        continue;
      }
      await boundary(input, operation.ticket);
      const observed = await externalRead({
        action: () =>
          advance(input.operator, () =>
            input.gitWorkspace.inspect({
              worktree: operation.worktree,
              base: operation.base,
              ...(operation.requiredAncestor === undefined
                ? {}
                : { requiredAncestor: operation.requiredAncestor }),
            }),
          ),
        audit: input.audit,
        event: input.event(
          operation.phase,
          "inspect_worktree",
          `ticket:${operation.ticket}`,
        ),
        clock: input.clock,
        operator: input.operator,
        retryPolicy: input.retryPolicy,
      });
      if (
        observed.worktree !== path.resolve(operation.worktree) ||
        observed.branch !== operation.branch ||
        observed.base !== operation.base ||
        !observed.clean
      ) {
        throw new Error("Agent Attempt left mismatched or dirty Git state");
      }
      if (result.outcome === "no_change") {
        if (operation.session?.resumePrompt !== undefined)
          throw new Error(
            "Review findings require an implementation fix or an explicit blocker",
          );
        if (observed.commits.length !== 0)
          throw new Error("no_change left new commits");
        await appendOperation(input, event, "no_change", null);
        await workflowWrite({
          action: () =>
            input.tracker.addComment(
              input.repository,
              operation.ticket,
              result.summary,
            ),
          audit: input.audit,
          clock: input.clock,
          automaticRetry: {},
          event: (attempt) =>
            input.event(
              operation.phase,
              "comment_no_change",
              `ticket:${operation.ticket}`,
            )(attempt),
          operator: input.operator,
          retryPolicy: input.retryPolicy,
        });
        if (operation.phase === "maintenance")
          await discardAgentLogs(
            input,
            operation.phase,
            operation.ticket,
            agentLogStage(operation.phase),
            attemptNumber,
          );
        return {
          outcome: "no_change",
          reason: `${input.ticketKind ?? "Delivery Ticket"} ${operation.ticket} no_change: ${result.summary}`,
        };
      }
      if (
        observed.commits.length === 0 ||
        !sameCommits(result.commits, observed.commits)
      ) {
        throw new Error("Agent commit claims do not match Git evidence");
      }
      const prTitle = result.pr_title ?? operation.existingPrMetadata?.prTitle;
      const prBody = result.pr_body ?? operation.existingPrMetadata?.prBody;
      if (!prTitle || !prBody)
        throw new Error("Agent Attempt result has no downstream PR metadata");
      const handoff: VerifiedHandoff = {
        ticket: operation.ticket,
        worktree: operation.worktree,
        branch: operation.branch,
        base: operation.base,
        commits: observed.commits,
        checks: result.checks,
        prTitle,
        prBody,
        verification: "verified",
      };
      await appendOperation(input, event, "succeeded", null, resultDiagnostics);
      if (operation.session === undefined)
        await discardAgentLogs(
          input,
          operation.phase,
          operation.ticket,
          agentLogStage(operation.phase),
          attemptNumber,
        );
      return handoff;
    } catch (error) {
      if (error instanceof OperatorCancelled || error instanceof TicketSkipped)
        throw error;
      if (error instanceof BoundaryStop) {
        await appendOperation(input, event, error.result.outcome, null);
        throw error;
      }
      releaseIntervention ??= input.operator.coordination?.intervene();
      const diagnostics: AgentDiagnostics = {
        provider: operation.agent.agent,
        ...resultDiagnostics,
        error: error instanceof Error ? error.message : "Agent Attempt failed",
        errorCategory: "agent_attempt",
        attemptOrdinal: attemptNumber,
        retryable: true,
        agentAttemptId: attemptId,
        workingDirectory: operation.worktree,
        diagnosticLogPath: logFile,
      };
      Object.assign(
        diagnostics,
        error instanceof Error && "diagnostics" in error
          ? (error as Error & { diagnostics?: AgentDiagnostics }).diagnostics
          : {},
      );
      await appendOperation(
        input,
        event,
        "failed",
        diagnostics.error!,
        diagnostics,
      );
      if (diagnostics.errorCategory === "process_cleanup") throw error;
      const continuable = diagnostics.retryable !== false;
      const decision = await pauseAgentAttempt(
        input,
        event,
        agentPauseMessage(
          "failed",
          diagnostics,
          operation.worktree,
          undefined,
          continuable ? ticketAgentContinueActions : ticketAgentRetryActions,
        ),
        continuable,
      );
      releaseIntervention?.();
      releaseIntervention = undefined;
      if (decision.decision === "skip")
        return await skipTicketAgentAttempt(
          input,
          operation.phase,
          event,
          operation.ticket,
          attemptNumber,
          diagnostics.error ?? "Agent Attempt failed",
        );
      if (continuable)
        continuationPrompt =
          decision.decision === "retry" ? "continue" : decision.response;
    } finally {
      releaseIntervention?.();
    }
  }
}
