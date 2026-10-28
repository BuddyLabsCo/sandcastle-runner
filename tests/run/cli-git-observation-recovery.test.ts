import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { executeCli } from "../../src/cli.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const observation of ["implementation", "review"] as const) {
  test(`failed ${observation} Git observation retries only the read`, async () => {
    const root = await createProject();
    await writeProjectConfig(path.join(root, "demo/config.yaml"), {
      ...validConfig,
      workflow: {
        ...validConfig.workflow,
        review: observation !== "implementation",
      },
    });
    const delivery = createCommittedDelivery();
    let reads = 0;
    let implementations = 0;
    let reviews = 0;
    const responses = ['{"outcome":"passed"}', ""];
    const read = (phase: typeof observation) => {
      if (phase === observation && ++reads <= 5)
        throw new Error("Git observation unavailable");
    };
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        ...delivery,
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async inspect(input) {
            read("implementation");
            return delivery.gitWorkspace.inspect!(input);
          },
          async inspectReview() {
            read("review");
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
          async execute(input) {
            implementations += 1;
            return delivery.agentExecutor.execute!(input);
          },
          async executeReview() {
            reviews += 1;
            return {
              outcome: "passed",
            };
          },
        },
        operator: {
          async pause(message) {
            assert.match(message, /s to skip/u);
            assert.match(message, /Other input is unsupported/u);
            assert.equal(reads, 5);
            assert.equal(implementations, 1);
            assert.equal(reviews, observation === "review" ? 1 : 0);
            return responses.shift() ?? "q";
          },
        },
      }),
    );
    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(reads, 6);
    assert.equal(implementations, 1);
    assert.equal(reviews, observation === "implementation" ? 0 : 1);
    assert.deepEqual(responses, []);
  });
}
