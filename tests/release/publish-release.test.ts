import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { posixTest } from "./support/release-fixture.ts";
import {
  createPublishFixture,
  mergedRelease,
  publishEnvironment,
  readyPackage,
  releaseBody,
} from "./support/publish-support.ts";

// Regression: publishing bytes other than the tested candidate, or recording a
// tag on a different commit. Observe the tag, the registry entry and the Release.
posixTest(
  "a squash-merged release publishes the candidate tarball, its tag and Release",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);

    const result = fixture.run(
      "publish-release",
      publishEnvironment(merge, tarball),
    );

    assert.equal(result.status, 0, result.stderr);
    const publish = fixture
      .calls("npm")
      .filter(({ args }) => args[0] === "publish");
    assert.equal(publish.length, 1);
    assert.equal(publish[0]?.args[1], tarball);
    assert.deepEqual(publish[0]?.args.slice(2), [
      "--tag",
      "latest",
      "--access",
      "public",
    ]);
    assert.equal(fixture.remoteTag("v0.1.1"), merge);
    const release = fixture.state().release as { tag: string; draft: boolean };
    assert.deepEqual(release, { tag: "v0.1.1", draft: false });
    const create = fixture
      .calls("gh")
      .find(({ args }) => args[0] === "release" && args[1] === "create");
    assert.equal(
      create?.args[create.args.indexOf("--notes") + 1],
      releaseBody.trimEnd(),
    );
  },
);

// Regression: only the release branch of this repository, merged into main, may
// publish. Observe that no registry, tag or Release write happens.
for (const [name, overrides, expected] of [
  [
    "a closed but unmerged pull request",
    { PR_MERGED: "false" },
    /Only a merged pull request/,
  ],
  [
    "a pull request from another branch",
    { PR_HEAD_REF: "feature/release" },
    /must be published from the auto-release branch/,
  ],
  [
    "a pull request into another branch",
    { PR_BASE_REF: "develop" },
    /must be merged into main/,
  ],
  [
    "a fork of the release branch",
    { PR_HEAD_REPOSITORY: "attacker/sandcastle-runner" },
    /must come from BuddyLabsCo\/sandcastle-runner/,
  ],
] as const) {
  posixTest(`${name} is rejected before any publication`, (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);

    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball, overrides),
    );

    assert.match(result.stderr, expected);
    assert.equal(fixture.remoteTag("v0.1.1"), "");
    assert.equal(fixture.calls("npm").length, 0);
    assert.equal(fixture.calls("gh").length, 0);
  });
}

// Regression: a merge commit would tag code that never passed the release
// review, and an unpushed commit is not the merged release.
posixTest("a merge commit is rejected", (t) => {
  const fixture = createPublishFixture(t);
  fixture.propose("0.1.1");
  const merge = fixture.mergeCommit();
  const tarball = fixture.pack(fixture.artifacts);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /squashed or rebased|merge commit/);
  assert.equal(fixture.remoteTag("v0.1.1"), "");
});

posixTest("a commit outside the target branch is rejected", (t) => {
  const fixture = createPublishFixture(t);
  const { tarball } = mergedRelease(fixture);
  fixture.commit(
    "dist/cli.js",
    "export const extra = true;\n",
    "Unpushed work",
  );

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(fixture.head(), tarball),
  );

  assert.match(result.stderr, /not contained in origin\/main/);
  assert.equal(fixture.remoteTag("v0.1.1"), "");
});

// Regression: the release commit must carry the published version in both the
// manifest and the lockfile.
posixTest("a malformed release version is rejected", (t) => {
  const fixture = createPublishFixture(t);
  fixture.propose("1.10");
  const merge = fixture.squashMerge();
  const tarball = fixture.pack(fixture.artifacts);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /three-part release version/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
});

posixTest("a lockfile that disagrees with the manifest is rejected", (t) => {
  const fixture = createPublishFixture(t);
  fixture.propose("0.1.1");
  fixture.git("checkout", "auto-release");
  const lockfile = JSON.parse(
    readFileSync(path.join(fixture.cwd, "package-lock.json"), "utf8"),
  ) as {
    version?: string;
    packages: Record<string, { version?: string }>;
  };
  const root = lockfile.packages[""] ?? {};
  root.version = "0.1.0";
  lockfile.packages[""] = root;
  lockfile.version = "0.1.0";
  fixture.write("package-lock.json", `${JSON.stringify(lockfile, null, 2)}\n`);
  fixture.git("add", ".");
  fixture.git("commit", "-m", "test: desynchronize the lockfile");
  fixture.git("push", "origin", "auto-release");
  fixture.git("checkout", "main");
  const merge = fixture.squashMerge();
  const tarball = fixture.pack(fixture.artifacts);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(
    result.stderr,
    /package-lock\.json version 0\.1\.0 does not match package\.json version 0\.1\.1/,
  );
});

// Regression: publication of an incomplete package. The current private,
// source-only manifest must keep publication disabled.
posixTest("an unpublished package shape keeps publication disabled", (t) => {
  const fixture = createPublishFixture(t, {
    manifest: {
      name: "sandcastle-runner",
      private: true,
      version: "0.1.0",
      type: "module",
    },
    files: { "src/cli.ts": "export const value = 1;\n" },
  });
  const { merge, tarball } = mergedRelease(fixture);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /is not publication-ready/);
  assert.match(result.stderr, /must not be private/);
  assert.match(result.stderr, /must name issue-runner/);
  assert.match(result.stderr, /must declare a files allowlist/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
  assert.equal(fixture.remoteTag("v0.1.1"), "");
  assert.equal(fixture.state().release, null);
});

// Regression: the workflow could pack one commit and publish another version.
posixTest("a tarball from another version is rejected", (t) => {
  const fixture = createPublishFixture(t);
  const stale = fixture.pack(fixture.artifacts);
  fixture.propose("0.1.1");
  const merge = fixture.squashMerge();

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, stale),
  );

  assert.match(
    result.stderr,
    /the tarball is issue-runner@0\.1\.0, not issue-runner@0\.1\.1/,
  );
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
});

// Regression: packing a checkout that diverged from the release commit would
// publish metadata that never passed review.
posixTest("a tarball packed from a modified checkout is rejected", (t) => {
  const fixture = createPublishFixture(t);
  fixture.propose("0.1.1");
  const merge = fixture.squashMerge();
  const manifest = JSON.parse(
    readFileSync(path.join(fixture.cwd, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  manifest.description = "Changed after the release commit";
  fixture.write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const tarball = fixture.pack(fixture.artifacts);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /does not match the release commit/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
});

posixTest("a tarball without the declared executable is rejected", (t) => {
  const fixture = createPublishFixture(t, {
    manifest: {
      ...readyPackage.manifest,
      bin: { "issue-runner": "dist/absent.js" },
    },
    files: readyPackage.files,
  });
  const { merge, tarball } = mergedRelease(fixture);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(
    result.stderr,
    /must contain the declared executable dist\/absent\.js/,
  );
});

// Regression: an existing tag is the version ledger. A conflicting tag target
// must stop the release before the registry is touched.
posixTest(
  "a tag that points at another commit is rejected before publishing",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    const other = fixture.git("rev-parse", "HEAD~1");
    fixture.git("tag", "v0.1.1", other);
    fixture.git("push", "origin", "refs/tags/v0.1.1");

    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );

    assert.match(result.stderr, /Tag v0\.1\.1 already points at/);
    assert.equal(fixture.remoteTag("v0.1.1"), other);
    assert.equal(
      fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
      0,
    );
    assert.equal(fixture.state().release, null);
  },
);

// Regression: a broad npm token must not reach earlier commands or logs.
posixTest("only the publication command receives NODE_AUTH_TOKEN", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);

  const result = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(result.status, 0, result.stderr);
  const npm = fixture.calls("npm");
  assert.ok(npm.some(({ args }) => args[0] === "publish"));
  for (const call of npm) {
    assert.equal(
      call.token,
      call.args[0] === "publish",
      `NODE_AUTH_TOKEN leaked into npm ${call.args.join(" ")}`,
    );
  }
  assert.ok(!result.stdout.includes("test-npm-token"));
  assert.ok(!result.stderr.includes("test-npm-token"));
});
