import assert from "node:assert/strict";

import {
  createReleaseFixture,
  posixTest,
  type ReleaseFixture,
} from "./support/release-fixture.ts";

// Writes the three release files for a proposal commit and returns the SHA
// before it, so the push range is exactly the merged proposal.
function commitReleaseFiles(
  fixture: ReleaseFixture,
  version: string,
  subject: string,
): string {
  const before = fixture.head();
  fixture.write(
    "package.json",
    `${JSON.stringify({ name: "issue-runner", version, type: "module" }, null, 2)}\n`,
  );
  fixture.write(
    "package-lock.json",
    `${JSON.stringify({ name: "issue-runner", version, lockfileVersion: 3, requires: true, packages: { "": { name: "issue-runner", version } } }, null, 2)}\n`,
  );
  fixture.write(
    "CHANGELOG.md",
    `# Changelog\n\n## ${version}\n\n- feat: [issue-8] add shipped behavior\n`,
  );
  fixture.git("add", ".");
  fixture.git("commit", "-m", subject);
  return before;
}

function manifestVersion(text: string): string | undefined {
  const manifest = JSON.parse(text) as { version?: string };
  return manifest.version;
}

function lockedVersion(text: string): string | undefined {
  const lockfile = JSON.parse(text) as {
    packages?: Record<string, { version?: string }>;
  };
  return lockfile.packages?.[""]?.version;
}

// Regression: the first formal release starts at 0.1.0 and a single proposal
// carries the manifest, lockfile and changelog for human review.
posixTest(
  "an untagged repository proposes 0.1.0 with manifest, lockfile and changelog",
  (t) => {
    const fixture = createReleaseFixture(t, {
      files: { "src/app.ts": "export const value = 1;\n" },
    });
    const before = fixture.commit(
      "src/app.ts",
      "export const value = 2;\n",
      "feat: [issue-1] add shipped behavior",
    );

    const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fixture.calls("gh").filter(({ args }) => args[1] === "create").length,
      1,
    );
    assert.equal(fixture.remoteHeads("auto-release"), fixture.head());
    fixture.git("fetch", "origin", "auto-release");
    assert.equal(
      manifestVersion(fixture.git("show", "origin/auto-release:package.json")),
      "0.1.0",
    );
    assert.equal(
      lockedVersion(
        fixture.git("show", "origin/auto-release:package-lock.json"),
      ),
      "0.1.0",
    );
    const changelog = fixture.git("show", "origin/auto-release:CHANGELOG.md");
    assert.match(changelog, /## 0\.1\.0/);
    assert.match(changelog, /- feat: \[issue-1\] add shipped behavior/);
    assert.match(
      String((fixture.state().pullRequest as { body: string }).body),
      /Proposed release 0\.1\.0/,
    );
  },
);

// Regression: packaging seeds 0.1.0 before the first release, and seeding must
// not turn the first proposal into a patch bump.
posixTest(
  "packaging that already seeds 0.1.0 keeps the first proposal at 0.1.0",
  (t) => {
    const fixture = createReleaseFixture(t, {
      manifest: { name: "issue-runner", version: "0.1.0", type: "module" },
      files: { "dist/cli.js": "export {};\n" },
    });
    const before = fixture.commit(
      "dist/cli.js",
      "export const value = 1;\n",
      "feat: [issue-8] add shipped behavior",
    );

    const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

    assert.equal(result.status, 0, result.stderr);
    fixture.git("fetch", "origin", "auto-release");
    assert.equal(
      manifestVersion(fixture.git("show", "origin/auto-release:package.json")),
      "0.1.0",
    );
  },
);

// Regression: automation must keep one version trail. A tagged release makes
// the next proposal a patch, and the changelog starts at that tag.
posixTest(
  "a subsequent proposal increments the patch and versions only new commits",
  (t) => {
    const fixture = createReleaseFixture(t, {
      manifest: { name: "issue-runner", version: "0.1.0", type: "module" },
      files: { "dist/cli.js": "export {};\n" },
    });
    fixture.git("tag", "v0.1.0");
    fixture.git("push", "origin", "v0.1.0");
    const before = fixture.commit(
      "dist/cli.js",
      "export const value = 1;\n",
      "fix: [issue-2] repair startup",
    );

    const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

    assert.equal(result.status, 0, result.stderr);
    fixture.git("fetch", "origin", "auto-release");
    assert.equal(
      manifestVersion(fixture.git("show", "origin/auto-release:package.json")),
      "0.1.1",
    );
    const changelog = fixture.git("show", "origin/auto-release:CHANGELOG.md");
    assert.match(changelog, /## 0\.1\.1/);
    assert.ok(!changelog.includes("Initial implementation"));
    assert.match(
      String((fixture.state().pullRequest as { body: string }).body),
      /v0\.1\.0/,
    );
  },
);

// Regression: the reference flow excluded Markdown, which would drop shipped
// prompts, while workflow-only edits must not propose a release.
posixTest(
  "shipped Markdown prompts are eligible and workflow edits are not",
  (t) => {
    const fixture = createReleaseFixture(t, {
      files: { "src/prompts/agent-attempt-input.md": "Task context\n" },
    });
    const workflowOnly = fixture.commit(
      ".github/workflows/ci.yml",
      "name: CI\n",
      "ci: tune checks",
    );
    const skipped = fixture.run("auto-release-pr", {
      PUSH_BEFORE: workflowOnly,
    });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(fixture.remoteHeads("auto-release"), "");
    assert.equal(
      fixture.calls("gh").length,
      1,
      "Only the open pull request lookup may run",
    );

    const prompt = fixture.commit(
      "src/prompts/agent-attempt-input.md",
      "Updated task context\n",
      "feat: [issue-3] sharpen task context",
    );
    const proposed = fixture.run("auto-release-pr", { PUSH_BEFORE: prompt });
    assert.equal(proposed.status, 0, proposed.stderr);
    fixture.git("fetch", "origin", "auto-release");
    assert.match(
      fixture.git("show", "origin/auto-release:CHANGELOG.md"),
      /- feat: \[issue-3\] sharpen task context/,
    );
  },
);

// Regression: the merge of the release proposal changes only the release files
// and must not start the next proposal.
posixTest("a release-only merge proposes nothing", (t) => {
  const fixture = createReleaseFixture(t, {
    manifest: { name: "issue-runner", version: "0.1.0", type: "module" },
    files: { "dist/cli.js": "export {};\n" },
  });
  fixture.git("tag", "v0.1.0");
  fixture.git("push", "origin", "v0.1.0");
  const before = fixture.head();
  fixture.write(
    "package.json",
    `${JSON.stringify({ name: "issue-runner", version: "0.1.1", type: "module" }, null, 2)}\n`,
  );
  fixture.write(
    "package-lock.json",
    `${JSON.stringify({ name: "issue-runner", version: "0.1.1", lockfileVersion: 3, requires: true, packages: { "": { name: "issue-runner", version: "0.1.1" } } }, null, 2)}\n`,
  );
  fixture.write(
    "CHANGELOG.md",
    "# Changelog\n\n## 0.1.1\n\n- fix: [issue-2] repair startup\n",
  );
  fixture.git("add", ".");
  fixture.git("commit", "-m", "chore: propose release v0.1.1");

  const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.remoteHeads("auto-release"), "");
  assert.equal(
    fixture.calls("gh").filter(({ args }) => args[1] === "create").length,
    0,
  );
});

// Regression: when packaging seeds 0.1.0, the first release merge does not
// increase the version. It is still the release merge and must not propose.
posixTest("merging a seeded first proposal proposes nothing", (t) => {
  const fixture = createReleaseFixture(t, {
    manifest: { name: "issue-runner", version: "0.1.0", type: "module" },
    files: { "dist/cli.js": "export {};\n" },
  });
  const before = fixture.head();
  fixture.write(
    "package-lock.json",
    `${JSON.stringify({ name: "issue-runner", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "issue-runner", version: "0.1.0" } } }, null, 2)}\n`,
  );
  fixture.write(
    "CHANGELOG.md",
    "# Changelog\n\n## 0.1.0\n\n- feat: [issue-8] add shipped behavior\n",
  );
  fixture.git("add", ".");
  fixture.git("commit", "-m", "chore: propose release v0.1.0");

  const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.remoteHeads("auto-release"), "");
  assert.equal(
    fixture.calls("gh").filter(({ args }) => args[1] === "create").length,
    0,
  );
});

// Regression: a human may edit the squash title, so the merged release pull
// request identifies the release merge.
posixTest(
  "an edited squash subject still suppresses the release merge",
  (t) => {
    const fixture = createReleaseFixture(t, {
      manifest: { name: "issue-runner", version: "0.1.0", type: "module" },
      files: { "dist/cli.js": "export {};\n" },
    });
    const before = commitReleaseFiles(fixture, "0.1.0", "chore: release 0.1.0");
    fixture.configureGitHub({
      mergedPullRequest: {
        number: "17",
        mergeCommit: { oid: fixture.head() },
      },
    });

    const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.remoteHeads("auto-release"), "");
    assert.equal(
      fixture.calls("gh").filter(({ args }) => args[1] === "create").length,
      0,
    );
  },
);

// Regression: a rebase merge can end with a maintainer's version-adjustment
// commit, and the whole rebased range is still the release merge.
posixTest(
  "a rebased release with a trailing adjustment proposes nothing",
  (t) => {
    const fixture = createReleaseFixture(t, {
      manifest: { name: "issue-runner", version: "0.1.0", type: "module" },
      files: { "dist/cli.js": "export {};\n" },
    });
    const before = commitReleaseFiles(fixture, "0.1.0", "chore: release 0.1.0");
    fixture.write(
      "package.json",
      `${JSON.stringify({ name: "issue-runner", version: "1.0.0", type: "module" }, null, 2)}\n`,
    );
    fixture.write(
      "package-lock.json",
      `${JSON.stringify({ name: "issue-runner", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "issue-runner", version: "1.0.0" } } }, null, 2)}\n`,
    );
    fixture.git("add", ".");
    fixture.git("commit", "-m", "chore: maintain the major version");
    fixture.configureGitHub({
      mergedPullRequest: {
        number: "17",
        mergeCommit: { oid: fixture.head() },
      },
    });

    const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.remoteHeads("auto-release"), "");
  },
);

// Regression: a dependency-only change after a release merge stays eligible
// even though the release branch was merged recently.
posixTest("a dependency-only change after a release merge is proposed", (t) => {
  const fixture = createReleaseFixture(t, {
    manifest: { name: "issue-runner", version: "0.1.0", type: "module" },
    files: { "dist/cli.js": "export {};\n" },
  });
  fixture.tag("v0.1.0");
  const released = fixture.head();
  const before = fixture.head();
  fixture.write(
    "package.json",
    `${JSON.stringify({ name: "issue-runner", version: "0.1.0", type: "module", dependencies: { yaml: "2.9.1" } }, null, 2)}\n`,
  );
  fixture.write(
    "package-lock.json",
    `${JSON.stringify({ name: "issue-runner", version: "0.1.0", lockfileVersion: 3, requires: true, packages: { "": { name: "issue-runner", version: "0.1.0", dependencies: { yaml: "2.9.1" } } } }, null, 2)}\n`,
  );
  fixture.git("add", ".");
  fixture.git("commit", "-m", "chore: bump yaml");
  fixture.configureGitHub({
    mergedPullRequest: {
      number: "17",
      mergeCommit: { oid: released },
    },
  });

  const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

  assert.equal(result.status, 0, result.stderr);
  fixture.git("fetch", "origin", "auto-release");
  assert.equal(
    manifestVersion(fixture.git("show", "origin/auto-release:package.json")),
    "0.1.1",
  );
});

// Regression: a maintainer who already raised the manifest version on main
// keeps that version; automation must not bump it again.
posixTest(
  "an explicitly maintained version on main is proposed unchanged",
  (t) => {
    const fixture = createReleaseFixture(t, {
      manifest: { name: "issue-runner", version: "0.2.0", type: "module" },
      files: { "dist/cli.js": "export {};\n" },
    });
    fixture.tag("v0.1.0");
    const before = fixture.commit(
      "dist/cli.js",
      "export const value = 1;\n",
      "feat: [issue-9] add shipped behavior",
    );

    const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

    assert.equal(result.status, 0, result.stderr);
    fixture.git("fetch", "origin", "auto-release");
    assert.equal(
      manifestVersion(fixture.git("show", "origin/auto-release:package.json")),
      "0.2.0",
    );
  },
);

// Regression: a fresh runner has no Git identity configured, so the proposal
// must author its commit rather than failing before the pull request exists.
posixTest("the proposal commits with the automation identity", (t) => {
  const fixture = createReleaseFixture(t, {
    files: { "src/app.ts": "export const value = 1;\n" },
  });
  const before = fixture.commit(
    "src/app.ts",
    "export const value = 2;\n",
    "feat: [issue-10] add shipped behavior",
  );
  fixture.git("config", "--unset", "user.name");
  fixture.git("config", "--unset", "user.email");

  const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

  assert.equal(result.status, 0, result.stderr);
  fixture.git("fetch", "origin", "auto-release");
  assert.equal(
    fixture.git("log", "-1", "--pretty=%an <%ae>", "origin/auto-release"),
    "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
  );
});

// Regression: refreshing must not overwrite an explicitly maintained minor or
// major version, and must not open a second proposal.
posixTest(
  "an open proposal keeps a maintainer-proposed version and is refreshed",
  (t) => {
    const fixture = createReleaseFixture(t, {
      manifest: { name: "issue-runner", version: "0.1.0", type: "module" },
      files: { "dist/cli.js": "export {};\n" },
    });
    fixture.git("tag", "v0.1.0");
    fixture.git("push", "origin", "v0.1.0");
    fixture.git("checkout", "-b", "auto-release");
    fixture.write(
      "package.json",
      `${JSON.stringify({ name: "issue-runner", version: "2.0.0", type: "module" }, null, 2)}\n`,
    );
    fixture.write(
      "package-lock.json",
      `${JSON.stringify({ name: "issue-runner", version: "2.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "issue-runner", version: "2.0.0" } } }, null, 2)}\n`,
    );
    fixture.git("add", ".");
    fixture.git("commit", "-m", "chore: propose release v2.0.0");
    fixture.git("push", "origin", "auto-release");
    fixture.git("checkout", "main");
    fixture.configureGitHub({
      pullRequest: { number: "17", title: "proposal", body: "old body" },
    });

    const before = fixture.commit(
      "dist/cli.js",
      "export const fixed = true;\n",
      "fix: [issue-4] repair release path",
    );
    const result = fixture.run("auto-release-pr", { PUSH_BEFORE: before });

    assert.equal(result.status, 0, result.stderr);
    fixture.git("fetch", "origin", "auto-release");
    assert.equal(
      manifestVersion(fixture.git("show", "origin/auto-release:package.json")),
      "2.0.0",
    );
    assert.equal(
      fixture.calls("gh").filter(({ args }) => args[1] === "create").length,
      0,
    );
    const edit = fixture.calls("gh").filter(({ args }) => args[1] === "edit");
    assert.equal(edit.length, 1);
    assert.match(String(edit[0]?.body), /Proposed release 2\.0\.0/);
    assert.match(String(edit[0]?.body), /fix: \[issue-4\] repair release path/);
    assert.match(
      fixture.git("show", "origin/auto-release:CHANGELOG.md"),
      /## 2\.0\.0/,
    );
  },
);

// Regression: a malformed manifest must fail loudly instead of inventing a
// replacement version.
posixTest("a malformed manifest version fails without a proposal", (t) => {
  const fixture = createReleaseFixture(t, {
    manifest: { name: "issue-runner", version: "1.10", type: "module" },
    files: { "dist/cli.js": "export {};\n" },
  });
  const before = fixture.commit(
    "dist/cli.js",
    "export const value = 1;\n",
    "fix: [issue-5] repair",
  );

  const result = fixture.runExpectingFailure("auto-release-pr", {
    PUSH_BEFORE: before,
  });

  assert.match(result.stderr, /three-part release version/);
  assert.equal(fixture.remoteHeads("auto-release"), "");
  assert.equal(
    fixture.calls("gh").filter(({ args }) => args[1] === "create").length,
    0,
  );
});

// Regression: a failed GitHub write must surface as a failed job.
posixTest("a failed pull request creation fails the proposal", (t) => {
  const fixture = createReleaseFixture(t, {
    files: { "src/app.ts": "export const value = 1;\n" },
  });
  fixture.configureGitHub({ fail: "pr create" });
  const before = fixture.commit(
    "src/app.ts",
    "export const value = 2;\n",
    "feat: [issue-6] add behavior",
  );

  const result = fixture.runExpectingFailure("auto-release-pr", {
    PUSH_BEFORE: before,
  });

  assert.match(result.stderr, /simulated gh pr create failure/);
});
