import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("Recovery Snapshot creation failures return a readable startup error", async (t) => {
  const root = await createProject();
  t.mock.method(fs, "open", async () => {
    throw new Error("snapshot write denied");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const messages: string[] = [];
  let workflowCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          assert.fail("startup must not pause");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(result.exitCode, 1);
  assert.equal(result.logPath, null);
  assert.equal(workflowCalls, 0);
  assert.deepEqual(messages, ["Startup failed: snapshot write denied"]);
});
