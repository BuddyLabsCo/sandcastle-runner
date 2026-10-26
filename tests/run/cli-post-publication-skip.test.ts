import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createAttemptTracker,
  createCliDependencies,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import { createProject, validConfig } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("a CI skip keeps its failed row when a peer leaves the Batch barrier unresolved", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10);
  let mergeRequests = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async inspect(input) {
          const observed = await delivery.gitWorkspace.inspect(input);
          return input.worktree.endsWith("ticket-10")
            ? { ...observed, commits: [] }
            : observed;
        },
      },
      agentExecutor: {
        async execute(input) {
          if (input.promptFile.endsWith("ci-repair.md"))
            return {
              outcome: "blocked",
              summary: "CI repair needs a decision",
              commits: [],
              checks: [],
              blocker: "CI repair needs a decision",
            };
          return input.ticket === 10
            ? {
                outcome: "no_change",
                summary: "no safe change",
                commits: [],
                checks: [],
                blocker: null,
              }
            : delivery.agentExecutor.execute(input);
        },
      },
      codeHost: {
        async getRequiredChecks() {
          return [
            {
              name: "checks",
              state: "FAILURE",
              link: "https://example.test/checks/1",
              bucket: "fail",
            },
          ];
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause() {
          return "s";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  const skipped = result.summary.tickets?.find(({ ticket }) => ticket === 9);
  assert.equal(skipped?.status, "failed");
  assert.equal(skipped?.pullRequest, 1);
  assert.match(skipped?.detail ?? "", /^skipped/u);
  assert.equal(result.summary.tickets?.[1]?.status, "no_change");
  assert.equal(mergeRequests, 0);
});

for (const repair of ["ci", "conflict"] as const) {
  test(`skip during ${repair} repair keeps the published ticket while its Batch peer completes`, async () => {
    const root = await createProject();
    const { tickets, tracker } = createAttemptTracker(9, 10);
    const workspaces = new Map<
      string,
      { ticket: number; branch: string; repair: boolean }
    >();
    const removedWorktrees: string[] = [];
    const deletedBranches: string[] = [];
    const pauses: string[] = [];
    const pullRequests = new Map<number, number>();
    const merged = new Set<number>();
    const implementationCalls = new Map<number, number>();
    let nextPullRequest = 41;
    let parentCloses = 0;
    const logs = path.join(root, "projects", "demo", "logs");
    await mkdir(logs, { recursive: true });
    const reviewLog = path.join(logs, "review-9-current.log");
    await writeFile(reviewLog, "review");

    const dependencies = createCliDependencies(root, {
      tracker: {
        ...tracker,
        async closeParent() {
          parentCloses += 1;
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          const ticket = Number(
            /(?:ticket|maintenance)-(\d+)(?:-|$)/u.exec(input.branch)![1],
          );
          workspaces.set(input.worktree, {
            ticket,
            branch: input.branch,
            repair: input.branch.includes("-repair-"),
          });
        },
        async inspect({ worktree, base }) {
          const workspace = workspaces.get(worktree)!;
          const ticket = workspace.ticket;
          return {
            worktree,
            branch: workspace.branch,
            base,
            commits: [
              {
                sha: String(ticket).at(-1)!.repeat(40),
                message: `feat: ticket ${ticket}`,
              },
            ],
            clean: true,
          };
        },
        async listWorktrees() {
          return [...workspaces].map(([worktree, { branch }]) => ({
            worktree,
            branch,
            repository: validConfig.checkout,
          }));
        },
        async removeWorktree(_checkout, worktree) {
          removedWorktrees.push(worktree);
        },
        async deleteBranch(_checkout, branch) {
          deletedBranches.push(branch);
        },
      },
      agentExecutor: {
        async execute(input) {
          if (input.promptFile.endsWith(`${repair}-repair.md`)) {
            await mkdir(input.logFile);
            return {
              outcome: "blocked",
              summary: `${repair} repair needs a decision`,
              commits: [],
              checks: [],
              blocker: `${repair} repair needs a decision`,
            };
          }
          const ticket = input.ticket;
          implementationCalls.set(
            ticket,
            (implementationCalls.get(ticket) ?? 0) + 1,
          );
          return {
            outcome: "committed",
            summary: `implemented ${ticket}`,
            commits: [
              {
                sha: String(ticket).at(-1)!.repeat(40),
                message: `feat: ticket ${ticket}`,
              },
            ],
            checks: [],
            blocker: null,
            pr_title: `feat: ticket ${ticket}`,
            pr_body: `Implements ticket ${ticket}.`,
          };
        },
      },
      codeHost: {
        async getRemoteBranchHead() {
          return "b".repeat(40);
        },
        async createPullRequest({ branch }) {
          const ticket = Number(branch.split("-").at(-1));
          const number = nextPullRequest++;
          pullRequests.set(ticket, number);
          return { number, url: `https://example.test/pull/${number}` };
        },
        async getRequiredChecks(_repository, pullRequest) {
          return repair === "ci" && pullRequest === pullRequests.get(9)
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
          return {
            headSha: "b".repeat(40),
            createdAt: "2026-09-09T00:00:00Z",
            merged: merged.has(pullRequest),
            mergeFailure: null,
          };
        },
        async requestSquashMerge({ pullRequest }) {
          if (repair === "conflict" && pullRequest === pullRequests.get(9))
            return { outcome: "conflict", error: "merge conflict" };
          merged.add(pullRequest);
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
    const args = ["run", "--project", "demo", "--parent", "8"];
    const result = await executeCli(args, dependencies);

    assert.equal(result.summary.outcome, "incomplete");
    assert.equal(pauses.length, 1);
    assert.match(pauses[0]!, /s to skip/u);
    assert.deepEqual(
      result.summary.tickets?.map(
        ({ ticket, status, pullRequest, detail }) => ({
          ticket,
          status,
          pullRequest,
          skipped: detail.startsWith("skipped"),
        }),
      ),
      [
        {
          ticket: 9,
          status: "failed",
          pullRequest: pullRequests.get(9),
          skipped: true,
        },
        {
          ticket: 10,
          status: "completed",
          pullRequest: pullRequests.get(10),
          skipped: false,
        },
      ],
    );
    assert.deepEqual(tickets[0]!.labels, [
      "ready-for-agent",
      "sandcastle:reserved",
    ]);
    assert.deepEqual(tickets[0]!.assignees, ["runner"]);
    assert.equal(tickets[0]!.state, "open");
    assert.equal(tickets[1]!.stateReason, "completed");
    assert.equal(parentCloses, 0);
    assert.equal(pullRequests.size, 2);
    assert.equal(implementationCalls.get(9), 1);
    const skippedWorkspaces = [...workspaces].filter(
      ([, { ticket }]) => ticket === 9,
    );
    const peerWorkspaces = [...workspaces].filter(
      ([, { ticket }]) => ticket === 10,
    );
    assert.equal(skippedWorkspaces.length, 2);
    assert.deepEqual(
      removedWorktrees,
      peerWorkspaces.map(([path]) => path),
    );
    assert.deepEqual(
      deletedBranches,
      peerWorkspaces.map(([, { branch }]) => branch),
    );
    assert.deepEqual(
      result.summary.tickets?.[0]?.retainedWorktrees,
      skippedWorkspaces.map(([path]) => path),
    );
    await assert.rejects(access(reviewLog));
    assert.ok(result.logPath);
    const cleanupFailure = (await readFile(result.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(
        (event) =>
          event.operation === "delete_agent_log" && event.result === "failed",
      );
    assert.ok(cleanupFailure);
    assert.match(
      String(cleanupFailure.diagnosticLogPath),
      repair === "ci" ? /ci-9-.*\.log$/u : /merge-9-.*\.log$/u,
    );

    const laterRun = await executeCli(args, dependencies);
    assert.equal(laterRun.summary.outcome, "incomplete");
    assert.equal(
      pullRequests.size,
      2,
      "a later Run must adopt the existing Pull Request",
    );
    assert.equal(
      implementationCalls.get(9),
      1,
      "a later Run must not rerun implementation for the published ticket",
    );
  });
}

test("skip of a failed Worktree command leaves its concurrent peer able to deliver", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10);
  const attempts: number[] = [];
  const pauses: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async createWorktree(input) {
          if (input.worktree.endsWith("ticket-9"))
            throw new Error("partial Worktree");
          await delivery.gitWorkspace.createWorktree(input);
        },
      },
      agentExecutor: {
        async execute(input) {
          attempts.push(input.ticket);
          return delivery.agentExecutor.execute(input);
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return pauses.length === 1 ? "s" : "q";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(attempts, [10]);
  assert.deepEqual(result.summary.completedTickets, [10]);
  assert.match(pauses[0]!, /s to skip/u);
  assert.match(
    result.summary.tickets?.find((row) => row.ticket === 9)?.detail ?? "",
    /skipped/u,
  );
});
