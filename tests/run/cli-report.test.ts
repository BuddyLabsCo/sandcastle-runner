import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createCliDependencies,
  createAttemptTracker,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  readProjectConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

// eslint-disable-next-line no-control-regex -- OSC 8 hyperlinks are the behavior under test.
const hyperlinkPattern = /\u001b\]8;;[^\u001b]*\u001b\\|\u001b\]8;;\u001b\\/gu;

function withoutHyperlinks(text: string): string {
  return text.replace(hyperlinkPattern, "");
}

test("an empty Run prints the no-work report without an audit path", async () => {
  const root = await createProject();
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      operator: {
        write(message) {
          messages.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^No issues processed\.$/mu);
  assert.doesNotMatch(messages[0]!, /Audit Log/u);
  assert.doesNotMatch(messages[0]!, /^\{/u);
  assert.ok(result.logPath);
});

test("processed Delivery and Maintenance Tickets render in processing order", async () => {
  const root = await createProject();
  const configPath = path.join(root, "demo", "config.yaml");
  const config = await readProjectConfig<{
    workflow: { docMaintainTriggerLabel: string };
  }>(configPath);
  config.workflow.docMaintainTriggerLabel = "documentation";
  await writeProjectConfig(configPath, config);
  const delivery = createCommittedBatch(9);
  delivery.tickets[0]!.labels.push("documentation");
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      operator: {
        write(message) {
          messages.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(
    result.summary.tickets?.map(({ ticket, status, pullRequest }) => ({
      ticket,
      status,
      pullRequest,
    })),
    [
      { ticket: 9, status: "completed", pullRequest: 1 },
      { ticket: 1000, status: "no_change", pullRequest: null },
    ],
  );
  const report = withoutHyperlinks(messages.at(-1)!);
  assert.match(report, /^Issue\s+Status\s+PR\s+Detail$/mu);
  assert.match(report, /^9\s+completed\s+#1\s+/mu);
  assert.match(report, /^1000\s+no_change\s+-\s+Documentation:/mu);
  assert.doesNotMatch(messages.at(-1)!, /Audit Log/u);
  assert.doesNotMatch(messages.at(-1)!, /^\{/u);
  assert.match(
    messages.at(-1)!,
    // eslint-disable-next-line no-control-regex -- OSC 8 hyperlinks are the behavior under test.
    /\u001b\]8;;https:\/\/github\.com\/owner\/repo\/pull\/1\u001b\\#1\s*\u001b\]8;;\u001b\\/u,
  );
});

test("a CI-ready --no-auto-merge Run reports PR ready and its retained Worktree", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9);
  let mergeRequests = 0;
  let worktree = "";
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--issue", "9", "--project", "demo", "--no-auto-merge"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      agentExecutor: delivery.agentExecutor,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async createWorktree(input) {
          worktree = input.worktree;
          await delivery.gitWorkspace.createWorktree(input);
        },
      },
      codeHost: {
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "accepted" };
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.equal(mergeRequests, 0);
  assert.deepEqual(result.summary.tickets, [
    {
      ticket: 9,
      kind: "delivery",
      status: "PR ready",
      pullRequest: 1,
      pullRequestUrl: "https://github.com/owner/repo/pull/1",
      detail: "Pull Request #1 is CI-ready; awaiting manual merge",
      retainedWorktrees: [worktree],
    },
  ]);
  assert.match(withoutHyperlinks(messages.at(-1)!), /^9\s+PR ready\s+#1\s+/mu);
  assert.ok(messages.at(-1)!.includes(`- ${worktree}`));
});

test("processed work with no pickable tickets stays incomplete without routine reasons", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9);
  const blocked = {
    number: 10,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: ["ready-for-agent"],
  };
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async listChildrenPage() {
          return {
            children: [...delivery.tickets, blocked],
            nextPage: null,
          };
        },
        async getTicket(repository, ticket) {
          if (ticket === 10) return blocked;
          return delivery.tracker.getTicket!(repository, ticket);
        },
        async listBlockersPage(_repository, ticket) {
          return {
            blockers:
              ticket === 10
                ? [
                    {
                      number: 99,
                      state: "open" as const,
                      stateReason: null,
                      repository: "owner/repo",
                    },
                  ]
                : [],
            nextPage: null,
          };
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.summary.tickets?.map(({ ticket, status }) => ({ ticket, status })),
    [{ ticket: 9, status: "completed" }],
  );
  assert.ok(
    result.summary.reasons.includes("No pickable Delivery Tickets remain"),
  );
  assert.match(messages.at(-1)!, /^9\s+completed\s+/mu);
  assert.doesNotMatch(messages.at(-1)!, /^10\s+blocked\s+/mu);
  assert.doesNotMatch(messages.at(-1)!, /^Reasons:$/mu);
  assert.doesNotMatch(messages.at(-1)!, /No pickable Delivery Tickets remain/u);
  assert.doesNotMatch(messages.at(-1)!, /blocked Delivery Tickets: 10/u);
});

test("a no-change Agent outcome keeps its Worktree and row detail", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  let worktree = "";
  let branch = "";
  const historicalWorktree = path.join(
    root,
    "projects",
    "demo",
    "worktrees",
    "historical",
    "ticket-9",
  );
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          worktree = input.worktree;
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch,
            base,
            commits: [],
            clean: true,
          };
        },
        async listWorktrees() {
          return [
            {
              worktree: historicalWorktree,
              branch: "sandcastle/run-historical/ticket-9",
              repository: "/tmp/repo",
            },
          ];
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "no_change",
            summary: "no implementation was needed",
            commits: [],
            checks: [],
            blocker: null,
          };
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(result.summary.tickets, [
    {
      ticket: 9,
      kind: "delivery",
      status: "no_change",
      pullRequest: null,
      pullRequestUrl: null,
      detail: "Delivery Ticket 9 no_change: no implementation was needed",
      retainedWorktrees: [worktree],
    },
  ]);
  assert.match(
    messages.at(-1)!,
    /^9\s+no_change\s+-\s+Delivery Ticket 9 no_change: no implementation was needed$/mu,
  );
  assert.ok(messages.at(-1)!.includes(`- ${worktree}`));
  assert.equal(messages.at(-1)!.includes(historicalWorktree), false);
});

test("operator cancellation keeps the processed ticket and Worktree in the report", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  let worktree = "";
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          worktree = input.worktree;
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "blocked",
            summary: "the implementation cannot proceed",
            commits: [],
            checks: [],
            blocker: "operator input required",
          };
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(
    result.summary.tickets?.map(({ ticket, status, retainedWorktrees }) => ({
      ticket,
      status,
      retainedWorktrees,
    })),
    [{ ticket: 9, status: "cancelled", retainedWorktrees: [worktree] }],
  );
  assert.match(messages.at(-1)!, /^9\s+cancelled\s+-\s+/mu);
  assert.ok(messages.at(-1)!.includes(`- ${worktree}`));
  assert.match(messages.at(-1)!, /^Run cancelled\.$/mu);
  assert.doesNotMatch(messages.at(-1)!, /^Reasons:$/mu);
  assert.doesNotMatch(messages.at(-1)!, /Audit Log/u);
});

test("a ticket that becomes blocked after selection renders as blocked", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  let blocked = false;
  let agentCalls = 0;
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async listBlockersPage() {
          return {
            blockers: blocked
              ? [
                  {
                    number: 99,
                    state: "open" as const,
                    stateReason: null,
                    repository: "owner/repo",
                  },
                ]
              : [],
            nextPage: null,
          };
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          blocked = true;
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          throw new Error("must not run");
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
      },
    }),
  );

  assert.equal(agentCalls, 0);
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(
    result.summary.tickets?.map(({ ticket, status, detail }) => ({
      ticket,
      status,
      detail,
    })),
    [
      {
        ticket: 9,
        status: "blocked",
        detail: "Delivery Ticket 9 became blocked",
      },
    ],
  );
  assert.match(
    messages[0]!,
    /^9\s+blocked\s+-\s+Delivery Ticket 9 became blocked$/mu,
  );
  assert.doesNotMatch(messages[0]!, /Retained Worktrees:/u);
});

test("an unrecoverable Agent failure renders the ticket as failed", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  let worktree = "";
  let branch = "";
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          worktree = input.worktree;
          branch = input.branch;
        },
        async inspect() {
          throw new Error("Git evidence unavailable");
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [
              {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                message: "feat: implementation",
              },
            ],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          throw new Error("operator input unavailable");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(branch.length > 0, true);
  assert.deepEqual(
    result.summary.tickets?.map(({ ticket, status, retainedWorktrees }) => ({
      ticket,
      status,
      retainedWorktrees,
    })),
    [{ ticket: 9, status: "failed", retainedWorktrees: [worktree] }],
  );
  assert.match(messages.at(-1)!, /^9\s+failed\s+-\s+/mu);
  assert.ok(messages.at(-1)!.includes(`- ${worktree}`));
});
