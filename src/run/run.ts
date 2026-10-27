/* eslint-disable max-lines */
import path from "node:path";
import { type VerifiedHandoff } from "./attempt.ts";
import { discoverAndReserve, releaseTerminalReservation } from "./discovery.ts";
import {
  externalRead,
  OperatorCancelled,
  pauseForOperator,
  scopeOperator,
  serializeOperator,
  TicketSkipped,
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
import { deleteTicketAgentLogs } from "./agent-logs.ts";
import { currentRepairHandoff } from "./pull-request-repair.ts";
import { cleanupTicketWorktrees, type CleanupRecord } from "./cleanup.ts";
import type { GitWorkspace, Ticket } from "./contracts.ts";
import {
  createEvent,
  describeFailure,
  type RunFailure,
  type RunInput,
  type RunOutcome,
  type RunSummary,
  type TicketReport,
  type TicketReportStatus,
} from "./run-input.ts";
import { batchBarrierResolved, implementBatch } from "./run-batch.ts";
import { createPublicationInput } from "./publication-input.ts";
import { runStandaloneIssue } from "./standalone-run.ts";
import { parentClosureReconciliation } from "./write-reconciliation.ts";
export type { RunInput, RunOutcome, RunSummary } from "./run-input.ts";

type PendingTicketReport = Omit<TicketReport, "status"> & {
  status: TicketReportStatus | "pending";
};

interface FailureSummary {
  report?: (error: unknown) => RunSummary;
}

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
  input = {
    ...input,
    operator: serializeOperator(input.operator, new AbortController()),
  };
  const failure: FailureSummary = {};
  try {
    return await runProjectInternal(input, failure);
  } catch (error) {
    if (failure.report === undefined) throw error;
    return failure.report(error);
  }
}

async function runProjectInternal(
  input: RunInput,
  failure: FailureSummary,
): Promise<RunSummary> {
  const event = createEvent(input);
  const targetBranch =
    input.configuredTargetBranch ??
    (await externalRead({
      action: () => input.codeHost.resolveTargetBranch(input.repository),
      audit: input.audit,
      event: event("startup", "resolve_target_branch", input.repository),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    }));

  let hadChildren = false;
  const batches: number[] = [...(input.recoveredRunTickets ?? [])];
  const skippedTickets = new Set<number>();
  const skippedMaintenance = new Set<number>();
  let skippedMaintenanceOccurrence = false;
  let unfinishedCleanup = false;
  const deferredCleanup = new Set<number>();
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
  const skipReasons = new Map<number, string>();
  const ticketReports: PendingTicketReport[] = [];
  const recordTicket = (
    ticket: number,
    kind: TicketReport["kind"],
  ): PendingTicketReport => {
    const existing = ticketReports.find((report) => report.ticket === ticket);
    if (existing) return existing;
    const report: PendingTicketReport = {
      ticket,
      kind,
      status: "pending",
      pullRequest: null,
      pullRequestUrl: null,
      detail: "Selected for processing",
      retainedWorktrees: [],
    };
    ticketReports.push(report);
    return report;
  };
  const updateTicket = (
    ticket: number,
    update: Partial<Omit<PendingTicketReport, "ticket" | "kind">>,
  ): void => {
    const report = ticketReports.find((entry) => entry.ticket === ticket);
    if (report) Object.assign(report, update);
  };
  const recordBatch = (batch: number[]): void => {
    for (const ticket of batch) recordTicket(ticket, "delivery");
  };
  const recordWorktree = (
    ticket: number,
    kind: TicketReport["kind"],
    worktree: string,
  ): void => {
    const report = recordTicket(ticket, kind);
    if (!report.retainedWorktrees.includes(worktree))
      report.retainedWorktrees.push(worktree);
  };
  const clearWorktrees = (ticket: number): void => {
    updateTicket(ticket, { retainedWorktrees: [] });
  };
  const forgetWorktree = (worktree: string): void => {
    for (const report of ticketReports)
      report.retainedWorktrees = report.retainedWorktrees.filter(
        (candidate) => candidate !== worktree,
      );
  };
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
  for (const ticket of batches) {
    recordTicket(ticket, "delivery");
    const intent = publicationIntents.get(ticket);
    if (completedTickets.includes(ticket)) {
      updateTicket(ticket, {
        status: "completed",
        ...(intent?.pullRequest === undefined
          ? {}
          : {
              pullRequest: intent.pullRequest.number,
              pullRequestUrl: intent.pullRequest.url,
            }),
        detail: "Completed Delivery Ticket",
      });
    } else if (intent?.pullRequest !== undefined) {
      updateTicket(ticket, {
        pullRequest: intent.pullRequest.number,
        pullRequestUrl: intent.pullRequest.url,
        detail: "Recovered Pull Request",
      });
    }
  }
  if (maintenanceRecovery?.ticket !== undefined) {
    recordTicket(maintenanceRecovery.ticket, "maintenance");
    if (maintenancePublication?.pullRequest !== undefined)
      updateTicket(maintenanceRecovery.ticket, {
        pullRequest: maintenancePublication.pullRequest.number,
        pullRequestUrl: maintenancePublication.pullRequest.url,
      });
  }
  const sourceGitWorkspace = input.gitWorkspace;
  const trackedGitWorkspace: GitWorkspace = new Proxy(sourceGitWorkspace, {
    get(target, property): unknown {
      if (property === "createWorktree") {
        return async (
          worktreeInput: Parameters<GitWorkspace["createWorktree"]>[0],
        ) => {
          await target.createWorktree(worktreeInput);
          const match = /(?:^|\/)(ticket|maintenance)-(\d+)(?:-|$)/u.exec(
            worktreeInput.branch,
          );
          if (match)
            recordWorktree(
              Number(match[2]),
              match[1] === "maintenance" ? "maintenance" : "delivery",
              worktreeInput.worktree,
            );
        };
      }
      if (
        property === "removeWorktree" &&
        typeof target.removeWorktree === "function"
      ) {
        return async (checkout: string, worktree: string) => {
          await target.removeWorktree!(checkout, worktree);
          forgetWorktree(worktree);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  const sourcePersistBatch = input.persistBatch;
  const sourcePersistMaintenance = input.persistMaintenance;
  const sourcePersistPublication = input.persistPublication;
  input = {
    ...input,
    gitWorkspace: trackedGitWorkspace,
    persistBatch: async (batch, completed) => {
      recordBatch(batch);
      await sourcePersistBatch?.(
        batch.filter((ticket) => !skippedTickets.has(ticket)),
        completed,
      );
    },
    persistMaintenance: async (state) => {
      if (state?.ticket !== undefined)
        recordTicket(state.ticket, "maintenance");
      await sourcePersistMaintenance?.(state);
    },
    persistPublication: async (ticket, intent) => {
      if (intent?.pullRequest !== undefined)
        updateTicket(ticket, {
          pullRequest: intent.pullRequest.number,
          pullRequestUrl: intent.pullRequest.url,
        });
      await sourcePersistPublication?.(ticket, intent);
    },
  };
  let runFailure: RunFailure | undefined;
  const summary = (
    outcome: RunOutcome,
    finalReasons: string[] = reasons,
  ): RunSummary => {
    if (
      (outcome === "succeeded" || outcome === "no_work") &&
      (skippedTickets.size > 0 ||
        skippedMaintenanceOccurrence ||
        unfinishedCleanup)
    )
      outcome = "incomplete";
    if (outcome === "no_work" && ticketReports.length > 0)
      outcome = "incomplete";
    const resolvedReasons =
      outcome === "incomplete" &&
      ticketReports.length > 0 &&
      !finalReasons.includes("No pickable Delivery Tickets remain")
        ? [...finalReasons, "No pickable Delivery Tickets remain"]
        : finalReasons;
    return {
      outcome,
      project: input.project,
      parentTicket: input.parentTicket,
      ...(input.issueTicket === undefined
        ? {}
        : { issueTicket: input.issueTicket }),
      targetBranch,
      reasons: resolvedReasons,
      ...(runFailure === undefined ? {} : { failure: runFailure }),
      skips: [...skipReasons].flatMap(([ticket, reason]) => {
        const report = ticketReports.find((entry) => entry.ticket === ticket);
        return report === undefined ||
          report.status === "completed" ||
          report.status === "no_change"
          ? []
          : [{ ticket, reason }];
      }),
      tickets: ticketReports.map((report) => ({
        ...report,
        status:
          report.status === "pending"
            ? outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? "failed"
                : "blocked"
            : report.status,
        detail:
          report.status === "pending" &&
          report.detail === "Selected for processing"
            ? "Processing did not complete"
            : report.detail,
      })),
      ...(!hasBatchState
        ? {}
        : { batch: batches, handoffs, pullRequests, completedTickets }),
    };
  };
  failure.report = (error) => {
    const outcome = error instanceof OperatorCancelled ? "cancelled" : "failed";
    const reason =
      error instanceof Error
        ? error.message
        : outcome === "cancelled"
          ? "operator cancelled"
          : "Run failed";
    reasons.push(reason);
    if (outcome === "failed") runFailure = describeFailure(error);
    for (const report of ticketReports)
      if (report.status === "pending")
        updateTicket(report.ticket, { detail: reason });
    return summary(outcome);
  };
  const applyAttempts = async (
    attempts: Awaited<ReturnType<typeof implementBatch>>,
  ): Promise<void> => {
    for (const result of attempts.tickets) {
      if (result.outcome === "skipped") {
        skippedTickets.add(result.ticket);
        skipReasons.set(result.ticket, result.skipReason ?? result.detail);
      }
      updateTicket(result.ticket, {
        status:
          result.outcome === "handoff"
            ? "pending"
            : result.outcome === "skipped"
              ? "failed"
              : result.outcome,
        detail:
          result.outcome === "handoff"
            ? "Implementation completed; publication pending"
            : result.detail,
      });
    }
    if (attempts.tickets.some(({ outcome }) => outcome === "skipped"))
      await input.persistBatch?.(
        attempts.tickets.map(({ ticket }) => ticket),
        completedDeliveries,
      );
  };
  const applyPublication = (publication: PublicationResult): void => {
    for (const {
      ticket,
      pullRequest,
      pullRequestUrl,
      reason,
      skipReason,
    } of publication.skipped ?? []) {
      skippedTickets.add(ticket);
      skipReasons.set(ticket, skipReason ?? reason);
      updateTicket(ticket, {
        pullRequest: pullRequest ?? null,
        pullRequestUrl: pullRequestUrl ?? null,
        status: "failed",
        detail: `skipped Delivery Ticket ${ticket}: ${reason}`,
      });
    }
    for (const { observation } of publication.published) {
      if (skippedTickets.has(observation.ticket)) continue;
      updateTicket(observation.ticket, {
        pullRequest: observation.number,
        pullRequestUrl: observation.url,
        status:
          observation.readiness === "ready"
            ? "pending"
            : observation.readiness === "failed"
              ? "failed"
              : "blocked",
        detail:
          observation.readiness === "ready"
            ? `Pull Request #${observation.number} is CI-ready`
            : (publication.reasons[0] ??
              `Pull Request #${observation.number} did not become CI-ready`),
      });
    }
    if (publication.outcome === "cancelled" || publication.outcome === "failed")
      for (const { observation } of publication.published)
        if (
          observation.readiness !== "ready" &&
          !skippedTickets.has(observation.ticket)
        )
          updateTicket(observation.ticket, {
            status: publication.outcome,
            detail: publication.reasons[0] ?? "Publication did not complete",
          });
  };

  const recordReplacementCleanup: NonNullable<
    PublicationInput["recordReplacementCleanup"]
  > = async (ticket, workspace, status) => {
    const candidate = `${workspace.worktree}:${workspace.branch}`;
    const candidates = new Set(cleanupRecords.get(ticket)?.candidates ?? []);
    if (status === "pending") candidates.add(candidate);
    else candidates.delete(candidate);
    const record: CleanupRecord = {
      status: "pending",
      candidates: [...candidates],
    };
    await input.persistCleanup?.(ticket, record);
    cleanupRecords.set(ticket, record);
  };

  const cleanupTerminal = async (
    ticket: number,
    worktreeRoot = path.join(input.projectDirectory, "worktrees"),
    workspaces: VerifiedHandoff[] = [],
  ): Promise<void> => {
    for (;;) {
      const previous = cleanupRecords.get(ticket);
      if (previous?.status === "cleaned" || previous?.status === "accepted")
        return;
      const pending: CleanupRecord = {
        status: "pending",
        candidates: [
          ...new Set([
            ...(previous?.candidates ?? []),
            ...workspaces.map(
              ({ worktree, branch }) => `${worktree}:${branch}`,
            ),
          ]),
        ],
        ...(previous?.error === undefined ? {} : { error: previous.error }),
      };
      await input.persistCleanup?.(ticket, pending);
      cleanupRecords.set(ticket, pending);
      try {
        if (workspaces.length > 0) {
          const logFailures = await deleteTicketAgentLogs(
            input.projectDirectory,
            ticket,
            [
              input.runId,
              ...workspaces.map(({ worktree }) =>
                path.basename(path.dirname(worktree)),
              ),
            ],
          );
          if (logFailures.length > 0)
            throw new Error(
              logFailures
                .map(
                  ({ logFile, error }) => `${logFile ?? "Agent log"}: ${error}`,
                )
                .join("; "),
            );
        }
        const result = await cleanupTicketWorktrees(
          input.gitWorkspace,
          input.checkout,
          input.checkout,
          worktreeRoot,
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
        clearWorktrees(ticket);
        return;
      } catch (error) {
        const current = cleanupRecords.get(ticket) ?? pending;
        const failed = {
          ...current,
          error: error instanceof Error ? error.message : "cleanup failed",
        };
        await input.persistCleanup?.(ticket, failed);
        cleanupRecords.set(ticket, failed);
        try {
          await pauseForOperator(
            input.audit,
            event("cleanup", "terminal_cleanup", `ticket:${ticket}`)(1),
            scopeOperator(
              input.operator,
              `remaining cleanup for Ticket ${ticket}`,
            ),
            `Terminal cleanup for Ticket ${ticket} failed: ${failed.error}`,
          );
        } catch (pauseError) {
          if (!(pauseError instanceof TicketSkipped)) throw pauseError;
          unfinishedCleanup = true;
          deferredCleanup.add(ticket);
          const detail = `Terminal cleanup pending for Ticket ${ticket}: ${failed.error}; retained artifacts: ${failed.candidates.join(", ") || "enumeration incomplete"}`;
          reasons.push(detail);
          const report = ticketReports.find((row) => row.ticket === ticket);
          if (report)
            updateTicket(ticket, { detail: `${report.detail}; ${detail}` });
          return;
        }
      }
    }
  };

  const releaseCompletedReservation = async (
    ticket: number,
    observed?: Ticket,
  ): Promise<void> => {
    const pending: CleanupRecord = {
      status: "pending",
      candidates: [],
      error: "Reservation release pending",
    };
    await input.persistCleanup?.(ticket, pending);
    cleanupRecords.set(ticket, pending);
    const scoped = {
      ...input,
      event,
      operator: scopeOperator(
        input.operator,
        `remaining Reservation release for Ticket ${ticket}`,
      ),
    };
    try {
      const current =
        observed ??
        (await externalRead({
          action: () => input.tracker.getTicket(input.repository, ticket),
          audit: input.audit,
          event: event("release", "read_completed_ticket", `ticket:${ticket}`),
          clock: input.clock,
          operator: scoped.operator,
          retryPolicy: input.retryPolicy,
        }));
      await releaseTerminalReservation(scoped, current);
      const cleaned: CleanupRecord = { status: "cleaned", candidates: [] };
      await input.persistCleanup?.(ticket, cleaned);
      cleanupRecords.set(ticket, cleaned);
    } catch (error) {
      if (!(error instanceof TicketSkipped)) throw error;
      unfinishedCleanup = true;
      const detail = `Reservation release pending for completed Ticket ${ticket}; possible Reservation residue`;
      reasons.push(detail);
      const report = ticketReports.find((row) => row.ticket === ticket);
      updateTicket(ticket, {
        detail: `${report?.detail ?? "Completed"}; ${detail}`,
      });
    }
  };

  for (const [ticket, record] of cleanupRecords) {
    if (
      record.status === "pending" &&
      (input.recoveredCompletedDeliveries?.some(
        (delivery) => delivery.ticket === ticket,
      ) ||
        (input.recoveredMaintenance?.phase === "completed" &&
          input.recoveredMaintenance.ticket === ticket))
    ) {
      await cleanupTerminal(ticket);
      if (
        !deferredCleanup.has(ticket) &&
        input.recoveredCompletedDeliveries?.some(
          (delivery) => delivery.ticket === ticket,
        )
      )
        await releaseCompletedReservation(ticket);
    }
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
      ciRepairAgent: input.ciRepairAgent,
      conflictRepairAgent: input.conflictRepairAgent,
      agentTimeoutMs: input.agentTimeoutMs,
      agentIdleTimeoutMs: input.agentIdleTimeoutMs,
      requiredChecksTimeoutMs: input.requiredChecksTimeoutMs,
      mergeQueueTimeoutMs: input.mergeQueueTimeoutMs,
      adminMerge: input.adminMerge,
      ticketClosure: input.ticketClosure,
      gitWorkspace: input.gitWorkspace,
      codeHost: input.codeHost,
      agentExecutor: input.agentExecutor,
      recordReplacementCleanup,
      ...(input.persistPublication === undefined
        ? {}
        : { persistPublication: input.persistPublication }),
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
    if (result.ticket !== undefined) {
      const report = recordTicket(result.ticket, "maintenance");
      const detail =
        result.reasons.join("; ") ||
        (result.outcome === "succeeded"
          ? `Completed Maintenance Ticket ${result.ticket}`
          : "Maintenance did not complete");
      updateTicket(result.ticket, {
        status:
          result.outcome === "succeeded"
            ? result.pullRequest === undefined && report.pullRequest === null
              ? "no_change"
              : "completed"
            : result.outcome === "cancelled"
              ? "cancelled"
              : result.outcome === "failed"
                ? "failed"
                : result.outcome === "skipped"
                  ? "failed"
                  : "blocked",
        ...(result.pullRequest === undefined
          ? {}
          : {
              pullRequest: result.pullRequest.number,
              pullRequestUrl: result.pullRequest.url,
            }),
        detail,
      });
    }
    if (result.outcome === "succeeded") {
      if (result.ticket !== undefined) await cleanupTerminal(result.ticket);
      maintainedDeliveryTickets = new Set(recovery.deliveryTickets);
      maintenanceRecovery = undefined;
      maintenancePublication = undefined;
      return null;
    }
    if (result.outcome === "skipped") {
      skippedMaintenanceOccurrence = true;
      if (result.ticket !== undefined) {
        skippedMaintenance.add(result.ticket);
        publicationIntents.delete(result.ticket);
        skipReasons.set(result.ticket, result.skipReason ?? result.reasons[0]!);
      }
      maintainedDeliveryTickets = new Set(recovery.deliveryTickets);
      maintenanceRecovery = undefined;
      maintenancePublication = undefined;
      return null;
    }
    return result.outcome;
  };

  const recordSkip = (
    ticket: number,
    reason: string,
    pauseReason = reason,
  ): Promise<void> => {
    skippedTickets.add(ticket);
    recordTicket(ticket, "delivery");
    updateTicket(ticket, { status: "failed", detail: reason });
    reasons.push(reason);
    skipReasons.set(ticket, pauseReason);
    return Promise.resolve();
  };

  const publicationInput = createPublicationInput(
    input,
    targetBranch,
    event,
    publicationIntents,
    recordReplacementCleanup,
  );

  const integratePublication = async (
    publication: PublicationResult,
    batchComplete: boolean,
    publicationInputs: PublicationInput,
    batchTickets: number[],
  ): Promise<RunOutcome | null> => {
    applyPublication(publication);
    pullRequests.push(...publication.pullRequests);
    reasons.push(...publication.reasons);
    const batchReady =
      batchComplete &&
      publication.outcome === "succeeded" &&
      publication.published.every(
        ({ observation }) =>
          observation.readiness === "ready" ||
          skippedTickets.has(observation.ticket),
      );
    if (!batchReady) {
      if (!batchComplete) {
        reasons.push("Batch barrier blocked by unresolved Agent Attempts");
        for (const { observation } of publication.published)
          if (!skippedTickets.has(observation.ticket))
            updateTicket(observation.ticket, {
              status: "blocked",
              detail: "Batch barrier blocked by unresolved Agent Attempts",
            });
      }
      return publication.outcome !== "succeeded"
        ? publication.outcome
        : "incomplete";
    }
    if (
      !input.autoMerge &&
      (input.issueTicket !== undefined ||
        input.standaloneIssueList !== undefined)
    ) {
      const worktreeRoot = path.join(
        input.projectDirectory,
        "worktrees",
        input.runId,
      );
      for (const { observation, handoff } of publication.published) {
        if (skippedTickets.has(observation.ticket)) continue;
        updateTicket(observation.ticket, {
          status: "PR ready",
          pullRequest: observation.number,
          pullRequestUrl: observation.url,
          detail: `Pull Request #${observation.number} is CI-ready; awaiting manual merge`,
        });
        await cleanupTerminal(observation.ticket, worktreeRoot, [
          currentRepairHandoff(publicationInputs, handoff),
        ]);
      }
      return null;
    }
    const observations = await Promise.all(
      publication.published
        .filter(({ handoff }) => !skippedTickets.has(handoff.ticket))
        .map(async (published) => {
          try {
            const scoped = {
              ...publicationInputs,
              operator: scopeOperator(
                publicationInputs.operator,
                `Delivery Ticket ${published.handoff.ticket}`,
              ),
            };
            return {
              ...published,
              state: await observePullRequestForIntegration(
                scoped,
                published.pullRequest.number,
              ),
            };
          } catch (error) {
            if (!(error instanceof TicketSkipped)) throw error;
            await recordSkip(
              published.handoff.ticket,
              error.reason,
              error.pauseReason,
            );
            return null;
          }
        }),
    );
    const ordered = observations.filter((published) => published !== null);
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
      if (integration.outcome === "skipped") {
        skippedTickets.add(handoff.ticket);
        skipReasons.set(
          handoff.ticket,
          integration.skipReason ?? integration.reason,
        );
        updateTicket(handoff.ticket, {
          status: "failed",
          pullRequest: pullRequest.number,
          pullRequestUrl: pullRequest.url,
          detail: `skipped Delivery Ticket ${handoff.ticket}: ${integration.reason}`,
        });
        reasons.push(
          `skipped Delivery Ticket ${handoff.ticket}: ${integration.reason}`,
        );
        continue;
      }
      if (integration.outcome !== "completed") {
        reasons.push(integration.reason);
        const status =
          integration.outcome === "cancelled"
            ? "cancelled"
            : integration.outcome === "failed"
              ? "failed"
              : "blocked";
        for (const ticket of batchTickets)
          if (
            ticketReports.find((report) => report.ticket === ticket)?.status ===
            "pending"
          )
            updateTicket(ticket, {
              status,
              detail: integration.reason,
            });
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
      updateTicket(handoff.ticket, {
        status: "completed",
        pullRequest: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        detail: `Pull Request #${pullRequest.number} merged and ticket closed`,
      });
      await input.persistBatch?.(batchTickets, completedDeliveries);
      if (!completedTickets.includes(handoff.ticket))
        completedTickets.push(handoff.ticket);
      reasons.push(
        `Completed Delivery Ticket ${handoff.ticket} through Pull Request ${pullRequest.number}`,
      );
      try {
        await cleanupTerminal(integration.ticket.number);
        if (deferredCleanup.has(integration.ticket.number)) continue;
        await releaseCompletedReservation(handoff.ticket, integration.ticket);
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
    return summary(
      skippedMaintenance.size > 0 ? "incomplete" : (outcome ?? "succeeded"),
    );
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
    recordBatch(batches);
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
      await applyAttempts(attempts);
      handoffs.push(...attempts.handoffs);
      batchComplete = batchBarrierResolved(
        attempts,
        recoveredPublication.restarted,
      );
      inputs = publicationInput(attempts.handoffs);
      const restartedPublication =
        attempts.handoffs.length === 0
          ? null
          : await publishVerifiedHandoffs(inputs);
      publication = {
        outcome:
          restartedPublication?.outcome ??
          (batchComplete ? recoveredPublication.outcome : attempts.outcome),
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
        ...((recoveredPublication.skipped?.length ?? 0) === 0 &&
        (restartedPublication?.skipped?.length ?? 0) === 0
          ? {}
          : {
              skipped: [
                ...(recoveredPublication.skipped ?? []),
                ...(restartedPublication?.skipped ?? []),
              ],
            }),
      };
    }
    const outcome = await integratePublication(
      publication,
      batchComplete,
      inputs,
      input.recoveredBatch ?? recovered.map(({ ticket }) => ticket),
    );
    if (outcome) return summary(outcome);
    if (!input.autoMerge)
      return summary(
        skippedTickets.size > 0 || skippedMaintenance.size > 0
          ? "incomplete"
          : "succeeded",
      );
  }

  if (input.issueTicket !== undefined) {
    hasBatchState = true;
    return runStandaloneIssue({
      input,
      targetBranch,
      event,
      publicationInput,
      integratePublication,
      summary,
      batches,
      handoffs,
      completedTickets,
      completedDeliveries,
      reasons,
      applyAttempts,
      skippedTickets,
      skippedMaintenance,
      recordSkip,
    });
  }

  if (input.standaloneIssueList !== undefined) {
    hasBatchState = true;
    return runStandaloneIssue({
      input,
      targetBranch,
      event,
      publicationInput,
      integratePublication,
      summary,
      batches,
      handoffs,
      completedTickets,
      completedDeliveries,
      reasons,
      applyAttempts,
      skippedTickets,
      skippedMaintenance,
      recordSkip,
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
      excludedTickets: skippedTickets,
      onSkip: recordSkip,
    });
    if (discovery.outcome === "incomplete") hasBatchState = true;
    if (discovery.outcome === "close_parent") {
      reasons.push(...discovery.reasons);
      if (skippedTickets.size > 0 || skippedMaintenanceOccurrence)
        return summary("incomplete");
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
    await applyAttempts(attempts);
    handoffs.push(...attempts.handoffs);
    const batchComplete = batchBarrierResolved(attempts, discovery.batch);
    const publicationInputs = publicationInput(attempts.handoffs);
    const publication =
      attempts.handoffs.length === 0
        ? null
        : await publishVerifiedHandoffs(publicationInputs);
    reasons.push(...discovery.reasons, ...attempts.reasons);
    if (!publication) {
      if (batchComplete) continue;
      return summary(attempts.outcome);
    }
    const outcome = await integratePublication(
      publication,
      batchComplete,
      publicationInputs,
      discovery.batch,
    );
    if (outcome) return summary(outcome);
  }
}
