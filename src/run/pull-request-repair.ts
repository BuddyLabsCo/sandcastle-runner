/* eslint-disable max-lines -- repair transitions remain explicit at each persisted step. */
import { randomUUID } from "node:crypto";
import {
  runCiRepairAttempt,
  runConflictRepairAttempt,
  type VerifiedHandoff,
} from "./attempt.ts";
import type {
  PullRequestIdentity,
  PullRequestState,
  RequiredCheck,
} from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  revalidateActiveTicket,
} from "./discovery.ts";
import { externalRead, pauseForOperator, workflowWrite } from "./operations.ts";
import { removeReplacedWorkspace } from "./cleanup.ts";
import {
  freshRepairHandoff,
  observePullRequestForIntegration,
  persistedBudget,
  pushRepair,
  repairIntent,
  type PublicationInput,
  type ReadinessInput,
  type PullRequestObservation,
  type RepairBudget,
} from "./pull-request-core.ts";

function checkResult(
  checks: RequiredCheck[],
):
  | { readiness: "ready"; failedChecks: [] }
  | { readiness: "pending"; failedChecks: [] }
  | { readiness: "failed"; failedChecks: RequiredCheck[] } {
  const failedChecks = checks.filter(
    ({ bucket }) => bucket === "fail" || bucket === "cancel",
  );
  if (failedChecks.length > 0) return { readiness: "failed", failedChecks };
  if (checks.some(({ bucket }) => bucket === "pending"))
    return { readiness: "pending", failedChecks: [] };
  return { readiness: "ready", failedChecks: [] };
}

function replacedWorkspaceCleanup(input: PublicationInput) {
  return (input.replacedWorkspaceCleanup ??= {
    removedWorktrees: new Set<string>(),
    deletedBranches: new Set<string>(),
  });
}

export function currentRepairHandoff(
  input: PublicationInput,
  handoff: VerifiedHandoff,
): VerifiedHandoff {
  const handoffs = (input.repairHandoffs ??= new Map());
  const current = handoffs.get(handoff.ticket);
  if (current) return current;
  const repair = input.publicationIntents?.get(handoff.ticket)?.repairState;
  if (!repair?.head || !repair.worktree || !repair.branch || !repair.base)
    return handoff;
  return {
    ...handoff,
    worktree: repair.worktree,
    branch: repair.branch,
    base: repair.base,
    commits: [],
    remoteBranch: handoff.remoteBranch ?? handoff.branch,
  };
}

export async function retireReplacedWorkspace(
  input: PublicationInput,
  phase: "ci_repair" | "conflict_repair",
  workspace: VerifiedHandoff,
): Promise<void> {
  const cleanup = replacedWorkspaceCleanup(input);
  if (
    cleanup.removedWorktrees.has(workspace.worktree) &&
    cleanup.deletedBranches.has(workspace.branch)
  ) {
    return;
  }
  await workflowWrite({
    action: async () => {
      await input.recordReplacementCleanup?.(
        workspace.ticket,
        workspace,
        "pending",
      );
      await removeReplacedWorkspace(
        input.gitWorkspace,
        input.checkout,
        workspace,
        cleanup,
      );
      await input.recordReplacementCleanup?.(
        workspace.ticket,
        workspace,
        "cleaned",
      );
    },
    audit: input.audit,
    clock: input.clock,
    event: (attempt) =>
      input.event(
        phase,
        "remove_replaced_workspace",
        `ticket:${workspace.ticket}`,
      )(attempt),
    operator: input.operator,
    retryPolicy: input.retryPolicy,
  });
}

export async function observeRequiredChecks(
  input: ReadinessInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
): Promise<Exclude<RequiredChecksResult, { outcome: "skipped" }>> {
  await input.clock.sleep(30_000);
  for (;;) {
    const deadline =
      input.clock.now().getTime() + input.requiredChecksTimeoutMs;
    for (;;) {
      const boundary = await revalidateActiveTicket(input, handoff.ticket);
      if (boundary.outcome !== "ready") return boundary;
      const checks = await externalRead({
        action: () =>
          input.codeHost.getRequiredChecks(
            input.repository,
            pullRequest.number,
          ),
        audit: input.audit,
        event: input.event(
          "ci_wait",
          "required_checks",
          `pull_request:${pullRequest.number}`,
        ),
        clock: input.clock,
        operator: input.operator,
        retryPolicy: input.retryPolicy,
      });
      const result = checkResult(checks);
      if (result.readiness !== "pending") return result;
      const remaining = deadline - input.clock.now().getTime();
      if (remaining <= 0) break;
      await input.clock.sleep(Math.min(10_000, remaining));
    }

    const event = input.event(
      "ci_wait",
      "required_checks_timeout",
      `pull_request:${pullRequest.number}`,
    )(1);
    await pauseForOperator(
      input.audit,
      event,
      input.operator,
      "Required checks timed out.",
    );
  }
}

export type RequiredChecksResult =
  | Pick<PullRequestObservation, "readiness" | "failedChecks">
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
  | { outcome: "skipped"; reason: string };

export async function repairRequiredChecks(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
  initialFailedChecks: RequiredCheck[],
  signal: AbortSignal,
): Promise<RequiredChecksResult> {
  let failedChecks = initialFailedChecks;
  let currentHandoff = currentRepairHandoff(input, handoff);
  const budget = input.ciRepairBudgets.get(handoff.ticket) ?? {
    consumed: 0,
    generation: 0,
    attempts: { value: 0 },
  };
  const persisted = persistedBudget(input, handoff.ticket, "ci");
  if (persisted) {
    budget.consumed = persisted.consumed;
    budget.generation = persisted.generation;
    budget.attempts.value = persisted.attempt;
  }
  input.ciRepairBudgets.set(handoff.ticket, budget);
  for (;;) {
    while (budget.consumed < 2) {
      const pullRequestState = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "ci_repair",
      );
      if (pullRequestState.merged)
        return { readiness: "ready", failedChecks: [] };
      const preparedRepair = await freshRepairHandoff(
        input,
        currentHandoff,
        "ci",
      );
      const replaced = preparedRepair !== currentHandoff;
      const repairHandoff = replaced
        ? preparedRepair
        : { ...currentHandoff, base: pullRequestState.headSha };
      const attemptId = randomUUID();
      await repairIntent(input, handoff.ticket, "ci", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value + 1,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
        pendingPush: null,
      });
      const repair = await runCiRepairAttempt({
        ...input,
        handoff: repairHandoff,
        base: repairHandoff.base,
        pullRequest,
        failedChecks,
        promptFile: input.ciRepairPrompt,
        agent: input.ciRepairAgent,
        timeoutMs: input.agentTimeoutMs,
        signal,
        attemptCounter: budget.attempts,
      });
      if (repair.outcome === "skipped") return repair;
      if (repair.outcome === "boundary") return repair.boundary;
      budget.consumed += 1;
      await repairIntent(input, handoff.ticket, "ci", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
        pendingPush: null,
      });
      if (repair.outcome === "consumed") continue;

      const currentPullRequestState = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "ci_repair",
      );
      if (currentPullRequestState.merged)
        return { readiness: "ready", failedChecks: [] };
      if (repair.outcome === "handoff") {
        await repairIntent(input, handoff.ticket, "ci", {
          consumed: budget.consumed,
          generation: budget.generation,
          attempt: budget.attempts.value,
          base: repair.handoff.base,
          worktree: repair.handoff.worktree,
          branch: repair.handoff.branch,
          attemptId,
          ...(repair.handoff.commits.at(-1)?.sha === undefined
            ? {}
            : { pendingPush: repair.handoff.commits.at(-1)!.sha }),
        });
      }
      const boundary = await pushRepair(
        input,
        repair.handoff,
        pullRequest,
        "ci_repair",
        budget.consumed,
      );
      if (boundary) return boundary;
      if (replaced)
        await input.recordReplacementCleanup?.(
          handoff.ticket,
          currentHandoff,
          "pending",
        );
      await repairIntent(
        input,
        handoff.ticket,
        "ci",
        {
          consumed: budget.consumed,
          generation: budget.generation,
          attempt: budget.attempts.value,
          head: repair.handoff.commits.at(-1)?.sha ?? repair.handoff.base,
          pendingPush: null,
        },
        "accepted",
      );
      if (replaced) {
        await retireReplacedWorkspace(input, "ci_repair", currentHandoff);
      }
      currentHandoff = repair.handoff;
      input.repairHandoffs!.set(handoff.ticket, currentHandoff);
      const readiness = await observeRequiredChecks(
        input,
        currentHandoff,
        pullRequest,
      );
      if ("outcome" in readiness || readiness.readiness === "ready") {
        return readiness;
      }
      failedChecks = readiness.failedChecks;
    }

    const event = input.event(
      "ci_repair",
      "repair_budget_exhausted",
      `pull_request:${pullRequest.number}`,
    )(budget.consumed);
    await pauseForOperator(
      input.audit,
      event,
      input.operator,
      "CI repair failed after two attempts. Resolve checks, then retry.",
    );
    const refreshed = await observeRequiredChecks(
      input,
      currentHandoff,
      pullRequest,
    );
    if ("outcome" in refreshed || refreshed.readiness === "ready")
      return refreshed;
    failedChecks = refreshed.failedChecks;
    budget.consumed = 0;
    budget.generation += 1;
    await repairIntent(input, handoff.ticket, "ci", {
      consumed: 0,
      generation: budget.generation,
      attempt: budget.attempts.value,
    });
  }
}

export async function repairMergeConflict(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
  conflict: string,
  budget: RepairBudget,
): Promise<
  | { state: PullRequestState }
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
  | { outcome: "skipped"; reason: string }
> {
  const controller = new AbortController();
  let currentHandoff = currentRepairHandoff(input, handoff);
  repairCycle: for (;;) {
    while (budget.consumed < 2) {
      const beforeRepair = await revalidateActiveTicket(
        input,
        currentHandoff.ticket,
      );
      if (beforeRepair.outcome !== "ready") return beforeRepair;
      const state = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "conflict_repair",
      );
      if (state.merged) return { state };
      const targetBase = await externalRead({
        action: () =>
          input.gitWorkspace.fetchTargetBranch(
            input.checkout,
            input.targetBranch,
          ),
        audit: input.audit,
        event: input.event(
          "conflict_repair",
          "fetch_target_branch",
          input.targetBranch,
        ),
        clock: input.clock,
        operator: input.operator,
        retryPolicy: input.retryPolicy,
      });
      const preparedRepair = await freshRepairHandoff(
        input,
        currentHandoff,
        "conflict",
      );
      const replaced = preparedRepair !== currentHandoff;
      const repairHandoff = replaced
        ? preparedRepair
        : { ...currentHandoff, base: state.headSha };
      const attemptId = randomUUID();
      await repairIntent(input, handoff.ticket, "conflict", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value + 1,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
        targetBase,
        pendingPush: null,
      });
      const repair = await runConflictRepairAttempt({
        ...input,
        handoff: repairHandoff,
        base: repairHandoff.base,
        targetBase,
        pullRequest,
        conflict,
        promptFile: input.conflictRepairPrompt,
        agent: input.conflictRepairAgent,
        timeoutMs: input.agentTimeoutMs,
        signal: controller.signal,
        attemptCounter: budget.attempts,
      });
      if (repair.outcome === "skipped") return repair;
      if (repair.outcome === "boundary") return repair.boundary;
      budget.consumed += 1;
      await repairIntent(input, handoff.ticket, "conflict", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
        targetBase,
        pendingPush: null,
      });
      if (repair.outcome === "consumed") continue;

      const current = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "conflict_repair",
      );
      if (current.merged) return { state: current };
      if (repair.outcome === "handoff") {
        await repairIntent(input, handoff.ticket, "conflict", {
          consumed: budget.consumed,
          generation: budget.generation,
          attempt: budget.attempts.value,
          base: repair.handoff.base,
          worktree: repair.handoff.worktree,
          branch: repair.handoff.branch,
          attemptId,
          targetBase,
          ...(repair.handoff.commits.at(-1)?.sha === undefined
            ? {}
            : { pendingPush: repair.handoff.commits.at(-1)!.sha }),
        });
      }
      const boundary = await pushRepair(
        input,
        repair.handoff,
        pullRequest,
        "conflict_repair",
        budget.consumed,
      );
      if (boundary) return boundary;
      if (replaced)
        await input.recordReplacementCleanup?.(
          handoff.ticket,
          currentHandoff,
          "pending",
        );
      await repairIntent(
        input,
        handoff.ticket,
        "conflict",
        {
          consumed: budget.consumed,
          generation: budget.generation,
          attempt: budget.attempts.value,
          head: repair.handoff.commits.at(-1)?.sha ?? repair.handoff.base,
          targetBase,
          pendingPush: null,
        },
        "accepted",
      );
      if (replaced) {
        await retireReplacedWorkspace(input, "conflict_repair", currentHandoff);
      }
      currentHandoff = repair.handoff;
      input.repairHandoffs!.set(handoff.ticket, currentHandoff);
      let readiness: RequiredChecksResult = await observeRequiredChecks(
        input,
        currentHandoff,
        pullRequest,
      );
      if (!("outcome" in readiness) && readiness.readiness === "failed") {
        readiness = await repairRequiredChecks(
          input,
          currentHandoff,
          pullRequest,
          readiness.failedChecks,
          controller.signal,
        );
      }
      if ("outcome" in readiness) return readiness;
      if (readiness.readiness === "ready") {
        return {
          state: await observePullRequestForIntegration(
            input,
            pullRequest.number,
            "conflict_repair",
          ),
        };
      }
    }

    const event = input.event(
      "conflict_repair",
      "repair_budget_exhausted",
      `pull_request:${pullRequest.number}`,
    )(budget.consumed);
    await pauseForOperator(
      input.audit,
      event,
      input.operator,
      "Conflict repair failed after two attempts. Resolve the conflict, then retry.",
    );
    const deadline = input.clock.now().getTime() + input.mergeQueueTimeoutMs;
    for (;;) {
      const boundary = await revalidateActiveTicket(
        input,
        currentHandoff.ticket,
      );
      if (boundary.outcome !== "ready") return boundary;
      const state = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "conflict_repair",
      );
      if (state.merged || state.mergeRequested) return { state };
      if (state.mergeable === "conflicting") break;
      if (state.mergeable !== "mergeable") {
        const remaining = deadline - input.clock.now().getTime();
        if (remaining <= 0) continue repairCycle;
        await input.clock.sleep(Math.min(10_000, remaining));
        continue;
      }
      let readiness: RequiredChecksResult = await observeRequiredChecks(
        input,
        currentHandoff,
        pullRequest,
      );
      if (!("outcome" in readiness) && readiness.readiness === "failed")
        readiness = await repairRequiredChecks(
          input,
          currentHandoff,
          pullRequest,
          readiness.failedChecks,
          controller.signal,
        );
      if ("outcome" in readiness) return readiness;
      return { state };
    }
    budget.consumed = 0;
    budget.generation += 1;
    await repairIntent(input, handoff.ticket, "conflict", {
      consumed: 0,
      generation: budget.generation,
      attempt: budget.attempts.value,
    });
  }
}
