#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";

import { SystemClock } from "./adapters/clock.ts";
import { LocalGitWorkspace } from "./adapters/git-workspace.ts";
import { GitHubCodeHost } from "./adapters/github-code-host.ts";
import { GitHubTracker } from "./adapters/github-tracker.ts";
import { SandcastleAgentExecutor } from "./adapters/sandcastle.ts";
import { TerminalOperator } from "./adapters/terminal.ts";
import { AuditLog } from "./audit.ts";
import { cac } from "cac";
import { loadProject } from "./config.ts";
import {
  InvalidRecoverySnapshot,
  readRecoverySnapshot,
  recoverySchemaVersion,
  recoveryPaths,
  writeRecoverySnapshot,
  type RecoverySnapshot,
  type MaintenanceState,
  type PublicationIntent,
} from "./recovery.ts";
import type {
  AgentExecutor,
  Clock,
  CodeHost,
  GitWorkspace,
  OperatorIO,
  Tracker,
} from "./run/contracts.ts";
import { OperatorCancelled, supervisedAuditWrite } from "./run/operations.ts";
import { runProject, type RunSummary } from "./run/run.ts";
import type { CleanupRecord } from "./run/cleanup.ts";

export interface CliDependencies {
  root: string;
  env: Record<string, string | undefined>;
  tracker?: Tracker;
  codeHost?: CodeHost;
  gitWorkspace?: GitWorkspace;
  agentExecutor?: AgentExecutor;
  clock: Clock;
  operator: OperatorIO;
}

export interface CliResult {
  exitCode: number;
  summary: RunSummary;
  logPath: string | null;
}

const usageMessage =
  "usage: sandcastle-runner run --project <project-key> (--parent <issue-number> | --issue [<issue-number>])";

function parseRunOptions(argv: string[]) {
  const cli = cac("sandcastle-runner");
  cli
    .command("run")
    .option("--project <project>", "Project key")
    .option("--parent <ticket>", "Parent Ticket number")
    .option("--issue [ticket]", "Standalone Issue number")
    .option("--auto-merge", "Request merge after the Pull Request is CI-ready")
    .option("--no-auto-merge", "Stop after the Pull Request is CI-ready")
    .action(() => undefined);
  cli.parse(["node", "sandcastle-runner", ...argv]);
  if (cli.matchedCommandName !== "run") throw new Error(usageMessage);
  const options = cli.options as {
    project?: unknown;
    parent?: unknown;
    issue?: unknown;
    autoMerge?: unknown;
  };

  if (argv.includes("--auto-merge") && argv.includes("--no-auto-merge"))
    throw new Error("auto-merge flags are mutually exclusive");
  if (typeof options.autoMerge !== "boolean")
    throw new Error("auto-merge flags do not accept a value");
  if (typeof options.project !== "string" || options.project.length === 0)
    throw new Error(
      "project and a positive Parent Ticket or issue number are required",
    );
  return {
    project: options.project,
    options,
    autoMerge: options.autoMerge === true,
  };
}

function ticketNumber(value: unknown): number | undefined {
  if (value === undefined || value === true) return undefined;
  return parseTicket(value);
}

function startupProject(argv: string[]): string {
  const value = argv[argv.indexOf("--project") + 1];
  return typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("--")
    ? value
    : "unknown";
}

function parseTicket(value: unknown): number {
  const ticket = Number(value);
  if (!Number.isSafeInteger(ticket) || ticket <= 0)
    throw new Error(
      "project and a positive Parent Ticket or issue number are required",
    );
  return ticket;
}

function parseArguments(argv: string[]): {
  project: string;
  parentTicket?: number;
  selector: "parent" | "issue";
  issueTicket?: number;
  autoMerge: boolean;
} {
  const { project, options, autoMerge } = parseRunOptions(argv);
  const parentSelector = options.parent !== undefined;
  const issueSelector = options.issue !== undefined;
  if (parentSelector === issueSelector) throw new Error(usageMessage);

  const parentTicket = ticketNumber(options.parent);
  const issueTicket = ticketNumber(options.issue);
  const explicitAutoMerge =
    argv.includes("--auto-merge") || argv.includes("--no-auto-merge");
  if (explicitAutoMerge && issueTicket === undefined)
    throw new Error("auto-merge flags require a value-bearing --issue");
  if (parentSelector) {
    if (parentTicket === undefined) throw new Error(usageMessage);
    return {
      project,
      parentTicket,
      selector: "parent",
      autoMerge,
    };
  }
  return {
    project,
    ...(issueTicket === undefined
      ? {}
      : { parentTicket: issueTicket, issueTicket }),
    selector: "issue",
    autoMerge,
  };
}

export async function executeCli(
  argv: string[],
  dependencies: CliDependencies,
): Promise<CliResult> {
  let project: string;
  let parentTicket: number | undefined;
  let selector: "parent" | "issue";
  let issueTicket: number | undefined;
  let autoMerge: boolean;
  try {
    ({ project, parentTicket, selector, issueTicket, autoMerge } =
      parseArguments(argv));
  } catch (error) {
    const summary: RunSummary = {
      outcome: "failed",
      project: startupProject(argv),
      parentTicket: 0,
      targetBranch: "unresolved",
      reasons: [
        error instanceof Error ? error.message : "invalid CLI arguments",
      ],
    };
    dependencies.operator.write(JSON.stringify(summary));
    return { exitCode: 1, summary, logPath: null };
  }
  let loaded: Awaited<ReturnType<typeof loadProject>>;
  try {
    loaded = await loadProject(dependencies.root, project, dependencies.env, {
      ...(selector !== "issue"
        ? {}
        : { disableDocumentationMaintenance: true }),
    });
  } catch (error) {
    const summary: RunSummary = {
      outcome: "failed",
      project,
      parentTicket: parentTicket ?? 0,
      targetBranch: "unresolved",
      reasons: [
        error instanceof Error ? error.message : "startup validation failed",
      ],
    };
    dependencies.operator.write(JSON.stringify(summary));
    return { exitCode: 1, summary, logPath: null };
  }
  const standaloneIssueList =
    selector === "issue" && issueTicket === undefined
      ? loaded.config.issueList
      : undefined;
  if (standaloneIssueList?.length === 0) {
    const summary: RunSummary = {
      outcome: "failed",
      project,
      parentTicket: 0,
      targetBranch: "unresolved",
      reasons: ["issueList must not be empty for value-less --issue"],
    };
    dependencies.operator.write(JSON.stringify(summary));
    return { exitCode: 1, summary, logPath: null };
  }
  const effectiveParentTicket = parentTicket ?? standaloneIssueList?.[0] ?? 0;
  const runId = randomUUID();
  const timestamp = dependencies.clock.now().toISOString();
  const runKind = selector;
  const selectionIssueList =
    selector === "parent" ? loaded.config.issueList : standaloneIssueList;
  const paths = recoveryPaths(
    loaded.directory,
    effectiveParentTicket,
    runKind,
    selectionIssueList ?? [],
  );
  let previous: RecoverySnapshot | null;
  try {
    previous = await readRecoverySnapshot(paths.snapshot);
    if (
      previous !== null &&
      (previous.project !== project ||
        previous.parentTicket !== effectiveParentTicket ||
        (previous.runKind ?? "parent") !== runKind ||
        previous.issueTicket !== issueTicket ||
        (selectionIssueList !== undefined &&
          JSON.stringify(previous.issueList ?? []) !==
            JSON.stringify(selectionIssueList)))
    ) {
      throw new InvalidRecoverySnapshot(
        "recovery snapshot identity does not match this Run",
      );
    }
  } catch (error) {
    if (error instanceof InvalidRecoverySnapshot) {
      await dependencies.operator.pause(
        `Recovery state is invalid: ${error.message}. Fix the snapshot and retry.`,
      );
    }
    const summary: RunSummary = {
      outcome: "failed",
      project,
      parentTicket: effectiveParentTicket,
      targetBranch: loaded.config.targetBranch ?? "unresolved",
      reasons: [
        error instanceof Error ? error.message : "recovery startup failed",
      ],
    };
    dependencies.operator.write(JSON.stringify(summary));
    return { exitCode: 1, summary, logPath: null };
  }
  let currentSnapshot: RecoverySnapshot = {
    ...(previous ?? {}),
    schemaVersion: recoverySchemaVersion,
    project,
    repository: loaded.config.repository,
    checkout: loaded.config.checkout,
    parentTicket: effectiveParentTicket,
    runKind,
    ...(issueTicket === undefined ? {} : { issueTicket }),
    ...(selectionIssueList === undefined || selectionIssueList.length === 0
      ? {}
      : { issueList: selectionIssueList }),
    runId,
    phase: "running",
    targetBranch: loaded.config.targetBranch ?? null,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  if (
    !loaded.config.workflow.documentationMaintenance &&
    (currentSnapshot.maintenance?.barrier === true ||
      currentSnapshot.publications?.some(({ kind }) => kind === "maintenance"))
  ) {
    const next = { ...currentSnapshot };
    delete next.maintenance;
    if (next.publications !== undefined) {
      const publications = next.publications.filter(
        ({ kind }) => kind !== "maintenance",
      );
      if (publications.length === 0) delete next.publications;
      else next.publications = publications;
    }
    currentSnapshot = next;
  }
  await writeRecoverySnapshot(paths.snapshot, currentSnapshot);
  const audit = new AuditLog(
    loaded.directory,
    timestamp,
    effectiveParentTicket,
    runId,
  );
  const tracker =
    dependencies.tracker ?? new GitHubTracker(loaded.trackerToken);
  const codeHost =
    dependencies.codeHost ?? new GitHubCodeHost(loaded.codeHostToken);
  const gitWorkspace =
    dependencies.gitWorkspace ?? new LocalGitWorkspace(loaded.codeHostToken);
  const agentExecutor =
    dependencies.agentExecutor ?? new SandcastleAgentExecutor();
  let publicationWrite = Promise.resolve();
  const persistPublication = async (
    ticket: number,
    intent: PublicationIntent | null,
  ) => {
    const previousWrite = publicationWrite;
    let releaseWrite!: () => void;
    publicationWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    await previousWrite;
    try {
      const publications = (currentSnapshot.publications ?? []).filter(
        (publication) => publication.ticket !== ticket,
      );
      if (intent !== null) publications.push(intent);
      const next = { ...currentSnapshot };
      if (publications.length === 0) delete next.publications;
      else next.publications = publications;
      const nextSnapshot = {
        ...next,
        updatedAt: dependencies.clock.now().toISOString(),
      };
      await writeRecoverySnapshot(paths.snapshot, nextSnapshot);
      currentSnapshot = nextSnapshot;
    } finally {
      releaseWrite();
    }
  };
  const persistBatch = async (batch: number[], completed: number[]) => {
    const nextSnapshot = {
      ...currentSnapshot,
      batch: [...batch],
      completedDeliveries: [...new Set(completed)],
      updatedAt: dependencies.clock.now().toISOString(),
    };
    await writeRecoverySnapshot(paths.snapshot, nextSnapshot);
    currentSnapshot = nextSnapshot;
  };
  const persistCleanup = async (ticket: number, record: CleanupRecord) => {
    const nextSnapshot = {
      ...currentSnapshot,
      terminalCleanup: {
        ...(currentSnapshot.terminalCleanup ?? {}),
        [ticket]: record,
      },
      updatedAt: dependencies.clock.now().toISOString(),
    };
    await writeRecoverySnapshot(paths.snapshot, nextSnapshot);
    currentSnapshot = nextSnapshot;
  };
  const persistMaintenance = async (state: MaintenanceState) => {
    const nextSnapshot = {
      ...currentSnapshot,
      maintenance: state,
      updatedAt: dependencies.clock.now().toISOString(),
    };
    await writeRecoverySnapshot(paths.snapshot, nextSnapshot);
    currentSnapshot = nextSnapshot;
  };
  let summary: RunSummary;
  try {
    await supervisedAuditWrite(() => audit.create(), dependencies.operator);
    summary = await runProject({
      project,
      parentTicket: effectiveParentTicket,
      issueList: loaded.config.issueList,
      ...(issueTicket === undefined ? {} : { issueTicket }),
      ...(standaloneIssueList === undefined ? {} : { standaloneIssueList }),
      autoMerge,
      repository: loaded.config.repository,
      ...(loaded.config.targetBranch === undefined
        ? {}
        : { configuredTargetBranch: loaded.config.targetBranch }),
      runId,
      audit,
      tracker,
      codeHost,
      clock: dependencies.clock,
      operator: dependencies.operator,
      runnerAccount: loaded.config.tracker.runnerAccount,
      reservationLabel: loaded.config.tracker.reservationLabel,
      checkout: loaded.config.checkout,
      projectDirectory: loaded.directory,
      implementationPrompt: path.join(
        loaded.directory,
        "prompts",
        "implement.md",
      ),
      implementationAgent: loaded.config.agents.implement,
      review: loaded.config.workflow.review,
      reviewPrompt: path.join(loaded.directory, "prompts", "review.md"),
      ...(loaded.config.agents.review === undefined
        ? {}
        : { reviewAgent: loaded.config.agents.review }),
      ciRepairPrompt: path.join(loaded.directory, "prompts", "ci-repair.md"),
      ciRepairAgent: loaded.config.agents.ciRepair,
      conflictRepairPrompt: path.join(
        loaded.directory,
        "prompts",
        "conflict-repair.md",
      ),
      conflictRepairAgent: loaded.config.agents.conflictRepair,
      documentationMaintenance:
        selector === "parent" &&
        loaded.config.workflow.documentationMaintenance,
      maintenanceTicket: loaded.config.maintenanceTicket,
      documentationPrompt: path.join(
        loaded.directory,
        "prompts",
        "documentation.md",
      ),
      ...(loaded.config.agents.documentation === undefined
        ? {}
        : { documentationAgent: loaded.config.agents.documentation }),
      agentTimeoutMs: loaded.config.timeouts.agentMinutes * 60_000,
      requiredChecksTimeoutMs:
        loaded.config.timeouts.requiredChecksMinutes * 60_000,
      mergeQueueTimeoutMs: loaded.config.timeouts.mergeQueueMinutes * 60_000,
      adminMerge: loaded.config.codeHost.adminMerge,
      ticketClosure: loaded.config.ticketClosure,
      retryPolicy: {
        operationRetry: loaded.config.operationRetry,
        agentRetry: loaded.config.agentRetry,
        operationRetryDelay: loaded.config.operationRetryDelay,
        agentRetryDelay: loaded.config.agentRetryDelay,
      },
      gitWorkspace,
      agentExecutor,
      persistPublication,
      persistBatch,
      persistCleanup,
      persistMaintenance,
      recoveredPublications: currentSnapshot.publications ?? [],
      ...(currentSnapshot.maintenance === undefined
        ? {}
        : { recoveredMaintenance: currentSnapshot.maintenance }),
      ...(currentSnapshot.batch === undefined
        ? {}
        : { recoveredBatch: currentSnapshot.batch }),
      ...(currentSnapshot.completedDeliveries === undefined
        ? {}
        : {
            recoveredCompletedDeliveries: currentSnapshot.completedDeliveries,
          }),
      ...(currentSnapshot.terminalCleanup === undefined
        ? {}
        : { recoveredCleanup: currentSnapshot.terminalCleanup }),
    });
  } catch (error) {
    summary = {
      outcome: error instanceof OperatorCancelled ? "cancelled" : "failed",
      project,
      parentTicket: effectiveParentTicket,
      targetBranch: loaded.config.targetBranch ?? "unresolved",
      reasons: [
        error instanceof OperatorCancelled
          ? "operator cancelled"
          : error instanceof Error
            ? error.message
            : "Run failed",
      ],
    };
  }
  await writeRecoverySnapshot(paths.snapshot, {
    ...currentSnapshot,
    phase:
      summary.outcome === "succeeded" && !autoMerge
        ? currentSnapshot.phase
        : summary.outcome,
    targetBranch: summary.targetBranch,
    updatedAt: dependencies.clock.now().toISOString(),
  });
  dependencies.operator.write(JSON.stringify(summary));
  return {
    exitCode:
      summary.outcome === "succeeded" || summary.outcome === "no_work" ? 0 : 1,
    summary,
    logPath: audit.path,
  };
}

if (import.meta.main) {
  const result = await executeCli(process.argv.slice(2), {
    root: path.resolve(import.meta.dirname, ".."),
    env: process.env,
    clock: new SystemClock(),
    operator: new TerminalOperator(),
  });
  process.exitCode = result.exitCode;
}
