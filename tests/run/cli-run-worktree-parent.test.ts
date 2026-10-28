import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { recoveryPaths } from "../../src/recovery.ts";
import {
  createAttemptTracker,
  createCliDependencies,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("a successful Run removes its empty Worktree parent and preserves sibling Run directories", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const worktrees = path.join(root, "demo", "worktrees");
  const historical = path.join(worktrees, "historical");
  const populated = path.join(worktrees, "historical-populated");
  await mkdir(historical, { recursive: true });
  await mkdir(populated, { recursive: true });
  await writeFile(path.join(populated, "keep.txt"), "keep");
  const commit = {
    sha: "b".repeat(40),
    message: "feat: implementation",
  };
  let current:
    { worktree: string; branch: string; repository: string } | undefined;
  let runParent = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          runParent = path.dirname(input.worktree);
          current = {
            worktree: input.worktree,
            branch: input.branch,
            repository: "/tmp/repo",
          };
          await mkdir(input.worktree, { recursive: true });
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch: current!.branch,
            base,
            commits: [commit],
            clean: true,
          };
        },
        async listWorktrees() {
          return current ? [current] : [];
        },
        async removeWorktree(_checkout, worktree) {
          assert.equal(worktree, current!.worktree);
          await rm(worktree, { recursive: true });
          current = undefined;
        },
        async deleteBranch() {},
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(current, undefined, JSON.stringify(result.summary));
  await assert.rejects(readdir(runParent), { code: "ENOENT" });
  assert.deepEqual((await readdir(worktrees)).sort(), [
    "historical",
    "historical-populated",
  ]);
  assert.deepEqual(await readdir(historical), []);
  assert.equal(
    await readFile(path.join(populated, "keep.txt"), "utf8"),
    "keep",
  );
});

test("a controlled failure removes an empty current Run parent", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const messages: string[] = [];
  let runParent = "";
  let pauses = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          runParent = path.dirname(input.worktree);
          await mkdir(runParent, { recursive: true });
          throw new Error("worktree creation failed");
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          pauses += 1;
          throw new Error("operator input unavailable");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(pauses, 1);
  await assert.rejects(readdir(runParent), { code: "ENOENT" });
  assert.equal(
    messages.some((message) => message.startsWith("Warning:")),
    false,
  );
});

test("a controlled cancellation removes an empty current Run parent after Worktree preparation", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  let runParent = "";
  let prepared = false;
  let agentCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async getParent() {
          return prepared
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          runParent = path.dirname(input.worktree);
          await mkdir(runParent, { recursive: true });
          prepared = true;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          throw new Error("must not start");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(agentCalls, 0);
  await assert.rejects(readdir(runParent), { code: "ENOENT" });
});

test("a missing current Run parent is cleaned without a warning", async () => {
  const root = await createProject();
  const messages: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      operator: {
        write(message) {
          messages.push(message);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(
    messages.some((message) => message.startsWith("Warning:")),
    false,
  );
});

test("a non-empty current Run parent is preserved with every entry and no warning", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const messages: string[] = [];
  let runParent = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "a".repeat(40);
        },
        async createWorktree(input) {
          runParent = path.dirname(input.worktree);
          await mkdir(path.join(runParent, "nested"), { recursive: true });
          await writeFile(path.join(runParent, ".hidden"), "hidden");
          await writeFile(path.join(runParent, "keep.txt"), "keep");
          await writeFile(path.join(runParent, "nested", "child.txt"), "child");
          throw new Error("worktree creation failed");
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          throw new Error("operator input unavailable");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.deepEqual((await readdir(runParent)).sort(), [
    ".hidden",
    "keep.txt",
    "nested",
  ]);
  assert.equal(
    await readFile(path.join(runParent, ".hidden"), "utf8"),
    "hidden",
  );
  assert.equal(
    await readFile(path.join(runParent, "keep.txt"), "utf8"),
    "keep",
  );
  assert.equal(
    await readFile(path.join(runParent, "nested", "child.txt"), "utf8"),
    "child",
  );
  assert.equal(
    messages.some((message) => message.startsWith("Warning:")),
    false,
  );
});

test("an unexpected current Run parent removal error warns without changing the result", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const messages: string[] = [];
  let runParent = "";
  let pauses = 0;
  let locked: ReturnType<typeof spawn> | undefined;
  let restorePermissions = false;

  try {
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "a".repeat(40);
          },
          async createWorktree(input) {
            runParent = path.dirname(input.worktree);
            await mkdir(runParent, { recursive: true });
            if (process.platform === "win32") {
              locked = spawn(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000)"],
                { cwd: runParent, stdio: "ignore" },
              );
              await once(locked, "spawn");
            } else {
              await chmod(path.dirname(runParent), 0o500);
              restorePermissions = true;
            }
            throw new Error("worktree creation failed");
          },
        },
        operator: {
          write(message) {
            messages.push(message);
          },
          async pause() {
            pauses += 1;
            throw new Error("operator input unavailable");
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "failed");
    assert.equal(pauses, 1);
    assert.ok((await readdir(runParent)).length === 0);
    const warning = messages.find((message) => message.startsWith("Warning:"));
    assert.ok(warning);
    assert.match(warning, /could not remove empty Run Worktree directory/u);
    assert.ok(warning.includes(runParent));
    assert.match(warning, /EBUSY|EACCES|EPERM/u);
  } finally {
    if (restorePermissions) await chmod(path.dirname(runParent), 0o700);
    if (locked?.exitCode === null) {
      locked.kill();
      await once(locked, "exit");
    }
  }
});

test("a final Recovery Snapshot exception still removes an empty current Run parent", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const project = path.join(root, "demo");
  const snapshot = recoveryPaths(project, 8).snapshot;
  let runParent = "";

  await assert.rejects(
    executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "a".repeat(40);
          },
          async createWorktree(input) {
            runParent = path.dirname(input.worktree);
            await mkdir(runParent, { recursive: true });
            await rm(snapshot);
            await mkdir(snapshot);
            throw new Error("worktree creation failed");
          },
        },
        operator: {
          async pause() {
            throw new Error("operator input unavailable");
          },
        },
      }),
    ),
    /EISDIR|EPERM|EEXIST|ENOTDIR|EACCES/u,
  );

  await assert.rejects(readdir(runParent), { code: "ENOENT" });
});

test("a final report exception still removes an empty current Run parent", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  let runParent = "";

  await assert.rejects(
    executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker,
        gitWorkspace: {
          async fetchTargetBranch() {
            return "a".repeat(40);
          },
          async createWorktree(input) {
            runParent = path.dirname(input.worktree);
            await mkdir(runParent, { recursive: true });
            throw new Error("worktree creation failed");
          },
        },
        operator: {
          write(message) {
            if (/^Issue\s+Status\s+PR\s+Detail$/mu.test(message))
              throw new Error("final report unavailable");
          },
          async pause() {
            throw new Error("operator input unavailable");
          },
        },
      }),
    ),
    /final report unavailable/u,
  );

  await assert.rejects(readdir(runParent), { code: "ENOENT" });
});
