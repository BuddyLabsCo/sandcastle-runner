import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A sandbox-wide allow-scripts setting would block npm pack here; it is not
  // part of the package.
  delete env.npm_config_allow_scripts;
  return env;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
    timeout: 240_000,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}: ${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

test("the packed artifact accepts the reviewed runtime and executable shim", async () => {
  const destination = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "issue-runner-package-")),
  );
  const env = environment();
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", destination], env),
  ) as { filename: string; files: { path: string }[] }[];
  const filename = packed[0]?.filename;
  assert.ok(filename);
  const tarball = path.join(destination, filename);
  const files = (packed[0]?.files ?? []).map((entry) => entry.path);
  for (const file of files) {
    assert.ok(
      file === "package.json" ||
        file === "README.md" ||
        file === "LICENSE" ||
        file.startsWith("dist/") ||
        file.startsWith("templates/"),
      file,
    );
  }
  assert.ok(!files.some((file) => file.endsWith(".ts")), "no TypeScript");
  assert.ok(files.includes("dist/cli.js"), "compiled entry point");
  assert.ok(files.includes("templates/prompts/implement.md"));

  const accepted = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "package-acceptance.ts")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...env, RELEASE_TARBALL: tarball },
      timeout: 240_000,
    },
  );
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, /Accepted issue-runner@0\.1\.0/u);
  assert.deepEqual(await readdir(destination), [filename]);
});
