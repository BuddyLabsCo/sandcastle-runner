import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuditEvent } from "../audit.ts";
import type { AgentConfig } from "../config.ts";
import { agentLogFile, agentLogStage } from "./agent-logs.ts";
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
} from "./discovery.ts";
import {
  OperatorCancelled,
  pauseForOperator,
  workflowWrite,
} from "./operations.ts";
import { appendOperation, discardAgentLogs } from "./operation-audit.ts";

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
  gitWorkspace: GitWorkspace;
  agentExecutor: AgentExecutor;
}

export interface AttemptInput extends AgentOperationInput {
  batch: number[];
  checkout: string;
  promptFile: string;
  agent: AgentConfig;
  review: boolean;
  reviewPrompt: string;
  reviewAgent?: AgentConfig;
}

function availableValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.trim().length > 0) return value;
  }
  return "unavailable";
}

function firstLine(...values: unknown[]): string {
  const value = availableValue(...values);
  return value === "unavailable" ? value : value.replace(/\s+/gu, " ").trim();
}

function shellArgument(value: string): string {
  const argument = value.replace(/^\\\\/u, "//");
  const prefix = /^[A-Za-z0-9_./:@%+=,-]*/u.exec(argument)![0];
  // An unquoted prefix lets sh and PowerShell join the following quote segments.
  return prefix === argument
    ? argument
    : `${prefix}'${argument.slice(prefix.length).replaceAll("'", "'\"'\"'")}'`;
}

export function agentPauseMessage(
  outcome: "blocked" | "failed",
  diagnostics: AgentDiagnostics | undefined,
  worktree: string,
  result?: Pick<AgentAttemptResult, "summary" | "blocker">,
  actions = "Enter to continue, q to cancel, or provide recovery instructions.",
): string {
  const d = diagnostics ?? {};
  const session = availableValue(d.sessionId);
  const resume =
    session === "unavailable"
      ? "unavailable"
      : `codex resume -C ${shellArgument(availableValue(worktree, d.workingDirectory))} ${shellArgument(session)}`;
  return [
    `Outcome: ${outcome}`,
    `Reason: ${firstLine(result?.blocker, result?.summary, d.error)}`,
    `Provider session: ${session}`,
    `Resume command: ${resume}`,
    ...(session === "unavailable"
      ? [`Diagnostic log: ${availableValue(d.diagnosticLogPath)}`]
      : []),
    `Actions: ${actions}`,
  ].join("\n");
}

export interface AttemptBatchResult {
  outcome: "incomplete" | "cancelled" | "failed";
  reasons: string[];
  handoffs: VerifiedHandoff[];
  tickets: TicketAttemptOutcome[];
}

export interface TicketAttemptOutcome {
  ticket: number;
  outcome: "handoff" | "no_change" | "blocked" | "failed" | "cancelled";
  detail: string;
  handoff?: VerifiedHandoff;
}

type AgentStop =
  | { outcome: "blocked"; reason: string }
  | { outcome: "no_change"; reason: string };

export type MaintenanceAttemptResult =
  | { outcome: "committed"; handoff: VerifiedHandoff }
  | AgentStop
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
  const result = await revalidateActiveTicket(input, ticket);
  if (result.outcome !== "ready") throw new BoundaryStop(result);
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

function trustedHandoff(
  value: string,
  ticket: number,
  worktree: string,
  branch: string,
  base: string,
  existingPrMetadata?: Pick<VerifiedHandoff, "prTitle" | "prBody">,
): VerifiedHandoff {
  const parsed = existingPrMetadata
    ? null
    : (JSON.parse(value) as Record<string, unknown>);
  if (
    parsed &&
    (parsed.outcome !== "committed" ||
      typeof parsed.pr_title !== "string" ||
      !parsed.pr_title.trim() ||
      typeof parsed.pr_body !== "string" ||
      !parsed.pr_body.trim())
  )
    throw new Error("override has no downstream PR metadata");
  return {
    ticket,
    worktree,
    branch,
    base,
    commits: [],
    checks: [],
    prTitle: existingPrMetadata?.prTitle ?? (parsed?.pr_title as string),
    prBody: existingPrMetadata?.prBody ?? (parsed?.pr_body as string),
    verification: "operator_override",
  };
}

export async function runAgentOperation(
  input: AgentOperationInput,
  operation: {
    phase: "implement" | "ci_repair" | "conflict_repair" | "maintenance";
    sessionName: string;
    ticket: number;
    worktree: string;
    branch: string;
    base: string;
    requiredAncestor?: string;
    promptFile: string;
    promptArgs: Record<string, string | number>;
    pullRequestMetadata: "required" | "required_for_committed" | "ignored";
    existingPrMetadata?: Pick<VerifiedHandoff, "prTitle" | "prBody">;
    agent: AgentConfig;
    signal: AbortSignal;
    attemptCounter: { value: number };
  },
): Promise<VerifiedHandoff | AgentStop> {
  let continuationPrompt: string | undefined;
  let attemptNumber!: number;
  let attemptId = "";
  let logFile = "";
  let event!: Omit<AuditEvent, "result" | "error">;
  for (;;) {
    await boundary(input, operation.ticket);
    const resumePrompt = continuationPrompt;
    continuationPrompt = undefined;
    if (resumePrompt === undefined) {
      operation.attemptCounter.value += 1;
      attemptNumber = operation.attemptCounter.value;
      attemptId = randomUUID();
      logFile = agentLogFile(
        input.projectDirectory,
        operation.ticket,
        agentLogStage(operation.phase),
        attemptId,
      );
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
    try {
      const gitDirectory = await mkdtemp(
        path.join(tmpdir(), "sandcastle-runner-git-"),
      );
      let result: AgentAttemptResult;
      try {
        const gitConfigGlobal = path.join(gitDirectory, "config");
        await writeFile(gitConfigGlobal, "");
        result = await input.agentExecutor.execute({
          ticket: operation.ticket,
          sessionName: operation.sessionName,
          worktree: operation.worktree,
          branch: operation.branch,
          base: operation.base,
          targetBranch: input.targetBranch,
          promptFile: operation.promptFile,
          promptArgs: operation.promptArgs,
          pullRequestMetadata: operation.pullRequestMetadata,
          model: operation.agent.model,
          effort: operation.agent.reasoningEffort,
          gitConfigGlobal,
          logFile,
          timeoutMs: input.timeoutMs,
          retryPolicy: input.retryPolicy,
          signal: operation.signal,
          ...(resumePrompt === undefined ? {} : { resumePrompt }),
        });
        resultDiagnostics = result.diagnostics;
      } finally {
        await rm(gitDirectory, { recursive: true, force: true });
      }

      await boundary(input, operation.ticket);
      if (result.diagnostics) {
        result.diagnostics.agentAttemptId = attemptId;
        result.diagnostics.attemptOrdinal = attemptNumber;
      }
      if (result.outcome === "blocked") {
        await appendOperation(
          input,
          event,
          "blocked",
          null,
          result.diagnostics,
        );
        const response = await pauseForOperator(
          input.audit,
          event,
          input.operator,
          agentPauseMessage(
            "blocked",
            result.diagnostics,
            operation.worktree,
            result,
          ),
        );
        continuationPrompt = response === "" ? "continue" : response;
        continue;
      }
      const observed = await input.gitWorkspace.inspect({
        worktree: operation.worktree,
        base: operation.base,
        ...(operation.requiredAncestor === undefined
          ? {}
          : { requiredAncestor: operation.requiredAncestor }),
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
      await appendOperation(
        input,
        event,
        "succeeded",
        null,
        result.diagnostics,
      );
      await discardAgentLogs(
        input,
        operation.phase,
        operation.ticket,
        agentLogStage(operation.phase),
        attemptNumber,
      );
      return handoff;
    } catch (error) {
      if (error instanceof OperatorCancelled) throw error;
      if (error instanceof BoundaryStop) {
        await appendOperation(input, event, error.result.outcome, null);
        throw error;
      }
      const diagnostics: AgentDiagnostics = {
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
      if (diagnostics.retryable === false) {
        for (;;) {
          const response = await pauseForOperator(
            input.audit,
            event,
            input.operator,
            agentPauseMessage(
              "failed",
              diagnostics,
              operation.worktree,
              undefined,
              "Enter to retry, q to cancel, or supply a trusted result.",
            ),
          );
          if (response === "") break;
          try {
            await boundary(input, operation.ticket);
            const handoff = trustedHandoff(
              response,
              operation.ticket,
              operation.worktree,
              operation.branch,
              operation.base,
              operation.existingPrMetadata,
            );
            await appendOperation(input, event, "operator_override", null);
            await discardAgentLogs(
              input,
              operation.phase,
              operation.ticket,
              agentLogStage(operation.phase),
              attemptNumber,
            );
            return handoff;
          } catch {
            // Invalid trusted results remain in the same Operator Pause.
          }
        }
        continue;
      }
      for (;;) {
        const response = await pauseForOperator(
          input.audit,
          event,
          input.operator,
          agentPauseMessage("failed", diagnostics, operation.worktree),
        );
        if (response === "") {
          continuationPrompt = "continue";
          break;
        }
        try {
          await boundary(input, operation.ticket);
          const handoff = trustedHandoff(
            response,
            operation.ticket,
            operation.worktree,
            operation.branch,
            operation.base,
            operation.existingPrMetadata,
          );
          await appendOperation(input, event, "operator_override", null);
          await discardAgentLogs(
            input,
            operation.phase,
            operation.ticket,
            agentLogStage(operation.phase),
            attemptNumber,
          );
          return handoff;
        } catch {
          // Free-form input continues the same provider session.
        }
        continuationPrompt = response;
        break;
      }
    }
  }
}
