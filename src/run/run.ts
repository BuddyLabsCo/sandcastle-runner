/* eslint-disable max-lines */
import path from "node:path";
import { type VerifiedHandoff } from "./attempt.ts";
import { discoverAndReserve, releaseTerminalReservation } from "./discovery.ts";
import {
  externalRead,
  OperatorCancelled,
  workflowWrite,
} from "./operations.ts";
import { runDocumentationMaintenance } from "./maintenance.ts";
import {
  integratePullRequest,
  observePullRequestForIntegration,
  publishVerifiedHandoffs,
  recoverPublishedHandoffs,
  type PublicationInput,
  type PublicationResult,
  type PullRequestObservation,
} from "./pull-request.ts";
import type {
  CompletedDelivery,
  MaintenanceState,
  PublicationIntent,
} from "../recovery.ts";
import { cleanupTicketWorktrees, type CleanupRecord } from "./cleanup.ts";
import type { Ticket } from "./contracts.ts";
import {
  createEvent,
  type RunInput,
  type RunOutcome,
  type RunSummary,
} from "./run-input.ts";
import { implementBatch } from "./run-batch.ts";
import { createPublicationInput } from "./publication-input.ts";
import { runStandaloneIssue } from "./standalone-run.ts";
import { parentClosureReconciliation } from "./write-reconciliation.ts";
export type { RunInput, RunOutcome, RunSummary } from "./run-input.ts";

function recordCompletedDelivery(
  deliveries: CompletedDelivery[],
  ticketNumber: number,
  ticket: Ticket,
): void {
  const delivery = {
    ticket: ticketNumber,
    labels:
      ticket.state === "closed" && ticket.stateReason === "completed"
        ? [...(ticket.labels ?? [])]
        : [],
  };
  const index = deliveries.findIndex(({ ticket }) => ticket === ticketNumber);
  if (index === -1) deliveries.push(delivery);
  else deliveries[index] = delivery;
}

function batchMatchesTrigger(
  batch: number[],
  deliveries: CompletedDelivery[],
  trigger: string,
): boolean {
  return (
    trigger.length > 0 &&
    batch.some((ticket) =>
      deliveries
        .find((delivery) => delivery.ticket === ticket)
        ?.labels.includes(trigger),
    )
  );
}

export async function runProject(input: RunInput): Promise<RunSummary> {
  const event = createEvent(input);
  const targetBranch =
    input.configuredTargetBranch ??
    (await externalRead({
      action: () => input.codeHost.resolveTargetBranch(input.repository),
      parseOverride: (value) => {
        const parsed = JSON.parse(value) as { targetBranch?: unknown };
        if (
          typeof parsed.targetBranch !== "string" ||
          parsed.targetBranch.length === 0
        ) {
          throw new Error("override has no Target Branch");
        }
        return parsed.targetBranch;
      },
      audit: input.audit,
      event: event("startup", "resolve_target_branch", input.repository),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    }));

  let hadChildren = false;
  const batches: number[] = [...(input.recoveredRunTickets ?? [])];
  const handoffs: VerifiedHandoff[] = [];
  const pullRequests: PullRequestObservation[] = [];
  const completedDeliveries: CompletedDelivery[] = [
    ...(input.recoveredCompletedDeliveries ?? []).map((delivery) => ({
      ticket: delivery.ticket,
      labels: [...delivery.labels],
    })),
  ];
  const completedTickets = completedDeliveries.map(({ ticket }) => ticket);
  const reasons: string[] = [...(input.startupReasons ?? [])];
  const publicationIntents = new Map<number, PublicationIntent>();
  for (const intent of input.recoveredPublications ?? [])
    publicationIntents.set(intent.ticket, intent);
  let hasBatchState = false;
  const cleanupRecords = new Map<number, CleanupRecord>();
  for (const [ticket, record] of Object.entries(input.recoveredCleanup ?? {}))
    cleanupRecords.set(Number(ticket), record);
  let maintenanceRecovery = input.recoveredMaintenance?.barrier
    ? input.recoveredMaintenance
    : undefined;
  let maintenancePublication = input.recoveredPublications?.find(
    ({ kind }) => kind === "maintenance",
  );
  if (
    maintenanceRecovery === undefined &&
    maintenancePublication !== undefined
  ) {
    maintenanceRecovery = {
      phase: "attempting",
      ticket: maintenancePublication.ticket,
      deliveryTickets: input.recoveredBatch ?? [],
      barrier: true,
    };
  }
  const summary = (
    outcome: RunOutcome,
    finalReasons: string[] = reasons,
  ): RunSummary => ({
    outcome,
    project: input.project,
    parentTicket: input.parentTicket,
    ...(input.issueTicket === undefined
      ? {}
      : { issueTicket: input.issueTicket }),
    targetBranch,
    reasons: finalReasons,
    ...(!hasBatchState
      ? {}
      : { batch: batches, handoffs, pullRequests, completedTickets }),
  });

  const cleanupTerminal = async (ticket: number): Promise<void> => {
    const previous = cleanupRecords.get(ticket);
    if (previous?.status === "cleaned" || previous?.status === "accepted")
      return;
    for (;;) {
      const pending: CleanupRecord = {
        status: "pending",
        candidates: previous?.candidates ?? [],
        ...(previous?.error === undefined ? {} : { error: previous.error }),
      };
      await input.persistCleanup?.(ticket, pending);
      cleanupRecords.set(ticket, pending);
      try {
        const result = await cleanupTicketWorktrees(
          input.gitWorkspace,
          input.checkout,
          input.checkout,
          path.join(input.projectDirectory, "worktrees"),
          ticket,
          async (candidates) => {
            const discovered = { ...pending, candidates };
            await input.persistCleanup?.(ticket, discovered);
            cleanupRecords.set(ticket, discovered);
          },
          pending.candidates,
        );
        await input.persistCleanup?.(ticket, result);
        cleanupRecords.set(ticket, result);
        return;
      } catch (error) {
        const current = cleanupRecords.get(ticket) ?? pending;
        const failed = {
          ...current,
          error: error instanceof Error ? error.message : "cleanup failed",
        };
        await input.persistCleanup?.(ticket, failed);
        cleanupRecords.set(ticket, failed);
        const response = await input.operator.pause(
          `Terminal cleanup for Ticket ${ticket} failed. Enter to retry, q to cancel, or supply accepted residual artifacts.`,
        );
        if (response === null || response === "q")
          throw new Error(`terminal cleanup pending for Ticket ${ticket}`, {
            cause: error,
          });
        if (response !== "") {
          const accepted = {
            status: "accepted" as const,
            candidates: failed.candidates,
            residual: response.split("\n").filter(Boolean),
          };
          await input.persistCleanup?.(ticket, accepted);
          cleanupRecords.set(ticket, accepted);
          return;
        }
      }
    }
  };

  for (const [ticket, record] of cleanupRecords) {
    if (record.status === "pending") await cleanupTerminal(ticket);
  }
  let maintainedDeliveryTickets = new Set(
    input.recoveredMaintenance?.phase === "completed"
      ? input.recoveredMaintenance.deliveryTickets
      : [],
  );

  const maintain = async (): Promise<RunOutcome | null> => {
    if (!input.documentationAgent) {
      throw new Error("Documentation Maintenance agent is not configured");
    }
    const recovery =
      maintenanceRecovery ??
      ({
        phase: "scheduled",
        deliveryTickets: [],
        barrier: true,
      } satisfies MaintenanceState);
    const result = await runDocumentationMaintenance({
      repository: input.repository,
      parentTicket: input.parentTicket,
      tracker: input.tracker,
      audit: input.audit,
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
      event,
      runnerAccount: input.runnerAccount,
      reservationLabel: input.reservationLabel,
      targetBranch,
      checkout: input.checkout,
      runId: input.runId,
      projectDirectory: input.projectDirectory,
      documentationPrompt: input.documentationPrompt,
      documentationAgent: input.documentationAgent,
      maintenanceTicket: input.maintenanceTicket,
      maintenanceTicketLabel: input.maintenanceTicket.label,
      parentScopedMaintenance:
        input.documentOnly !== true &&
        input.issueTicket === undefined &&
        input.standaloneIssueList === undefined,
      recovery,
      ...(input.persistMaintenance === undefined
        ? {}
        : { persistMaintenance: input.persistMaintenance }),
      ...(maintenancePublication === undefined
        ? {}
        : {
            recoveryPublication: maintenancePublication,
          }),
      ciRepairPrompt: input.ciRepairPrompt,
      ciRepairAgent: input.ciRepairAgent,
      conflictRepairPrompt: input.conflictRepairPrompt,
      conflictRepairAgent: input.conflictRepairAgent,
      agentTimeoutMs: input.agentTimeoutMs,
      requiredChecksTimeoutMs: input.requiredChecksTimeoutMs,
      mergeQueueTimeoutMs: input.mergeQueueTimeoutMs,
      adminMerge: input.adminMerge,
      ticketClosure: input.ticketClosure,
      gitWorkspace: input.gitWorkspace,
      codeHost: input.codeHost,
      agentExecutor: input.agentExecutor,
      ...(input.persistPublication === undefined
        ? {}
        : { persistPublication: input.persistPublication }),
      cleanupTerminal,
    }).catch((error: unknown) => {
      if (!(error instanceof OperatorCancelled)) throw error;
      return null;
    });
    if (!result) {
      reasons.push("operator cancelled");
      return "cancelled";
    }
    reasons.push(...result.reasons);
    if (result.handoff) handoffs.push(result.handoff);
    if (result.pullRequest) pullRequests.push(result.pullRequest);
    if (result.outcome === "succeeded") {
      if (result.ticket !== undefined) await cleanupTerminal(result.ticket);
      maintainedDeliveryTickets = new Set(recovery.deliveryTickets);
      maintenanceRecovery = undefined;
      maintenancePublication = undefined;
      return null;
    }
    return result.outcome;
  };

  const publicationInput = createPublicationInput(
    input,
    targetBranch,
    event,
    publicationIntents,
    cleanupTerminal,
  );

  const integratePublication = async (
    publication: PublicationResult,
    batchComplete: boolean,
    publicationInputs: PublicationInput,
    batchTickets: number[],
  ): Promise<RunOutcome | null> => {
    pullRequests.push(...publication.pullRequests);
    reasons.push(...publication.reasons);
    const batchReady =
      batchComplete &&
      publication.outcome === "succeeded" &&
      publication.published.every(
        ({ observation }) => observation.readiness === "ready",
      );
    if (!batchReady) {
      if (!batchComplete)
        reasons.push("Batch barrier blocked by unresolved Agent Attempts");
      return publication.outcome !== "succeeded"
        ? publication.outcome
        : "incomplete";
    }
    if (
      !input.autoMerge &&
      (input.issueTicket !== undefined ||
        input.standaloneIssueList !== undefined)
    )
      return null;
    const ordered = await Promise.all(
      publication.published.map(async (published) => ({
        ...published,
        state: await observePullRequestForIntegration(
          publicationInputs,
          published.pullRequest.number,
        ),
      })),
    );
    ordered.sort(
      (left, right) =>
        left.state.createdAt.localeCompare(right.state.createdAt) ||
        left.pullRequest.number - right.pullRequest.number,
    );
    for (const { handoff, pullRequest, state } of ordered) {
      let integration: Awaited<ReturnType<typeof integratePullRequest>>;
      try {
        integration = await integratePullRequest(
          publicationInputs,
          handoff,
          pullRequest,
          state,
        );
      } catch (error) {
        if (!(error instanceof OperatorCancelled)) throw error;
        reasons.push("operator cancelled");
        return "cancelled";
      }
      if (integration.outcome !== "completed") {
        reasons.push(integration.reason);
        return integration.outcome === "cancelled"
          ? "cancelled"
          : integration.outcome === "failed"
            ? "failed"
            : "incomplete";
      }
      recordCompletedDelivery(
        completedDeliveries,
        handoff.ticket,
        integration.ticket,
      );
      await input.persistBatch?.(batchTickets, completedDeliveries);
      if (!completedTickets.includes(handoff.ticket))
        completedTickets.push(handoff.ticket);
      reasons.push(
        `Completed Delivery Ticket ${handoff.ticket} through Pull Request ${pullRequest.number}`,
      );
      try {
        await cleanupTerminal(integration.ticket.number);
        await releaseTerminalReservation(publicationInputs, integration.ticket);
      } catch (error) {
        if (!(error instanceof OperatorCancelled)) throw error;
        reasons.push("operator cancelled");
        return "cancelled";
      }
    }
    const matches = batchMatchesTrigger(
      batchTickets,
      completedDeliveries,
      input.docMaintainTriggerLabel,
    );
    const alreadyMaintained =
      batchTickets.length > 0 &&
      batchTickets.every((ticket) => maintainedDeliveryTickets.has(ticket));
    if (matches && !alreadyMaintained) {
      maintenanceRecovery = {
        phase: "scheduled",
        deliveryTickets: [...batchTickets],
        barrier: true,
      };
      await input.persistMaintenance?.(maintenanceRecovery);
      return maintain();
    }
    return null;
  };

  if (maintenanceRecovery?.barrier) {
    const outcome = await maintain();
    if (outcome) return summary(outcome);
  }

  if (input.documentOnly) {
    maintenanceRecovery = {
      phase: "scheduled",
      deliveryTickets: [],
      barrier: true,
    };
    const outcome = await maintain();
    return summary(outcome ?? "succeeded");
  }

  if (
    (input.recoveredPublications?.some(({ kind }) => kind !== "maintenance") ??
      false) ||
    (input.recoveredBatch?.length ?? 0) > 0
  ) {
    hasBatchState = true;
    const completed = new Set(
      (input.recoveredCompletedDeliveries ?? []).map(({ ticket }) => ticket),
    );
    const recovered = (input.recoveredPublications ?? []).filter(
      (intent) =>
        intent.kind !== "maintenance" && !completed.has(intent.ticket),
    );
    if (input.recoveredRunTickets === undefined) {
      batches.push(
        ...(input.recoveredBatch ?? recovered.map(({ ticket }) => ticket)),
      );
    }
    let inputs = publicationInput([]);
    const recoveredPublication = recovered.length
      ? await recoverPublishedHandoffs(inputs, recovered)
      : {
          outcome: "succeeded" as const,
          reasons: [],
          pullRequests: [],
          published: [],
          restarted: (input.recoveredBatch ?? []).filter(
            (ticket) => !completed.has(ticket),
          ),
        };
    let publication: PublicationResult = recoveredPublication;
    handoffs.push(...publication.published.map(({ handoff }) => handoff));
    let batchComplete = recoveredPublication.restarted.length === 0;
    if (recoveredPublication.restarted.length > 0) {
      const attempts = await implementBatch(
        input,
        targetBranch,
        event,
        recoveredPublication.restarted,
      );
      handoffs.push(...attempts.handoffs);
      batchComplete =
        attempts.handoffs.length === recoveredPublication.restarted.length &&
        attempts.reasons.length === 0;
      inputs = publicationInput(attempts.handoffs);
      const restartedPublication =
        attempts.handoffs.length === 0
          ? null
          : await publishVerifiedHandoffs(inputs);
      publication = {
        outcome: restartedPublication?.outcome ?? attempts.outcome,
        reasons: [
          ...recoveredPublication.reasons,
          ...attempts.reasons,
          ...(restartedPublication?.reasons ?? []),
        ],
        pullRequests: [
          ...recoveredPublication.pullRequests,
          ...(restartedPublication?.pullRequests ?? []),
        ],
        published: [
          ...recoveredPublication.published,
          ...(restartedPublication?.published ?? []),
        ],
      };
    }
    const outcome = await integratePublication(
      publication,
      batchComplete,
      inputs,
      input.recoveredBatch ?? recovered.map(({ ticket }) => ticket),
    );
    if (outcome) return summary(outcome);
    if (!input.autoMerge) return summary("succeeded");
  }

  if (input.issueTicket !== undefined) {
    hasBatchState = true;
    return runStandaloneIssue({
      input,
      targetBranch,
      event,
      cleanupTerminal,
      publicationInput,
      integratePublication,
      summary,
      batches,
      handoffs,
      completedTickets,
      completedDeliveries,
      reasons,
    });
  }

  if (input.standaloneIssueList !== undefined) {
    hasBatchState = true;
    return runStandaloneIssue({
      input,
      targetBranch,
      event,
      cleanupTerminal,
      publicationInput,
      integratePublication,
      summary,
      batches,
      handoffs,
      completedTickets,
      completedDeliveries,
      reasons,
    });
  }

  for (;;) {
    const discovery = await discoverAndReserve({
      repository: input.repository,
      parentTicket: input.parentTicket,
      maxBatchSize: input.maxBatchSize,
      tracker: input.tracker,
      audit: input.audit,
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
      event,
      runnerAccount: input.runnerAccount,
      reservationLabel: input.reservationLabel,
      issueList: input.issueList,
      hadChildren,
      cleanupTerminal,
    });
    if (discovery.outcome === "incomplete") hasBatchState = true;
    if (discovery.outcome === "close_parent") {
      reasons.push(...discovery.reasons);
      await workflowWrite({
        action: () =>
          input.tracker.closeParent(input.repository, input.parentTicket),
        audit: input.audit,
        clock: input.clock,
        automaticRetry: {
          reconcile: parentClosureReconciliation(input, event),
        },
        event: (attempt) =>
          event(
            "close_parent",
            "close_parent",
            `parent:${input.parentTicket}`,
          )(attempt),
        operator: input.operator,
        retryPolicy: input.retryPolicy,
      });
      return summary("succeeded");
    }
    if (discovery.outcome !== "incomplete" || discovery.batch.length === 0) {
      return summary(discovery.outcome, [...reasons, ...discovery.reasons]);
    }

    hadChildren = true;
    batches.push(...discovery.batch);
    await input.persistBatch?.(discovery.batch, completedDeliveries);
    const attempts = await implementBatch(
      input,
      targetBranch,
      event,
      discovery.batch,
    );
    handoffs.push(...attempts.handoffs);
    const batchComplete =
      attempts.handoffs.length === discovery.batch.length &&
      attempts.reasons.length === 0;
    const publicationInputs = publicationInput(attempts.handoffs);
    const publication =
      attempts.handoffs.length === 0
        ? null
        : await publishVerifiedHandoffs(publicationInputs);
    reasons.push(...discovery.reasons, ...attempts.reasons);
    if (!publication) return summary(attempts.outcome);
    const outcome = await integratePublication(
      publication,
      batchComplete,
      publicationInputs,
      discovery.batch,
    );
    if (outcome) return summary(outcome);
  }
}
