import type { AuditEvent, AuditLog } from "../audit.ts";
import type { Clock, OperatorIO, RetryPolicy } from "./contracts.ts";

export class OperatorCancelled extends Error {}

async function operatorResponse(
  operator: OperatorIO,
  message: string,
  agentActions?: "continue" | "retry",
): Promise<string | null> {
  for (;;) {
    const response = await operator.pause(message);
    if (
      response === null ||
      response === "q" ||
      response === "" ||
      agentActions === "continue" ||
      (agentActions === "retry" && response === "s")
    )
      return response;
    operator.write(
      agentActions === "retry"
        ? "Unsupported input. Enter to retry, s to skip, q to cancel."
        : "Unsupported input. Enter to retry, q to cancel.",
    );
  }
}

export async function retryOrCancel(
  operator: OperatorIO,
  message: string,
): Promise<void> {
  const response = await operatorResponse(operator, message);
  if (response === null || response === "q")
    throw new OperatorCancelled("operator cancelled");
}

export function serializeOperator(
  operator: OperatorIO,
  controller: AbortController,
): OperatorIO {
  let tail = Promise.resolve();
  return {
    write(message) {
      operator.write(message);
    },
    async pause(message) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (controller.signal.aborted) return null;
        const response = await operator.pause(message);
        if (response === null || response === "q")
          controller.abort(new OperatorCancelled("operator cancelled"));
        return response;
      } finally {
        release();
      }
    },
  };
}

export async function supervisedAuditWrite(
  action: () => Promise<void>,
  operator: OperatorIO,
): Promise<void> {
  for (;;) {
    try {
      await action();
      return;
    } catch {
      await retryOrCancel(
        operator,
        "Audit write failed. Enter to retry, q to cancel.",
      );
    }
  }
}

interface ReadOperation<T> {
  action: () => Promise<T>;
  audit: AuditLog;
  event: (attempt: number) => Omit<AuditEvent, "result" | "error">;
  clock: Clock;
  operator: OperatorIO;
  retryPolicy: RetryPolicy;
}

export type WriteReconciliation<T> =
  { outcome: "pending" } | { outcome: "completed"; result?: T };

interface WriteOperation<T> {
  audit: AuditLog;
  clock: Clock;
  event: (attempt: number) => Omit<AuditEvent, "result" | "error">;
  operator: OperatorIO;
  retryPolicy: RetryPolicy;
  beforeRetry?: () => Promise<void>;
  automaticRetry?: {
    reconcile?: () => Promise<WriteReconciliation<T>>;
  };
}

interface VoidWriteOperation extends WriteOperation<void> {
  action: () => Promise<void>;
}

interface ResultWriteOperation<T> extends WriteOperation<T> {
  action: () => Promise<T>;
}

export async function pauseForOperator(
  audit: AuditLog,
  event: Omit<AuditEvent, "result" | "error">,
  operator: OperatorIO,
  message: string,
): Promise<void> {
  await waitForOperator(audit, event, operator, message);
}

export type TicketAgentPauseDecision =
  | { decision: "retry" }
  | { decision: "continue"; response: string }
  | { decision: "skip" };

export async function pauseTicketAgentForOperator(
  audit: AuditLog,
  event: Omit<AuditEvent, "result" | "error">,
  operator: OperatorIO,
  message: string,
  allowsContinuation = true,
): Promise<TicketAgentPauseDecision> {
  const response = await waitForOperator(
    audit,
    event,
    operator,
    message,
    allowsContinuation ? "continue" : "retry",
  );
  if (response === "") return { decision: "retry" };
  if (response === "s") return { decision: "skip" };
  return { decision: "continue", response };
}

async function waitForOperator(
  audit: AuditLog,
  event: Omit<AuditEvent, "result" | "error">,
  operator: OperatorIO,
  message: string,
  agentActions?: "continue" | "retry",
): Promise<string> {
  await supervisedAuditWrite(
    () =>
      audit.append({
        ...event,
        operation: "operator_pause",
        result: "started",
        error: null,
        transition: "pause_started",
      }),
    operator,
  );
  const response = await operatorResponse(operator, message, agentActions);
  if (response === null || response === "q") {
    await supervisedAuditWrite(
      () =>
        audit.append({
          ...event,
          operation: "operator_pause",
          result: "cancelled",
          error: null,
          transition: "cancelled",
        }),
      operator,
    );
    throw new OperatorCancelled("operator cancelled");
  }
  await supervisedAuditWrite(
    () =>
      audit.append({
        ...event,
        operation: "operator_pause",
        result:
          response === ""
            ? "retry"
            : agentActions && response === "s"
              ? "skipped"
              : "continue",
        error: null,
        transition:
          response === ""
            ? "retry"
            : agentActions && response === "s"
              ? "skipped"
              : "operator_prompt",
      }),
    operator,
  );
  return response;
}

export async function externalRead<T>(operation: ReadOperation<T>): Promise<T> {
  const policy = operation.retryPolicy;
  const maxAttempts = policy.operationRetry + 1;
  const delayFor = (retryIndex: number) =>
    policy.operationRetryDelay[
      Math.min(retryIndex, policy.operationRetryDelay.length - 1)
    ]! * 1000;
  for (;;) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const event = operation.event(attempt);
      await supervisedAuditWrite(
        () =>
          operation.audit.append({ ...event, result: "started", error: null }),
        operation.operator,
      );
      let result: T;
      try {
        result = await operation.action();
      } catch (error) {
        await supervisedAuditWrite(
          () =>
            operation.audit.append({
              ...event,
              result: "failed",
              error:
                error instanceof Error ? error.message : "external read failed",
            }),
          operation.operator,
        );
        if (attempt < maxAttempts)
          await operation.clock.sleep(delayFor(attempt - 1));
        continue;
      }
      await supervisedAuditWrite(
        () =>
          operation.audit.append({
            ...event,
            result: "succeeded",
            error: null,
          }),
        operation.operator,
      );
      return result;
    }

    await pauseForOperator(
      operation.audit,
      operation.event(maxAttempts),
      operation.operator,
      "Operation failed. Enter to retry, q to cancel.",
    );
  }
}

export function workflowWrite(operation: VoidWriteOperation): Promise<void>;
export function workflowWrite<T>(
  operation: ResultWriteOperation<T>,
): Promise<T>;
export async function workflowWrite<T>(
  operation: VoidWriteOperation | ResultWriteOperation<T>,
): Promise<T | void> {
  const policy = operation.retryPolicy;
  const maxAutomaticRetries = policy.operationRetry;
  let attempt = 1;
  for (;;) {
    const event = operation.event(attempt);
    await supervisedAuditWrite(
      () =>
        operation.audit.append({ ...event, result: "started", error: null }),
      operation.operator,
    );
    const reconciliation = operation.automaticRetry?.reconcile;
    if (reconciliation) {
      const state = await reconciliation();
      if (state.outcome === "completed") {
        await supervisedAuditWrite(
          () =>
            operation.audit.append({
              ...event,
              result: "succeeded",
              error: null,
            }),
          operation.operator,
        );
        return state.result;
      }
    }
    let result: T | void;
    try {
      result = await operation.action();
    } catch (error) {
      await supervisedAuditWrite(
        () =>
          operation.audit.append({
            ...event,
            result: "failed",
            error:
              error instanceof Error ? error.message : "workflow write failed",
          }),
        operation.operator,
      );
      if (reconciliation) {
        const state = await reconciliation();
        if (state.outcome === "completed") {
          await supervisedAuditWrite(
            () =>
              operation.audit.append({
                ...event,
                result: "succeeded",
                error: null,
              }),
            operation.operator,
          );
          return state.result;
        }
      }
      const delay =
        operation.automaticRetry && attempt <= maxAutomaticRetries
          ? policy.operationRetryDelay[
              Math.min(attempt - 1, policy.operationRetryDelay.length - 1)
            ]! * 1000
          : undefined;
      if (delay !== undefined) {
        await operation.clock.sleep(delay);
        attempt += 1;
        continue;
      }
      await pauseForOperator(
        operation.audit,
        event,
        operation.operator,
        "Operation failed. Enter to retry, q to cancel.",
      );
      await operation.beforeRetry?.();
      attempt = 1;
      continue;
    }
    await supervisedAuditWrite(
      () =>
        operation.audit.append({
          ...event,
          result: "succeeded",
          error: null,
        }),
      operation.operator,
    );
    return result;
  }
}
