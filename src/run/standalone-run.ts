import type { VerifiedHandoff } from "./attempt.ts";
import type { CompletedDelivery } from "../recovery.ts";
import {
  discoverAndReserveStandalone,
  discoverAndReserveStandaloneBatch,
} from "./discovery.ts";
import {
  publishVerifiedHandoffs,
  type PublicationInput,
  type PublicationResult,
} from "./pull-request.ts";
import type { RunInput, RunOutcome, RunSummary } from "./run-input.ts";
import type { createEvent } from "./run-input.ts";
import { implementBatch } from "./run-batch.ts";
import type { AttemptBatchResult } from "./agent-operation.ts";

export interface StandaloneRunContext {
  input: RunInput;
  targetBranch: string;
  event: ReturnType<typeof createEvent>;
  publicationInput: (handoffs: VerifiedHandoff[]) => PublicationInput;
  integratePublication: (
    publication: PublicationResult,
    batchComplete: boolean,
    input: PublicationInput,
    batchTickets: number[],
  ) => Promise<RunOutcome | null>;
  summary: (outcome: RunOutcome, reasons?: string[]) => RunSummary;
  batches: number[];
  handoffs: VerifiedHandoff[];
  completedTickets: number[];
  completedDeliveries: CompletedDelivery[];
  reasons: string[];
  applyAttempts: (attempts: AttemptBatchResult) => void;
}

export async function runStandaloneIssue(
  context: StandaloneRunContext,
): Promise<RunSummary> {
  const { input } = context;
  const selected = input.standaloneIssueList ?? [input.issueTicket!];
  for (;;) {
    const remaining = selected.filter(
      (ticket) => !context.completedTickets.includes(ticket),
    );
    if (remaining.length === 0) return context.summary("succeeded");
    const discovery = input.standaloneIssueList
      ? await discoverAndReserveStandaloneBatch({
          repository: input.repository,
          parentTicket: input.parentTicket,
          standaloneIssues: remaining,
          maxBatchSize: input.maxBatchSize,
          tracker: input.tracker,
          audit: input.audit,
          clock: input.clock,
          operator: input.operator,
          retryPolicy: input.retryPolicy,
          event: context.event,
          runnerAccount: input.runnerAccount,
          reservationLabel: input.reservationLabel,
        })
      : await discoverAndReserveStandalone({
          repository: input.repository,
          parentTicket: input.parentTicket,
          standaloneIssue: input.issueTicket!,
          tracker: input.tracker,
          audit: input.audit,
          clock: input.clock,
          operator: input.operator,
          retryPolicy: input.retryPolicy,
          event: context.event,
          runnerAccount: input.runnerAccount,
          reservationLabel: input.reservationLabel,
        });
    if (discovery.outcome === "no_work" && context.batches.length > 0)
      return context.summary("succeeded");
    if (discovery.outcome !== "incomplete" || discovery.batch.length === 0)
      return context.summary(
        discovery.outcome === "close_parent" ? "succeeded" : discovery.outcome,
        [...context.reasons, ...discovery.reasons],
      );
    context.batches.push(...discovery.batch);
    await input.persistBatch?.(discovery.batch, context.completedDeliveries);
    const attempts = await implementBatch(
      input,
      context.targetBranch,
      context.event,
      discovery.batch,
    );
    context.applyAttempts(attempts);
    context.handoffs.push(...attempts.handoffs);
    const batchComplete =
      attempts.handoffs.length === discovery.batch.length &&
      attempts.reasons.length === 0;
    const publicationInputs = context.publicationInput(attempts.handoffs);
    const publication =
      attempts.handoffs.length === 0
        ? null
        : await publishVerifiedHandoffs(publicationInputs);
    context.reasons.push(...discovery.reasons, ...attempts.reasons);
    if (!publication) return context.summary(attempts.outcome);
    const outcome = await context.integratePublication(
      publication,
      batchComplete,
      publicationInputs,
      discovery.batch,
    );
    if (outcome) return context.summary(outcome);
    if (!input.autoMerge) return context.summary("succeeded");
  }
}
