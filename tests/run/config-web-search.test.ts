import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadProject } from "../../src/config.ts";
import { createProject, validConfig } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const disableWebSearch of [true, false, undefined]) {
  test(`loadProject resolves disableWebSearch=${disableWebSearch}`, async () => {
    const root = await createProject();
    await writeFile(
      path.join(root, "projects", "demo", "config.json"),
      JSON.stringify({ ...validConfig, disableWebSearch }),
    );

    const loaded = await loadProject(root, "demo", { TEST_GH_TOKEN: "token" });

    assert.equal(loaded.config.disableWebSearch, disableWebSearch ?? false);
  });
}

test("loadProject rejects non-boolean disableWebSearch values including null", async () => {
  const root = await createProject();
  for (const disableWebSearch of [null, "true", "false", 0, 1, {}, []]) {
    await writeFile(
      path.join(root, "projects", "demo", "config.json"),
      JSON.stringify({ ...validConfig, disableWebSearch }),
    );

    await assert.rejects(
      loadProject(root, "demo", { TEST_GH_TOKEN: "token" }),
      /disableWebSearch/u,
      `invalid disableWebSearch=${JSON.stringify(disableWebSearch)}`,
    );
  }
});
