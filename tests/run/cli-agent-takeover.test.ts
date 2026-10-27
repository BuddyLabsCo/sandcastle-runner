import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import type { AgentAttemptInput } from "../../src/run/contracts.ts";
import { executeCli } from "../../src/cli.ts";
import {
  createCliDependencies,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { committed, result as agentResult } from "../support/sandcastle.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("k settles only the selected invocation and keeps all entries pending until manual exit and independent acknowledgement", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    agentRetry: 0,
    timeouts: { ...validConfig.timeouts, agentMinutes: 0.001 },
  });
  const delivery = createCommittedBatch(9, 10);
  const inputs = new Map<number, AgentAttemptInput>();
  const signals = new Map<number, AbortSignal>();
  const calls: number[] = [];
  let inspections = 0;
  let prompts = 0;
  let settled = false;
  let confirmStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    confirmStop = resolve;
  });
  let finishOther!: () => void;
  const other = new Promise<void>((resolve) => {
    finishOther = resolve;
  });
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      const ticket = options.name === "implement issue 9" ? 9 : 10;
      options.agent.sessionStorage!.findByIdOnHost = async () => ({
        path: "/fixture/native-session.jsonl",
        searchedRoot: "/fixture",
      });
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          ...agentResult("SESSION_READY", committed),
          iterations: [{ sessionId: `session-${ticket}` }],
        };
      calls.push(ticket);
      assert.equal(options.resumeSession, `session-${ticket}`);
      if (calls.filter((value) => value === ticket).length === 1) {
        signals.set(ticket, options.signal!);
        if (ticket === 9) {
          await new Promise<void>((_resolve, reject) => {
            options.signal!.addEventListener(
              "abort",
              () => {
                settled = true;
                confirmStop();
                reject(new Error("selected invocation killed"));
              },
              { once: true },
            );
          });
        } else await other;
      }
      const output = await delivery.agentExecutor.execute(inputs.get(ticket)!);
      return agentResult(
        `<agent_attempt_result>${JSON.stringify(output)}</agent_attempt_result>`,
        output,
      );
    },
    async () => {},
    async () => {},
    async () => {},
  );
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async inspect(input) {
          inspections += 1;
          return delivery.gitWorkspace.inspect(input);
        },
      },
      agentExecutor: {
        execute(input) {
          inputs.set(input.ticket, input);
          return executor.execute({
            ...input,
            timeoutMs: input.ticket === 9 ? 60 : 150,
          });
        },
      },
      operator: {
        async pause(message) {
          prompts += 1;
          if (prompts > 3) return "q";
          assert.equal(inspections, 0);
          if (prompts === 1) {
            assert.match(message, /implement issue 9/u);
            assert.match(message, /session-9/u);
            await new Promise((resolve) => setTimeout(resolve, 200));
            finishOther();
            await new Promise((resolve) => setTimeout(resolve, 30));
            return "k";
          }
          await stopped;
          assert.equal(settled, true);
          assert.equal(signals.get(10)?.aborted, false);
          assert.equal(calls.length, 2);
          if (prompts === 2) {
            assert.match(message, /implement issue 10/u);
            assert.match(message, /retained outcome/u);
            await new Promise((resolve) => setTimeout(resolve, 100));
          } else {
            assert.match(message, /settled/iu);
            assert.match(message, /exit.*manual CLI/iu);
          }
          return "";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(prompts, 3);
  assert.deepEqual(
    calls.sort((a, b) => a - b),
    [9, 9, 10],
  );
  assert.equal(inspections, 2);
  assert.ok(result.logPath);
  const audit = await readFile(result.logPath, "utf8");
  assert.match(audit, /"result":"kill_requested"/u);
  assert.match(audit, /"result":"process_settled"/u);
  assert.doesNotMatch(audit, /"result":"agent_retry"/u);
});

for (const state of ["unknown", "missing", "ambiguous"] as const) {
  for (const cancel of ["q", null]) {
    test(`kill with ${state} native storage blocks Enter and retains ${cancel ?? "EOF"} cancellation`, async () => {
      const root = await createProject();
      await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
        ...validConfig,
        timeouts: { ...validConfig.timeouts, agentMinutes: 0.0005 },
      });
      const delivery = createCommittedBatch(9);
      let calls = 0;
      let prompts = 0;
      let inspections = 0;
      const executor = new SandcastleAgentExecutor(
        async (options) => {
          calls += 1;
          if (state !== "unknown") {
            options.agent.sessionStorage!.findByIdOnHost = async () => {
              if (state === "ambiguous")
                throw new Error("ambiguous exact-session matches");
              return { path: undefined, searchedRoot: "/fixture/missing" };
            };
            if (options.prompt === "Reply with exactly: SESSION_READY")
              return {
                ...agentResult("SESSION_READY", committed),
                iterations: [{ sessionId: "known-session" }],
              };
          }
          await new Promise<void>((_resolve, reject) => {
            options.signal!.addEventListener(
              "abort",
              () => reject(new Error("stopped before session discovery")),
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
        async () => {},
        async () => {},
        async () => {},
      );
      const result = await executeCli(
        ["run", "--project", "demo", "--parent", "8"],
        createCliDependencies(root, {
          tracker: delivery.tracker,
          gitWorkspace: {
            ...delivery.gitWorkspace,
            async inspect(input) {
              inspections += 1;
              return delivery.gitWorkspace.inspect(input);
            },
          },
          agentExecutor: executor,
          operator: {
            async pause(message) {
              prompts += 1;
              if (prompts === 1) return "k";
              assert.match(message, /native session is unavailable/u);
              assert.match(message, /Continuation is blocked/u);
              return prompts === 2 ? "" : cancel;
            },
          },
        }),
      );
      assert.equal(result.summary.outcome, "cancelled");
      assert.equal(calls, state === "unknown" ? 1 : 2);
      assert.equal(prompts, 3);
      assert.equal(inspections, 0);
    });
  }
}

test("Review takeover resumes the review session and verifies its ordinary result after manual exit", async () => {
  const root = await createProject();
  await writeProjectConfig(path.join(root, "projects/demo/config.yaml"), {
    ...validConfig,
    agentRetry: 0,
    workflow: { ...validConfig.workflow, review: true },
    timeouts: { ...validConfig.timeouts, agentMinutes: 0.0005 },
  });
  const delivery = createCommittedBatch(9);
  let reviews = 0;
  let inspections = 0;
  let prompts = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      options.agent.sessionStorage!.findByIdOnHost = async () => ({
        path: "/fixture/review.jsonl",
        searchedRoot: "/fixture",
      });
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          ...agentResult("SESSION_READY", committed),
          iterations: [{ sessionId: "review-session" }],
        };
      reviews += 1;
      assert.equal(options.resumeSession, "review-session");
      if (reviews === 1)
        await new Promise<void>((_resolve, reject) =>
          options.signal!.addEventListener(
            "abort",
            () => reject(new Error("selected review killed")),
            { once: true },
          ),
        );
      return {
        iterations: [{ sessionId: "review-session" }],
        stdout:
          '<review_attempt_result>{"outcome":"passed"}</review_attempt_result>',
        commits: [],
        branch: "unused",
        output: { outcome: "passed" },
      };
    },
    async () => {},
    async () => {},
    async () => {},
  );
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async inspectReview() {
          inspections += 1;
          return {
            clean: true,
            deliveryCommits: [
              { sha: "b".repeat(40), message: "feat: implementation" },
            ],
            reviewCommits: [],
          };
        },
      },
      agentExecutor: {
        execute: (input) => delivery.agentExecutor.execute(input),
        executeReview: (input) => executor.executeReview(input),
      },
      operator: {
        async pause(message) {
          prompts += 1;
          assert.equal(inspections, 0);
          assert.equal(reviews, 1);
          if (prompts === 1) {
            assert.match(message, /review issue 9/u);
            return "k";
          }
          assert.match(message, /exit.*manual CLI/iu);
          return "";
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(reviews, 2);
  assert.equal(prompts, 2);
  assert.equal(inspections, 1);
});
