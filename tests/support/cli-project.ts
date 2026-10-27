import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

import {
  recoveryPaths,
  writeRecoverySnapshot,
  type PublicationIntent,
} from "../../src/recovery.ts";
import { registerTempRoot } from "../support/temp-cleanup.ts";
export const validConfig = {
  repository: "owner/repo",
  checkout: "/tmp/repo",
  issueList: [],
  maxBatchSize: 3,
  targetBranch: "main",
  tracker: {
    type: "github",
    tokenEnv: "TEST_GH_TOKEN",
    runnerAccount: "runner",
    reservationLabel: "sandcastle:reserved",
  },
  codeHost: {
    type: "github",
    tokenEnv: "TEST_GH_TOKEN",
    adminMerge: false,
  },
  agents: Object.fromEntries(
    ["implement", "review", "ciRepair", "conflictRepair", "documentation"].map(
      (name) => [
        name,
        { agent: "codex", model: "gpt-5.6-sol", options: { effort: "high" } },
      ],
    ),
  ),
  timeouts: {
    agentMinutes: 120,
    requiredChecksMinutes: 60,
    mergeQueueMinutes: 60,
  },
  operationRetry: 4,
  agentRetry: 4,
  operationRetryDelay: [10, 20, 40, 80],
  agentRetryDelay: [10, 20, 40, 80],
  workflow: { review: false, docMaintainTriggerLabel: "" },
  ticketClosure: "runner",
  maintenanceTicket: {
    title: "Maintain project documentation",
    body: "Run the configured documentation-maintenance prompt for the current Target Branch.",
    label: "doc-maintain",
  },
};

export async function readProjectConfig<T>(configPath: string): Promise<T> {
  return parse(await readFile(configPath, "utf8")) as T;
}

export async function writeProjectConfig(
  configPath: string,
  config: unknown,
): Promise<void> {
  await writeFile(configPath, stringify(config));
}

export async function createProject(): Promise<string> {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-runner-")),
  );
  const project = path.join(root, "projects", "demo");
  await mkdir(path.join(project, "prompts"), { recursive: true });
  await writeProjectConfig(path.join(project, "config.yaml"), validConfig);
  await Promise.all(
    ["implement", "review", "documentation"].map((name) =>
      writeFile(path.join(project, "prompts", `${name}.md`), `${name} prompt`),
    ),
  );
  return root;
}

export function publicationIntent(
  phase: PublicationIntent["phase"],
  ticket = 9,
): PublicationIntent {
  const head = String(ticket).at(-1)!.repeat(40);
  return {
    ticket,
    kind: "delivery",
    originalBase: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    targetBranch: "main",
    stableBranch: `ticket-${ticket}-old`,
    intendedHeadSha: head,
    title: `feat: ticket ${ticket}`,
    body: `Completes ticket ${ticket}.`,
    phase,
    implementationEvidence: [{ sha: head, message: `feat: ticket ${ticket}` }],
    reviewEvidence: [],
    completionEvidence: {
      ticket,
      worktree: `/tmp/old-ticket-${ticket}`,
      branch: `ticket-${ticket}-old`,
      base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      commits: [{ sha: head, message: `feat: ticket ${ticket}` }],
      checks: [],
      prTitle: `feat: ticket ${ticket}`,
      prBody: `Completes ticket ${ticket}.`,
      verification: "verified",
    },
    ...(phase === "pr_created"
      ? {
          pullRequest: {
            number: 4,
            url: "https://example.test/pull/4",
            headSha: head,
          },
        }
      : {}),
  };
}

export async function writePublicationState(
  root: string,
  publications: PublicationIntent[],
): Promise<string> {
  const project = path.join(root, "projects", "demo");
  const snapshot = recoveryPaths(project, 8).snapshot;
  await writeRecoverySnapshot(snapshot, {
    schemaVersion: 2,
    project: "demo",
    repository: "owner/repo",
    checkout: "/tmp/repo",
    parentTicket: 8,
    runId: "interrupted",
    phase: "running",
    targetBranch: "main",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    batch: publications.map(({ ticket }) => ticket),
    completedDeliveries: [],
    publications,
  });
  return snapshot;
}

export async function recoverySnapshot(
  root: string,
  ticket: number,
  publication: PublicationIntent,
): Promise<string> {
  const snapshot = recoveryPaths(
    `${root}/projects/demo`,
    ticket,
    "issue",
  ).snapshot;
  await writeRecoverySnapshot(snapshot, {
    schemaVersion: 2,
    project: "demo",
    repository: "owner/repo",
    checkout: "/tmp/repo",
    parentTicket: ticket,
    runKind: "issue",
    issueTicket: ticket,
    runId: "interrupted",
    phase: "running",
    targetBranch: "main",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    batch: [publication.ticket],
    completedDeliveries: [],
    publications: [publication],
  });
  return snapshot;
}
