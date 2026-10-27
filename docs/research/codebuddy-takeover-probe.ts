import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { run } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";
import { TerminalOperator } from "../../src/adapters/terminal.ts";
import {
  ProcessCleanupError,
  type SandcastleRun,
} from "../../src/adapters/process-settlement.ts";
import { AuditLog } from "../../src/audit.ts";
import type { AgentAttemptInput } from "../../src/run/contracts.ts";
import {
  advance,
  pauseForAgentTimeout,
  serializeOperator,
} from "../../src/run/operations.ts";

const exec = promisify(execFile);
// Keep disposable commits inside the supplied checkout, under its ignored dependency directory.
const root = await mkdtemp(
  join(resolve("node_modules"), ".codebuddy-takeover-"),
);
const repository = join(root, "repository");
const worktree = join(root, "worktree");
const store = join(root, "cli-state");
const gitConfig = join(root, "gitconfig");
const marker = randomUUID();
const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
process.env.GIT_CONFIG_GLOBAL = gitConfig;
const controller = new AbortController();
let deadline = setTimeout(
  () => controller.abort(new Error("live probe deadline")),
  300_000,
);
const operator = serializeOperator(new TerminalOperator(), controller);
const audit = new AuditLog(
  root,
  new Date().toISOString(),
  264,
  "takeover-probe",
);
const evidence: Record<string, unknown>[] = [];
let safeToRemove = true;
const model = "deepseek-v4.1-flash";
let calls = 0;
let session: string | undefined;
const executor = new SandcastleAgentExecutor(async (options) => {
  calls += 1;
  const start = performance.now();
  const result = await (run as SandcastleRun)(options);
  const id = result.iterations.at(-1)?.sessionId;
  if (options.prompt === "Reply with exactly: SESSION_READY") {
    assert.equal(result.stdout.trim(), "SESSION_READY");
    session = id;
  }
  evidence.push({
    phase:
      options.prompt === "Reply with exactly: SESSION_READY"
        ? "SESSION_READY"
        : "runner continuation",
    elapsedMs: Math.round(performance.now() - start),
    sameSession: session === id,
  });
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
    "probe base",
  ]);
  await exec("git", [
    "-C",
    repository,
    "worktree",
    "add",
    "-b",
    "takeover",
    worktree,
  ]);
  const base = (
    await exec("git", ["-C", worktree, "rev-parse", "HEAD"])
  ).stdout.trim();
  await audit.create();
  const ownedScript = join(root, "owned.cjs");
  const childPid = join(root, "child.pid");
  const parentPid = join(root, "parent.pid");
  const writesFile = join(root, "writes");
  await writeFile(
    ownedScript,
    `
const fs = require("node:fs");
const {spawn} = require("node:child_process");
fs.writeFileSync(${JSON.stringify(parentPid)}, String(process.pid));
spawn(process.execPath, ["-e", 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>fs.appendFileSync(process.argv[2], "tick"), 20)', ${JSON.stringify(childPid)}, ${JSON.stringify(writesFile)}], {stdio:"inherit"});
setInterval(()=>{}, 1000);
`,
  );
  const promptFile = join(root, "task.md");
  await writeFile(
    promptFile,
    `This is a disposable local acceptance fixture, with no GitHub issue to read. No network or tracker operations. Remember the secret context marker ${marker}. First read CODEBUDDY.md. If manual.txt does not exist, run Bash command node ${JSON.stringify(ownedScript)} in the foreground and wait. Do not detach it or create other processes. After manual handling, skip that command, read manual.txt and confirm it equals the secret marker from this context. Write add.mjs exporting add(a,b) that returns a-b (the intentional initial fixture for a later review). Use Write and Edit, run a Node assertion that add(4,2) is 2, then git add add.mjs manual.txt and commit with subject "feat: takeover fixture". Return a committed tagged result with all observed commits since base. Do not add PR fields. Report a permission refusal as blocked. Keep the worktree clean.`,
  );
  await writeFile(
    join(worktree, "CODEBUDDY.md"),
    "For this disposable probe, every implementation commit subject starts with feat:. Never access remote services.\n",
  );
  await exec("git", ["-C", worktree, "add", "CODEBUDDY.md"]);
  await exec("git", ["-C", worktree, "commit", "-qm", "fixture instructions"]);
  const attemptBase = (
    await exec("git", ["-C", worktree, "rev-parse", "HEAD"])
  ).stdout.trim();
  const input: AgentAttemptInput = {
    ticket: 264,
    runName: "live takeover fixture",
    worktree,
    branch: "takeover",
    base: attemptBase,
    targetBranch: "main",
    promptFile,
    promptArgs: {},
    pullRequestMetadata: "ignored",
    agent: "codebuddy",
    model,
    options: {
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Write", "Edit", "Bash"],
      maxTurns: 20,
      env: { CODEBUDDY_CONFIG_DIR: store },
    },
    gitConfigGlobal: gitConfig,
    logFile: join(root, "implementation.log"),
    timeoutMs: 30_000,
    idleTimeoutMs: 60_000,
    retryPolicy: {
      operationRetry: 0,
      agentRetry: 0,
      operationRetryDelay: [0],
      agentRetryDelay: [0],
    },
    signal: controller.signal,
    advance: (action) => advance(operator, action),
    pauseForTimeout: async (cause, intervention) => {
      assert.ok(intervention);
      console.log(
        `MANUAL_STATE ${JSON.stringify({ worktree, store, gitConfig, session })}`,
      );
      await pauseForAgentTimeout(
        audit,
        {
          timestamp: new Date().toISOString(),
          runId: "takeover-probe",
          project: "disposable",
          parentTicket: 264,
          phase: "implementation",
          operation: "timeout",
          target: "fixture",
          attempt: 1,
        },
        operator,
        `Live ${cause} threshold. Use k, manually resume only after settlement, exit the native CLI, then Enter.`,
        {
          describe: () => intervention.describe(),
          kill: async () => {
            const stopped = await intervention.kill();
            assert.equal(stopped.continuable, true);
            clearTimeout(deadline);
            const pids = await Promise.all(
              [parentPid, childPid].map(async (file) =>
                Number(await readFile(file, "utf8")),
              ),
            );
            for (const pid of pids)
              assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
            const writes = await readFile(writesFile, "utf8");
            await new Promise((resolve) => setTimeout(resolve, 150));
            assert.equal(await readFile(writesFile, "utf8"), writes);
            evidence.push({
              phase: "selected kill",
              settled: true,
              descendantWritesStopped: true,
              runnerCalls: calls,
            });
            return stopped;
          },
        },
      );
      deadline = setTimeout(
        () => controller.abort(new Error("continuation deadline")),
        120_000,
      );
      assert.equal(
        (await readFile(join(worktree, "manual.txt"), "utf8")).trim(),
        marker,
      );
    },
  };
  const output = await executor.execute(input);
  assert.equal(output.outcome, "committed");
  const git = new LocalGitWorkspace("");
  const observed = await git.inspect({ worktree, base: attemptBase });
  assert.equal(observed.branch, "takeover");
  assert.equal(observed.clean, true);
  assert.deepEqual(output.commits, observed.commits);
  assert.ok(observed.commits.length > 0);
  assert.equal(
    (await readFile(join(worktree, "manual.txt"), "utf8")).trim(),
    marker,
  );
  await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {add} from './add.mjs'; if(add(4,2)!==2) throw Error('fixture');",
    ],
    { cwd: worktree },
  );
  evidence.push({
    phase: "independent Git verification",
    accepted: true,
    commits: observed.commits.length,
    manualContextRecalled: true,
    baseWasIsolated: base !== attemptBase,
  });
  console.log(
    `LIVE_EVIDENCE ${JSON.stringify({ cli: (await exec("codebuddy", ["--version"])).stdout.trim(), sandcastle: "0.12.0", model, backend: "native authenticated CodeBuddy backend", evidence }, null, 2)}`,
  );
} catch (error) {
  if (error instanceof ProcessCleanupError) safeToRemove = false;
  throw error;
} finally {
  clearTimeout(deadline);
  controller.abort(new Error("probe cleanup"));
  if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
  if (safeToRemove) await rm(root, { recursive: true, force: true });
  else
    console.error(
      `Uncertain process ownership; retained disposable state at ${root}`,
    );
}
