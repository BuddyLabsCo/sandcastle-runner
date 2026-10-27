import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { run } from "@ai-hero/sandcastle";

import { nativeAgent } from "../../src/adapters/agent-provider.ts";
import { noShellSandbox } from "../../src/adapters/no-shell-sandbox.ts";
import {
  invokeSandbox,
  type SandcastleRun,
} from "../../src/adapters/process-settlement.ts";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "runner-codebuddy-provider-"));
const repository = join(root, "repository");
const worktree = join(root, "worktree");
const store = join(root, "cli-state");
const gitConfig = join(root, "gitconfig");
const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
process.env.GIT_CONFIG_GLOBAL = gitConfig;
const evidence: Record<string, unknown>[] = [];
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
    "--detach",
    worktree,
  ]);
  const model = "deepseek-v4.1-flash";
  const options = {
    permissionMode: "dontAsk",
    tools: "",
    maxTurns: 3,
    env: { CODEBUDDY_CONFIG_DIR: store },
  };
  const invoke = async (prompt: string, session?: string) => {
    const provider = nativeAgent("codebuddy", model, options);
    const start = performance.now();
    const invocation = await invokeSandbox(run as SandcastleRun, {
      agent: provider,
      sandbox: noShellSandbox({ env: { GIT_CONFIG_GLOBAL: gitConfig } }),
      cwd: worktree,
      prompt,
      maxIterations: 1,
      completionSignal: [],
      idleTimeoutSeconds: 30,
      branchStrategy: { type: "head" },
      signal: AbortSignal.timeout(45_000),
      ...(session === undefined ? {} : { resumeSession: session }),
    });
    assert.equal(invocation.settlement.outcome, "settled");
    if (invocation.runError !== undefined) throw invocation.runError;
    assert.ok(invocation.result);
    const result = invocation.result;
    const id = result.iterations.at(-1)?.sessionId;
    assert.ok(id);
    const lookupStart = performance.now();
    const found = await provider.sessionStorage!.findByIdOnHost(id);
    assert.ok(found.path);
    const bytes = (await stat(found.path)).size;
    assert.ok(bytes > 0);
    evidence.push({
      phase: evidence.length + 1,
      elapsedMs: Math.round(lookupStart - start),
      lookupMs: Math.round(performance.now() - lookupStart),
      transcriptBytes: bytes,
      resumedExactId: session === undefined ? false : id === session,
      text: result.stdout,
    });
    if (session !== undefined) assert.equal(id, session);
    return { id, text: result.stdout };
  };
  const probe = await invoke("Reply with exactly: SESSION_READY");
  assert.equal(probe.text.trim(), "SESSION_READY");
  const context = await invoke(
    "Return the entire previous user message verbatim. Do not use tools.",
    probe.id,
  );
  assert.match(context.text, /Reply with exactly: SESSION_READY/u);
  const marker = randomUUID();
  const saved = await invoke(
    `Remember this marker for the next turn: ${marker}. Reply with exactly: MARKER_SAVED`,
    probe.id,
  );
  assert.equal(saved.text.trim(), "MARKER_SAVED");
  const recalled = await invoke(
    "Reply with only the marker I asked you to remember in the previous turn. Do not use tools.",
    probe.id,
  );
  assert.equal(recalled.text.trim(), marker);
  assert.ok(
    (
      await readFile(
        (
          await nativeAgent(
            "codebuddy",
            model,
            options,
          ).sessionStorage!.findByIdOnHost(probe.id)
        ).path!,
        "utf8",
      )
    ).includes(marker),
  );
  console.log(
    JSON.stringify(
      {
        cli: (await exec("codebuddy", ["--version"])).stdout.trim(),
        sandcastle: "0.12.0",
        model,
        backend: "native authenticated CodeBuddy backend",
        evidence: evidence.map((entry) => ({
          ...entry,
          text: String(entry.text).replaceAll(
            marker,
            "[random marker recalled exactly]",
          ),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
  await rm(root, { recursive: true, force: true });
}
