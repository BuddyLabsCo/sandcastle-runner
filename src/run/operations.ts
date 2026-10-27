import type { AuditEvent, AuditLog } from "../audit.ts";
import type { Clock, OperatorIO, RetryPolicy } from "./contracts.ts";
import { RunCoordination } from "./run-coordination.ts";

export class OperatorCancelled extends Error {}

export class TicketSkipped extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function scopeOperator(operator: OperatorIO, scope: string): OperatorIO {
  return {
    ...operator,
    skipScope: scope,
    write: (message) => operator.write(message),
    pause: (message) => operator.pause(message),
  };
}

export function serializeOperator(
  operator: OperatorIO,
  controller: AbortController,
): OperatorIO {
  const coordination = new RunCoordination(controller);
  let tail = Promise.resolve();
  return {
    coordination,
    ...(operator.skipScope === undefined
      ? {}
      : { skipScope: operator.skipScope }),
    write(message) {
      operator.write(message);
    },
    async pause(message) {
      const releaseIntervention = coordination.intervene();
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
        releaseIntervention();
      }
    },
  };
}

export function advance<T>(
  operator: OperatorIO,
  action: () => Promise<T>,
): Promise<T> {
  return operator.coordination
    ? operator.coordination.advance(action)
    : action();
}

export async function supervisedAuditWrite(
  action: () => Promise<void>,
  operator: OperatorIO,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    for (;;) {
      try {
        await action();
        return;
      } catch {
        release ??= operator.coordination?.intervene();
        for (;;) {
          const response = await operator.pause(
            "Audit write failed. Enter to retry the same log action, q/EOF to cancel. Other input is unsupported.",
          );
          if (response === null || response === "q")
            throw new OperatorCancelled("operator cancelled");
          if (response === "") break;
        }
      }
    }
  } finally {
    release?.();
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
  const actions = operator.skipScope
    ? `Enter to retry, s to skip ${operator.skipScope}, q/EOF to cancel.`
    : "Enter to retry, q/EOF to cancel.";
  const response = await waitForOperator(
    audit,
    event,
    operator,
    `${message} Actions: ${actions} Other input is unsupported.`,
    operator.skipScope !== undefined,
    false,
  );
  if (response === "s")
    throw new TicketSkipped(
      `skipped ${operator.skipScope}; side effects may remain, including unknown resources from unobserved writes`,
    );
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
  continuable = true,
): Promise<TicketAgentPauseDecision> {
  const response = await waitForOperator(
    audit,
    event,
    operator,
    message,
    true,
    continuable,
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
  allowsSkip: boolean,
  allowsInstructions: boolean,
): Promise<string> {
  const release = operator.coordination?.intervene();
  try {
    const record = (result: string, transition = result) =>
      supervisedAuditWrite(
        () =>
          audit.append({
            ...event,
            operation: "operator_pause",
            result,
            error: null,
            transition,
          }),
        operator,
      );
    for (;;) {
      await record("started", "pause_started");
      const response = await operator.pause(message);
      if (response === null || response === "q") {
        await record("cancelled");
        throw new OperatorCancelled("operator cancelled");
      }
      const result =
        response === ""
          ? "retry"
          : allowsSkip && response === "s"
            ? "skipped"
            : allowsInstructions
              ? "continue"
              : "unsupported_input";
      await record(
        result,
        result === "continue"
          ? "operator_prompt"
          : result === "unsupported_input"
            ? "pause_started"
            : result,
      );
      if (result !== "unsupported_input") return response;
      operator.write("Unsupported input. " + message);
    }
  } finally {
    release?.();
  }
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
        // Observations, including retries, remain available during Operator Pause.
        result = await operation.action();
      } catch (error) {
        operation.operator.coordination?.controller.signal.throwIfAborted();
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
      "Operation failed.",
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
      result = await advance<T | void>(operation.operator, operation.action);
    } catch (error) {
      operation.operator.coordination?.controller.signal.throwIfAborted();
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
        "Operation failed.",
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
