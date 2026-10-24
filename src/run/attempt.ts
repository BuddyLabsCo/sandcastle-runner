import path from "node:path";

import type { AgentConfig } from "../config.ts";
import type { PullRequestIdentity, RequiredCheck } from "./contracts.ts";
import {
  releasePrePublicationReservation,
  type DeliveryBoundaryResult,
} from "./discovery.ts";
import {
  externalRead,
  OperatorCancelled,
  serializeOperator,
  workflowWrite,
} from "./operations.ts";
import {
  runAgentOperation,
  boundary,
  BoundaryStop,
  type AgentOperationInput,
  type AttemptInput,
  type VerifiedHandoff,
  type AttemptBatchResult,
  type MaintenanceAttemptResult,
  type TicketAttemptOutcome,
} from "./agent-operation.ts";
import { TicketSkipped } from "./agent-pause.ts";
import { reviewHandoff } from "./review-attempt.ts";
export type {
  AttemptBatchResult,
  MaintenanceAttemptResult,
  VerifiedHandoff,
} from "./agent-operation.ts";

function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/u.test(value))
    throw new Error("override has no full base SHA");
  return value;
}

async function implementTicket(
  input: AttemptInput,
  ticket: number,
  base: string,
  controller: AbortController,
): Promise<TicketAttemptOutcome> {
  const ticketInput =
    input.standaloneIssues === undefined
      ? input
      : { ...input, standaloneIssue: ticket };
  try {
    await boundary(ticketInput, ticket);
    const branch = `sandcastle/run-${input.runId}/ticket-${ticket}`;
    const worktree = path.join(
      input.projectDirectory,
      "worktrees",
      input.runId,
      `ticket-${ticket}`,
    );
    await workflowWrite({
      action: () =>
        input.gitWorkspace.createWorktree({
          checkout: input.checkout,
          worktree,
          branch,
          base,
        }),
      audit: input.audit,
      clock: input.clock,
      event: () =>
        input.event(
          "prepare_worktrees",
          "create_worktree",
          `ticket:${ticket}`,
        )(1),
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    const result = await runAgentOperation(ticketInput, {
      phase: "implement",
      sessionName: `implement issue ${ticket}`,
      ticket,
      worktree,
      branch,
      base,
      promptFile: input.promptFile,
      promptArgs: {
        TICKET_NUMBER: ticket,
        TICKET_REFERENCE: `${input.repository}#${ticket}`,
        WORKTREE_PATH: worktree,
        BASE_SHA: base,
        PROJECT_TARGET_BRANCH: input.targetBranch,
      },
      pullRequestMetadata: "required",
      agent: input.agent,
      signal: controller.signal,
      attemptCounter: { value: 0 },
    });
    if ("reason" in result)
      return { ticket, outcome: result.outcome, detail: result.reason };
    const handoff = input.review
      ? await reviewHandoff(input, result, controller.signal)
      : result;
    return {
      ticket,
      outcome: "handoff",
      detail: "Implementation and review completed",
      handoff,
    };
  } catch (error) {
    if (error instanceof TicketSkipped) {
      await releasePrePublicationReservation(ticketInput, ticket);
      return {
        ticket,
        outcome: "skipped",
        detail: `skipped Delivery Ticket ${ticket}: ${error.reason}`,
      };
    }
    if (error instanceof BoundaryStop && error.result.outcome === "stopped")
      return { ticket, outcome: "blocked", detail: error.result.reason };
    throw error;
  }
}

export async function runCiRepairAttempt(
  input: AgentOperationInput & {
    handoff: VerifiedHandoff;
    base: string;
    pullRequest: PullRequestIdentity;
    failedChecks: RequiredCheck[];
    promptFile: string;
    agent: AgentConfig;
    signal: AbortSignal;
    attemptCounter: { value: number };
  },
): Promise<
  | { outcome: "handoff"; handoff: VerifiedHandoff }
  | { outcome: "consumed"; reason: string }
  | {
      outcome: "boundary";
      boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;
    }
  | { outcome: "skipped"; reason: string }
> {
  try {
    const result = await runAgentOperation(input, {
      phase: "ci_repair",
      sessionName: `fix ci for pr ${input.pullRequest.number}`,
      ticket: input.handoff.ticket,
      worktree: input.handoff.worktree,
      branch: input.handoff.branch,
      base: input.base,
      promptFile: input.promptFile,
      promptArgs: {
        TICKET_NUMBER: input.handoff.ticket,
        TICKET_REFERENCE: `${input.repository}#${input.handoff.ticket}`,
        WORKTREE_PATH: input.handoff.worktree,
        BASE_SHA: input.base,
        PROJECT_TARGET_BRANCH: input.targetBranch,
        PULL_REQUEST_NUMBER: input.pullRequest.number,
        PULL_REQUEST_URL: input.pullRequest.url,
        FAILED_CHECKS: JSON.stringify(
          input.failedChecks.map(({ name, state, link }) => ({
            name,
            state,
            link,
          })),
        ),
      },
      pullRequestMetadata: "ignored",
      existingPrMetadata: input.handoff,
      agent: input.agent,
      signal: input.signal,
      attemptCounter: input.attemptCounter,
    });
    return "reason" in result
      ? { outcome: "consumed", reason: result.reason }
      : {
          outcome: "handoff",
          handoff: {
            ...result,
            ...(input.handoff.remoteBranch === undefined
              ? {}
              : { remoteBranch: input.handoff.remoteBranch }),
          },
        };
  } catch (error) {
    if (error instanceof TicketSkipped)
      return { outcome: "skipped", reason: error.reason };
    if (error instanceof BoundaryStop) {
      return { outcome: "boundary", boundary: error.result };
    }
    throw error;
  }
}

export async function runConflictRepairAttempt(
  input: AgentOperationInput & {
    handoff: VerifiedHandoff;
    base: string;
    targetBase: string;
    pullRequest: PullRequestIdentity;
    conflict: string;
    promptFile: string;
    agent: AgentConfig;
    signal: AbortSignal;
    attemptCounter: { value: number };
  },
): Promise<
  | { outcome: "handoff"; handoff: VerifiedHandoff }
  | { outcome: "consumed"; reason: string }
  | {
      outcome: "boundary";
      boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;
    }
  | { outcome: "skipped"; reason: string }
> {
  try {
    const result = await runAgentOperation(input, {
      phase: "conflict_repair",
      sessionName: `resolve conflict for pr ${input.pullRequest.number}`,
      ticket: input.handoff.ticket,
      worktree: input.handoff.worktree,
      branch: input.handoff.branch,
      base: input.base,
      requiredAncestor: input.targetBase,
      promptFile: input.promptFile,
      promptArgs: {
        TICKET_NUMBER: input.handoff.ticket,
        TICKET_REFERENCE: `${input.repository}#${input.handoff.ticket}`,
        WORKTREE_PATH: input.handoff.worktree,
        BASE_SHA: input.base,
        PROJECT_TARGET_BRANCH: input.targetBranch,
        TARGET_BRANCH_SHA: input.targetBase,
        PULL_REQUEST_NUMBER: input.pullRequest.number,
        PULL_REQUEST_URL: input.pullRequest.url,
        MERGE_CONFLICT: input.conflict,
      },
      pullRequestMetadata: "ignored",
      existingPrMetadata: input.handoff,
      agent: input.agent,
      signal: input.signal,
      attemptCounter: input.attemptCounter,
    });
    return "reason" in result
      ? { outcome: "consumed", reason: result.reason }
      : {
          outcome: "handoff",
          handoff: {
            ...result,
            ...(input.handoff.remoteBranch === undefined
              ? {}
              : { remoteBranch: input.handoff.remoteBranch }),
          },
        };
  } catch (error) {
    if (error instanceof TicketSkipped)
      return { outcome: "skipped", reason: error.reason };
    if (error instanceof BoundaryStop) {
      return { outcome: "boundary", boundary: error.result };
    }
    throw error;
  }
}

export async function runMaintenanceAttempt(
  input: AgentOperationInput & {
    checkout: string;
    ticket: number;
    promptFile: string;
    agent: AgentConfig;
  },
): Promise<MaintenanceAttemptResult> {
  try {
    await boundary(input, input.ticket);
    const base = await externalRead({
      action: () =>
        input.gitWorkspace.fetchTargetBranch(
          input.checkout,
          input.targetBranch,
        ),
      parseOverride: (value) => {
        const parsed = JSON.parse(value) as { base?: unknown };
        return fullSha(parsed.base);
      },
      audit: input.audit,
      event: input.event(
        "maintenance",
        "fetch_target_branch",
        input.targetBranch,
      ),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    const branch = `sandcastle/run-${input.runId}/maintenance-${input.ticket}`;
    const worktree = path.join(
      input.projectDirectory,
      "worktrees",
      input.runId,
      `maintenance-${input.ticket}`,
    );
    await workflowWrite({
      action: () =>
        input.gitWorkspace.createWorktree({
          checkout: input.checkout,
          worktree,
          branch,
          base,
        }),
      audit: input.audit,
      clock: input.clock,
      event: () =>
        input.event(
          "maintenance",
          "create_worktree",
          `ticket:${input.ticket}`,
        )(1),
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    const result = await runAgentOperation(input, {
      phase: "maintenance",
      sessionName: `document maintain issue ${input.ticket}`,
      ticket: input.ticket,
      worktree,
      branch,
      base,
      promptFile: input.promptFile,
      promptArgs: {
        TICKET_NUMBER: input.ticket,
        TICKET_REFERENCE: `${input.repository}#${input.ticket}`,
        WORKTREE_PATH: worktree,
        BASE_SHA: base,
        PROJECT_TARGET_BRANCH: input.targetBranch,
      },
      pullRequestMetadata: "required_for_committed",
      agent: input.agent,
      signal: new AbortController().signal,
      attemptCounter: { value: 0 },
    });
    return "reason" in result
      ? result
      : { outcome: "committed", handoff: result };
  } catch (error) {
    if (error instanceof TicketSkipped)
      return { outcome: "skipped", reason: error.reason };
    if (error instanceof BoundaryStop) {
      return { outcome: "boundary", boundary: error.result };
    }
    throw error;
  }
}

export async function implementReservedBatch(
  input: AttemptInput,
): Promise<AttemptBatchResult> {
  const candidates: number[] = [];
  const tickets: TicketAttemptOutcome[] = [];
  const controller = new AbortController();
  let attempts: Promise<TicketAttemptOutcome>[] = [];
  try {
    for (const ticket of input.batch) {
      try {
        await boundary(input, ticket);
        candidates.push(ticket);
      } catch (error) {
        if (!(error instanceof BoundaryStop)) throw error;
        const outcome: TicketAttemptOutcome = {
          ticket,
          outcome:
            error.result.outcome === "cancelled"
              ? "cancelled"
              : error.result.outcome === "failed"
                ? "failed"
                : "blocked",
          detail: error.result.reason,
        };
        tickets.push(outcome);
        if (outcome.outcome === "cancelled" || outcome.outcome === "failed")
          return {
            outcome: outcome.outcome,
            reasons: [outcome.detail],
            handoffs: [],
            tickets,
          };
      }
    }
    if (candidates.length === 0)
      return {
        outcome: "incomplete",
        reasons: tickets.map(({ detail }) => detail),
        handoffs: [],
        tickets,
      };
    const base = await externalRead({
      action: () =>
        input.gitWorkspace.fetchTargetBranch(
          input.checkout,
          input.targetBranch,
        ),
      parseOverride: (value) => {
        const parsed = JSON.parse(value) as { base?: unknown };
        return fullSha(parsed.base);
      },
      audit: input.audit,
      event: input.event(
        "prepare_worktrees",
        "fetch_target_branch",
        input.targetBranch,
      ),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    const concurrentInput = {
      ...input,
      operator: serializeOperator(input.operator, controller),
    };
    attempts = candidates.map((ticket) =>
      implementTicket(concurrentInput, ticket, base, controller).then(
        (result) => {
          tickets.push(result);
          return result;
        },
      ),
    );
    await Promise.all(attempts);
    const byTicket = new Map(tickets.map((result) => [result.ticket, result]));
    const ordered = input.batch.flatMap((ticket) => {
      const result = byTicket.get(ticket);
      return result ? [result] : [];
    });
    const handoffs = ordered.flatMap(({ handoff }) =>
      handoff === undefined ? [] : [handoff],
    );
    const terminal = ordered.find(
      ({ outcome }) => outcome === "cancelled" || outcome === "failed",
    );
    return {
      outcome:
        terminal?.outcome === "cancelled"
          ? "cancelled"
          : terminal?.outcome === "failed"
            ? "failed"
            : "incomplete",
      handoffs: terminal === undefined ? handoffs : [],
      reasons: ordered
        .filter(({ outcome }) => outcome !== "handoff")
        .map(({ detail }) => detail),
      tickets: ordered,
    };
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(attempts);
    const outcome =
      error instanceof OperatorCancelled ||
      (error instanceof BoundaryStop && error.result.outcome === "cancelled")
        ? "cancelled"
        : "failed";
    const detail =
      error instanceof BoundaryStop
        ? error.result.reason
        : error instanceof Error
          ? error.message
          : "Agent Attempt failed";
    return {
      outcome,
      reasons: [detail],
      handoffs: [],
      tickets: input.batch.map(
        (ticket) =>
          tickets.find((result) => result.ticket === ticket) ?? {
            ticket,
            outcome,
            detail,
          },
      ),
    };
  }
}
