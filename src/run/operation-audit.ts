import type { AuditEvent } from "../audit.ts";
import {
  deleteAgentLogs,
  type AgentLogStage,
  type AgentOperationPhase,
} from "./agent-logs.ts";
import type { AgentOperationInput } from "./agent-operation.ts";
import type { AgentDiagnostics } from "./contracts.ts";
import { advance, supervisedAuditWrite } from "./operations.ts";

export async function appendOperation(
  input: AgentOperationInput,
  event: Omit<AuditEvent, "result" | "error">,
  result: string,
  error: string | null,
  diagnostics?: AgentDiagnostics,
  transition?: string,
): Promise<void> {
  await supervisedAuditWrite(
    () =>
      input.audit.append({
        ...event,
        result,
        error,
        ...(diagnostics?.agentAttemptId === undefined
          ? {}
          : { agentAttemptId: diagnostics.agentAttemptId }),
        ...(diagnostics?.diagnosticLogPath === undefined
          ? {}
          : { diagnosticLogPath: diagnostics.diagnosticLogPath }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        ...(transition === undefined ? {} : { transition }),
      }),
    input.operator,
  );
}

export async function discardAgentLogs(
  input: AgentOperationInput,
  phase: AgentOperationPhase | "review",
  ticket: number,
  stage: AgentLogStage,
  attempt: number,
): Promise<void> {
  for (const failure of await advance(input.operator, () =>
    deleteAgentLogs(input.projectDirectory, ticket, stage),
  )) {
    await appendOperation(
      input,
      input.event(phase, "delete_agent_log", `ticket:${ticket}`)(attempt),
      "failed",
      failure.error,
      {
        errorCategory: "agent_log_cleanup",
        retryable: false,
        ...(failure.logFile === undefined
          ? {}
          : { diagnosticLogPath: failure.logFile }),
      },
    );
  }
}

export async function discardTicketAgentLogs(
  input: AgentOperationInput,
  phase: AgentOperationPhase | "review",
  ticket: number,
  attempt: number,
): Promise<void> {
  for (const stage of ["implement", "review", "ci", "merge", "doc"] as const) {
    await discardAgentLogs(input, phase, ticket, stage, attempt);
  }
}
