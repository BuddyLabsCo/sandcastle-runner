import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { cleanupTempRoots, registerTempRoot } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

async function executeInformational(args: string[]) {
  const launch = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "issue-runner-info-")),
  );
  const messages: string[] = [];
  let externalCalls = 0;
  const dependencies = createCliDependencies(launch, {
    env: {},
    tracker: {
      async getParent() {
        externalCalls += 1;
        throw new Error("informational output must not read the tracker");
      },
    },
    operator: {
      write(message) {
        messages.push(message);
      },
      async pause() {
        assert.fail("informational output must not pause");
      },
    },
  });
  const result = await executeCli(args, dependencies);
  assert.equal(await readdir(launch).then((entries) => entries.length), 0);
  assert.equal(externalCalls, 0);
  return { result, output: messages.join("\n") };
}

test("top-level help explains setup and points to Run help", async () => {
  for (const args of [["--help"], ["-h"], []]) {
    const { result, output } = await executeInformational(args);
    assert.equal(result.exitCode, 0);
    assert.match(output, /usage: issue-runner/u);
    assert.match(output, /init --project <project-key>/u);
    assert.match(output, /run --project <project-key>/u);
    assert.match(output, /Edit <project-key>\/config\.yaml/u);
    assert.match(output, /issue-runner run --help/u);
  }
});

test("Run and init help list options, constraints, and examples", async () => {
  const run = await executeInformational(["run", "--help"]);
  assert.equal(run.result.exitCode, 0);
  for (const option of [
    "--project",
    "--parent",
    "--issue",
    "--document",
    "--no-auto-merge",
  ]) {
    assert.ok(run.output.includes(option), option);
  }
  assert.match(run.output, /Exactly one of --parent, --issue, or --document/u);
  assert.match(run.output, /^usage: issue-runner run --project/u);
  assert.doesNotMatch(run.output, /--auto-merge/u);
  assert.match(run.output, /Standalone Issue \(--issue <issue-number>\)/u);
  assert.match(run.output, /or --document, and accepts no value/u);
  assert.match(
    run.output,
    /issue-runner run --project my-project --parent 42/u,
  );

  const short = await executeInformational(["run", "-h"]);
  assert.equal(short.result.exitCode, 0);
  assert.equal(short.output, run.output);

  const init = await executeInformational(["init", "-h"]);
  assert.equal(init.result.exitCode, 0);
  assert.match(
    init.output,
    /^usage: issue-runner init --project <project-key>/u,
  );
  assert.match(init.output, /prompts\/\{implement,review,documentation\}\.md/u);
  assert.doesNotMatch(init.output, /The copy performs/u);
});

test("--version reports the executing package version without a Project", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as { version: string };
  const { result, output } = await executeInformational(["--version"]);
  assert.equal(result.exitCode, 0);
  assert.equal(output, manifest.version);
});
