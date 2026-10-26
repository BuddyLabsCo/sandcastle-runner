import type { AuditEvent } from "../audit.ts";
import {
  externalRead,
  OperatorCancelled,
  type WriteReconciliation,
} from "./operations.ts";
import type { PublicationInput } from "./pull-request-core.ts";
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

export function remoteBranchReconciliation(
  input: PublicationInput,
  phase: string,
  remoteBranch: string,
  expectedHead: string,
  target: string,
): () => Promise<WriteReconciliation<void>> {
  return async () => {
    const currentHead = await externalRead({
      action: () =>
        input.codeHost.getRemoteBranchHead(input.repository, remoteBranch),
      audit: input.audit,
      event: input.event(phase, "remote_branch_head", target),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    return currentHead === expectedHead
      ? { outcome: "completed" }
      : { outcome: "pending" };
  };
}
