import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import { readRecoverySnapshot, recoveryPaths } from "../../src/recovery.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
  createCommittedBatch,
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

for (const phase of [
  "reservation",
  "parent_read",
  "push",
  "create_pr",
  "checks",
  "integration_read",
  "merge",
  "closure",
  "cleanup",
  "release",
] as const) {
  test(`non-Agent ${phase} skip preserves side effects and lets the other issue complete`, async () => {
    const root = await createProject();
    const delivery = createCommittedBatch(9, 10);
    const merged = new Set<number>();
    const workspaces = new Map<
      string,
      { worktree: string; branch: string; repository: string }
    >();
    const pauses: string[] = [];
    let reservationStarted = false;
    let skipped = false;
    const fail = (point: typeof phase, ticket: number) => {
      if (point === phase && ticket === 9 && !skipped)
        throw new Error(`injected ${phase}`);
    };
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          ...delivery.tracker,
          async getParent() {
            if (reservationStarted) fail("parent_read", 9);
            return { number: 8, state: "open", stateReason: null };
          },
          async addLabel(repository, ticket, label) {
            fail("reservation", ticket);
            await delivery.tracker.addLabel!(repository, ticket, label);
            if (ticket === 9) reservationStarted = true;
          },
          async closeTicket(repository, ticket) {
            fail("closure", ticket);
            await delivery.tracker.closeTicket!(repository, ticket);
          },
          async removeAssignee(repository, ticket, assignee) {
            if (merged.has(ticket)) fail("release", ticket);
            await delivery.tracker.removeAssignee!(
              repository,
              ticket,
              assignee,
            );
          },
        },
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async createWorktree(input) {
            await delivery.gitWorkspace.createWorktree(input);
            workspaces.set(input.worktree, {
              ...input,
              repository: "/tmp/repo",
            });
          },
          async push(_worktree, branch) {
            fail("push", Number(branch.split("-").at(-1)));
          },
          async listWorktrees() {
            return [...workspaces.values()];
          },
          async removeWorktree(_checkout, worktree) {
            fail("cleanup", Number(worktree.split("-").at(-1)));
            workspaces.delete(worktree);
          },
          async deleteBranch() {},
        },
        agentExecutor: delivery.agentExecutor,
        codeHost: {
          async createPullRequest(input) {
            const ticket = Number(input.branch.split("-").at(-1));
            fail("create_pr", ticket);
            return {
              number: ticket,
              url: `https://example.test/pull/${ticket}`,
            };
          },
          async getRequiredChecks(_repository, ticket) {
            fail("checks", ticket);
            return [];
          },
          async getPullRequest(_repository, ticket) {
            fail("integration_read", ticket);
            return {
              headSha: String(ticket).at(-1)!.repeat(40),
              createdAt: String(ticket),
              merged: merged.has(ticket),
              mergeFailure: null,
            };
          },
          async requestSquashMerge(input) {
            fail("merge", input.pullRequest);
            merged.add(input.pullRequest);
            return { outcome: "accepted" };
          },
        },
        operator: {
          async pause(message) {
            pauses.push(message);
            assert.match(message, /s to skip/u);
            if (pauses.length === 1) return '{"outcome":"succeeded"}';
            skipped = true;
            return "s";
          },
        },
      }),
    );
    assert.equal(result.summary.outcome, "incomplete");
    assert.equal(pauses.length, 2);
    assert.ok(result.summary.completedTickets?.includes(10));
    const afterDelivery = phase === "cleanup" || phase === "release";
    assert.equal(result.summary.completedTickets?.includes(9), afterDelivery);
    assert.equal(
      result.summary.tickets?.find((row) => row.ticket === 9)?.status,
      afterDelivery ? "completed" : "failed",
    );
    if (phase === "closure" || afterDelivery) assert.ok(merged.has(9));
    if (afterDelivery) {
      const snapshot = await readRecoverySnapshot(
        recoveryPaths(path.join(root, "projects/demo"), 8).snapshot,
      );
      assert.equal(snapshot?.terminalCleanup?.[9]?.status, "pending");
      assert.ok(snapshot?.completedDeliveries?.some((row) => row.ticket === 9));
    }
  });
}

test("a second skip can abandon failed pre-publication Reservation release", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10);
  let pauses = 0;
  let releases = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async removeAssignee(repository, ticket, assignee) {
          if (ticket === 9) {
            releases += 1;
            throw new Error("release unavailable");
          }
          await delivery.tracker.removeAssignee!(repository, ticket, assignee);
        },
      },
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async push(_worktree, branch) {
          if (branch.endsWith("ticket-9")) throw new Error("push failed");
        },
      },
      agentExecutor: delivery.agentExecutor,
      operator: {
        async pause(message) {
          pauses += 1;
          assert.match(message, /s to skip/u);
          return "s";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(result.summary.completedTickets, [10]);
  assert.equal(pauses, 2);
  assert.equal(releases, 5);
  assert.match(
    result.summary.reasons.join("\n"),
    /possible Reservation residue/u,
  );
});

test("recovery retains skipped issue residue when a later issue stops at its boundary", async () => {
  const root = await createProject();
  await writePublicationState(root, [
    publicationIntent("pending_pr", 9),
    publicationIntent("pending_pr", 10),
  ]);
  const delivery = createCommittedBatch(9, 10);
  delivery.tickets[0]!.assignees = ["runner"];
  delivery.tickets[0]!.labels.push("sandcastle:reserved");
  delivery.tickets[1]!.assignees = ["other"];
  let pauses = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async removeAssignee() {
          throw new Error("release unavailable");
        },
      },
      codeHost: {
        async getRemoteBranchHead() {
          return "f".repeat(40);
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /s to skip/u);
          pauses += 1;
          return "s";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(pauses, 2);
  assert.equal(
    result.summary.tickets?.find((row) => row.ticket === 9)?.status,
    "failed",
  );
  assert.match(
    result.summary.reasons.join("\n"),
    /possible Reservation residue/u,
  );
  assert.match(result.summary.reasons.join("\n"), /became externally owned/u);
});

test("Worktree creation retries its original command after operator repair", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let repaired = false;
  let creates = 0;
  let remoteReads = 0;
  const responses = ["accept existing Worktree", ""];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async createWorktree(input) {
          creates += 1;
          if (!repaired) throw new Error("partial Worktree already exists");
          await delivery.gitWorkspace.createWorktree!(input);
        },
      },
      codeHost: {
        async getRemoteBranchHead() {
          remoteReads += 1;
          throw new Error("no pre-retry query expected");
        },
      },
      operator: {
        async pause() {
          assert.equal(creates, 1);
          const response = responses.shift() ?? "q";
          if (response === "") repaired = true;
          return response;
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(creates, 2);
  assert.equal(remoteReads, 0);
});

for (const phase of ["fetch", "close_parent"] as const) {
  test(`shared ${phase} rejects skip and retries only on Enter`, async () => {
    const root = await createProject();
    const delivery = createCommittedDelivery();
    let calls = 0;
    let pauses = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        ...delivery,
        tracker: {
          ...delivery.tracker,
          async closeParent() {
            if (phase === "close_parent" && ++calls <= 5)
              throw new Error("closure unavailable");
          },
        },
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async fetchTargetBranch() {
            if (phase === "fetch" && ++calls <= 5)
              throw new Error("fetch unavailable");
            return "a".repeat(40);
          },
        },
        operator: {
          async pause(message) {
            pauses += 1;
            assert.doesNotMatch(message, /s to skip/u);
            assert.equal(calls, 5);
            return pauses === 1 ? "s" : "";
          },
        },
      }),
    );
    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(calls, 6);
    assert.equal(pauses, 2);
  });
}

test("skipping automatic maintenance preparation keeps Parent closeout incomplete", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    workflow: {
      ...validConfig.workflow,
      docMaintainTriggerLabel: "documentation",
    },
  });
  const delivery = createCommittedDelivery();
  delivery.tickets[0]!.labels.push("documentation");
  let parentCloses = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async createMaintenanceTicket() {
          throw new Error("maintenance issue response lost");
        },
        async closeParent() {
          parentCloses += 1;
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
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(parentCloses, 0);
});
