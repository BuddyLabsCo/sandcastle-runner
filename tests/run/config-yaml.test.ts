import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProject } from "../../src/config.ts";
import { validConfig } from "../support/cli-project.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("loadProject reads commented YAML configuration", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-runner-yaml-")),
  );
  const project = path.join(root, "projects", "demo");
  await mkdir(path.join(project, "prompts"), { recursive: true });
  await Promise.all(
    ["implement", "ci-repair", "conflict-repair", "documentation"].map((name) =>
      writeFile(path.join(project, "prompts", `${name}.md`), `${name} prompt`),
    ),
  );
  await writeFile(
    path.join(project, "config.yaml"),
    `# Project configuration uses YAML comments.
repository: owner/repo
checkout: /tmp/repo # Absolute checkout path.
issueList: [3, 1]
maxBatchSize: 2
targetBranch: main
tracker:
  type: github
  tokenEnv: TEST_GH_TOKEN
  runnerAccount: runner
  reservationLabel: sandcastle:reserved
codeHost:
  type: github
  tokenEnv: TEST_GH_TOKEN
  adminMerge: false
workflow:
  # Review is disabled for this fixture.
  review: false
  docMaintainTriggerLabel: documentation
agents:
  implement:
    model: gpt-5.6-sol
    reasoningEffort: high
  review:
    model: gpt-5.6-sol
    reasoningEffort: high
  ciRepair:
    model: gpt-5.6-sol
    reasoningEffort: high
  conflictRepair:
    model: gpt-5.6-sol
    reasoningEffort: high
  documentation:
    model: gpt-5.6-sol
    reasoningEffort: high
timeouts:
  agentMinutes: 120
  requiredChecksMinutes: 60
  mergeQueueMinutes: 60
operationRetry: 4
agentRetry: 4
operationRetryDelay: [10, 20, 40, 80]
agentRetryDelay: [10, 20, 40, 80]
ticketClosure: runner
maintenanceTicket:
  title: Maintain project documentation
  body: Run the documentation prompt.
  label: doc-maintain
`,
  );

  const loaded = await loadProject(root, "demo", { TEST_GH_TOKEN: "token" });

  assert.deepEqual(loaded.config, {
    ...validConfig,
    issueList: [1, 3],
    maxBatchSize: 2,
    workflow: {
      review: false,
      docMaintainTriggerLabel: "documentation",
    },
    maintenanceTicket: {
      title: "Maintain project documentation",
      body: "Run the documentation prompt.",
      label: "doc-maintain",
    },
  });
});

test("loadProject reports a missing config.yaml with its path", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-runner-yaml-")),
  );
  await mkdir(path.join(root, "projects", "demo"), { recursive: true });

  await assert.rejects(
    loadProject(root, "demo", { TEST_GH_TOKEN: "token" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith(
        `failed to load ${path.join(root, "projects", "demo", "config.yaml")}:`,
      ),
  );
});

test("loadProject reports invalid YAML with its path", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-runner-yaml-")),
  );
  const project = path.join(root, "projects", "demo");
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, "config.yaml"),
    "repository: [unterminated",
  );

  await assert.rejects(
    loadProject(root, "demo", { TEST_GH_TOKEN: "token" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith(
        `failed to load ${path.join(project, "config.yaml")}:`,
      ),
  );
});
