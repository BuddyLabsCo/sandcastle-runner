import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AuditEvent } from "../audit.ts";
import type {
  AgentAttemptResult,
  AgentDiagnostics,
  ReviewAttemptResult,
  Ticket,
} from "./contracts.ts";
import { agentLogFile } from "./agent-logs.ts";
import {
  agentPauseMessage,
  skipTicketAgentAttempt,
  TicketSkipped,
  ticketAgentContinueActions,
  ticketAgentRetryActions,
} from "./agent-pause.ts";
import {
  externalRead,
  OperatorCancelled,
  pauseTicketAgentForOperator,
} from "./operations.ts";
import {
  boundary,
  BoundaryStop,
  runAgentOperation,
  type AgentSession,
  type AttemptInput,
  type VerifiedHandoff,
} from "./agent-operation.ts";
import { appendOperation, discardAgentLogs } from "./operation-audit.ts";

function snapshot(
  ticket: Ticket,
  name: string,
): { source: string; title: string; body: string } {
  if (!ticket.source || !ticket.title || ticket.body === undefined)
    throw new Error(`${name} snapshot is incomplete`);
  return { source: ticket.source, title: ticket.title, body: ticket.body };
}

async function readReviewSnapshot(
  input: AttemptInput,
  ticket: number,
  parent: boolean,
) {
  return snapshot(
    await externalRead({
      action: () =>
        parent
          ? input.tracker.getParent(input.repository, ticket)
          : input.tracker.getTicket(input.repository, ticket),
      audit: input.audit,
      event: input.event(
        "review",
        parent ? "read_specification" : "read_ticket_snapshot",
        `${parent ? "parent" : "ticket"}:${ticket}`,
      ),
      clock: input.clock,
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    }),
    parent ? "governing specification" : "Delivery Ticket",
  );
}

async function acceptReview(
  input: AttemptInput,
  handoff: VerifiedHandoff,
  implementationHead: string,
  checks: AgentAttemptResult["checks"],
): Promise<VerifiedHandoff> {
  const evidence = await externalRead({
    action: () =>
      input.gitWorkspace.inspectReview({
        worktree: handoff.worktree,
        base: handoff.base,
        implementationHead,
      }),
    audit: input.audit,
    event: input.event("review", "inspect_review", `ticket:${handoff.ticket}`),
    clock: input.clock,
    operator: input.operator,
    retryPolicy: input.retryPolicy,
  });
  if (!evidence.clean) throw new Error("Review left a dirty Worktree");
  if (evidence.reviewCommits.length !== 0)
    throw new Error(
      "Reviewer created commits; only implementation may commit fixes",
    );
  return {
    ...handoff,
    commits: evidence.deliveryCommits,
    implementationCommits: evidence.deliveryCommits,
    reviewCommits: [],
    reviewChecks: checks,
    reviewVerification: "verified",
  };
}

async function runReviewRound(
  input: AttemptInput,
  handoff: VerifiedHandoff,
  signal: AbortSignal,
  round: { number: number; base: string; session: AgentSession },
): Promise<{ handoff: VerifiedHandoff; result: ReviewAttemptResult }> {
  if (handoff.verification !== "verified" || handoff.commits.length === 0)
    throw new Error(
      "Review requires a committed implementation Verified Handoff",
    );
  if (!input.reviewAgent) throw new Error("Review agent is not configured");
  const implementationHead = handoff.commits.at(-1)!.sha;
  let continuationPrompt = round.session.resumePrompt;
  let attemptNumber!: number;
  let attemptId = "";
  let logFile = "";
  let event!: Omit<AuditEvent, "result" | "error">;
  for (;;) {
    await boundary(input, handoff.ticket);
    const resumePrompt = continuationPrompt;

    continuationPrompt = undefined;
    if (attemptNumber === undefined || resumePrompt === undefined) {
      attemptNumber = (attemptNumber || 0) + 1;
      attemptId = randomUUID();
      logFile =
        (resumePrompt === undefined ? undefined : round.session.logFile) ??
        agentLogFile(
          input.projectDirectory,
          handoff.ticket,
          "review",
          `${input.runId}-${attemptId}`,
        );
      round.session.logFile = logFile;
      event = input.event(
        "review",
        "agent_attempt",
        `ticket:${handoff.ticket}`,
      )(attemptNumber);
    }
    await appendOperation(
      input,
      event,
      "started",
      null,
      undefined,
      resumePrompt === undefined ? undefined : "resumed",
    );
    let resultDiagnostics: AgentDiagnostics | undefined;
    try {
      const [deliveryTicket, governingSpecification, standardsSources] =
        await Promise.all([
          readReviewSnapshot(input, handoff.ticket, false),
          readReviewSnapshot(
            input,
            input.standaloneIssue ?? input.parentTicket,
            input.standaloneIssue === undefined,
          ),
          externalRead({
            action: () =>
              input.gitWorkspace.readReviewStandards(
                handoff.worktree,
                handoff.base,
              ),
            audit: input.audit,
            event: input.event(
              "review",
              "read_standards",
              `ticket:${handoff.ticket}`,
            ),
            clock: input.clock,
            operator: input.operator,
            retryPolicy: input.retryPolicy,
          }),
        ]);
      const gitDirectory = await mkdtemp(
        path.join(tmpdir(), "sandcastle-runner-git-"),
      );
      const findingsFile = logFile.replace(
        /\.log$/u,
        `-round-${round.number}.md`,
      );
      const reviewHandoff = JSON.stringify({
        repository: input.repository,
        projectTargetBranch: input.targetBranch,
        worktree: handoff.worktree,
        deliveryBranch: handoff.branch,
        originalFixedPoint: handoff.base,
        reviewBase: round.base,
        reviewRound: round.number,
        implementationHead,
        findingsFile,
        deliveryTicket,
        governingSpecification,
        standardsSources,
        acceptedExceptions: [
          "Runner verifies Worktree cleanliness and rejects reviewer-created commits without comparing frozen branch or merge-base values.",
        ],
        implementationReportedChecks: handoff.checks,
      });
      let result: ReviewAttemptResult;
      try {
        const gitConfigGlobal = path.join(gitDirectory, "config");
        await writeFile(gitConfigGlobal, "");
        result = await input.agentExecutor.executeReview({
          ticket: handoff.ticket,
          runName: `review issue ${handoff.ticket}`,
          worktree: handoff.worktree,
          branch: handoff.branch,
          base: handoff.base,
          targetBranch: input.targetBranch,
          promptFile: input.reviewPrompt,
          promptArgs: {
            REVIEW_HANDOFF: reviewHandoff,
          },
          agent: input.reviewAgent.agent,
          model: input.reviewAgent.model,
          ...(input.reviewAgent.options === undefined
            ? {}
            : { options: input.reviewAgent.options }),
          gitConfigGlobal,
          logFile,
          timeoutMs: input.timeoutMs,
          retryPolicy: input.retryPolicy,
          signal,
          ...(resumePrompt === undefined ? {} : { resumePrompt }),
        });
        resultDiagnostics = result.diagnostics;
      } finally {
        await rm(gitDirectory, { recursive: true, force: true });
      }
      await boundary(input, handoff.ticket);
      if (result.diagnostics) {
        result.diagnostics.agentAttemptId = attemptId;
        result.diagnostics.attemptOrdinal = attemptNumber;
      }
      if (result.outcome === "blocked") {
        await appendOperation(
          input,
          event,
          "blocked",
          null,
          result.diagnostics,
        );
        const continuable = result.diagnostics?.retryable !== false;
        const decision = await pauseTicketAgentForOperator(
          input.audit,
          event,
          input.operator,
          agentPauseMessage(
            "blocked",
            result.diagnostics,
            handoff.worktree,
            {
              summary: result.summary,
              blocker: result.blocker,
            },
            continuable ? ticketAgentContinueActions : ticketAgentRetryActions,
          ),
          continuable,
        );
        if (decision.decision === "skip")
          return await skipTicketAgentAttempt(
            input,
            "review",
            event,
            handoff.ticket,
            attemptNumber,
            result.blocker ?? result.summary,
          );
        if (continuable)
          continuationPrompt =
            decision.decision === "retry" ? "continue" : decision.response;
        continue;
      }
      if (result.outcome === "findings") {
        if (result.findings_file !== findingsFile)
          throw new Error(
            "Review findings_file must match the assigned findings path",
          );
        const file = await lstat(findingsFile);
        if (!file.isFile() || file.size === 0)
          throw new Error("Review findings must be a nonempty Markdown file");
      }
      const reviewed = await acceptReview(
        input,
        handoff,
        implementationHead,
        result.checks,
      );
      await appendOperation(
        input,
        event,
        "succeeded",
        null,
        result.diagnostics,
      );
      return { handoff: reviewed, result };
    } catch (error) {
      if (error instanceof OperatorCancelled || error instanceof TicketSkipped)
        throw error;
      if (error instanceof BoundaryStop) {
        await appendOperation(input, event, error.result.outcome, null);
        throw error;
      }
      const diagnostics: AgentDiagnostics = {
        ...resultDiagnostics,
        error:
          error instanceof Error
            ? error.message
            : "Review Agent Attempt failed",
        errorCategory: "agent_attempt",
        attemptOrdinal: attemptNumber,
        retryable: true,
        agentAttemptId: attemptId,
        diagnosticLogPath: logFile,
      };
      Object.assign(
        diagnostics,
        error instanceof Error && "diagnostics" in error
          ? (error as Error & { diagnostics?: AgentDiagnostics }).diagnostics
          : {},
      );
      await appendOperation(
        input,
        event,
        "failed",
        diagnostics.error!,
        diagnostics,
      );
      const continuable = diagnostics.retryable !== false;
      const decision = await pauseTicketAgentForOperator(
        input.audit,
        event,
        input.operator,
        agentPauseMessage(
          "failed",
          diagnostics,
          handoff.worktree,
          undefined,
          continuable ? ticketAgentContinueActions : ticketAgentRetryActions,
        ),
        continuable,
      );
      if (decision.decision === "skip")
        return await skipTicketAgentAttempt(
          input,
          "review",
          event,
          handoff.ticket,
          attemptNumber,
          diagnostics.error ?? "Review Agent Attempt failed",
        );
      if (continuable)
        continuationPrompt =
          decision.decision === "retry" ? "continue" : decision.response;
    }
  }
}

export async function reviewHandoff(
  input: AttemptInput,
  initialHandoff: VerifiedHandoff,
  signal: AbortSignal,
  implementationSession: AgentSession,
): Promise<VerifiedHandoff> {
  let handoff = initialHandoff;
  let reviewBase = handoff.base;
  const reviewSession: AgentSession = {};
  const checks: AgentAttemptResult["checks"] = [];
  for (let round = 1; ; round += 1) {
    const reviewedHead = handoff.commits.at(-1)!.sha;
    const reviewed = await runReviewRound(input, handoff, signal, {
      number: round,
      base: reviewBase,
      session: reviewSession,
    });
    handoff = reviewed.handoff;
    checks.push(...reviewed.result.checks);
    handoff.reviewChecks = [...checks];
    if (reviewed.result.outcome === "passed") break;
    implementationSession.resumePrompt = (
      await readFile(
        new URL("../prompts/implementation-review-fix.md", import.meta.url),
        "utf8",
      )
    )
      .replaceAll("{{FINDINGS_FILE}}", reviewed.result.findings_file!)
      .replaceAll("{{BASE_SHA}}", reviewedHead);
    const fixed = await runAgentOperation(input, {
      phase: "implement",
      runName: `fix review findings for issue ${handoff.ticket}`,
      ticket: handoff.ticket,
      worktree: handoff.worktree,
      branch: handoff.branch,
      base: reviewedHead,
      promptFile: fileURLToPath(
        new URL("../prompts/implementation-review-fix.md", import.meta.url),
      ),
      promptArgs: {
        FINDINGS_FILE: reviewed.result.findings_file!,
        BASE_SHA: reviewedHead,
      },
      pullRequestMetadata: "ignored",
      existingPrMetadata: initialHandoff,
      agent: input.agent,
      signal,
      attemptCounter: { value: 0 },
      session: implementationSession,
    });
    if ("reason" in fixed) throw new Error(fixed.reason);
    const commits = [...handoff.commits, ...fixed.commits];
    handoff = {
      ...handoff,
      commits,
      implementationCommits: commits,
      checks: [...handoff.checks, ...fixed.checks],
    };
    if (input.maxReviewRounds !== undefined && round >= input.maxReviewRounds)
      break;
    reviewBase = reviewedHead;
    reviewSession.resumePrompt = (
      await readFile(
        new URL("../prompts/review-continuation.md", import.meta.url),
        "utf8",
      )
    )
      .replaceAll("{{REVIEW_BASE}}", reviewBase)
      .replaceAll("{{IMPLEMENTATION_HEAD}}", fixed.commits.at(-1)!.sha)
      .replaceAll("{{REVIEW_ROUND}}", String(round + 1))
      .replaceAll(
        "{{FINDINGS_FILE}}",
        reviewSession.logFile!.replace(/\.log$/u, `-round-${round + 1}.md`),
      );
  }
  for (const stage of ["implement", "review"] as const)
    await discardAgentLogs(input, "review", handoff.ticket, stage, 1);
  return handoff;
}
