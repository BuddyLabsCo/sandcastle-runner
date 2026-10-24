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
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  publicationIntent,
  validConfig,
  writeProjectConfig,
  writePublicationState,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const completed of [false, true]) {
  test(`recovered Maintenance PR evidence survives ${completed ? "completed closure" : "early cancellation"}`, async () => {
    const root = await createProject();
    await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
      ...validConfig,
      workflow: {
        ...validConfig.workflow,
        docMaintainTriggerLabel: "documentation",
      },
    });
    const intent = {
      ...publicationIntent("pr_created", 1000),
      kind: "maintenance" as const,
    };
    const snapshotPath = await writePublicationState(root, []);
    const snapshot = await readRecoverySnapshot(snapshotPath);
    assert.ok(snapshot);
    await writeRecoverySnapshot(snapshotPath, {
      ...snapshot,
      batch: [9],
      completedDeliveries: [{ ticket: 9, labels: ["documentation"] }],
      publications: [intent],
      maintenance: {
        phase: "attempting",
        ticket: 1000,
        deliveryTickets: [9],
        barrier: true,
      },
    });
    const delivery = {
      ...createCommittedBatch(9).tickets[0]!,
      state: "closed" as const,
      stateReason: "completed" as const,
      labels: ["documentation"],
    };
    const messages: string[] = [];
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          async getParent() {
            if (!completed) throw new Error("Parent read unavailable");
            return { number: 8, state: "open", stateReason: null };
          },
          async getTicket() {
            return { ...delivery, number: 1000 };
          },
          async listChildrenPage() {
            return { children: [delivery], nextPage: null };
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

    assert.equal(result.summary.outcome, completed ? "succeeded" : "cancelled");
    const report = result.summary.tickets?.find(
      ({ ticket }) => ticket === 1000,
    );
    assert.equal(report?.pullRequest, 4);
    assert.equal(report?.status, completed ? "completed" : "cancelled");
    assert.match(
      messages.at(-1)!,
      completed
        ? /^1000\s+completed\s+#4\s+Documentation:/mu
        : /^1000\s+cancelled\s+#4\s+Documentation:/mu,
    );
  });
}

for (const documentOnly of [false, true]) {
  test(`cancelling checks preserves the ${documentOnly ? "Maintenance" : "Delivery"} Ticket's PR number`, async () => {
    const root = await createProject();
    const delivery = createCommittedBatch(9);
    const messages: string[] = [];
    let checksRequested = false;
    let branch = "";
    const result = await executeCli(
      [
        "run",
        "--project",
        "demo",
        ...(documentOnly ? ["--document"] : ["--parent", "8"]),
      ],
      createCliDependencies(root, {
        ...delivery,
        tracker: {
          ...delivery.tracker,
          async createMaintenanceTicket() {
            return {
              ...delivery.tickets[0]!,
              number: 1000,
              labels: ["doc-maintain", "ready-for-agent"],
            };
          },
        },
        gitWorkspace: documentOnly
          ? {
              async fetchTargetBranch() {
                return "a".repeat(40);
              },
              async createWorktree(input) {
                branch = input.branch;
              },
              async inspect({ worktree, base }) {
                return {
                  worktree,
                  branch,
                  base,
                  commits: [
                    { sha: "0".repeat(40), message: "feat: ticket 1000" },
                  ],
                  clean: true,
                };
              },
            }
          : delivery.gitWorkspace,
        codeHost: {
          async getRequiredChecks() {
            checksRequested = true;
            throw new Error("checks unavailable");
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
    assert.equal(checksRequested, true);
    assert.equal(result.summary.tickets?.[0]?.status, "cancelled");
    assert.equal(result.summary.tickets?.[0]?.pullRequest, 1);
    assert.match(
      messages.at(-1)!,
      documentOnly
        ? /^1000\s+cancelled\s+#1\s+Documentation:/mu
        : /^9\s+cancelled\s+#1\s+/mu,
    );
  });
}

for (const outcome of ["cancelled", "failed"] as const) {
  test(`a ${outcome} peer preserves an already settled no-change outcome`, async () => {
    const root = await createProject();
    const delivery = createCommittedBatch(9, 10);
    let finishNoChange!: () => void;
    const noChangeFinished = new Promise<void>((resolve) => {
      finishNoChange = resolve;
    });
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        ...delivery,
        tracker: {
          ...delivery.tracker,
          async addComment() {
            finishNoChange();
          },
        },
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async inspect(input) {
            const evidence = await delivery.gitWorkspace.inspect(input);
            return { ...evidence, commits: [] };
          },
        },
        agentExecutor: {
          async execute(input) {
            if (input.ticket === 9) {
              return {
                outcome: "no_change",
                summary: "already implemented",
                commits: [],
                checks: [],
                blocker: null,
              };
            }
            await noChangeFinished;
            return {
              outcome: "blocked",
              summary: "needs operator input",
              commits: [],
              checks: [],
              blocker: "needs operator input",
            };
          },
        },
        operator: {
          async pause() {
            if (outcome === "failed")
              throw new Error("operator input unavailable");
            return "q";
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, outcome);
    assert.deepEqual(
      result.summary.tickets?.map(({ ticket, status }) => ({ ticket, status })),
      [
        { ticket: 9, status: "no_change" },
        { ticket: 10, status: outcome },
      ],
    );
    assert.match(result.summary.tickets[0]!.detail, /already implemented/u);
  });
}
