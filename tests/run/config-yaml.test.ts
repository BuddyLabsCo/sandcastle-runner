import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProject } from "../../src/config.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("loadProject reads commented YAML configuration", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-runner-yaml-")),
  );
  const project = path.join(root, "demo");
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
  tokenEnv: TEST_GH_TOKEN
  runnerAccount: runner
  reservationLabel: sandcastle:reserved
codeHost:
  tokenEnv: TEST_GH_TOKEN
  adminMerge: false
workflow:
  # Review is disabled for this fixture.
  review: false
  docMaintainTriggerLabel: documentation
agents:
  implement:
    agent: codex
    model: gpt-5.6-sol
    options:
      effort: high
  review:
    agent: codex
    model: gpt-5.6-sol
    options:
      effort: high
  ciRepair:
    agent: codex
    model: gpt-5.6-sol
    options:
      effort: high
  conflictRepair:
    agent: codex
    model: gpt-5.6-sol
    options:
      effort: high
  documentation:
    agent: codex
    model: gpt-5.6-sol
    options:
      effort: high
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
    timeouts: { ...validConfig.timeouts, agentIdleMinutes: 10 },
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

test("agent idle threshold defaults to ten minutes and rejects invalid values", async () => {
  const root = await createProject();
  const configPath = path.join(root, "demo/config.yaml");
  const load = () => loadProject(root, "demo", { TEST_GH_TOKEN: "token" });
  assert.equal((await load()).config.timeouts.agentIdleMinutes, 10);
  for (const value of [0, -1, NaN, Infinity, "2", null, true]) {
    await writeProjectConfig(configPath, {
      ...validConfig,
      timeouts: { ...validConfig.timeouts, agentIdleMinutes: value },
    });
    await assert.rejects(load(), /timeouts.agentIdleMinutes.*positive number/u);
  }
  await writeProjectConfig(configPath, {
    ...validConfig,
    timeouts: { ...validConfig.timeouts, agentIdleMinutes: 0.5 },
  });
  const loaded = await load();
  assert.equal(loaded.config.timeouts.agentIdleMinutes, 0.5);
  assert.equal(loaded.config.timeouts.agentMinutes, 120);
});

test("loadProject reports a missing config.yaml with its path", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-runner-yaml-")),
  );
  await mkdir(path.join(root, "demo"), { recursive: true });

  await assert.rejects(
    loadProject(root, "demo", { TEST_GH_TOKEN: "token" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith(
        `failed to load ${path.join(root, "demo", "config.yaml")}:`,
      ),
  );
});

test("loadProject reports invalid YAML with its path", async () => {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-runner-yaml-")),
  );
  const project = path.join(root, "demo");
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

test("agent profiles require agent and model and preserve native options", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.agents.implement = {
    agent: "claude-code",
    model: "claude-opus-4-8",
    options: {
      effort: "max",
      sessionStorage: { hostProjectsDir: "/explicit/projects" },
    },
  } as (typeof config.agents)["implement"];
  await writeProjectConfig(path.join(root, "demo/config.yaml"), config);

  const loaded = await loadProject(root, "demo", { TEST_GH_TOKEN: "token" });

  assert.deepEqual(loaded.config.agents.implement, {
    agent: "claude-code",
    model: "claude-opus-4-8",
    options: {
      effort: "max",
      sessionStorage: { hostProjectsDir: "/explicit/projects" },
    },
  });
});

test("agent profiles reject missing selectors and malformed options", async () => {
  for (const profile of [
    { model: "gpt-5.6-sol" },
    { agent: "codex", model: "gpt-5.6-sol", options: "high" },
    { agent: "codex", options: { effort: "high" } },
  ]) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    (config.agents as Record<string, unknown>).implement = profile;
    await writeProjectConfig(path.join(root, "demo/config.yaml"), config);
    await assert.rejects(
      loadProject(root, "demo", { TEST_GH_TOKEN: "token" }),
      /agents\.implement\.(agent|model|options)/u,
    );
  }
});

test("obsolete reasoningEffort requires migration, even beside new fields", async () => {
  for (const profile of [
    { model: "gpt-5.6-sol", reasoningEffort: "max" },
    {
      agent: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      options: { effort: "max" },
    },
  ]) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    (config.agents as Record<string, unknown>).implement = profile;
    await writeProjectConfig(path.join(root, "demo/config.yaml"), config);
    await assert.rejects(
      loadProject(root, "demo", { TEST_GH_TOKEN: "token" }),
      /reasoningEffort is no longer supported.*options\.effort/u,
    );
  }
});

test("review rounds accept only an optional positive integer without a default cap", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  const configPath = path.join(root, "demo/config.yaml");
  const load = () => loadProject(root, "demo", { TEST_GH_TOKEN: "token" });
  assert.equal((await load()).config.workflow.maxReviewRounds, undefined);
  for (const value of [0, -1, 1.5, "2", null, true]) {
    await writeProjectConfig(configPath, {
      ...config,
      workflow: { ...config.workflow, maxReviewRounds: value },
    });
    await assert.rejects(load(), /workflow.maxReviewRounds.*positive integer/u);
  }
  for (const value of [1, 2]) {
    await writeProjectConfig(configPath, {
      ...config,
      workflow: { ...config.workflow, maxReviewRounds: value },
    });
    assert.equal((await load()).config.workflow.maxReviewRounds, value);
  }
});
