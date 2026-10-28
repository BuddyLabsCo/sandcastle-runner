import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
}

interface Job {
  uses?: string;
  with?: Record<string, unknown>;
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on: {
    push?: { branches?: string[] };
    pull_request?: { types?: string[]; branches?: string[] };
    workflow_call?: { inputs?: Record<string, { type?: string }> };
  };
  permissions?: { contents?: string };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
}

function workflow(name: string): Workflow {
  const source = readFileSync(
    new URL(`../../.github/workflows/${name}`, import.meta.url),
    "utf8",
  );
  return parse(source) as Workflow;
}

// Regression: a workflow that pushes with the default token would need
// contents: write, and a checkout before the App token would persist the wrong
// credential. The script tests fake `gh`, so only the wiring is observable here.
test("release proposals use the repository-scoped GitHub App token", () => {
  const file = workflow("auto-release-pr.yml");
  assert.deepEqual(file.on.push?.branches, ["main"]);
  assert.equal(file.permissions?.contents, "read");
  assert.equal(file.concurrency?.group, "auto-release-pr");
  assert.equal(file.concurrency?.["cancel-in-progress"], false);

  const steps = file.jobs["prepare-release"]?.steps ?? [];
  const token = steps.findIndex((step) =>
    step.uses?.startsWith("actions/create-github-app-token@"),
  );
  const checkout = steps.findIndex((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  const proposal = steps.find((step) =>
    step.run?.includes("scripts/release/auto-release-pr.ts"),
  );

  assert.ok(token >= 0, "The App token step must exist");
  assert.ok(
    checkout > token,
    "The App token must be generated before checkout",
  );
  assert.equal(steps[token]?.id, "app-token");
  assert.deepEqual(steps[token]?.with, {
    "app-id": "${{ secrets.APP_ID }}",
    "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
    owner: "BuddyLabsCo",
    repositories: "sandcastle-runner",
  });
  assert.equal(
    steps[checkout]?.with?.token,
    "${{ steps.app-token.outputs.token }}",
  );
  assert.equal(steps[checkout]?.with?.["fetch-depth"], 0);
  assert.ok(proposal, "The proposal script must run");
  assert.equal(proposal?.env?.GH_TOKEN, "${{ steps.app-token.outputs.token }}");
  assert.equal(proposal?.env?.PUSH_BEFORE, "${{ github.event.before }}");
  assert.ok(!JSON.stringify(file).includes("NPM_TOKEN"));
});

// Regression: publication could run without the required checks, on a moving
// tip, or with the npm token available to earlier commands.
test("publication re-checks the merged commit and isolates the npm token", () => {
  const file = workflow("publish-release.yml");
  assert.deepEqual(file.on.pull_request?.types, ["closed"]);
  assert.deepEqual(file.on.pull_request?.branches, ["main"]);
  assert.equal(file.permissions?.contents, "read");
  assert.equal(file.concurrency?.group, "publish-release");
  assert.equal(file.concurrency?.["cancel-in-progress"], false);

  const checks = file.jobs.checks;
  assert.equal(checks?.uses, "./.github/workflows/ci.yml");
  assert.equal(
    checks?.with?.ref,
    "${{ github.event.pull_request.merge_commit_sha }}",
  );
  assert.match(String(checks?.if), /merged == true/);
  assert.match(String(checks?.if), /head\.ref == 'auto-release'/);

  const publish = file.jobs.publish;
  assert.deepEqual(publish?.needs, ["checks"]);
  assert.match(String(publish?.if), /merged == true/);
  const steps = publish?.steps ?? [];
  const checkout = steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(
    checkout?.with?.ref,
    "${{ github.event.pull_request.merge_commit_sha }}",
  );
  assert.equal(checkout?.with?.["fetch-depth"], 0);

  const release = steps.find((step) =>
    step.run?.includes("scripts/release/publish-release.ts"),
  );
  assert.ok(release, "The publication script must run");
  assert.equal(release?.env?.NODE_AUTH_TOKEN, "${{ secrets.NPM_TOKEN }}");
  assert.equal(
    release?.env?.MERGE_SHA,
    "${{ github.event.pull_request.merge_commit_sha }}",
  );
  assert.equal(release?.env?.TARBALL, "${{ steps.pack.outputs.tarball }}");
  assert.equal(release?.env?.GITHUB_REPOSITORY, "${{ github.repository }}");
  for (const step of steps) {
    if (step === release) continue;
    assert.equal(step.env?.NODE_AUTH_TOKEN, undefined);
    assert.ok(!JSON.stringify(step).includes("NPM_TOKEN"));
  }
  assert.ok(!steps.some((step) => step.run?.includes("npm publish")));
});

// Regression: publication would otherwise check an event revision instead of
// the merged release commit.
test("the checks workflow accepts the exact commit to verify", () => {
  const file = workflow("ci.yml");
  assert.equal(file.on.workflow_call?.inputs?.ref?.type, "string");
  const steps = file.jobs.checks?.steps ?? [];
  const checkout = steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout?.with?.ref, "${{ inputs.ref }}");
});
