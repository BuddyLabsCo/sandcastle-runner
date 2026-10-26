/* eslint-disable max-lines -- recovery and publication transitions remain explicit. */
import type { AgentConfig } from "../config.ts";
import { runMaintenanceAttempt, type VerifiedHandoff } from "./attempt.ts";
import type { LabelPage, Ticket } from "./contracts.ts";
import {
  revalidateParentForOperation,
  revalidateStandaloneMaintenanceTicket,
  type TicketBoundary,
} from "./discovery.ts";
import {
  externalRead,
  pauseForOperator,
  workflowWrite,
  scopeOperator,
  TicketSkipped,
} from "./operations.ts";
import {
  integratePullRequest,
  observePullRequestForIntegration,
  recoverPublishedHandoffs,
  type PublicationInput,
  publishVerifiedHandoffs,
  type PullRequestObservation,
} from "./pull-request.ts";
import type { MaintenanceState, PublicationIntent } from "../recovery.ts";

interface MaintenanceInput extends Omit<
  PublicationInput,
  "ciRepairBudgets" | "handoffs" | "ticketBoundary" | "ticketKind"
> {
  maintenanceTicket: { title: string; body: string; label: string };
  documentationPrompt: string;
  documentationAgent: AgentConfig;
  recovery?: MaintenanceState;
  recoveryPublication?: PublicationIntent;
  persistMaintenance?: (state: MaintenanceState | null) => Promise<void>;
}

export interface MaintenanceResult {
  outcome: "succeeded" | "incomplete" | "cancelled" | "failed" | "skipped";
  reasons: string[];
  ticket?: number;
  handoff?: VerifiedHandoff;
  pullRequest?: PullRequestObservation;
}

function stopped(
  boundary: {
    outcome: "cancelled" | "failed" | "stopped" | "skipped";
    reason: string;
  },
  ticket?: number,
): MaintenanceResult {
  return {
    outcome:
      boundary.outcome === "cancelled"
        ? "cancelled"
        : boundary.outcome === "failed"
          ? "failed"
          : "incomplete",
    reasons: [boundary.reason],
    ...(ticket === undefined ? {} : { ticket }),
  };
}

async function skipMaintenance(
  input: MaintenanceInput,
  ticket: number,
  reason: string,
  handoff?: VerifiedHandoff,
  pullRequest?: PullRequestObservation,
): Promise<MaintenanceResult> {
  await input.persistMaintenance?.(null);
  return {
    outcome: "skipped",
    reasons: [`skipped Maintenance Ticket ${ticket}: ${reason}`],
    ticket,
    ...(handoff === undefined ? {} : { handoff }),
    ...(pullRequest === undefined ? {} : { pullRequest }),
  };
}

async function maintenanceLabelExists(
  input: MaintenanceInput,
): Promise<boolean> {
  let page: number | null = 1;
  while (page !== null) {
    const current: number = page;
    const labels = await externalRead<LabelPage>({
      action: () => input.tracker.listLabelsPage(input.repository, current),
      audit: input.audit,
      event: input.event("maintenance", "read_labels", `page:${current}`),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    if (labels.labels.includes(input.maintenanceTicket.label)) return true;
    page = labels.nextPage;
  }
  return false;
}

async function ensureLabel(input: MaintenanceInput): Promise<void> {
  await workflowWrite({
    action: () =>
      input.tracker.createLabel(
        input.repository,
        input.maintenanceTicket.label,
      ),
    audit: input.audit,
    clock: input.clock,
    automaticRetry: {
      async reconcile() {
        return (await maintenanceLabelExists(input))
          ? { outcome: "completed" as const }
          : { outcome: "pending" as const };
      },
    },
    event: (attempt) =>
      input.event(
        "maintenance",
        "create_label",
        input.maintenanceTicket.label,
      )(attempt),
    operator: input.operator,
    retryPolicy: input.retryPolicy,
  });
}

function boundaryFor(input: MaintenanceInput): TicketBoundary {
  return {
    async beforeOperation(ticket) {
      const result = await revalidateStandaloneMaintenanceTicket(input, ticket);
      return result.outcome === "terminal"
        ? {
            outcome: "stopped",
            reason: `Maintenance Ticket ${ticket} became terminal`,
          }
        : result;
    },
    afterMerge: (ticket) =>
      revalidateStandaloneMaintenanceTicket(input, ticket),
    releaseTerminal: () => Promise.resolve(),
  };
}

async function closeNoChange(
  input: MaintenanceInput,
  boundary: TicketBoundary,
  ticket: number,
): Promise<MaintenanceResult> {
  for (;;) {
    const ready = await boundary.beforeOperation(ticket);
    if (ready.outcome !== "ready") return stopped(ready, ticket);
    await workflowWrite({
      action: () => input.tracker.closeTicket(input.repository, ticket),
      audit: input.audit,
      clock: input.clock,
      automaticRetry: {
        async reconcile() {
          const changed = await boundary.afterMerge(ticket);
          return changed.outcome === "terminal"
            ? { outcome: "completed" as const }
            : { outcome: "pending" as const };
        },
      },
      event: (attempt) =>
        input.event(
          "maintenance",
          "close_no_change",
          `ticket:${ticket}`,
        )(attempt),
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    const confirmation = await boundary.afterMerge(ticket);
    if (confirmation.outcome === "terminal") {
      await input.persistMaintenance?.({
        phase: "completed",
        ticket,
        deliveryTickets: input.recovery?.deliveryTickets ?? [],
        barrier: false,
      });
      return confirmation.ticket.stateReason === "completed"
        ? {
            outcome: "succeeded",
            reasons: [`Completed Maintenance Ticket ${ticket} with no changes`],
            ticket,
          }
        : {
            outcome: "incomplete",
            reasons: [`Maintenance Ticket ${ticket} was cancelled`],
            ticket,
          };
    }
    if (confirmation.outcome !== "ready") return stopped(confirmation, ticket);
    const event = input.event(
      "maintenance",
      "confirm_no_change_closure",
      `ticket:${ticket}`,
    )(1);
    await pauseForOperator(
      input.audit,
      event,
      input.operator,
      `Maintenance Ticket ${ticket} is not closed as completed.`,
    );
  }
}

export async function runDocumentationMaintenance(
  input: MaintenanceInput,
): Promise<MaintenanceResult> {
  let ticket = input.recovery?.ticket;
  const scoped = {
    ...input,
    operator: scopeOperator(
      input.operator,
      "the current Documentation Maintenance occurrence",
    ),
    persistMaintenance: async (state: MaintenanceState | null) => {
      if (state?.ticket !== undefined) ticket = state.ticket;
      await input.persistMaintenance?.(state);
    },
  };
  try {
    return await runMaintenanceOccurrence(scoped);
  } catch (error) {
    if (!(error instanceof TicketSkipped)) throw error;
    await input.persistMaintenance?.(null);
    return {
      outcome: "skipped",
      reasons: [error.reason],
      ...(ticket === undefined ? {} : { ticket }),
    };
  }
}

async function runMaintenanceOccurrence(
  input: MaintenanceInput,
): Promise<MaintenanceResult> {
  const persist = (state: MaintenanceState) =>
    input.persistMaintenance?.(state) ?? Promise.resolve();
  const deliveryTickets = input.recovery?.deliveryTickets ?? [];
  if (input.parentScopedMaintenance !== false) {
    const parent = await revalidateParentForOperation(input);
    if (parent.outcome !== "ready") return stopped(parent);
  }
  let ticket: Ticket;
  if (input.recovery?.ticket !== undefined) {
    ticket = {
      number: input.recovery.ticket,
      state: "open",
      stateReason: null,
      assignees: [],
      labels: [input.maintenanceTicket.label],
    };
  } else {
    await ensureLabel(input);
    if (input.parentScopedMaintenance !== false) {
      const beforeCreate = await revalidateParentForOperation(input);
      if (beforeCreate.outcome !== "ready") return stopped(beforeCreate);
    }
    await persist({
      phase: "scheduled",
      deliveryTickets,
      barrier: true,
    });
    ticket = await workflowWrite({
      action: () =>
        input.tracker.createMaintenanceTicket(
          input.repository,
          input.maintenanceTicket.title,
          input.maintenanceTicket.body,
          input.maintenanceTicket.label,
        ),
      audit: input.audit,
      clock: input.clock,
      event: () =>
        input.event(
          "maintenance",
          "create_ticket",
          input.maintenanceTicket.label,
        )(1),
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    if (
      ticket.state !== "open" ||
      (ticket.assignees ?? []).length !== 0 ||
      !(ticket.labels ?? []).includes(input.maintenanceTicket.label) ||
      (ticket.labels ?? []).includes(input.reservationLabel)
    ) {
      throw new Error(
        "created Maintenance Ticket is not standalone and labelled",
      );
    }
    await persist({
      phase: "ticket_created",
      ticket: ticket.number,
      deliveryTickets,
      barrier: true,
    });
  }
  const ticketBoundary = boundaryFor(input);
  if (input.recovery?.phase === "pending_closure") {
    return closeNoChange(input, ticketBoundary, ticket.number);
  }
  await persist({
    phase: "attempting",
    ticket: ticket.number,
    deliveryTickets,
    barrier: true,
  });
  if (input.recoveryPublication) {
    const publicationInput: PublicationInput = {
      ...input,
      handoffs: [],
      ciRepairBudgets: new Map(),
      ticketBoundary,
      ticketKind: "Maintenance Ticket",
      publicationIntents: new Map([
        [input.recoveryPublication.ticket, input.recoveryPublication],
      ]),
    };
    const recovered = await recoverPublishedHandoffs(publicationInput, [
      input.recoveryPublication,
    ]);
    const published = recovered.published[0];
    const skipped = recovered.skipped?.[0];
    if (skipped) return skipMaintenance(input, ticket.number, skipped.reason);
    if (recovered.outcome === "succeeded" && published === undefined) {
      await input.persistPublication?.(ticket.number, null);
      await persist({
        phase: "completed",
        ticket: ticket.number,
        deliveryTickets,
        barrier: false,
      });
      return {
        outcome: "succeeded",
        reasons: recovered.reasons,
        ticket: ticket.number,
      };
    }
    if (recovered.outcome !== "succeeded" || published === undefined) {
      await persist({
        phase: "blocked",
        ticket: ticket.number,
        deliveryTickets,
        barrier: true,
      });
      return {
        outcome: recovered.outcome,
        reasons: recovered.reasons,
        ticket: ticket.number,
      };
    }
    const state = await observePullRequestForIntegration(
      publicationInput,
      published.pullRequest.number,
    );
    const integration = await integratePullRequest(
      publicationInput,
      published.handoff,
      published.pullRequest,
      state,
    );
    if (integration.outcome === "completed") {
      await input.persistPublication?.(ticket.number, null);
      await persist({
        phase: "completed",
        ticket: ticket.number,
        deliveryTickets,
        barrier: false,
      });
      return {
        outcome: "succeeded",
        reasons: [`Completed Maintenance Ticket ${ticket.number}`],
        ticket: ticket.number,
        handoff: published.handoff,
        pullRequest: published.observation,
      };
    }
    if (integration.outcome === "skipped")
      return skipMaintenance(
        input,
        ticket.number,
        integration.reason,
        published.handoff,
        published.observation,
      );
    await persist({
      phase: "blocked",
      ticket: ticket.number,
      deliveryTickets,
      barrier: true,
    });
    return {
      ...stopped(integration, ticket.number),
      handoff: published.handoff,
      pullRequest: published.observation,
    };
  }
  const operationInput = {
    ...input,
    ticketBoundary,
    ticketKind: "Maintenance Ticket" as const,
  };
  const attempt = await runMaintenanceAttempt({
    ...operationInput,
    checkout: input.checkout,
    ticket: ticket.number,
    promptFile: input.documentationPrompt,
    agent: input.documentationAgent,
    timeoutMs: input.agentTimeoutMs,
  });
  if (attempt.outcome === "boundary")
    return stopped(attempt.boundary, ticket.number);
  if (attempt.outcome === "skipped")
    return skipMaintenance(input, ticket.number, attempt.reason);
  if (attempt.outcome === "blocked") {
    await persist({
      phase: "blocked",
      ticket: ticket.number,
      deliveryTickets,
      barrier: true,
    });
    return {
      outcome: "incomplete",
      reasons: [attempt.reason],
      ticket: ticket.number,
    };
  }
  if (attempt.outcome === "no_change") {
    await persist({
      phase: "pending_closure",
      ticket: ticket.number,
      deliveryTickets,
      barrier: true,
    });
    return closeNoChange(input, ticketBoundary, ticket.number);
  }

  const publicationInput: PublicationInput = {
    ...operationInput,
    handoffs: [attempt.handoff],
    ciRepairBudgets: new Map(),
  };
  const publication = await publishVerifiedHandoffs(publicationInput);
  const published = publication.published[0];
  const skipped = publication.skipped?.[0];
  if (skipped)
    return skipMaintenance(
      input,
      ticket.number,
      skipped.reason,
      attempt.handoff,
      published?.observation,
    );
  if (
    publication.outcome !== "succeeded" ||
    published?.observation.readiness !== "ready"
  ) {
    return {
      outcome:
        publication.outcome === "cancelled"
          ? "cancelled"
          : publication.outcome === "failed"
            ? "failed"
            : "incomplete",
      reasons: publication.reasons,
      ticket: ticket.number,
      handoff: attempt.handoff,
      ...(published ? { pullRequest: published.observation } : {}),
    };
  }
  const state = await observePullRequestForIntegration(
    publicationInput,
    published.pullRequest.number,
  );
  const integration = await integratePullRequest(
    publicationInput,
    attempt.handoff,
    published.pullRequest,
    state,
  );
  if (integration.outcome === "completed") {
    await input.persistPublication?.(ticket.number, null);
    await persist({
      phase: "completed",
      ticket: ticket.number,
      deliveryTickets,
      barrier: false,
    });
    return {
      outcome: "succeeded",
      reasons: [`Completed Maintenance Ticket ${ticket.number}`],
      ticket: ticket.number,
      handoff: attempt.handoff,
      pullRequest: published.observation,
    };
  }
  if (integration.outcome === "skipped")
    return skipMaintenance(
      input,
      ticket.number,
      integration.reason,
      attempt.handoff,
      published.observation,
    );
  await persist({
    phase: "blocked",
    ticket: ticket.number,
    deliveryTickets,
    barrier: true,
  });
  return {
    ...stopped(integration, ticket.number),
    handoff: attempt.handoff,
    pullRequest: published.observation,
  };
}
