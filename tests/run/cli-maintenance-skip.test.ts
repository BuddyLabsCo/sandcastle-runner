import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  recoveryPaths,
  readRecoverySnapshot,
  writeRecoverySnapshot,
} from "../../src/recovery.ts";
import type { Ticket } from "../../src/run/contracts.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import {
  createProject,
  readProjectConfig,
  publicationIntent,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const selector of ["parent", "issue"] as const)
  for (const [point, laterBatch] of [
    ["before_pr", true],
    ["before_pr", false],
    ["after_pr", true],
    ["after_pr", false],
  ] as const) {
    test(`skip ends a Maintenance occurrence ${point} with ${laterBatch ? "later" : "no later"} ${selector} work`, async () => {
      const root = await createProject();
      const configPath = path.join(root, "projects/demo/config.yaml");
      const config = await readProjectConfig<{
        issueList: number[];
        maxBatchSize: number;
        workflow: { docMaintainTriggerLabel: string };
      }>(configPath);
      const deliveries = laterBatch ? [9, 10] : [9];
      config.issueList = selector === "issue" ? deliveries : [];
      config.maxBatchSize = 1;
      config.workflow.docMaintainTriggerLabel = "documentation";
      await writeProjectConfig(configPath, config);

      const parent: Ticket = {
        number: 8,
        state: "open",
        stateReason: null,
      };
      const tickets = new Map<number, Ticket>(
        deliveries.map((ticket) => [
          ticket,
          {
            number: ticket,
            state: "open",
            stateReason: null,
            repository: validConfig.repository,
            assignees: [],
            labels: ["ready-for-agent", "documentation"],
          },
        ]),
      );
      const maintenanceTickets = new Map<number, Ticket>();
      const workspaces = new Map<
        string,
        { ticket: number; branch: string; maintenance: boolean }
      >();
      const maintenanceHeads = new Map<number, string>();
      const branchHeads = new Map<string, string>();
      const pullRequests = new Map<
        number,
        { ticket: number; headSha: string; merged: boolean }
      >();
      const removedWorktrees: string[] = [];
      const deletedBranches: string[] = [];
      const comments: Ticket["number"][] = [];
      const pauses: string[] = [];
      const agentCalls: { ticket: number; prompt: string | undefined }[] = [];
      const logs = new Map<number, string[]>();
      let nextMaintenanceTicket = 100;
      let nextPullRequest = 41;
      let parentCloses = 0;
      let maintenanceCreates = 0;
      let maintenancePullRequest: number | undefined;

      const head = (ticket: number) => String(ticket).at(-1)!.repeat(40);
      const ticketForBranch = (branch: string) =>
        Number(/(?:ticket|maintenance)-(\d+)(?:-|$)/u.exec(branch)![1]);
      const rememberLog = (ticket: number, logFile: string) => {
        const ticketLogs = logs.get(ticket) ?? [];
        ticketLogs.push(logFile);
        logs.set(ticket, ticketLogs);
      };

      const dependencies = createCliDependencies(root, {
        tracker: {
          async getParent() {
            return parent;
          },
          async listChildrenPage() {
            return { children: [...tickets.values()], nextPage: null };
          },
          async getTicket(_repository, ticket) {
            return maintenanceTickets.get(ticket) ?? tickets.get(ticket)!;
          },
          async listBlockersPage() {
            return { blockers: [], nextPage: null };
          },
          async listLabelsPage() {
            return { labels: ["doc-maintain"], nextPage: null };
          },
          async createMaintenanceTicket() {
            maintenanceCreates += 1;
            const ticket: Ticket = {
              number: nextMaintenanceTicket++,
              state: "open",
              stateReason: null,
              assignees: [],
              labels: ["doc-maintain"],
            };
            maintenanceTickets.set(ticket.number, ticket);
            return ticket;
          },
          async addLabel(_repository, ticket, label) {
            const found = maintenanceTickets.get(ticket) ?? tickets.get(ticket);
            if (found && !(found.labels ?? []).includes(label))
              found.labels?.push(label);
          },
          async addAssignee(_repository, ticket, assignee) {
            const found = maintenanceTickets.get(ticket) ?? tickets.get(ticket);
            if (found && !(found.assignees ?? []).includes(assignee))
              found.assignees?.push(assignee);
          },
          async removeLabel(_repository, ticket, label) {
            const found = maintenanceTickets.get(ticket) ?? tickets.get(ticket);
            if (found)
              found.labels = (found.labels ?? []).filter(
                (value) => value !== label,
              );
          },
          async removeAssignee(_repository, ticket, assignee) {
            const found = maintenanceTickets.get(ticket) ?? tickets.get(ticket);
            if (found)
              found.assignees = (found.assignees ?? []).filter(
                (value) => value !== assignee,
              );
          },
          async addComment(_repository, ticket) {
            comments.push(ticket);
          },
          async closeTicket(_repository, ticket) {
            const found =
              maintenanceTickets.get(ticket) ?? tickets.get(ticket)!;
            found.state = "closed";
            found.stateReason = "completed";
          },
          async closeParent() {
            parentCloses += 1;
            parent.state = "closed";
            parent.stateReason = "completed";
          },
        },
        gitWorkspace: {
          async fetchTargetBranch() {
            return "a".repeat(40);
          },
          async createWorktree(input) {
            const ticket = ticketForBranch(input.branch);
            workspaces.set(input.worktree, {
              ticket,
              branch: input.branch,
              maintenance: input.branch.includes("/maintenance-"),
            });
          },
          async inspect({ worktree, base }) {
            const workspace = workspaces.get(worktree)!;
            const sha = maintenanceHeads.get(workspace.ticket);
            return {
              worktree,
              branch: workspace.branch,
              base,
              commits:
                workspace.maintenance && sha === undefined
                  ? []
                  : [
                      {
                        sha: sha ?? head(workspace.ticket),
                        message: workspace.maintenance
                          ? "docs: maintain documentation"
                          : `feat: ticket ${workspace.ticket}`,
                      },
                    ],
              clean: true,
            };
          },
          async push(worktree, branch, remoteBranch) {
            const workspace = workspaces.get(worktree)!;
            branchHeads.set(
              remoteBranch ?? branch,
              maintenanceHeads.get(workspace.ticket) ?? head(workspace.ticket),
            );
          },
          async listWorktrees() {
            return [...workspaces].map(([worktree, workspace]) => ({
              worktree,
              branch: workspace.branch,
              repository: validConfig.checkout,
            }));
          },
          async removeWorktree(_checkout, worktree) {
            removedWorktrees.push(worktree);
            workspaces.delete(worktree);
          },
          async deleteBranch(_checkout, branch) {
            deletedBranches.push(branch);
          },
        },
        agentExecutor: {
          async execute(input) {
            agentCalls.push({
              ticket: input.ticket,
              prompt: input.promptFile,
            });
            await mkdir(path.dirname(input.logFile), { recursive: true });
            await writeFile(input.logFile, `attempt ${input.ticket}`);
            rememberLog(input.ticket, input.logFile);
            if (input.promptFile?.endsWith("documentation.md")) {
              if (input.ticket === 100) {
                if (point === "before_pr")
                  return {
                    outcome: "blocked",
                    summary: "documentation needs a decision",
                    commits: [],
                    checks: [],
                    blocker: "missing Documentation Base",
                  };
                const sha = "c".repeat(40);
                maintenanceHeads.set(input.ticket, sha);
                return {
                  outcome: "committed",
                  summary: "maintained documentation",
                  commits: [{ sha, message: "docs: maintain documentation" }],
                  checks: [],
                  blocker: null,
                  pr_title: "docs: maintain documentation",
                  pr_body: "Maintain documentation.",
                };
              }
              return {
                outcome: "no_change",
                summary: "documentation is current",
                commits: [],
                checks: [],
                blocker: null,
              };
            }
            if (input.promptArgs.FAILED_CHECKS !== undefined)
              return {
                outcome: "blocked",
                summary: "CI repair needs a decision",
                commits: [],
                checks: [],
                blocker: "CI repair needs a decision",
              };
            const commit = {
              sha: head(input.ticket),
              message: `feat: ticket ${input.ticket}`,
            };
            return {
              outcome: "committed",
              summary: `implemented ${input.ticket}`,
              commits: [commit],
              checks: [],
              blocker: null,
              pr_title: `feat: ticket ${input.ticket}`,
              pr_body: `Implements ticket ${input.ticket}.`,
            };
          },
        },
        codeHost: {
          async createPullRequest(input) {
            const ticket = ticketForBranch(input.branch);
            const number = nextPullRequest++;
            const headSha = branchHeads.get(input.branch) ?? "d".repeat(40);
            pullRequests.set(number, { ticket, headSha, merged: false });
            if (ticket === 100) maintenancePullRequest = number;
            return { number, url: `https://example.test/pull/${number}` };
          },
          async getRemoteBranchHead(_repository, branch) {
            return branchHeads.get(branch) ?? null;
          },
          async getRequiredChecks(_repository, pullRequest) {
            return point === "after_pr" &&
              pullRequest === maintenancePullRequest
              ? [
                  {
                    name: "checks",
                    state: "FAILURE",
                    link: "https://example.test/checks/1",
                    bucket: "fail" as const,
                  },
                ]
              : [];
          },
          async getPullRequest(_repository, pullRequest) {
            const found = pullRequests.get(pullRequest)!;
            return {
              headSha: found.headSha,
              createdAt: "2026-09-09T00:00:00Z",
              merged: found.merged,
              mergeFailure: null,
            };
          },
          async requestSquashMerge({ pullRequest }) {
            pullRequests.get(pullRequest)!.merged = true;
            return { outcome: "accepted" };
          },
        },
        operator: {
          async pause(message) {
            pauses.push(message);
            return "s";
          },
        },
      });

      const args =
        selector === "parent"
          ? ["run", "--project", "demo", "--parent", "8"]
          : ["run", "--project", "demo", "--issue"];
      const result = await executeCli(args, dependencies);

      assert.equal(
        result.summary.outcome,
        "incomplete",
        result.summary.reasons.join("; "),
      );
      assert.deepEqual(result.summary.completedTickets, deliveries);
      assert.equal(parentCloses, 0);
      assert.equal(parent.state, "open");
      assert.deepEqual(
        [...maintenanceTickets.keys()],
        laterBatch ? [100, 101] : [100],
      );
      assert.equal(maintenanceCreates, laterBatch ? 2 : 1);
      assert.equal(pauses.length, 1);
      assert.match(pauses[0]!, /s to skip/u);

      const skippedTicket = maintenanceTickets.get(100)!;
      assert.equal(skippedTicket.state, "open");
      assert.deepEqual(skippedTicket.labels, ["doc-maintain"]);
      assert.deepEqual(skippedTicket.assignees, []);
      assert.equal(comments.includes(100), false);
      if (laterBatch)
        assert.equal(maintenanceTickets.get(101)?.stateReason, "completed");

      const skippedRow = result.summary.tickets?.find(
        ({ ticket }) => ticket === 100,
      );
      assert.equal(skippedRow?.status, "failed");
      assert.equal(skippedRow?.pullRequest, maintenancePullRequest ?? null);
      assert.match(
        skippedRow?.detail ?? "",
        /^skipped Maintenance Ticket 100/u,
      );
      if (maintenancePullRequest !== undefined)
        assert.equal(pullRequests.get(maintenancePullRequest)?.merged, false);

      const skippedWorkspace = [...workspaces].find(
        ([, workspace]) => workspace.ticket === 100,
      );
      assert.ok(skippedWorkspace);
      const [skippedWorktree, { branch: skippedBranch }] = skippedWorkspace;
      assert.equal(removedWorktrees.includes(skippedWorktree), false);
      assert.equal(deletedBranches.includes(skippedBranch), false);
      assert.ok(
        skippedRow?.retainedWorktrees.some((worktree) =>
          worktree.includes("maintenance-100"),
        ),
      );
      for (const logFile of logs.get(100) ?? [])
        await assert.rejects(access(logFile));

      const projectDirectory = path.join(root, "projects", "demo");
      const snapshot = await readRecoverySnapshot(
        selector === "parent"
          ? recoveryPaths(projectDirectory, 8).snapshot
          : recoveryPaths(projectDirectory, 9, "issue", deliveries).snapshot,
      );
      assert.equal(snapshot?.maintenance?.ticket, laterBatch ? 101 : undefined);
      assert.equal(
        snapshot?.publications?.some(({ ticket }) => ticket === 100),
        false,
      );

      const callsBeforeRestart = agentCalls.filter(
        ({ ticket }) => ticket === 100,
      ).length;
      await executeCli(args, dependencies);
      assert.equal(
        agentCalls.filter(({ ticket }) => ticket === 100).length,
        callsBeforeRestart,
        "a restart must not resume the skipped Maintenance occurrence",
      );
      assert.equal(
        maintenanceCreates,
        laterBatch ? 2 : 1,
        "a restart must not retrigger maintenance for the skipped Batch",
      );
    });
  }

for (const phase of ["attempt", "publication"] as const)
  test(`skipping recovered Maintenance ${phase} stays incomplete under --no-auto-merge`, async () => {
    const root = await createProject();
    const configPath = path.join(root, "projects/demo/config.yaml");
    const config = await readProjectConfig<{
      workflow: { docMaintainTriggerLabel: string };
    }>(configPath);
    config.workflow.docMaintainTriggerLabel = "documentation";
    await writeProjectConfig(configPath, config);
    await writeRecoverySnapshot(
      recoveryPaths(path.join(root, "projects/demo"), 9, "issue").snapshot,
      {
        schemaVersion: 2,
        project: "demo",
        repository: validConfig.repository,
        checkout: validConfig.checkout,
        parentTicket: 9,
        runKind: "issue",
        issueTicket: 9,
        runId: "interrupted",
        phase: "running",
        targetBranch: "main",
        createdAt: "2026-10-24T00:00:00.000Z",
        updatedAt: "2026-10-24T00:00:00.000Z",
        batch: [9],
        activeBatch: [9],
        completedDeliveries: [{ ticket: 9, labels: ["documentation"] }],
        maintenance: {
          phase: "blocked",
          ticket: 100,
          deliveryTickets: [9],
          barrier: true,
        },
        ...(phase === "publication"
          ? {
              publications: [
                {
                  ...publicationIntent("pr_created", 100),
                  kind: "maintenance" as const,
                },
              ],
            }
          : {}),
      },
    );
    const maintenance: Ticket = {
      number: 100,
      state: "open",
      stateReason: null,
      assignees: [],
      labels: ["doc-maintain"],
    };
    let parentCloses = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--issue", "9", "--no-auto-merge"],
      createCliDependencies(root, {
        tracker: {
          async getTicket() {
            return maintenance;
          },
          async closeParent() {
            parentCloses += 1;
          },
        },
        codeHost: {
          async getRemoteBranchHead() {
            return "f".repeat(40);
          },
        },
        operator: {
          async pause() {
            return "s";
          },
        },
      }),
    );
    assert.equal(
      result.summary.outcome,
      "incomplete",
      result.summary.reasons.join("; "),
    );
    assert.equal(result.exitCode, 1);
    assert.equal(parentCloses, 0);
    assert.equal(maintenance.state, "open");
    assert.equal(
      result.summary.tickets?.find(({ ticket }) => ticket === 100)?.status,
      "failed",
    );
  });
