import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createCliDependencies,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const review of [false, true]) {
  for (const change of [
    "parent cancellation",
    "scope removal",
    "ticket closure",
  ] as const) {
    test(`a blocked ${review ? "review" : "implementation"} observes ${change} without a recovery prompt`, async () => {
      const root = await createProject();
      await writeProjectConfig(path.join(root, "demo/config.yaml"), {
        ...validConfig,
        workflow: { ...validConfig.workflow, review },
      });
      const delivery = createCommittedBatch(9);
      let changed = false;
      let pauses = 0;
      let cancellationReads = 0;
      const stop = () => {
        changed = true;
        if (change === "ticket closure") {
          delivery.tickets[0]!.state = "closed";
          delivery.tickets[0]!.stateReason = "not_planned";
        }
      };
      const result = await executeCli(
        ["run", "--project", "demo", "--parent", "8"],
        createCliDependencies(root, {
          tracker: {
            ...delivery.tracker,
            async getParent() {
              if (changed && change === "parent cancellation") {
                cancellationReads += 1;
                if (cancellationReads === 1)
                  throw new Error("transient observation failure");
                return {
                  number: 8,
                  state: "closed",
                  stateReason: "not_planned",
                };
              }
              return { number: 8, state: "open", stateReason: null };
            },
            async listChildrenPage() {
              return {
                children:
                  changed && change === "scope removal" ? [] : delivery.tickets,
                nextPage: null,
              };
            },
          },
          gitWorkspace: delivery.gitWorkspace,
          agentExecutor: {
            async execute(input) {
              if (review) return delivery.agentExecutor.execute(input);
              stop();
              return {
                outcome: "blocked",
                summary: "needs help",
                commits: [],
                checks: [],
                blocker: "needs help",
              };
            },
            async executeReview() {
              stop();
              return { outcome: "blocked", blocker: "needs review context" };
            },
          },
          operator: {
            async pause() {
              pauses += 1;
              return "q";
            },
          },
        }),
      );
      assert.equal(
        result.summary.outcome,
        change === "parent cancellation" ? "cancelled" : "incomplete",
      );
      assert.equal(pauses, 0);
      assert.equal(result.summary.handoffs?.length ?? 0, 0);
      if (change === "parent cancellation") assert.equal(cancellationReads, 2);
      if (change === "ticket closure") {
        assert.ok(!delivery.tickets[0]!.labels.includes("sandcastle:reserved"));
        assert.ok(!delivery.tickets[0]!.assignees.includes("runner"));
      }
    });
  }
}
