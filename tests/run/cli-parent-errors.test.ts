import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import { recoveryPaths } from "../../src/recovery.ts";

test.afterEach(cleanupTempRoots);

test("a cross-repository child fails explicitly without Operator Pause", async () => {
  const root = await createProject();
  let closeCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "another/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /cross-repository/u);
  assert.equal(result.exitCode, 1);
  assert.equal(closeCalls, 0);
  assert.equal(pauseCalls, 0);
});

test("a completed Parent with an open child fails as contradictory", async () => {
  const root = await createProject();
  let closeCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          return {
            number: 8,
            state: "closed",
            stateReason: "completed",
          } as const;
        },
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "open",
                stateReason: null,
                repository: "owner/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(
    result.summary.reasons[0] ?? "",
    /completed Parent Ticket has open children/u,
  );
  assert.equal(closeCalls, 0);
});

test("a closed Parent without a supported reason fails before child discovery", async () => {
  const root = await createProject();
  let childCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          return { number: 8, state: "closed", stateReason: null } as const;
        },
        async listChildrenPage() {
          childCalls += 1;
          return { children: [], nextPage: null };
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /closed Parent Ticket/u);
  assert.equal(childCalls, 0);
  assert.equal(pauseCalls, 0);
});

test("an external read succeeds on the fifth call with fixed delays", async () => {
  const root = await createProject();
  let parentCalls = 0;
  const sleeps: number[] = [];
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentCalls += 1;
          if (parentCalls < 5) throw new Error("temporary read failure");
          return { number: 8, state: "open", stateReason: null } as const;
        },
      },
      clock: {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(parentCalls, 5);
  assert.deepEqual(sleeps, [10_000, 20_000, 40_000, 80_000]);
  assert.equal(pauseCalls, 0);
});

test("q and EOF at an exhausted external read cancel the Run", async () => {
  for (const response of ["q", null] as const) {
    const root = await createProject();
    let parentCalls = 0;
    let pauseCalls = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          async getParent() {
            parentCalls += 1;
            throw new Error("unavailable");
          },
          async listChildrenPage() {
            throw new Error("must not scan children");
          },
        },
        operator: {
          async pause() {
            pauseCalls += 1;
            return response;
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(result.exitCode, 1);
    assert.equal(parentCalls, 5);
    assert.equal(pauseCalls, 1);
    assert.ok(result.logPath);
    const pauseResults = (await readFile(result.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.operation === "operator_pause")
      .map((event) => event.result);
    assert.deepEqual(pauseResults, ["started", "cancelled"]);
  }
});

test("read-result text stays paused until Enter and never enters the audit log", async () => {
  const root = await createProject();
  let parentCalls = 0;
  const responses = ["{}", '{"state":"open"}', ""];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentCalls += 1;
          if (parentCalls <= 5) throw new Error("unavailable");
          return { number: 8, state: "open", stateReason: null };
        },
      },
      operator: {
        async pause() {
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.ok(result.logPath);
  const log = await readFile(result.logPath, "utf8");
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(parentCalls, 6);
  assert.equal(responses.length, 0);
  assert.equal(log.includes('"operator_override":"{}"'), false);
  assert.equal(log.includes("operator_override"), false);
  assert.match(log, /unsupported_input/u);
});

test("child read payloads stay paused even when repository metadata is present", async () => {
  const root = await createProject();
  let childCalls = 0;
  const responses = [
    '{"children":[{"number":9,"state":"closed","stateReason":"completed"}],"nextPage":null}',
    '{"children":[{"number":9,"state":"closed","stateReason":"completed","repository":"owner/repo"}],"nextPage":null}',
    "",
  ];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childCalls += 1;
          if (childCalls > 5) {
            return {
              children: [
                {
                  number: 9,
                  state: "closed",
                  stateReason: "completed",
                  repository: "owner/repo",
                },
              ],
              nextPage: null,
            };
          }
          throw new Error("unavailable");
        },
      },
      operator: {
        async pause() {
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(childCalls, 7);
  assert.equal(responses.length, 0);
  assert.ok(result.logPath);
  assert.match(await readFile(result.logPath, "utf8"), /unsupported_input/u);
});

test("empty Operator Pause input resets the complete read budget", async () => {
  const root = await createProject();
  let parentCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentCalls += 1;
          if (parentCalls <= 5) throw new Error("unavailable");
          return { number: 8, state: "open", stateReason: null } as const;
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(parentCalls, 6);
  assert.equal(pauseCalls, 1);
});

test("a failed Parent close retries automatically without Operator Pause", async () => {
  const root = await createProject();
  let closeCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "owner/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error("write failed");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(closeCalls, 2);
  assert.equal(pauseCalls, 0);
});

test("write acknowledgement text stays paused until Enter retries the actual write", async () => {
  const root = await createProject();
  let closeCalls = 0;
  let pauses = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "owner/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
          if (closeCalls <= 5) throw new Error("response lost");
        },
      },
      operator: {
        async pause() {
          pauses += 1;
          assert.equal(closeCalls, 5);
          return pauses === 1 ? "I confirmed the write" : "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(closeCalls, 6);
  assert.equal(pauses, 2);
  assert.ok(result.logPath);
  assert.equal(
    (await readFile(result.logPath, "utf8")).includes("I confirmed"),
    false,
  );
});

test("startup validation errors return a failed summary without workflow or pause", async () => {
  const root = await createProject();
  let workflowCalls = 0;
  let pauseCalls = 0;
  const messages: string[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      env: {},
      tracker: {
        async getParent() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
        async listChildrenPage() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
        async closeParent() {
          workflowCalls += 1;
        },
      },
      codeHost: {
        async resolveTargetBranch() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(result.exitCode, 1);
  assert.match(result.summary.reasons[0] ?? "", /missing credential/u);
  assert.equal(result.logPath, null);
  assert.equal(workflowCalls, 0);
  assert.equal(pauseCalls, 0);
  assert.equal(messages.length, 1);
  assert.match(
    messages[0]!,
    /^Startup failed: missing credential TEST_GH_TOKEN$/u,
  );
  assert.doesNotMatch(messages[0]!, /^\{/u);
});

test("malformed Recovery Snapshots fail startup with one readable error", async () => {
  const root = await createProject();
  const snapshot = recoveryPaths(
    path.join(root, "projects", "demo"),
    8,
  ).snapshot;
  await mkdir(path.dirname(snapshot), { recursive: true });
  await writeFile(snapshot, "{not-json", "utf8");
  let workflowCalls = 0;
  let pauseCalls = 0;
  const messages: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
      },
      operator: {
        write(message) {
          messages.push(message);
        },
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.equal(result.exitCode, 1);
  assert.equal(result.logPath, null);
  assert.equal(workflowCalls, 0);
  assert.equal(pauseCalls, 0);
  assert.deepEqual(messages, [
    "Startup failed: recovery snapshot is malformed JSON",
  ]);
});

test("an empty required prompt fails startup before workflow operations", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects", "demo", "prompts", "implement.md"),
    "",
  );
  let workflowCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
        async listChildrenPage() {
          workflowCalls += 1;
          throw new Error("must not run");
        },
        async closeParent() {
          workflowCalls += 1;
        },
      },
      codeHost: {
        async resolveTargetBranch() {
          workflowCalls += 1;
          return "main";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /implement.md.*empty/u);
  assert.equal(workflowCalls, 0);
});
