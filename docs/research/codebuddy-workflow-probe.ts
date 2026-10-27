import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { run } from "@ai-hero/sandcastle";

import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  ProcessCleanupError,
  type SandcastleRun,
} from "../../src/adapters/process-settlement.ts";
import type { AgentAttemptInput } from "../../src/run/contracts.ts";

const exec = promisify(execFile);
const root = await mkdtemp(
  join(resolve("node_modules"), ".codebuddy-workflow-"),
);
const repository = join(root, "repository");
const worktree = join(root, "worktree");
const gitConfig = join(root, "gitconfig");
const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
process.env.GIT_CONFIG_GLOBAL = gitConfig;
const git = new LocalGitWorkspace("");
const command = async (...args: string[]) =>
  (await exec("git", ["-C", worktree, ...args])).stdout.trim();
const evidence: Record<string, unknown>[] = [];
const sessions = new Map<string, string>();
const model = "deepseek-v4.1-flash";
let injectTransportFailure = false;
let safeToRemove = true;
const executor = new SandcastleAgentExecutor(async (options) => {
  const start = performance.now();
  const result = await (run as SandcastleRun)(options);
  const key = options.name!;
  const id = result.iterations.at(-1)?.sessionId;
  assert.ok(id);
  const previous = sessions.get(key);
  if (previous) assert.equal(id, previous);
  sessions.set(key, id);
  evidence.push({
    phase: key,
    probe: options.prompt === "Reply with exactly: SESSION_READY",
    elapsedMs: Math.round(performance.now() - start),
    sameSession: previous === undefined ? null : id === previous,
  });
  if (
    injectTransportFailure &&
    options.prompt !== "Reply with exactly: SESSION_READY"
  ) {
    injectTransportFailure = false;
    throw new Error("controlled transport loss after live native output");
  }
  return result;
});
try {
  await mkdir(repository);
  await writeFile(
    gitConfig,
    "[user]\n name = Runner Probe\n email = probe@example.test\n",
  );
  await exec("git", ["init", "-q", repository]);
  await exec("git", [
    "-C",
    repository,
    "commit",
    "--allow-empty",
    "-qm",
    "fixture base",
  ]);
  await exec("git", [
    "-C",
    repository,
    "worktree",
    "add",
    "-b",
    "workflow",
    worktree,
  ]);
  await writeFile(
    join(worktree, "CODEBUDDY.md"),
    "This is a disposable local fixture; never access remote services. All implementation commit subjects MUST start with feat:. Read this file before work.\n",
  );
  await command("add", "CODEBUDDY.md");
  await command("commit", "-qm", "fixture instructions");
  const base = await command("rev-parse", "HEAD");
  const common: AgentAttemptInput = {
    ticket: 264,
    runName: "implementation",
    worktree,
    branch: "workflow",
    base,
    targetBranch: "main",
    promptArgs: {},
    pullRequestMetadata: "ignored",
    agent: "codebuddy",
    model,
    options: {
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Write", "Edit", "Bash"],
      maxTurns: 20,
      env: { CODEBUDDY_CONFIG_DIR: join(root, "cli-state") },
    },
    gitConfigGlobal: gitConfig,
    logFile: join(root, "implementation.log"),
    timeoutMs: 120_000,
    idleTimeoutMs: 60_000,
    retryPolicy: {
      operationRetry: 0,
      agentRetry: 1,
      operationRetryDelay: [0],
      agentRetryDelay: [0],
    },
    signal: AbortSignal.timeout(240_000),
    pauseForTimeout: () =>
      Promise.reject(new Error("live operation exceeded its bounded deadline")),
  };
  const protocol =
    "This is a disposable local fixture with no remote issue. Read CODEBUDDY.md. Never access remote services. Run relevant Node checks and commit required changes. Keep the worktree clean. Report all commits since BASE_SHA in order. Use the required tagged result; no PR fields.";
  const perform = async (
    phase: string,
    task: string,
    input = common,
    requiredAncestor?: string,
  ) => {
    const promptFile = join(root, `${phase}.md`);
    await writeFile(promptFile, `${protocol}\n${task}`);
    const output = await executor.execute({
      ...input,
      runName: phase,
      promptFile,
    });
    assert.equal(output.outcome, "committed", output.blocker ?? output.summary);
    const observed = await git.inspect({
      worktree,
      base: input.base,
      ...(requiredAncestor ? { requiredAncestor } : {}),
    });
    assert.equal(observed.clean, true);
    assert.equal(observed.branch, "workflow");
    assert.deepEqual(output.commits, observed.commits);
    assert.ok(observed.commits.length > 0);
    for (const commit of observed.commits)
      assert.match(commit.message, /^feat:/u);
    evidence.push({
      phase,
      acceptedByGitVerification: true,
      commits: observed.commits.length,
    });
    return output;
  };
  await perform(
    "implementation",
    "Create add.mjs exporting add(a,b) that deliberately returns a-b as the initial review fixture. Use Write and Edit. Run node --input-type=module -e to assert add(4,2)===2. Commit it.",
  );
  const implementation = sessions.get("implementation");
  const findingsFile = join(root, "findings.md");
  const reviewPrompt = join(root, "review.md");
  await writeFile(
    reviewPrompt,
    "Disposable local review fixture; no remote issue. Read CODEBUDDY.md. The accepted specification is that add(4,2) returns 6. Inspect the diff and write this correctness finding to findingsFile. Never modify implementation or create commits.",
  );
  const review = {
    ...common,
    runName: "review",
    logFile: join(root, "review.log"),
    promptFile: reviewPrompt,
    promptArgs: {
      REVIEW_INPUT: JSON.stringify({
        worktree,
        deliveryBranch: "workflow",
        reviewBase: base,
        implementationHead: await command("rev-parse", "HEAD"),
        findingsFile,
      }),
    },
  };
  const findings = await executor.executeReview(review);
  assert.equal(findings.outcome, "findings");
  if (findings.outcome !== "findings")
    throw new Error("expected review finding");
  assert.equal(findings.findings_file, findingsFile);
  assert.ok((await readFile(findingsFile, "utf8")).trim());
  assert.notEqual(sessions.get("review"), implementation);
  await perform("implementation", "", {
    ...common,
    resumePrompt: `Read ${findingsFile}. Fix add.mjs to implement addition; run a Node assertion add(4,2)===6, then commit. Report ALL commits since ${base}, including the original fixture commit.`,
  });
  assert.equal(sessions.get("implementation"), implementation);
  const cleanReview = await executor.executeReview({
    ...review,
    resumePrompt:
      "Review the new HEAD and previous findings. The specification is add(4,2)===6. Verify the fix and return passed if resolved. Do not modify code or commit.",
  });
  assert.equal(cleanReview.outcome, "passed");
  evidence.push({
    phase: "review and original-session fixes",
    independentReviewSession: true,
    originalImplementationSession: true,
    rereviewPassed: true,
  });
  await writeFile(
    join(worktree, "ci-check.mjs"),
    "import assert from 'node:assert/strict';\nimport {add} from './add.mjs';\nassert.equal(add(4,2), 7);\n",
  );
  await command("add", "ci-check.mjs");
  await command("commit", "-qm", "fixture failing check");
  const ciBase = await command("rev-parse", "HEAD");
  await assert.rejects(
    exec(process.execPath, ["ci-check.mjs"], { cwd: worktree }),
  );
  await perform(
    "ci repair",
    "The actual local required check node ci-check.mjs fails: actual 6, expected 7. The accepted sum is 6. Correct the fixture expectation, run node ci-check.mjs and commit.",
    {
      ...common,
      base: ciBase,
      logFile: join(root, "ci.log"),
      promptArgs: { FAILED_CHECKS: "node ci-check.mjs: actual 6, expected 7" },
    },
  );
  await exec(process.execPath, ["ci-check.mjs"], { cwd: worktree });
  await writeFile(join(worktree, "features.txt"), "features=base\n");
  await command("add", "features.txt");
  await command("commit", "-qm", "fixture conflict base");
  const conflictBase = await command("rev-parse", "HEAD");
  await exec("git", [
    "-C",
    repository,
    "checkout",
    "-qb",
    "target-fixture",
    conflictBase,
  ]);
  await writeFile(join(repository, "features.txt"), "features=target\n");
  await exec("git", [
    "-C",
    repository,
    "commit",
    "-am",
    "fixture target change",
  ]);
  const target = (
    await exec("git", ["-C", repository, "rev-parse", "HEAD"])
  ).stdout.trim();
  await writeFile(join(worktree, "features.txt"), "features=source\n");
  await command("commit", "-am", "fixture source change");
  const source = await command("rev-parse", "HEAD");
  await assert.rejects(command("merge", "--no-edit", "target-fixture"));
  assert.match(
    await readFile(join(worktree, "features.txt"), "utf8"),
    /<<<<<<</u,
  );
  await perform(
    "conflict repair",
    "Resolve the current real merge conflict in features.txt to exactly features=source,target followed by newline. Preserve both source and target accepted intents. git add and commit the merge, and run node ci-check.mjs. Report only commits on the FIRST-PARENT path since BASE_SHA.",
    {
      ...common,
      base: source,
      logFile: join(root, "conflict.log"),
      promptArgs: { TARGET_BRANCH_SHA: target },
    },
    target,
  );
  assert.equal(
    await readFile(join(worktree, "features.txt"), "utf8"),
    "features=source,target\n",
  );
  const docsBase = await command("rev-parse", "HEAD");
  await perform(
    "Documentation Maintenance",
    `Create README.md documenting add(a,b), the Node check, and Documentation Base ${docsBase}. Run node ci-check.mjs and commit.`,
    { ...common, base: docsBase, logFile: join(root, "docs.log") },
  );
  const retryBase = await command("rev-parse", "HEAD");
  injectTransportFailure = true;
  await perform(
    "Agent Retry",
    "Create retry.txt containing retry verified, run node ci-check.mjs and commit exactly once. If asked to continue after already completing it, inspect Git and re-emit the result without adding another commit.",
    { ...common, base: retryBase, logFile: join(root, "retry.log") },
  );
  assert.equal(
    (await git.inspect({ worktree, base: retryBase })).commits.length,
    1,
  );
  console.log(
    `LIVE_WORKFLOW_EVIDENCE ${JSON.stringify({ cli: (await exec("codebuddy", ["--version"])).stdout.trim(), sandcastle: "0.12.0", model, backend: "native authenticated CodeBuddy backend", transportFailure: "injected after live CLI response; recovery uses another real CLI", evidence }, null, 2)}`,
  );
} catch (error) {
  if (error instanceof ProcessCleanupError) safeToRemove = false;
  throw error;
} finally {
  if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
  if (safeToRemove) await rm(root, { recursive: true, force: true });
  else
    console.error(
      `Uncertain process ownership; retained disposable state at ${root}`,
    );
}
