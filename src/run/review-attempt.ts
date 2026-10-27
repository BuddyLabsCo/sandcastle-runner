import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AuditEvent } from "../audit.ts";
import type { AgentDiagnostics, ReviewAttemptResult } from "./contracts.ts";
import { agentLogFile } from "./agent-logs.ts";
import {
  agentPauseMessage,
  skipTicketAgentAttempt,
  TicketSkipped,
  ticketAgentContinueActions,
  ticketAgentRetryActions,
} from "./agent-pause.ts";
import {
  advance,
  externalRead,
  OperatorCancelled,
  pauseForAgentTimeout,
  pauseTicketAgentForOperator,
} from "./operations.ts";
import {
  boundary,
  observePausedAttempt,
  BoundaryStop,
  runAgentOperation,
  type AgentSession,
  type AttemptInput,
  type VerifiedHandoff,
} from "./agent-operation.ts";
import { appendOperation, discardAgentLogs } from "./operation-audit.ts";
import { showProgress } from "./progress.ts";

function createReviewInput(
  input: AttemptInput,
  handoff: VerifiedHandoff,
  reviewBase: string,
  findingsFile: string,
): string {
  return JSON.stringify({
    worktree: handoff.worktree,
    deliveryBranch: handoff.branch,
    deliveryTicket: `${input.repository}#${handoff.ticket}`,
    reviewBase,
    implementationHead: handoff.commits.at(-1)!.sha,
    findingsFile,
  });
}

async function acceptReview(
  input: AttemptInput,
  handoff: VerifiedHandoff,
  implementationHead: string,
): Promise<VerifiedHandoff> {
  const evidence = await externalRead({
    action: () =>
      advance(input.operator, () =>
        input.gitWorkspace.inspectReview({
          worktree: handoff.worktree,
          base: handoff.base,
          implementationHead,
        }),
      ),
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
    reviewChecks: [],
    reviewVerification: "verified",
  };
}

async function runReviewRound(
  input: AttemptInput,
  handoff: VerifiedHandoff,
  signal: AbortSignal,
  round: { number: number; base: string; session: AgentSession },
): Promise<{
  handoff: VerifiedHandoff;
  result: Exclude<ReviewAttemptResult, { outcome: "blocked" }>;
}> {
  if (handoff.verification !== "verified" || handoff.commits.length === 0)
    throw new Error(
      "Review requires a committed implementation Verified Handoff",
    );
  if (!input.reviewAgent) throw new Error("Review agent is not configured");
  const reviewAgent = input.reviewAgent;
  const implementationHead = handoff.commits.at(-1)!.sha;
  let continuationPrompt = round.session.resumePrompt;
  let executions = 0;
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
    let releaseIntervention: (() => void) | undefined;
    try {
      const gitDirectory = await mkdtemp(
        path.join(tmpdir(), "sandcastle-runner-git-"),
      );
      const findingsFile = logFile.replace(
        /\.log$/u,
        `-round-${round.number}.md`,
      );
      const reviewInput = createReviewInput(
        input,
        handoff,
        round.base,
        findingsFile,
      );
      let result: ReviewAttemptResult;
      try {
        const gitConfigGlobal = path.join(gitDirectory, "config");
        await writeFile(gitConfigGlobal, "");
        result = await advance(input.operator, () => {
          executions += 1;
          showProgress(
            input.operator,
            handoff.ticket,
            { kind: "review", round: round.number },
            attemptNumber > 1 || executions > 1,
          );
          return input.agentExecutor.executeReview({
            ticket: handoff.ticket,
            runName: `review issue ${handoff.ticket}`,
            worktree: handoff.worktree,
            branch: handoff.branch,
            base: handoff.base,
            targetBranch: input.targetBranch,
            promptFile: input.reviewPrompt,
            promptArgs: {
              REVIEW_INPUT: reviewInput,
            },
            agent: reviewAgent.agent,
            model: reviewAgent.model,
            ...(reviewAgent.options === undefined
              ? {}
              : { options: reviewAgent.options }),
            gitConfigGlobal,
            logFile,
            timeoutMs: input.timeoutMs,
            idleTimeoutMs: input.idleTimeoutMs,
            pauseForTimeout: (cause, intervention) =>
              pauseForAgentTimeout(
                input.audit,
                event,
                input.operator,
                `Agent ${cause} threshold reached for review issue ${handoff.ticket}. Working directory: ${handoff.worktree}. Diagnostic log: ${logFile}.`,
                intervention,
              ),
            retryPolicy: input.retryPolicy,
            signal: input.operator.coordination
              ? AbortSignal.any([
                  signal,
                  input.operator.coordination.controller.signal,
                ])
              : signal,
            advance: (action) => advance(input.operator, action),
            ...(resumePrompt === undefined ? {} : { resumePrompt }),
          });
        });
        resultDiagnostics = {
          provider: reviewAgent.agent,
          workingDirectory: handoff.worktree,
          diagnosticLogPath: logFile,
          ...result.diagnostics,
          agentAttemptId: attemptId,
          attemptOrdinal: attemptNumber,
        };
        if (result.outcome === "blocked")
          releaseIntervention = input.operator.coordination?.intervene();
      } catch (error) {
        releaseIntervention ??= input.operator.coordination?.intervene();
        throw error;
      } finally {
        await rm(gitDirectory, { recursive: true, force: true });
      }
      if (result.outcome === "blocked") {
        await observePausedAttempt(input, handoff.ticket, releaseIntervention);
        await appendOperation(input, event, "blocked", null, resultDiagnostics);
        const continuable = resultDiagnostics?.retryable !== false;
        const decision = await pauseTicketAgentForOperator(
          input.audit,
          event,
          input.operator,
          agentPauseMessage(
            "blocked",
            resultDiagnostics,
            handoff.worktree,
            {
              summary: "Review could not complete.",
              blocker: result.blocker,
            },
            continuable ? ticketAgentContinueActions : ticketAgentRetryActions,
          ),
          continuable,
        );
        releaseIntervention?.();
        releaseIntervention = undefined;
        if (decision.decision === "skip")
          return await skipTicketAgentAttempt(
            input,
            "review",
            event,
            handoff.ticket,
            attemptNumber,
            result.blocker,
          );
        if (continuable)
          continuationPrompt =
            decision.decision === "retry" ? "continue" : decision.response;
        continue;
      }
      await boundary(input, handoff.ticket);
      if (result.outcome === "findings") {
        if (result.findings_file !== findingsFile)
          throw new Error(
            "Review findings_file must match the assigned findings path",
          );
        const file = await lstat(findingsFile);
        if (!file.isFile() || file.size === 0)
          throw new Error("Review findings must be a nonempty Markdown file");
      }
      const reviewed = await acceptReview(input, handoff, implementationHead);
      await appendOperation(input, event, "succeeded", null, resultDiagnostics);
      return { handoff: reviewed, result };
    } catch (error) {
      if (error instanceof OperatorCancelled || error instanceof TicketSkipped)
        throw error;
      if (error instanceof BoundaryStop) {
        await appendOperation(input, event, error.result.outcome, null);
        throw error;
      }
      releaseIntervention ??= input.operator.coordination?.intervene();
      const diagnostics: AgentDiagnostics = {
        provider: reviewAgent.agent,
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
      if (diagnostics.errorCategory === "process_cleanup") throw error;
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
      releaseIntervention?.();
      releaseIntervention = undefined;
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
    } finally {
      releaseIntervention?.();
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
  for (let round = 1; ; round += 1) {
    const reviewedHead = handoff.commits.at(-1)!.sha;
    const reviewed = await runReviewRound(input, handoff, signal, {
      number: round,
      base: reviewBase,
      session: reviewSession,
    });
    handoff = reviewed.handoff;
    if (reviewed.result.outcome === "passed") break;
    implementationSession.resumePrompt = (
      await readFile(
        new URL("../prompts/implementation-review-fix.md", import.meta.url),
        "utf8",
      )
    )
      .replaceAll("{{FINDINGS_FILE}}", reviewed.result.findings_file)
      .replaceAll("{{BASE_SHA}}", reviewedHead);
    const fixed = await runAgentOperation(input, {
      phase: "implement",
      progress: { kind: "fix_review", round },
      runName: `fix review findings for issue ${handoff.ticket}`,
      ticket: handoff.ticket,
      worktree: handoff.worktree,
      branch: handoff.branch,
      base: reviewedHead,
      promptFile: fileURLToPath(
        new URL("../prompts/implementation-review-fix.md", import.meta.url),
      ),
      promptArgs: {
        FINDINGS_FILE: reviewed.result.findings_file,
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
        new URL("../prompts/review-attempt-input.md", import.meta.url),
        "utf8",
      )
    ).replaceAll(
      "{{REVIEW_INPUT}}",
      createReviewInput(
        input,
        handoff,
        reviewBase,
        reviewSession.logFile!.replace(/\.log$/u, `-round-${round + 1}.md`),
      ),
    );
  }
  for (const stage of ["implement", "review"] as const)
    await discardAgentLogs(input, "review", handoff.ticket, stage, 1);
  return handoff;
}
