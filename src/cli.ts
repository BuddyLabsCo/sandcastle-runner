#!/usr/bin/env node
/* eslint-disable max-lines -- CLI startup and recovery sequencing stay together. */
import { randomUUID } from "node:crypto";
import { rmdir } from "node:fs/promises";
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
import { renderRunReport } from "./run/report.ts";
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
  "usage: sandcastle-runner run --project <project-key> (--parent <issue-number> | --issue [<issue-number>] | --document)";

async function removeEmptyRunWorktreeParent(
  directory: string,
  operator: OperatorIO,
): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
    try {
      operator.write(
        `Warning: could not remove empty Run Worktree directory ${directory}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    } catch {
      // Cleanup diagnostics must not replace the Run result.
    }
  }
}

function parseRunOptions(argv: string[]) {
  const cli = cac("sandcastle-runner");
  cli
    .command("run")
    .option("--project <project>", "Project key")
    .option("--parent <ticket>", "Parent Ticket number")
    .option("--issue [ticket]", "Standalone Issue number")
    .option("--document", "Run Documentation Maintenance")
    .option("--auto-merge", "Request merge after the Pull Request is CI-ready")
    .option("--no-auto-merge", "Stop after the Pull Request is CI-ready")
    .action(() => undefined);
  cli.parse(["node", "sandcastle-runner", ...argv]);
  if (cli.matchedCommandName !== "run") throw new Error(usageMessage);
  const options = cli.options as {
    project?: unknown;
    parent?: unknown;
    issue?: unknown;
    document?: unknown;
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

function startupFailureMessage(reason: string | undefined): string {
  const line = (reason ?? "startup failed").replace(/\s+/gu, " ").trim();
  return `Startup failed: ${line || "startup failed"}`;
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
  selector: "parent" | "issue" | "document";
  issueTicket?: number;
  autoMerge: boolean;
} {
  const { project, options, autoMerge } = parseRunOptions(argv);
  const parentSelector = options.parent !== undefined;
  const issueSelector = options.issue !== undefined;
  const documentSelector = options.document === true;
  if (
    Number(parentSelector) +
      Number(issueSelector) +
      Number(documentSelector) !==
    1
  )
    throw new Error(usageMessage);

  const parentTicket = ticketNumber(options.parent);
  const issueTicket = ticketNumber(options.issue);
  const explicitAutoMerge =
    argv.includes("--auto-merge") || argv.includes("--no-auto-merge");
  if (explicitAutoMerge && issueTicket === undefined)
    throw new Error("auto-merge flags require a value-bearing --issue");
  if (documentSelector)
    return { project, selector: "document", autoMerge: false };
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

function maintenanceArtifacts(
  snapshot: RecoverySnapshot,
  publication: PublicationIntent | undefined,
): string[] {
  const ticket = snapshot.maintenance?.ticket;
  const cleanup =
    ticket === undefined ? undefined : snapshot.terminalCleanup?.[ticket];
  return [
    ticket === undefined ? undefined : `Maintenance Ticket ${ticket}`,
    publication?.pullRequest?.url,
    publication?.stableBranch === undefined
      ? undefined
      : `branch ${publication.stableBranch}`,
    typeof publication?.completionEvidence === "object" &&
    publication.completionEvidence !== null &&
    "worktree" in publication.completionEvidence &&
    typeof publication.completionEvidence.worktree === "string"
      ? `worktree ${publication.completionEvidence.worktree}`
      : undefined,
    ...(cleanup?.candidates ?? []).map((candidate) => `worktree ${candidate}`),
  ].filter((value): value is string => value !== undefined);
}

function withoutMaintenanceRecovery(
  snapshot: RecoverySnapshot,
): RecoverySnapshot {
  const next = { ...snapshot };
  const ticket = next.maintenance?.ticket;
  delete next.maintenance;
  if (ticket !== undefined && next.terminalCleanup !== undefined) {
    const terminalCleanup = { ...next.terminalCleanup };
    delete terminalCleanup[ticket];
    if (Object.keys(terminalCleanup).length === 0) delete next.terminalCleanup;
    else next.terminalCleanup = terminalCleanup;
  }
  if (next.publications !== undefined) {
    const publications = next.publications.filter(
      ({ kind }) => kind !== "maintenance",
    );
    if (publications.length === 0) delete next.publications;
    else next.publications = publications;
  }
  return next;
}

function reconcileMaintenanceRecovery(
  snapshot: RecoverySnapshot,
  trigger: string,
): { snapshot: RecoverySnapshot; reasons: string[] } {
  const publication = snapshot.publications?.find(
    ({ kind }) => kind === "maintenance",
  );
  if (snapshot.maintenance?.barrier !== true && publication === undefined)
    return { snapshot, reasons: [] };

  const completed = new Map(
    (snapshot.completedDeliveries ?? []).map((delivery) => [
      delivery.ticket,
      delivery.labels,
    ]),
  );
  const stillRequired =
    trigger.length > 0 &&
    (snapshot.maintenance?.deliveryTickets ?? []).some((ticket) =>
      completed.get(ticket)?.includes(trigger),
    );
  if (stillRequired) return { snapshot, reasons: [] };

  const artifacts = maintenanceArtifacts(snapshot, publication);
  return {
    snapshot: withoutMaintenanceRecovery(snapshot),
    reasons: [
      `Current workflow.docMaintainTriggerLabel stops unfinished automatic Documentation Maintenance; preserved ${artifacts.join(", ") || "recorded artifacts"} for manual handling`,
    ],
  };
}

export async function executeCli(
  argv: string[],
  dependencies: CliDependencies,
): Promise<CliResult> {
  let project: string;
  let parentTicket: number | undefined;
  let selector: "parent" | "issue" | "document";
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
    dependencies.operator.write(startupFailureMessage(summary.reasons[0]));
    return { exitCode: 1, summary, logPath: null };
  }
  let loaded: Awaited<ReturnType<typeof loadProject>>;
  try {
    loaded = await loadProject(dependencies.root, project, dependencies.env, {
      ...(selector === "document"
        ? { requireDocumentationMaintenance: true }
        : {}),
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
    dependencies.operator.write(startupFailureMessage(summary.reasons[0]));
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
    dependencies.operator.write(startupFailureMessage(summary.reasons[0]));
    return { exitCode: 1, summary, logPath: null };
  }
  const effectiveParentTicket = parentTicket ?? standaloneIssueList?.[0] ?? 0;
  const runId = randomUUID();
  const timestamp = dependencies.clock.now().toISOString();
  const runKind = selector === "issue" ? "issue" : "parent";
  const selectionIssueList =
    selector === "parent" ? loaded.config.issueList : standaloneIssueList;
  const paths =
    selector === "document"
      ? undefined
      : recoveryPaths(
          loaded.directory,
          effectiveParentTicket,
          runKind,
          selectionIssueList ?? [],
        );
  let previous: RecoverySnapshot | null;
  try {
    previous =
      paths === undefined ? null : await readRecoverySnapshot(paths.snapshot);
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
    const summary: RunSummary = {
      outcome: "failed",
      project,
      parentTicket: effectiveParentTicket,
      targetBranch: loaded.config.targetBranch ?? "unresolved",
      reasons: [
        error instanceof Error ? error.message : "recovery startup failed",
      ],
    };
    dependencies.operator.write(startupFailureMessage(summary.reasons[0]));
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
  const maintenanceRecovery = reconcileMaintenanceRecovery(
    currentSnapshot,
    loaded.config.workflow.docMaintainTriggerLabel,
  );
  currentSnapshot = maintenanceRecovery.snapshot;
  const startupReasons = maintenanceRecovery.reasons;
  const writeSnapshot = async (snapshot: RecoverySnapshot) => {
    if (paths !== undefined)
      await writeRecoverySnapshot(paths.snapshot, snapshot);
  };
  try {
    await writeSnapshot(currentSnapshot);
  } catch (error) {
    const summary: RunSummary = {
      outcome: "failed",
      project,
      parentTicket: effectiveParentTicket,
      targetBranch: loaded.config.targetBranch ?? "unresolved",
      reasons: [
        error instanceof Error ? error.message : "recovery startup failed",
      ],
    };
    dependencies.operator.write(startupFailureMessage(summary.reasons[0]));
    return { exitCode: 1, summary, logPath: null };
  }
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
  let snapshotWrite = Promise.resolve();
  const persistSnapshotUpdate = async (
    update: (snapshot: RecoverySnapshot) => RecoverySnapshot,
  ) => {
    const previousWrite = snapshotWrite;
    let releaseWrite!: () => void;
    snapshotWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    await previousWrite;
    try {
      const nextSnapshot = {
        ...update(currentSnapshot),
        updatedAt: dependencies.clock.now().toISOString(),
      };
      await writeSnapshot(nextSnapshot);
      currentSnapshot = nextSnapshot;
    } finally {
      releaseWrite();
    }
  };
  const persistPublication = (
    ticket: number,
    intent: PublicationIntent | null,
  ) =>
    persistSnapshotUpdate((snapshot) => {
      const publications = (snapshot.publications ?? []).filter(
        (publication) => publication.ticket !== ticket,
      );
      if (intent !== null) publications.push(intent);
      const next = { ...snapshot };
      if (publications.length === 0) delete next.publications;
      else next.publications = publications;
      return next;
    });
  const persistBatch = async (
    batch: number[],
    completed: NonNullable<RecoverySnapshot["completedDeliveries"]>,
  ) => {
    const nextSnapshot = {
      ...currentSnapshot,
      batch: [...new Set([...(currentSnapshot.batch ?? []), ...batch])],
      activeBatch: [...batch],
      completedDeliveries: completed.map((delivery) => ({
        ticket: delivery.ticket,
        labels: [...delivery.labels],
      })),
      updatedAt: dependencies.clock.now().toISOString(),
    };
    await writeSnapshot(nextSnapshot);
    currentSnapshot = nextSnapshot;
  };
  const persistCleanup = (ticket: number, record: CleanupRecord) =>
    persistSnapshotUpdate((snapshot) => ({
      ...snapshot,
      terminalCleanup: {
        ...(snapshot.terminalCleanup ?? {}),
        [ticket]: record,
      },
    }));
  const persistMaintenance = async (state: MaintenanceState | null) => {
    const nextSnapshot =
      state === null
        ? {
            ...withoutMaintenanceRecovery(currentSnapshot),
            activeBatch: [],
            updatedAt: dependencies.clock.now().toISOString(),
          }
        : {
            ...currentSnapshot,
            maintenance: state,
            updatedAt: dependencies.clock.now().toISOString(),
          };
    await writeSnapshot(nextSnapshot);
    currentSnapshot = nextSnapshot;
  };
  let summary: RunSummary;
  try {
    await supervisedAuditWrite(() => audit.create(), dependencies.operator);
    summary = await runProject({
      project,
      parentTicket: effectiveParentTicket,
      issueList: loaded.config.issueList,
      maxBatchSize: loaded.config.maxBatchSize,
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
      docMaintainTriggerLabel: loaded.config.workflow.docMaintainTriggerLabel,
      ...(selector === "document" ? { documentOnly: true } : {}),
      ...(startupReasons.length === 0 ? {} : { startupReasons }),
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
      ...(selector === "document"
        ? {}
        : {
            persistPublication,
            persistBatch,
            persistCleanup,
            persistMaintenance,
          }),
      recoveredPublications:
        selector === "document" ? [] : (currentSnapshot.publications ?? []),
      ...(currentSnapshot.maintenance === undefined
        ? {}
        : { recoveredMaintenance: currentSnapshot.maintenance }),
      ...(currentSnapshot.activeBatch === undefined &&
      currentSnapshot.batch === undefined
        ? {}
        : {
            recoveredBatch:
              currentSnapshot.activeBatch ?? currentSnapshot.batch ?? [],
          }),
      ...(currentSnapshot.batch === undefined
        ? {}
        : { recoveredRunTickets: currentSnapshot.batch }),
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
  try {
    await writeSnapshot({
      ...currentSnapshot,
      phase:
        summary.outcome === "succeeded" && !autoMerge
          ? currentSnapshot.phase
          : summary.outcome,
      targetBranch: summary.targetBranch,
      updatedAt: dependencies.clock.now().toISOString(),
    });
    dependencies.operator.write(renderRunReport(summary, audit.path));
  } finally {
    await removeEmptyRunWorktreeParent(
      path.join(loaded.directory, "worktrees", runId),
      dependencies.operator,
    );
  }
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
