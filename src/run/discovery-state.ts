import type { AuditEvent, AuditLog } from "../audit.ts";
import type {
  BlockerPage,
  ChildPage,
  Clock,
  OperatorIO,
  RetryPolicy,
  Ticket,
  Tracker,
} from "./contracts.ts";
import { externalRead, workflowWrite } from "./operations.ts";

export interface DiscoveryInput {
  repository: string;
  parentTicket: number;
  standaloneIssue?: number;
  standaloneIssues?: number[];
  issueList?: number[];
  tracker: Tracker;
  audit: AuditLog;
  clock: Clock;
  operator: OperatorIO;
  retryPolicy: RetryPolicy;
  event: (
    phase: string,
    operation: string,
    target: string,
  ) => (attempt: number) => Omit<AuditEvent, "result" | "error">;
  runnerAccount: string;
  reservationLabel: string;
  hadChildren?: boolean;
  ticketBoundary?: TicketBoundary;
  ticketKind?: "Delivery Ticket" | "Maintenance Ticket";
  parentScopedMaintenance?: boolean;
  maintenanceTicketLabel?: string;
}

export interface BatchDiscoveryInput extends DiscoveryInput {
  maxBatchSize: number;
  excludedTickets?: ReadonlySet<number>;
}

export const readyForAgentLabel = "ready-for-agent";

export interface Selection {
  batch: Ticket[];
  blocked: number[];
  externallyOwned: number[];
  reservations: string[];
  missing: number[];
}

export async function readParent(
  input: DiscoveryInput,
  phase = "discover",
): Promise<Ticket> {
  return externalRead({
    action: () => input.tracker.getParent(input.repository, input.parentTicket),
    audit: input.audit,
    event: input.event(phase, "read_parent", `parent:${input.parentTicket}`),
    clock: input.clock,
    operator: input.operator,
    retryPolicy: input.retryPolicy,
  });
}

export async function readChildren(
  input: DiscoveryInput,
  phase: string,
): Promise<Ticket[]> {
  const children: Ticket[] = [];
  let pageNumber: number | null = 1;
  while (pageNumber !== null) {
    const currentPage: number = pageNumber;
    const page: ChildPage = await externalRead<ChildPage>({
      action: () =>
        input.tracker.listChildrenPage(
          input.repository,
          input.parentTicket,
          currentPage,
        ),
      audit: input.audit,
      event: input.event(
        phase,
        "read_children",
        `parent:${input.parentTicket}:page:${currentPage}`,
      ),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    children.push(...page.children);
    pageNumber = page.nextPage;
  }
  const crossRepositoryChild = children.find(
    ({ repository }) => repository !== input.repository,
  );
  if (crossRepositoryChild) {
    throw new Error(
      `cross-repository child ${crossRepositoryChild.repository}#${crossRepositoryChild.number} is unsupported`,
    );
  }
  return children;
}

export async function readBlockers(
  input: DiscoveryInput,
  ticket: number,
  phase: string,
): Promise<Ticket[]> {
  const blockers: Ticket[] = [];
  let pageNumber: number | null = 1;
  while (pageNumber !== null) {
    const currentPage: number = pageNumber;
    const page: BlockerPage = await externalRead<BlockerPage>({
      action: () =>
        input.tracker.listBlockersPage(input.repository, ticket, currentPage),
      audit: input.audit,
      event: input.event(
        phase,
        "read_blockers",
        `ticket:${ticket}:page:${currentPage}`,
      ),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    blockers.push(...page.blockers);
    pageNumber = page.nextPage;
  }
  return blockers;
}

export async function releaseReservation(
  input: DiscoveryInput,
  ticket: number,
  removeAssignee: boolean,
  removeLabel: boolean,
): Promise<void> {
  if (removeAssignee) {
    await workflowWrite({
      action: () =>
        input.tracker.removeAssignee(
          input.repository,
          ticket,
          input.runnerAccount,
        ),
      audit: input.audit,
      clock: input.clock,
      automaticRetry: {},
      event: (attempt) =>
        input.event(
          "release",
          "remove_runner_assignee",
          `ticket:${ticket}`,
        )(attempt),
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
  }
  if (removeLabel) {
    await workflowWrite({
      action: () =>
        input.tracker.removeLabel(
          input.repository,
          ticket,
          input.reservationLabel,
        ),
      audit: input.audit,
      clock: input.clock,
      automaticRetry: {},
      event: (attempt) =>
        input.event(
          "release",
          "remove_reservation_label",
          `ticket:${ticket}`,
        )(attempt),
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
  }
}

export async function inspect(
  input: BatchDiscoveryInput,
  children: Ticket[],
  phase: string,
  excluded = new Set<number>(),
): Promise<Selection> {
  const eligible: Ticket[] = [];
  const blocked: number[] = [];
  const externallyOwned: number[] = [];
  const reservations: { number: number; state: string }[] = [];
  const allowed =
    input.issueList && input.issueList.length > 0
      ? new Set(input.issueList)
      : undefined;
  for (const child of children) {
    const blockers = await readBlockers(input, child.number, phase);
    const invalidBlocker = blockers.find(
      ({ state, stateReason }) => state === "closed" && stateReason === null,
    );
    if (invalidBlocker) {
      throw new Error(
        `blocker ${invalidBlocker.number} has an unsupported terminal state`,
      );
    }
    if (child.state === "closed" && child.stateReason === null) {
      throw new Error(
        `Delivery Ticket ${child.number} has an unsupported terminal state`,
      );
    }
    if (child.state !== "open") continue;
    const hasRunner = (child.assignees ?? []).includes(input.runnerAccount);
    const hasLabel = (child.labels ?? []).includes(input.reservationLabel);
    const readyForAgent = (child.labels ?? []).includes(readyForAgentLabel);
    const hasExternalOwner = (child.assignees ?? []).some(
      (assignee) => assignee !== input.runnerAccount,
    );
    const hasOpenBlocker = blockers.some(({ state }) => state === "open");
    if (hasExternalOwner) externallyOwned.push(child.number);
    if (hasRunner || hasLabel) {
      reservations.push({
        number: child.number,
        state: hasRunner && hasLabel ? "complete" : "partial",
      });
    }
    if (hasOpenBlocker) blocked.push(child.number);
    if (
      !excluded.has(child.number) &&
      !input.excludedTickets?.has(child.number) &&
      (allowed === undefined || allowed.has(child.number)) &&
      !hasExternalOwner &&
      !hasOpenBlocker &&
      readyForAgent &&
      hasRunner === hasLabel
    ) {
      eligible.push(child);
    }
  }
  return {
    batch: eligible
      .sort((left, right) => left.number - right.number)
      .slice(0, input.maxBatchSize),
    blocked: blocked.sort((left, right) => left - right),
    externallyOwned: externallyOwned.sort((left, right) => left - right),
    reservations: reservations
      .sort((left, right) => left.number - right.number)
      .map(({ number, state }) => `${number} (${state})`),
    missing:
      allowed === undefined
        ? []
        : [...allowed]
            .filter(
              (number) => !children.some((child) => child.number === number),
            )
            .sort((left, right) => left - right),
  };
}

export async function revalidateTicket(
  input: DiscoveryInput,
  ticketNumber: number,
): Promise<
  { inScope: false } | { inScope: true; ticket: Ticket; blocked: boolean }
> {
  if (
    input.standaloneIssue !== undefined ||
    input.standaloneIssues !== undefined
  ) {
    const selected = input.standaloneIssues ?? [input.standaloneIssue!];
    if (!selected.includes(ticketNumber)) return { inScope: false };
    const ticket = await externalRead({
      action: () => input.tracker.getTicket(input.repository, ticketNumber),
      audit: input.audit,
      event: input.event("revalidate", "read_ticket", `ticket:${ticketNumber}`),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    if (ticket.state === "closed" && ticket.stateReason === null) {
      throw new Error(
        `Delivery Ticket ${ticket.number} has an unsupported terminal state`,
      );
    }
    const blockers = await readBlockers(input, ticketNumber, "revalidate");
    return {
      inScope: true,
      ticket,
      blocked: blockers.some(({ state }) => state === "open"),
    };
  }
  const children = await readChildren(input, "revalidate");
  if (!children.some(({ number }) => number === ticketNumber)) {
    return { inScope: false };
  }
  const ticket = await externalRead({
    action: () => input.tracker.getTicket(input.repository, ticketNumber),
    audit: input.audit,
    event: input.event("revalidate", "read_ticket", `ticket:${ticketNumber}`),
    clock: input.clock,
    operator: input.operator,
    retryPolicy: input.retryPolicy,
  });
  if (ticket.state === "closed" && ticket.stateReason === null) {
    throw new Error(
      `Delivery Ticket ${ticket.number} has an unsupported terminal state`,
    );
  }
  const blockers = await readBlockers(input, ticketNumber, "revalidate");
  return {
    inScope: true,
    ticket,
    blocked: blockers.some(({ state }) => state === "open"),
  };
}

export type DeliveryBoundaryResult =
  | { outcome: "ready" }
  | { outcome: "cancelled" | "failed" | "stopped"; reason: string };

export type MergedDeliveryBoundaryResult =
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
  | { outcome: "ready"; ticket: Ticket }
  | { outcome: "terminal"; ticket: Ticket };

export interface TicketBoundary {
  beforeOperation(ticket: number): Promise<DeliveryBoundaryResult>;
  afterMerge(ticket: number): Promise<MergedDeliveryBoundaryResult>;
  releaseTerminal(ticket: Ticket): Promise<void>;
}
