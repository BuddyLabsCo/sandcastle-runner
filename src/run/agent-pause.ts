import type { AuditEvent } from "../audit.ts";
import type { AgentOperationInput } from "./agent-operation.ts";
import type { AgentOperationPhase } from "./agent-logs.ts";
import type { AgentAttemptResult, AgentDiagnostics } from "./contracts.ts";
import { appendOperation, discardTicketAgentLogs } from "./operation-audit.ts";
import {
  pauseTicketAgentForOperator,
  type TicketAgentPauseDecision,
} from "./operations.ts";

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

export function agentPauseMessage(
  outcome: "blocked" | "failed",
  diagnostics: AgentDiagnostics | undefined,
  worktree: string,
  result?: Pick<AgentAttemptResult, "summary" | "blocker">,
  actions = "Enter to continue, q to cancel, or provide recovery instructions.",
): string {
  const d = diagnostics ?? {};
  const session = availableValue(d.sessionId);
  return [
    `Outcome: ${outcome}`,
    `Reason: ${firstLine(result?.blocker, result?.summary, d.error)}`,
    `Agent: ${availableValue(d.provider)}`,
    `Provider session: ${session}`,
    `Working directory: ${availableValue(worktree, d.workingDirectory)}`,
    `Diagnostic log: ${availableValue(d.diagnosticLogPath)}`,
    `Actions: ${actions}`,
  ].join("\n");
}

export const ticketAgentContinueActions =
  "Enter to continue, s to skip, q to cancel, or provide recovery instructions.";
export const ticketAgentRetryActions =
  "Enter to retry, s to skip, q to cancel, or supply a trusted result.";

export async function pauseAgentAttempt(
  input: AgentOperationInput,
  event: Omit<AuditEvent, "result" | "error">,
  message: string,
): Promise<TicketAgentPauseDecision> {
  return pauseTicketAgentForOperator(
    input.audit,
    event,
    input.operator,
    message,
  );
}

export class TicketSkipped extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export async function skipTicketAgentAttempt(
  input: AgentOperationInput,
  phase: AgentOperationPhase | "review",
  event: Omit<AuditEvent, "result" | "error">,
  ticket: number,
  attempt: number,
  reason: string,
): Promise<never> {
  await appendOperation(input, event, "skipped", reason);
  await discardTicketAgentLogs(input, phase, ticket, attempt);
  throw new TicketSkipped(reason);
}
