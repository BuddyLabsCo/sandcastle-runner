import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import type { AgentExecutor } from "../../src/run/contracts.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
  createAttemptTracker,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
  publicationIntent,
  writePublicationState,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("a failed Review probe rejects text and Enter starts a fresh verified attempt", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    workflow: { ...validConfig.workflow, review: true },
  });
  const delivery = createCommittedDelivery();
  const reviewInputs: Parameters<AgentExecutor["executeReview"]>[0][] = [];
  const responses = ['{"outcome":"passed"}', ""];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async inspectReview() {
          return {
            clean: true,
            deliveryCommits: [
              { sha: "b".repeat(40), message: "feat: implementation" },
            ],
            reviewCommits: [],
          };
        },
      },
      agentExecutor: {
        ...delivery.agentExecutor,
        async executeReview(input) {
          reviewInputs.push(input);
          if (reviewInputs.length === 1)
            throw Object.assign(new Error("probe failed"), {
              diagnostics: { retryable: false },
            });
          return {
            outcome: "passed",
            summary: "review passed",
            standards: { verdict: "passed", unresolved_findings: [] },
            spec: { verdict: "passed", unresolved_findings: [] },
            checks: [],
            blocker: null,
          };
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /Enter to retry/u);
          assert.equal(reviewInputs.length, 1);
          return responses.shift() ?? "q";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(reviewInputs.length, 2);
  assert.ok(reviewInputs.every((input) => input.resumePrompt === undefined));
  assert.notEqual(reviewInputs[0]?.logFile, reviewInputs[1]?.logFile);
  assert.equal(result.summary.handoffs?.[0]?.reviewVerification, "verified");
});

for (const phase of ["labels", "create_label", "create_issue"] as const) {
  test(`skip during maintenance ${phase} ends the occurrence before an issue exists`, async () => {
    const root = await createProject();
    const responses = ['{"number":100}', "s"];
    let agentCalls = 0;
    let creates = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--document"],
      createCliDependencies(root, {
        tracker: {
          async listLabelsPage() {
            if (phase === "labels") throw new Error("labels unavailable");
            return {
              labels: phase === "create_label" ? [] : ["doc-maintain"],
              nextPage: null,
            };
          },
          async createLabel() {
            throw new Error("label creation unavailable");
          },
          async createMaintenanceTicket() {
            creates += 1;
            throw new Error("uncertain issue creation");
          },
        },
        agentExecutor: {
          async execute() {
            agentCalls += 1;
            throw new Error("must not invoke Agent");
          },
        },
        operator: {
          async pause(message) {
            assert.match(message, /s to skip.*Maintenance occurrence/u);
            return responses.shift() ?? "q";
          },
        },
      }),
    );
    assert.equal(result.summary.outcome, "incomplete");
    assert.equal(agentCalls, 0);
    assert.equal(creates, phase === "create_issue" ? 1 : 0);
    assert.deepEqual(responses, []);
  });
}

test("a queued merge receives no completion credit until timeout recovery confirms success", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    timeouts: { ...validConfig.timeouts, mergeQueueMinutes: 1 / 60_000 },
  });
  const delivery = createCommittedDelivery();
  let elapsed = 0;
  let mergeRequests = 0;
  let closeCalls = 0;
  let merged = false;
  const responses = ["trusted merge", ""];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async closeTicket(_repository, ticket) {
          closeCalls += 1;
          const found = delivery.tickets.find(
            ({ number }) => number === ticket,
          )!;
          found.state = "closed";
          found.stateReason = "completed";
        },
      },
      codeHost: {
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeRequested: mergeRequests > 0,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "accepted" };
        },
      },
      clock: {
        now: () => new Date(elapsed),
        async sleep(milliseconds) {
          elapsed += milliseconds;
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /Merge confirmation timed out/u);
          const response = responses.shift() ?? "q";
          if (response === "") merged = true;
          return response;
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(mergeRequests, 1);
  assert.equal(closeCalls, 1);
});

test("push retries directly and unobserved PR creation permits a duplicate attempt", async () => {
  for (const failedWrite of ["push", "create"] as const) {
    const root = await createProject();
    let branch = "",
      pushCalls = 0,
      createCalls = 0;
    let pauses = 0;
    const commit = {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "feat: implementation",
    };
    const { tracker } = createAttemptTracker(9);
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          },
          async createWorktree(input) {
            branch = input.branch;
          },
          async inspect({ worktree, base }) {
            return { worktree, branch, base, commits: [commit], clean: true };
          },
          async push() {
            pushCalls += 1;
            if (failedWrite === "push" && pushCalls === 1)
              throw new Error("[remote rejected] (failed)");
          },
        },
        agentExecutor: {
          async execute() {
            return {
              outcome: "committed",
              summary: "implemented",
              commits: [commit],
              checks: [],
              blocker: null,
              pr_title: "feat: implementation",
              pr_body: "Implementation body.",
            };
          },
        },
        codeHost: {
          async createPullRequest() {
            createCalls += 1;
            if (failedWrite === "create" && createCalls === 1)
              throw new Error("502 Bad Gateway");
            return {
              number: failedWrite === "create" ? 42 : 41,
              url: `https://github.com/owner/repo/pull/${failedWrite === "create" ? 42 : 41}`,
            };
          },
          async getRequiredChecks() {
            return [];
          },
        },
        operator: {
          async pause() {
            if (failedWrite === "push") throw new Error("unexpected pause");
            pauses += 1;
            return pauses === 1 ? "https://github.com/owner/repo/pull/41" : "";
          },
        },
      }),
    );

    assert.equal(
      result.summary.pullRequests?.[0]?.number,
      failedWrite === "create" ? 42 : 41,
    );
    assert.equal(pushCalls, failedWrite === "push" ? 2 : 1);
    assert.equal(createCalls, failedWrite === "create" ? 2 : 1);
  }
});

test("unobserved maintenance issue creation retries directly and may create a duplicate", async () => {
  const root = await createProject();
  const issues: number[] = [];
  const maintenance = {
    number: 102,
    state: "open" as "open" | "closed",
    stateReason: null as null | "completed",
    assignees: [] as string[],
    labels: ["doc-maintain"],
  };
  let pauses = 0;
  let branch = "";
  const result = await executeCli(
    ["run", "--project", "demo", "--document"],
    createCliDependencies(root, {
      tracker: {
        async createMaintenanceTicket() {
          issues.push(issues.length + 101);
          if (issues.length === 1)
            throw new Error("issue created but response lost");
          return maintenance;
        },
        async getTicket() {
          return maintenance;
        },
        async closeTicket() {
          maintenance.state = "closed";
          maintenance.stateReason = "completed";
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return { worktree, branch, base, commits: [], clean: true };
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "no_change",
            summary: "docs current",
            commits: [],
            checks: [],
            blocker: null,
          };
        },
      },
      operator: {
        async pause() {
          pauses += 1;
          return "";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(issues, [101, 102]);
  assert.equal(pauses, 1);
  assert.equal(result.summary.tickets?.[0]?.ticket, 102);
});

for (const action of ["", "s"] as const) {
  test(`publication recovery ${action === "" ? "rechecks on Enter" : "permits issue skip"} after inconsistent remote state`, async () => {
    const root = await createProject();
    const intent = publicationIntent("pending_pr");
    await writePublicationState(root, [intent]);
    const delivery = createCommittedDelivery();
    delivery.tickets[0]!.assignees = ["runner"];
    delivery.tickets[0]!.labels.push("sandcastle:reserved");
    let repaired = false;
    let reads = 0;
    let forbiddenCalls = 0;
    const responses = ["accept remote state", action];
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: delivery.tracker,
        codeHost: {
          async getRemoteBranchHead() {
            reads += 1;
            return repaired ? intent.intendedHeadSha : "f".repeat(40);
          },
          async listPullRequests() {
            return [
              {
                number: 41,
                url: "https://example.test/pull/41",
                branch: intent.stableBranch,
                targetBranch: "main",
                headSha: intent.intendedHeadSha,
                state: "open",
              },
            ];
          },
          async getPullRequest() {
            return {
              headSha: intent.intendedHeadSha,
              createdAt: "2026-09-09T00:00:00Z",
              merged: true,
              mergeFailure: null,
            };
          },
          async createPullRequest() {
            forbiddenCalls += 1;
            throw new Error("existing recovery PR");
          },
        },
        agentExecutor: {
          async execute() {
            forbiddenCalls += 1;
            throw new Error("existing handoff");
          },
        },
        operator: {
          async pause(message) {
            assert.match(message, /s to skip/u);
            assert.equal(reads, 1);
            const response = responses.shift() ?? "q";
            if (response === "") repaired = true;
            return response;
          },
        },
      }),
    );
    assert.equal(
      result.summary.outcome,
      action === "" ? "succeeded" : "incomplete",
    );
    assert.equal(reads, action === "" ? 2 : 1);
    assert.equal(forbiddenCalls, 0);
    assert.deepEqual(responses, []);
  });
}

test("stable repair branch recovery re-observes on Enter without another Agent attempt", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let remote = "b".repeat(40);
  let branch = "";
  let agents = 0;
  let merged = false;
  const responses = ["accept advanced branch", ""];
  const commit = { sha: "c".repeat(40), message: "fix: checks" };
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect(input) {
          if (agents === 1)
            return {
              worktree: input.worktree,
              branch,
              base: input.base,
              clean: true,
              commits: [
                { sha: "b".repeat(40), message: "feat: implementation" },
              ],
            };
          return {
            worktree: input.worktree,
            branch,
            base: input.base,
            clean: true,
            commits: [commit],
          };
        },
        async push() {
          remote = agents === 1 ? "b".repeat(40) : commit.sha;
        },
      },
      agentExecutor: {
        async execute(input) {
          agents += 1;
          if (agents === 1) return delivery.agentExecutor.execute!(input);
          remote = "d".repeat(40);
          return {
            outcome: "committed",
            summary: "repaired",
            commits: [commit],
            checks: [],
            blocker: null,
          };
        },
      },
      codeHost: {
        async getRemoteBranchHead() {
          return remote;
        },
        async getRequiredChecks() {
          return agents === 1
            ? [
                {
                  name: "check",
                  state: "FAILURE",
                  link: "https://example.test/check",
                  bucket: "fail",
                },
              ]
            : [];
        },
        async getPullRequest() {
          return {
            headSha: remote,
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /Stable repair branch advanced/u);
          assert.equal(agents, 2);
          const response = responses.shift() ?? "q";
          if (response === "") remote = "b".repeat(40);
          return response;
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(agents, 2);
  assert.equal(remote, commit.sha);
  assert.deepEqual(responses, []);
});
