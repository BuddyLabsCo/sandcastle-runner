import type { AuditEvent } from "../audit.ts";
import {
  externalRead,
  OperatorCancelled,
  type WriteReconciliation,
} from "./operations.ts";
import type { RunInput } from "./run-input.ts";

type EventFactory = (
  phase: string,
  operation: string,
  target: string,
) => (attempt: number) => Omit<AuditEvent, "result" | "error">;

export function parentClosureReconciliation(
  input: RunInput,
  event: EventFactory,
): () => Promise<WriteReconciliation<void>> {
  return async () => {
    const parent = await externalRead({
      action: () =>
        input.tracker.getParent(input.repository, input.parentTicket),
      audit: input.audit,
      event: event(
        "close_parent",
        "read_parent_state",
        `parent:${input.parentTicket}`,
      ),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    if (parent.state === "closed" && parent.stateReason === "not_planned")
      throw new OperatorCancelled("Parent Ticket is cancelled");
    return parent.state === "closed" && parent.stateReason === "completed"
      ? { outcome: "completed" }
      : { outcome: "pending" };
  };
}
