import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import {
  createCliDependencies,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

async function configureIssueList(
  root: string,
  issueList: number[],
): Promise<void> {
  const configPath = `${root}/projects/demo/config.json`;
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    issueList: number[];
  };
  config.issueList = issueList;
  await writeFile(configPath, JSON.stringify(config));
}

test("value-less issue processes eligible entries whose successors are blocked", async () => {
  const root = await createProject();
  await configureIssueList(root, [41, 42]);
  const delivery = createCommittedBatch(41, 42);
  const merged = new Set<number>();

  const result = await executeCli(
    ["run", "--project", "demo", "--issue"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async listBlockersPage(_repository, ticket) {
          return {
            blockers:
              ticket === 42
                ? [delivery.tickets.find(({ number }) => number === 41)!]
                : [],
            nextPage: null,
          };
        },
      },
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: delivery.agentExecutor,
      codeHost: {
        async createPullRequest({ branch }) {
          const ticket = Number(branch.split("-").at(-1));
          return {
            number: ticket,
            url: `https://github.com/owner/repo/pull/${ticket}`,
          };
        },
        async getPullRequest(_repository, pullRequest) {
          return {
            headSha: String(pullRequest).at(-1)!.repeat(40),
            createdAt: "2026-09-09T00:00:00Z",
            merged: merged.has(pullRequest),
            mergeFailure: null,
          };
        },
        async requestSquashMerge({ pullRequest }) {
          merged.add(pullRequest);
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.batch, [41, 42]);
  assert.deepEqual(result.summary.completedTickets, [41, 42]);
  assert.ok(
    result.summary.reasons.includes("blocked Delivery Tickets: 42"),
    `expected the blocked entry to be reported: ${result.summary.reasons.join("; ")}`,
  );
});

test("value-less issue reports blocked entries without reserving any", async () => {
  const root = await createProject();
  await configureIssueList(root, [41, 42]);
  const writes: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--issue"],
    createCliDependencies(root, {
      tracker: {
        async listBlockersPage() {
          return {
            blockers: [
              {
                number: 99,
                state: "open",
                stateReason: null,
                repository: "owner/repo",
              },
            ],
            nextPage: null,
          };
        },
        async addLabel(_repository, ticket) {
          writes.push(`label:${ticket}`);
        },
        async addAssignee(_repository, ticket) {
          writes.push(`assignee:${ticket}`);
        },
      },
    }),
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(result.summary.batch, []);
  assert.deepEqual(result.summary.reasons, [
    "blocked Delivery Tickets: 41",
    "blocked Delivery Tickets: 42",
  ]);
  assert.deepEqual(writes, []);
});
