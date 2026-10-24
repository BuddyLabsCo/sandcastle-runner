import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadProject } from "../../src/config.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

for (const disableWebSearch of [true, false, undefined]) {
  test(`loadProject resolves disableWebSearch=${disableWebSearch}`, async () => {
    const root = await createProject();
    await writeProjectConfig(
      path.join(root, "projects", "demo", "config.yaml"),
      { ...validConfig, disableWebSearch },
    );

    const loaded = await loadProject(root, "demo", { TEST_GH_TOKEN: "token" });

    assert.equal(loaded.config.disableWebSearch, disableWebSearch ?? false);
  });
}

test("loadProject rejects non-boolean disableWebSearch values including null", async () => {
  const root = await createProject();
  for (const disableWebSearch of [null, "true", "false", 0, 1, {}, []]) {
    await writeProjectConfig(
      path.join(root, "projects", "demo", "config.yaml"),
      { ...validConfig, disableWebSearch },
    );

    await assert.rejects(
      loadProject(root, "demo", { TEST_GH_TOKEN: "token" }),
      /disableWebSearch/u,
      `invalid disableWebSearch=${JSON.stringify(disableWebSearch)}`,
    );
  }
});
