import type { VerifiedHandoff } from "./attempt.ts";
import type { PullRequestIdentity } from "./contracts.ts";
import {
  revalidateActiveTicket,
  releasePrePublicationReservation,
  revalidateStandaloneMaintenanceTicket,
} from "./discovery.ts";
import {
  externalRead,
  pauseForOperator,
  workflowWrite,
  scopeOperator,
  TicketSkipped,
} from "./operations.ts";
import {
  reconcileInitialPush,
  reconcilePullRequest,
  type PublicationIntent,
} from "../recovery.ts";
import {
  currentRepairHandoff,
  observeRequiredChecks,
  retireReplacedWorkspace,
} from "./pull-request-repair.ts";
import {
  stopped,
  type PublicationInput,
  type PublishedHandoff,
  type RecoveredPublicationResult,
} from "./pull-request-core.ts";

function recoveredHandoff(intent: PublicationIntent): VerifiedHandoff {
  const value = intent.completionEvidence;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(
      `Delivery Ticket ${intent.ticket} has invalid completion evidence`,
    );
  const handoff = value as Partial<VerifiedHandoff>;
  const completedHead =
    handoff.commits?.at(-1)?.sha ??
    (handoff.verification === "operator_override" ? handoff.base : undefined);
  if (
    handoff.ticket !== intent.ticket ||
    handoff.branch !== intent.stableBranch ||
    handoff.base !== intent.originalBase ||
    !Array.isArray(handoff.commits) ||
    completedHead !== intent.intendedHeadSha ||
    handoff.prTitle !== intent.title ||
    handoff.prBody !== intent.body
  )
    throw new Error(
      `Delivery Ticket ${intent.ticket} has inconsistent completion evidence`,
    );
  return handoff as VerifiedHandoff;
}

async function pauseRecoveredPublication(
  input: PublicationInput,
  intent: PublicationIntent,
  reason: string,
): Promise<void> {
  await pauseForOperator(
    input.audit,
    input.event(
      "publication_recovery",
      "inconsistent_remote_state",
      `ticket:${intent.ticket}`,
    )(1),
    input.operator,
    `${reason}. Resolve the remote state, then retry.`,
  );
}

export async function recoverPublishedHandoffs(
  input: PublicationInput,
  intents: PublicationIntent[],
): Promise<RecoveredPublicationResult> {
  const published: PublishedHandoff[] = [];
  const restarted: number[] = [];
  const skipped: NonNullable<RecoveredPublicationResult["skipped"]> = [];
  const rootInput = input;
  recovery: for (const initialIntent of intents) {
    input = {
      ...rootInput,
      operator: scopeOperator(
        rootInput.operator,
        `${initialIntent.kind === "maintenance" ? "Maintenance Ticket" : "Delivery Ticket"} ${initialIntent.ticket}`,
      ),
    };
    try {
      for (;;) {
        const intent =
          input.publicationIntents?.get(initialIntent.ticket) ?? initialIntent;
        const handoff = recoveredHandoff(intent);
        if (intent.targetBranch !== input.targetBranch) {
          await pauseRecoveredPublication(
            input,
            intent,
            `persisted Target Branch ${intent.targetBranch} does not match ${input.targetBranch}`,
          );
          continue;
        }
        const boundary = await (intent.kind === "maintenance"
          ? revalidateStandaloneMaintenanceTicket(input, intent.ticket)
          : revalidateActiveTicket(input, intent.ticket));
        if (boundary.outcome === "terminal") {
          if (
            intent.kind === "maintenance" &&
            boundary.ticket.stateReason === "completed"
          ) {
            return {
              outcome: "succeeded",
              reasons: [
                ...skipped.map(({ reason }) => reason),
                `Maintenance Ticket ${intent.ticket} is already completed`,
              ],
              skipped,
              pullRequests: [],
              published: [],
              restarted,
            };
          }
          return {
            outcome: "incomplete",
            reasons: [
              ...skipped.map(({ reason }) => reason),
              `Maintenance Ticket ${intent.ticket} is terminal`,
            ],
            skipped,
            pullRequests: [],
            published: [],
            restarted,
          };
        }
        if (boundary.outcome !== "ready")
          return {
            ...stopped(boundary, [], published, skipped),
            reasons: [...skipped.map(({ reason }) => reason), boundary.reason],
            restarted,
          };
        const readRemoteHead = () =>
          externalRead({
            action: () =>
              input.codeHost.getRemoteBranchHead(
                input.repository,
                intent.stableBranch,
              ),
            audit: input.audit,
            event: input.event(
              "publication_recovery",
              "remote_branch_head",
              `branch:${intent.stableBranch}`,
            ),
            clock: input.clock,
            operator: input.operator,
            retryPolicy: input.retryPolicy,
          });
        const remoteHead = await readRemoteHead();
        const activeRepair =
          Object.values(intent.repairBudgets ?? {}).find(
            (repair) => repair.pendingPush !== undefined,
          ) ?? intent.repairState;
        const pendingRepair = activeRepair?.pendingPush;
        const push =
          pendingRepair === undefined && activeRepair?.head === undefined
            ? reconcileInitialPush(intent, remoteHead)
            : remoteHead === (pendingRepair ?? activeRepair?.head) ||
                (pendingRepair !== undefined &&
                  remoteHead === activeRepair?.base)
              ? {
                  outcome: "adopt" as const,
                  reason: "repair push can be reconciled",
                }
              : {
                  outcome: "pause" as const,
                  reason:
                    "repair branch advanced while a repair push was pending",
                };
        if (push.outcome === "restart" && intent.phase === "pending_push") {
          await input.persistPublication?.(intent.ticket, null);
          restarted.push(intent.ticket);
          continue recovery;
        }
        if (push.outcome !== "adopt") {
          await pauseRecoveredPublication(input, intent, push.reason);
          continue;
        }
        let pullRequest: PullRequestIdentity;
        let merged = false;
        if (intent.phase === "pr_created") {
          pullRequest = intent.pullRequest!;
        } else {
          if (intent.phase === "pending_push") {
            await input.persistPublication?.(intent.ticket, {
              ...intent,
              phase: "pushed",
            });
          }
          const candidates = await externalRead({
            action: () => input.codeHost.listPullRequests(input.repository),
            audit: input.audit,
            event: input.event(
              "publication_recovery",
              "list_pull_requests",
              `ticket:${intent.ticket}`,
            ),
            clock: input.clock,
            operator: input.operator,
            retryPolicy: input.retryPolicy,
          });
          const reconciliation = reconcilePullRequest(intent, candidates);
          if (reconciliation.outcome === "restart") {
            if ((await readRemoteHead()) !== intent.intendedHeadSha) {
              await pauseRecoveredPublication(
                input,
                intent,
                "remote branch changed before Pull Request creation",
              );
              continue;
            }
            await input.persistPublication?.(intent.ticket, {
              ...intent,
              phase: "pending_pr",
            });
            pullRequest = await workflowWrite({
              action: () =>
                input.codeHost.createPullRequest({
                  repository: input.repository,
                  targetBranch: intent.targetBranch,
                  branch: intent.stableBranch,
                  title: intent.title,
                  body: intent.body,
                }),
              audit: input.audit,
              clock: input.clock,
              event: () =>
                input.event(
                  "publication_recovery",
                  "create_pull_request",
                  `ticket:${intent.ticket}`,
                )(1),
              operator: input.operator,
              retryPolicy: input.retryPolicy,
            });
          } else if (reconciliation.outcome === "adopt") {
            pullRequest = reconciliation.pullRequest;
            merged = reconciliation.pullRequest.state === "merged";
          } else {
            await pauseRecoveredPublication(
              input,
              intent,
              reconciliation.reason,
            );
            continue;
          }
        }
        const recordedHead = intent.repairState?.head ?? intent.intendedHeadSha;
        await input.persistPublication?.(intent.ticket, {
          ...intent,
          phase: "pr_created",
          pullRequest: { ...pullRequest, headSha: recordedHead },
        });
        input.publicationIntents?.set(intent.ticket, {
          ...intent,
          phase: "pr_created",
          pullRequest: { ...pullRequest, headSha: recordedHead },
        });
        if (activeRepair?.pendingPush) {
          const repairHead = await readRemoteHead();
          if (
            repairHead !== activeRepair.pendingPush &&
            repairHead !== activeRepair.base
          ) {
            await pauseRecoveredPublication(
              input,
              intent,
              "repair branch advanced while a repair push was pending",
            );
            continue;
          }
          if (repairHead === activeRepair.base) {
            await pauseRecoveredPublication(
              input,
              intent,
              "pending repair push was not observed on the stable branch",
            );
            continue;
          }
          const predecessor = currentRepairHandoff(input, handoff);
          await input.recordReplacementCleanup?.(
            handoff.ticket,
            predecessor,
            "pending",
          );
          const repairState = { ...activeRepair, head: repairHead };
          delete repairState.pendingPush;
          const repairedIntent = {
            ...intent,
            repairState,
            ...(repairState.purpose === undefined
              ? {}
              : {
                  repairBudgets: {
                    ...intent.repairBudgets,
                    [repairState.purpose]: repairState,
                  },
                }),
            pullRequest: { ...pullRequest, headSha: repairHead },
          };
          await input.persistPublication?.(intent.ticket, repairedIntent);
          input.publicationIntents?.set(intent.ticket, repairedIntent);
          input.repairHandoffs?.delete(intent.ticket);
          pullRequest = repairedIntent.pullRequest;
          if (predecessor.worktree !== repairState.worktree) {
            await retireReplacedWorkspace(
              input,
              repairState.purpose === "conflict"
                ? "conflict_repair"
                : "ci_repair",
              predecessor,
            );
          }
        }
        const readiness = merged
          ? { readiness: "ready" as const, failedChecks: [] }
          : await observeRequiredChecks(input, handoff, pullRequest);
        if ("outcome" in readiness)
          return {
            ...stopped(readiness, [], published, skipped),
            reasons: [...skipped.map(({ reason }) => reason), readiness.reason],
            restarted,
          };
        published.push({
          handoff,
          pullRequest,
          observation: {
            ticket: intent.ticket,
            branch: intent.stableBranch,
            ...pullRequest,
            ...readiness,
          },
        });
        break;
      }
    } catch (error) {
      if (!(error instanceof TicketSkipped)) throw error;
      const current =
        input.publicationIntents?.get(initialIntent.ticket) ?? initialIntent;
      const residue =
        current.kind !== "maintenance" && current.phase !== "pr_created"
          ? await releasePrePublicationReservation(input, current.ticket)
          : undefined;
      skipped.push({
        ticket: current.ticket,
        ...(current.pullRequest === undefined
          ? {}
          : { pullRequest: current.pullRequest.number }),
        reason: `${error.reason}${residue ? `; ${residue}` : ""}`,
      });
    }
  }
  return {
    outcome: "succeeded",
    reasons: skipped.map(({ reason }) => reason),
    ...(skipped.length === 0 ? {} : { skipped }),
    pullRequests: published.map(({ observation }) => observation),
    published,
    restarted,
  };
}
