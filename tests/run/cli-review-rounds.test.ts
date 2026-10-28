import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import {
  createProject,
  validConfig,
  writeProjectConfig,
} from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("review rounds reuse both sessions, fix every findings round, and review only the latest fix", async () => {
  for (const maximum of [1, 2, undefined]) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    config.workflow.review = true;
    await writeProjectConfig(path.join(root, "demo/config.yaml"), {
      ...config,
      workflow: {
        ...config.workflow,
        ...(maximum === undefined ? {} : { maxReviewRounds: maximum }),
      },
    });
    const delivery = createCommittedDelivery(9);
    const commits = [{ sha: "b".repeat(40), message: "feat: implementation" }];
    const calls: string[] = [];
    const logs: string[] = [];
    const findingsFiles: string[] = [];
    let implementationLog = "";
    let reviewLog = "";
    let branch = "";
    let round = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: delivery.tracker,
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async createWorktree(input) {
            branch = input.branch;
          },
          async inspect({ worktree, base }) {
            const index =
              base === "a".repeat(40)
                ? -1
                : commits.findIndex(({ sha }) => sha === base);
            return {
              worktree,
              branch,
              base,
              clean: true,
              commits: commits.slice(index + 1),
            };
          },
          async inspectReview({ implementationHead }) {
            assert.equal(implementationHead, commits.at(-1)!.sha);
            return {
              clean: true,
              deliveryCommits: [...commits],
              reviewCommits: [],
            };
          },
        },
        agentExecutor: {
          async execute(input) {
            if (implementationLog === "") {
              implementationLog = input.logFile;
              logs.push(input.logFile);
              calls.push("implement");
              await writeFile(input.logFile, "implementation session");
              return delivery.agentExecutor.execute!(input);
            }
            calls.push("fix");
            assert.equal(input.logFile, implementationLog);
            assert.ok(input.resumePrompt?.includes(findingsFiles.at(-1)!));
            assert.match(input.resumePrompt!, /read|Read/u);
            assert.match(
              await readFile(findingsFiles.at(-1)!, "utf8"),
              /P1 finding/u,
            );
            await access(implementationLog);
            await access(reviewLog);
            assert.equal(input.base, commits.at(-1)!.sha);
            const fix = {
              sha: String.fromCharCode(99 + round - 1).repeat(40),
              message: `fix: round ${round}`,
            };
            commits.push(fix);
            return {
              outcome: "committed",
              summary: "Fixed findings",
              commits: [fix],
              checks: [
                {
                  command: "npm test",
                  status: "passed",
                  details: `fix ${round}`,
                },
              ],
              blocker: null,
            };
          },
          async executeReview(input) {
            assert.equal(input.idleTimeoutMs, 600_000);
            assert.equal(input.timeoutMs, 7_200_000);
            assert.equal(typeof input.pauseForTimeout, "function");
            calls.push("review");
            round += 1;
            const handoff = JSON.parse(
              String(input.promptArgs.REVIEW_INPUT),
            ) as {
              reviewBase: string;
              implementationHead: string;
              findingsFile: string;
            };
            assert.ok(handoff.findingsFile.endsWith(`-round-${round}.md`));
            assert.equal(
              handoff.reviewBase,
              round === 1 ? "a".repeat(40) : commits.at(-2)!.sha,
            );
            assert.equal(handoff.implementationHead, commits.at(-1)!.sha);
            if (round === 1) {
              reviewLog = input.logFile;
              logs.push(input.logFile);
              assert.equal(input.resumePrompt, undefined);
            } else {
              assert.equal(input.logFile, reviewLog);
              assert.ok(input.resumePrompt?.includes(handoff.reviewBase));
              assert.ok(
                input.resumePrompt?.includes(handoff.implementationHead),
              );
              assert.ok(input.resumePrompt?.includes(JSON.stringify(handoff)));
              assert.ok(input.resumePrompt?.startsWith("Review input:"));
              for (const filename of findingsFiles) await access(filename);
            }
            assert.notEqual(reviewLog, implementationLog);
            await access(implementationLog);
            await writeFile(input.logFile, "review session");
            if (round === 3)
              return {
                outcome: "passed",
              };
            const filename = String(handoff.findingsFile);
            assert.equal(path.dirname(filename), path.join(root, "demo/logs"));
            assert.ok(!findingsFiles.includes(filename));
            findingsFiles.push(filename);
            await writeFile(filename, "# P1 finding\nFix missing validation.");
            return {
              outcome: "findings",
              findings_file: filename,
            };
          },
        },
      }),
    );
    assert.equal(
      result.summary.outcome,
      "succeeded",
      JSON.stringify(result.summary),
    );
    assert.deepEqual(
      calls,
      maximum === 1
        ? ["implement", "review", "fix"]
        : maximum === 2
          ? ["implement", "review", "fix", "review", "fix"]
          : ["implement", "review", "fix", "review", "fix", "review"],
    );
    const handoff = result.summary.handoffs![0]!;
    assert.deepEqual(handoff.commits, commits);
    assert.deepEqual(handoff.implementationCommits, commits);
    assert.deepEqual(handoff.reviewCommits, []);
    assert.equal(handoff.checks.length, maximum === 1 ? 1 : 2);
    assert.equal(handoff.prTitle, "feat: implementation");
    for (const filename of [...logs, ...findingsFiles])
      await assert.rejects(access(filename));
  }
});

test("findings pauses stay in the relevant session and retain files until success or skip", async () => {
  for (const [action, failure] of [
    ["q", "blocked"],
    ["s", "blocked"],
    ["resolve the finding", "blocked"],
    ["q", "no_change"],
  ] as const) {
    const root = await createProject();
    await writeProjectConfig(path.join(root, "demo/config.yaml"), {
      ...validConfig,
      workflow: { ...validConfig.workflow, review: true, maxReviewRounds: 1 },
    });
    const delivery = createCommittedDelivery(9);
    const implementation = {
      sha: "b".repeat(40),
      message: "feat: implementation",
    };
    const fix = { sha: "c".repeat(40), message: "fix: finding" };
    const files: string[] = [];
    let implementations = 0;
    let reviews = 0;
    let pauses = 0;
    let pushes = 0;
    let implementationLog = "";
    let reviewLog = "";
    let findingsFile = "";
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: delivery.tracker,
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async inspect(input) {
            const evidence = await delivery.gitWorkspace.inspect!(input);
            return {
              ...evidence,
              commits:
                implementations === 1
                  ? [implementation]
                  : failure === "no_change"
                    ? []
                    : [fix],
            };
          },
          async inspectReview() {
            return {
              clean: true,
              deliveryCommits: [implementation],
              reviewCommits: [],
            };
          },
          async push() {
            pushes += 1;
          },
        },
        agentExecutor: {
          async execute(input) {
            implementations += 1;
            if (implementations === 1) {
              implementationLog = input.logFile;
              files.push(input.logFile);
              await writeFile(input.logFile, "implementation");
              return delivery.agentExecutor.execute!(input);
            }
            assert.equal(input.logFile, implementationLog);
            assert.ok(input.resumePrompt);
            for (const filename of files) await access(filename);
            if (implementations === 2 && failure === "no_change")
              return {
                outcome: "no_change",
                summary: "Ignored findings",
                commits: [],
                checks: [],
                blocker: null,
                diagnostics: {
                  sessionId: "implementation-session",
                  diagnosticLogPath: implementationLog,
                },
              };
            if (implementations === 2)
              return {
                outcome: "blocked",
                summary: "Disputed finding",
                commits: [],
                checks: [],
                blocker: "Finding cannot be resolved",
                diagnostics: {
                  sessionId: "implementation-session",
                  diagnosticLogPath: implementationLog,
                },
              };
            assert.equal(input.resumePrompt, action);
            return {
              outcome: "committed",
              summary: "Fixed after guidance",
              commits: [fix],
              checks: [],
              blocker: null,
            };
          },
          async executeReview(input) {
            reviews += 1;
            const handoff = JSON.parse(
              String(input.promptArgs.REVIEW_INPUT),
            ) as { findingsFile: string };
            assert.ok(handoff.findingsFile.endsWith("-round-1.md"));
            if (reviews === 1) {
              reviewLog = input.logFile;
              files.push(input.logFile);
              await writeFile(input.logFile, "review");
              return {
                outcome: "blocked",
                blocker: "Specification unavailable",
                diagnostics: {
                  sessionId: "review-session",
                  diagnosticLogPath: reviewLog,
                },
              };
            }
            assert.equal(input.logFile, reviewLog);
            assert.equal(input.resumePrompt, "specification restored");
            findingsFile = handoff.findingsFile;
            files.push(findingsFile);
            await writeFile(findingsFile, "# P1 actionable finding");
            return {
              outcome: "findings",
              findings_file: findingsFile,
            };
          },
        },
        operator: {
          async pause(message) {
            pauses += 1;
            for (const filename of files) await access(filename);
            if (pauses === 1) {
              assert.match(message, /Provider session: review-session/u);
              return "specification restored";
            }
            assert.match(message, /Provider session: implementation-session/u);
            assert.match(
              message,
              failure === "no_change"
                ? /Review findings require an implementation fix/u
                : /Finding cannot be resolved/u,
            );
            return action;
          },
        },
      }),
    );
    assert.equal(pauses, 2);
    assert.equal(
      reviews,
      2,
      "a review continuation must not consume another round",
    );
    assert.equal(implementations, action === "resolve the finding" ? 3 : 2);
    assert.equal(
      result.summary.outcome,
      action === "q"
        ? "cancelled"
        : action === "s"
          ? "incomplete"
          : "succeeded",
    );
    assert.equal(pushes, action === "resolve the finding" ? 1 : 0);
    for (const filename of files) {
      if (action === "q") await access(filename);
      else await assert.rejects(access(filename));
    }
  }
});
