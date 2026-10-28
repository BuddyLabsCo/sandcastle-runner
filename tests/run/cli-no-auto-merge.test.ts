import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  readRecoverySnapshot,
  writeRecoverySnapshot,
} from "../../src/recovery.ts";
import {
  createCliDependencies,
  createAttemptTracker,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  publicationIntent,
  recoverySnapshot,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const kind of ["delivery", "maintenance"] as const) {
  test(`a recovered no-auto-merge ${kind} run stops before merge and retains its Worktree`, async () => {
    const root = await createProject();
    const ticket = kind === "delivery" ? 9 : 100;
    const intent = { ...publicationIntent("pr_created", ticket), kind };
    const evidence = intent.completionEvidence;
    assert.ok(
      evidence && typeof evidence === "object" && "worktree" in evidence,
    );
    const snapshot = await recoverySnapshot(root, 9, intent);
    if (kind === "maintenance") {
      await writeProjectConfig(path.join(root, "demo/config.yaml"), {
        ...validConfig,
        workflow: {
          ...validConfig.workflow,
          docMaintainTriggerLabel: "documentation",
        },
      });
      await writeRecoverySnapshot(snapshot, {
        ...(await readRecoverySnapshot(snapshot))!,
        batch: [9],
        completedDeliveries: [{ ticket: 9, labels: ["documentation"] }],
        maintenance: {
          phase: "attempting",
          ticket,
          deliveryTickets: [9],
          barrier: true,
        },
      });
    }
    const { tracker, tickets } = createAttemptTracker(ticket);
    tickets[0]!.labels =
      kind === "delivery"
        ? ["ready-for-agent", "sandcastle:reserved"]
        : ["doc-maintain"];
    tickets[0]!.assignees = kind === "delivery" ? ["runner"] : [];
    let mergeRequests = 0;
    const result = await executeCli(
      ["run", "--issue", "9", "--project", "demo", "--no-auto-merge"],
      createCliDependencies(root, {
        tracker,
        codeHost: {
          async getRemoteBranchHead() {
            return intent.intendedHeadSha;
          },
          async getPullRequest() {
            return {
              headSha: intent.intendedHeadSha,
              createdAt: "2026-09-08T00:00:00.000Z",
              merged: false,
              mergeFailure: null,
            };
          },
          async requestSquashMerge() {
            mergeRequests += 1;
            return {
              outcome: "rejected",
              error: "merge must not be requested",
            };
          },
          async createPullRequest() {
            throw new Error("must not recreate the Pull Request");
          },
        },
        agentExecutor: {
          async execute() {
            throw new Error("must not rerun implementation");
          },
        },
      }),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.outcome, "succeeded");
    if (kind === "delivery")
      assert.deepEqual(result.summary.completedTickets ?? [], []);
    assert.equal(mergeRequests, 0);
    const recovered = await readRecoverySnapshot(snapshot);
    assert.equal(recovered?.phase, "running");
    assert.equal(tickets[0]!.state, "open");
    assert.deepEqual(
      result.summary.tickets?.find((row) => row.ticket === ticket)
        ?.retainedWorktrees,
      [evidence.worktree],
    );
    if (kind === "delivery")
      assert.deepEqual(recovered?.completedDeliveries ?? [], []);
    else assert.equal(recovered?.maintenance?.barrier, true);
    assert.deepEqual(
      recovered?.publications?.map(({ ticket, phase }) => ({ ticket, phase })),
      [{ ticket, phase: "pr_created" }],
    );
  });
}

test("a recovered standalone run with auto-merge continues through merge", async () => {
  const root = await createProject();
  const intent = publicationIntent("pr_created", 9);
  await recoverySnapshot(root, 9, intent);
  const { tracker, tickets } = createAttemptTracker(9);
  tickets[0]!.labels = ["ready-for-agent", "sandcastle:reserved"];
  tickets[0]!.assignees = ["runner"];
  let mergeRequests = 0;
  let merged = false;
  const result = await executeCli(
    ["run", "--issue", "9", "--project", "demo", "--auto-merge"],
    createCliDependencies(root, {
      tracker,
      codeHost: {
        async getRemoteBranchHead() {
          return intent.intendedHeadSha;
        },
        async getPullRequest() {
          return {
            headSha: intent.intendedHeadSha,
            createdAt: "2026-09-08T00:00:00.000Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          merged = true;
          return { outcome: "accepted" };
        },
        async createPullRequest() {
          throw new Error("must not recreate the Pull Request");
        },
      },
      agentExecutor: {
        async execute() {
          throw new Error("must not rerun implementation");
        },
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(mergeRequests, 1);
  assert.equal(tickets[0]?.state, "closed");
});

test("no-auto-merge keeps Operator Pause behavior when CI repair fails", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const pauses: string[] = [];
  let branch = "";
  let agentCalls = 0;
  let mergeRequests = 0;
  const result = await executeCli(
    ["run", "--issue", "9", "--project", "demo", "--no-auto-merge"],
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
          return {
            worktree,
            branch,
            base,
            commits:
              agentCalls === 1
                ? [
                    {
                      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                      message: "feat: implementation",
                    },
                  ]
                : [],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          if (agentCalls === 2) {
            return {
              outcome: "blocked",
              summary: "CI repair is blocked",
              commits: [],
              checks: [],
              blocker: "CI repair is blocked",
              pr_title: "unused",
              pr_body: "unused",
            };
          }
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
      codeHost: {
        async getRequiredChecks() {
          return [
            {
              name: "checks",
              state: "FAILURE",
              link: "https://github.com/owner/repo/actions/runs/1",
              bucket: "fail",
            },
          ];
        },
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            createdAt: "2026-09-08T00:00:00.000Z",
            merged: false,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "rejected", error: "merge must not be requested" };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.match(pauses[0] ?? "", /^Outcome: blocked$/mu);
  assert.equal(agentCalls, 2);
  assert.equal(mergeRequests, 0);
});
