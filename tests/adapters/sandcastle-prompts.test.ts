import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RunOptions } from "@ai-hero/sandcastle";

import {
  committed,
  createExecutor,
  input,
  reviewInput,
} from "../support/sandcastle.ts";
import { registerTempRoot } from "../support/temp-cleanup.ts";

test("Runner supplies task context even when project prompts contain only user instructions", async () => {
  const directory = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "runner-prompts-")),
  );
  const promptFile = path.join(directory, "user.md");
  await writeFile(promptFile, "Follow this project's instructions.");
  for (const purpose of [
    "implement",
    "review",
    "ciRepair",
    "conflictRepair",
    "documentation",
  ]) {
    const prompts: RunOptions[] = [];
    const review = purpose === "review";
    const output = review ? { outcome: "passed" } : committed;
    const tag = review ? "review_attempt_result" : "agent_attempt_result";
    const executor = createExecutor(async (options) => {
      prompts.push(options);
      return {
        iterations: [{ sessionId: "session-id" }],
        stdout: `<${tag}>${JSON.stringify(output)}</${tag}>`,
        commits: [],
        branch: input().branch,
        output,
      };
    });
    const context = {
      TICKET_REFERENCE: "owner/repo#9",
      ...(purpose === "ciRepair"
        ? { FAILED_CHECKS: "Required build failed" }
        : {}),
      ...(purpose === "conflictRepair"
        ? {
            TARGET_BRANCH_SHA: "c".repeat(40),
            MERGE_CONFLICT: "Conflict in src/main.ts",
          }
        : {}),
    };
    if (review) {
      await executor.executeReview({
        ...reviewInput(),
        promptFile,
        promptArgs: {
          REVIEW_HANDOFF: JSON.stringify({
            ...context,
            worktree: input().worktree,
            deliveryBranch: input().branch,
            reviewBase: input().base,
            implementationHead: "b".repeat(40),
            findingsFile: "/runner/logs/findings.md",
          }),
        },
      });
    } else {
      await executor.execute({ ...input(), promptFile, promptArgs: context });
    }
    const prompt = String(prompts[0]?.prompt);
    for (const value of [
      input().worktree,
      input().branch,
      input().base,
      ...Object.values(context),
    ])
      assert.ok(prompt.includes(value), `${purpose}: missing ${value}`);
    assert.match(prompt, /Follow this project's instructions/u);
    assert.match(prompt, /Work only in the supplied Worktree/u);
    assert.match(prompt, /Do not fetch or pull/u);
    assert.ok(prompt.includes(`<${tag}>`));
    assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/u);
    if (review) {
      assert.ok(prompt.includes("/runner/logs/findings.md"));
      assert.ok(prompt.includes("b".repeat(40)));
    }
  }
});
