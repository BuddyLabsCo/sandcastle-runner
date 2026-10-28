import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { executeCli } from "../../src/cli.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const templates = path.join(repositoryRoot, "templates");
const assets = [
  "config.yaml",
  "prompts/documentation.md",
  "prompts/implement.md",
  "prompts/review.md",
];

async function launchDirectory(): Promise<string> {
  return registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "issue-runner-init-")),
  );
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(directory, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

function runInit(launch: string, key: string, messages: string[] = []) {
  return executeCli(
    ["init", "--project", key],
    createCliDependencies(launch, {
      env: {},
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          assert.fail("init must not pause");
        },
      },
    }),
  );
}

test("init copies the reviewed assets into the launch-directory child", async () => {
  const launch = await launchDirectory();
  const messages: string[] = [];
  const result = await runInit(launch, "demo", messages);

  assert.equal(result.exitCode, 0);
  const directory = path.join(launch, "demo");
  assert.deepEqual(await listFiles(directory), assets);
  for (const asset of assets) {
    assert.equal(
      await readFile(path.join(directory, asset), "utf8"),
      await readFile(path.join(templates, asset), "utf8"),
      asset,
    );
  }
  const config = parse(
    await readFile(path.join(directory, "config.yaml"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(config.repository, "your-account/your-repository");
  assert.equal(config.checkout, "/absolute/path/to/your-repository");
  assert.deepEqual(Object.keys(config.tracker as object).sort(), [
    "reservationLabel",
    "runnerAccount",
    "tokenEnv",
    "type",
  ]);

  const output = messages.join("\n");
  assert.match(output, new RegExp(`Initialized Project at ${directory}`));
  assert.match(output, /repository, checkout, targetBranch/);
  assert.match(
    output,
    /issue-runner run --project demo --parent <issue-number>/,
  );
  assert.doesNotMatch(
    output,
    /xiakeng|BuddyLabsCo|sandcastle-runner\/projects/u,
  );
});

test("init refuses every existing destination and preserves its content", async (t) => {
  const launch = await launchDirectory();
  const directory = path.join(launch, "demo");
  await mkdir(directory);
  await fs.writeFile(path.join(directory, "keep.txt"), "keep");

  const directoryMessages: string[] = [];
  const directoryResult = await runInit(launch, "demo", directoryMessages);
  assert.equal(directoryResult.exitCode, 1);
  assert.match(directoryMessages.join("\n"), /destination already exists/u);
  assert.match(directoryMessages.join("\n"), new RegExp(directory));
  assert.equal(
    await readFile(path.join(directory, "keep.txt"), "utf8"),
    "keep",
  );
  assert.deepEqual(await listFiles(directory), ["keep.txt"]);

  const file = path.join(launch, "file-project");
  await fs.writeFile(file, "keep");
  const fileMessages: string[] = [];
  assert.equal(
    (await runInit(launch, "file-project", fileMessages)).exitCode,
    1,
  );
  assert.match(fileMessages.join("\n"), /destination already exists/u);
  assert.equal(await readFile(file, "utf8"), "keep");

  const target = path.join(launch, "target");
  await mkdir(target);
  const link = path.join(launch, "link-project");
  try {
    await symlink(target, link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }
  const linkMessages: string[] = [];
  assert.equal(
    (await runInit(launch, "link-project", linkMessages)).exitCode,
    1,
  );
  assert.match(linkMessages.join("\n"), /destination already exists/u);
  assert.equal((await lstat(link)).isSymbolicLink(), true);

  const dangling = path.join(launch, "dangling-project");
  await symlink(path.join(launch, "missing-target"), dangling);
  const danglingMessages: string[] = [];
  assert.equal(
    (await runInit(launch, "dangling-project", danglingMessages)).exitCode,
    1,
  );
  assert.match(danglingMessages.join("\n"), /destination already exists/u);
  assert.equal((await lstat(dangling)).isSymbolicLink(), true);
});

test("init rejects invalid project keys before writing", async () => {
  const launch = await launchDirectory();
  for (const key of ["", ".", "..", "../demo", "a/b", "a\\b", "/absolute"]) {
    const messages: string[] = [];
    const result = await runInit(launch, key, messages);
    assert.equal(result.exitCode, 1, key);
    assert.notEqual(messages.join("\n").trim(), "", key);
  }
  assert.deepEqual(await readdir(launch), []);
});

test("a failed copy retains partial output and names the destination", async (t) => {
  const launch = await launchDirectory();
  const directory = path.join(launch, "demo");
  const original = fs.copyFile;
  let copies = 0;
  t.mock.method(
    fs,
    "copyFile",
    async (...args: Parameters<typeof fs.copyFile>) => {
      copies += 1;
      if (copies === 2) throw new Error("copy denied");
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const messages: string[] = [];
  const result = await runInit(launch, "demo", messages);
  assert.equal(result.exitCode, 1);
  const output = messages.join("\n");
  assert.match(output, new RegExp(`Initialization failed for ${directory}`));
  assert.match(output, /copy denied/u);
  assert.match(output, /partial output was retained for inspection/u);
  assert.doesNotMatch(output, /Initialized Project/u);
  assert.deepEqual(await listFiles(directory), ["config.yaml"]);
});

test("run selects only the launch-directory child and never falls back", async () => {
  const launch = await launchDirectory();
  const tempting = path.join(launch, "projects", "demo");
  await mkdir(path.join(tempting, "prompts"), { recursive: true });
  await fs.writeFile(
    path.join(tempting, "config.yaml"),
    "repository: owner/repo\n",
  );

  const messages: string[] = [];
  const missing = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(launch, {
      env: {},
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
  assert.equal(missing.exitCode, 1);
  assert.match(
    messages.join("\n"),
    new RegExp(`failed to load ${path.join(launch, "demo", "config.yaml")}`),
  );
  assert.deepEqual(await readdir(tempting), ["config.yaml", "prompts"]);
  assert.equal(
    await lstat(path.join(tempting, "state")).catch(() => null),
    null,
  );

  assert.equal((await runInit(launch, "demo")).exitCode, 0);
  const initializedMessages: string[] = [];
  const initialized = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(launch, {
      env: {},
      operator: {
        write(message) {
          initializedMessages.push(message);
        },
        async pause() {
          assert.fail("startup must not pause");
        },
      },
    }),
  );
  assert.equal(initialized.exitCode, 1);
  assert.match(initializedMessages.join("\n"), /missing credential GH_TOKEN/u);
});

test("run rejects a traversal key without reading another Project", async () => {
  const launch = await launchDirectory();
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "../demo", "--parent", "8"],
    createCliDependencies(launch, {
      env: {},
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
  assert.equal(result.exitCode, 1);
  assert.match(messages.join("\n"), /Invalid project key "\.\.\/demo"/u);
});
