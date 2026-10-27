import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { committed, input, reviewInput } from "../support/sandcastle.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

const exec = promisify(execFile);
const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
test.afterEach(async () => {
  if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
  await cleanupTempRoots();
});

async function setup() {
  const root = registerTempRoot(
    await mkdtemp(join(tmpdir(), "codebuddy-executor-")),
  );
  const repository = join(root, "worktree");
  const bin = join(root, "bin");
  const store = join(root, "state");
  const gitConfig = join(root, "gitconfig");
  await mkdir(repository);
  await mkdir(bin);
  await writeFile(
    gitConfig,
    "[user]\n name = Runner Test\n email = runner@example.test\n",
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  await exec("git", ["init", "-q", repository]);
  await exec("git", [
    "-C",
    repository,
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  const branch = (
    await exec("git", ["-C", repository, "branch", "--show-current"])
  ).stdout.trim();
  const script = `#!/usr/bin/env node
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
await writeFile(process.env.ARGUMENTS_FILE,JSON.stringify({args:process.argv.slice(2),prompt,cwd:process.cwd(),gitConfig:process.env.GIT_CONFIG_GLOBAL}));
const id='fixture-session';
const init={type:'system',subtype:'init',session_id:id};
if(prompt==='Reply with exactly: SESSION_READY') {
const dir=join(process.env.CODEBUDDY_CONFIG_DIR,'projects','fixture-worktree');
await mkdir(dir,{recursive:true}); await writeFile(join(dir,id+'.jsonl'),'{}\\n');
console.log(JSON.stringify(init));
console.log(JSON.stringify({type:'result',subtype:'success',session_id:id,result:'SESSION_READY'}));
} else {
const fixture=JSON.parse(await readFile(process.env.EVENTS_FILE,'utf8'));
for(const event of fixture.events) console.log(typeof event==='string'?event:JSON.stringify(event));
process.stderr.write(fixture.stderr??''); process.exitCode=fixture.exitCode??0;
}
`;
  await writeFile(join(bin, "fake.mjs"), script);
  if (process.platform === "win32")
    await writeFile(
      join(bin, "codebuddy.cmd"),
      '@echo off\r\nnode "%~dp0fake.mjs" %*\r\n',
    );
  else {
    await writeFile(join(bin, "codebuddy"), script);
    await chmod(join(bin, "codebuddy"), 0o755);
  }
  const fixtureFile = join(root, "events.json");
  const argsFile = join(root, "args.json");
  const profile = {
    agent: "codebuddy",
    model: "test model's name",
    worktree: repository,
    gitConfigGlobal: gitConfig,
    branch,
    logFile: join(root, "agent.log"),
    options: {
      effort: "high",
      permissionMode: "dontAsk",
      tools: "",
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        CODEBUDDY_CONFIG_DIR: store,
        EVENTS_FILE: fixtureFile,
        ARGUMENTS_FILE: argsFile,
      },
    },
    retryPolicy: {
      operationRetry: 0,
      agentRetry: 0,
      operationRetryDelay: [1],
      agentRetryDelay: [1],
    },
  };
  return {
    profile,
    argsFile,
    fixture: async (events: unknown[], exitCode = 0, stderr = "") => {
      await writeFile(
        fixtureFile,
        JSON.stringify({ events, exitCode, stderr }),
      );
    },
  };
}
const init = { type: "system", subtype: "init", session_id: "fixture-session" };
const final = (result: string, extra = {}) => ({
  type: "result",
  subtype: "success",
  session_id: "fixture-session",
  result,
  ...extra,
});

// Regression: CodeBuddy must exercise the existing executor and strict contracts,
// not accept raw events or terminal success flags as a handoff.
test("CodeBuddy executes both tagged contracts through shell-free native continuation", async () => {
  const { profile, fixture, argsFile } = await setup();
  const executor = new SandcastleAgentExecutor();
  const agentText = `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`;
  await fixture([init, final(agentText)]);
  const agent = await executor.execute({ ...input(), ...profile });
  assert.equal(agent.outcome, "committed");
  const transport = JSON.parse(await readFile(argsFile, "utf8")) as {
    args: string[];
    cwd: string;
    gitConfig: string;
    prompt: string;
  };
  assert.equal(transport.cwd, profile.worktree);
  assert.equal(transport.gitConfig, profile.gitConfigGlobal);
  assert.ok(transport.args.includes("test model's name"));
  assert.ok(transport.args.includes("--tools="));
  assert.deepEqual(transport.args.slice(-2), ["--resume", "fixture-session"]);
  assert.match(transport.prompt, /agent_attempt_result/u);
  await fixture([
    init,
    final(
      '<review_attempt_result>{"outcome":"passed"}</review_attempt_result>',
    ),
  ]);
  const review = await executor.executeReview({
    ...reviewInput(),
    ...profile,
    logFile: join(profile.worktree, "review.log"),
  });
  assert.equal(review.outcome, "passed");
});

test("CodeBuddy rejects malformed, duplicate, absent and misleading tagged results", async () => {
  const { profile, fixture } = await setup();
  const executor = new SandcastleAgentExecutor();
  for (const tag of ["agent_attempt_result", "review_attempt_result"]) {
    const payload =
      tag === "agent_attempt_result"
        ? JSON.stringify(committed)
        : '{"outcome":"passed"}';
    const valid = `<${tag}>${payload}</${tag}>`;
    const invoke = () =>
      tag === "agent_attempt_result"
        ? executor.execute({ ...input(), ...profile })
        : executor.executeReview({ ...reviewInput(), ...profile });
    for (const events of [
      [init, final("no tagged output")],
      [init, final(`<${tag}>{bad}</${tag}>`)],
      [init, final(`<${tag}>{}</${tag}>`)],
      [init, final(valid + valid)],
      [
        init,
        {
          type: "assistant",
          message: { content: [{ type: "text", text: valid }] },
        },
      ],
      [init, { type: "future", result: valid }],
      [valid],
      [final(valid)],
      [
        init,
        final(valid, { is_error: false, terminal_reason: "aborted_streaming" }),
      ],
      [init, final(valid, { subtype: "error_max_turns", is_error: true })],
      [init, final(valid, { is_error: "false" })],
      [init, final(valid), final(valid)],
      [init, { type: "error", error: "failed" }, final(valid)],
    ]) {
      await fixture(events);
      await assert.rejects(
        invoke(),
        /result tag|structured output|protocol|exactly one/iu,
      );
    }
    await fixture([init, final(valid)], 7, "native process failed");
    await assert.rejects(
      invoke(),
      /exited with code 7.*|native process failed/iu,
    );
  }
});

test("CodeBuddy preserves permission refusals with a successful zero-exit envelope", async () => {
  const { profile, fixture } = await setup();
  await fixture([
    init,
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            is_error: true,
            content: "Write requires approval; prompts unavailable",
          },
        ],
      },
    },
    final(
      '<agent_attempt_result>{"outcome":"blocked","summary":"Write was denied","commits":[],"checks":[],"blocker":"Pre-authorize Write"}</agent_attempt_result>',
      { is_error: false, permission_denials: [] },
    ),
  ]);
  const result = await new SandcastleAgentExecutor().execute({
    ...input(),
    ...profile,
    pullRequestMetadata: "ignored",
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.blocker, "Pre-authorize Write");
  assert.match(
    await readFile(profile.logFile, "utf8"),
    /Write requires approval/u,
  );
});

// Regression: native cancellation must retain the original context for Agent Retry.
test("CodeBuddy terminal failures retry the exact session under the existing budget", async () => {
  const { profile, fixture, argsFile } = await setup();
  const valid = `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`;
  await fixture([
    init,
    final(valid, { is_error: false, terminal_reason: "aborted_streaming" }),
  ]);
  const delays: number[] = [];
  const executor = new SandcastleAgentExecutor(
    undefined,
    async (milliseconds) => {
      delays.push(milliseconds);
      await fixture([init, final(valid)]);
    },
  );
  const result = await executor.execute({
    ...input(),
    ...profile,
    retryPolicy: { ...profile.retryPolicy, agentRetry: 1 },
  });
  assert.equal(result.outcome, "committed");
  assert.deepEqual(delays, [1000]);
  const transport = JSON.parse(await readFile(argsFile, "utf8")) as {
    args: string[];
  };
  assert.deepEqual(transport.args.slice(-2), ["--resume", "fixture-session"]);
});
