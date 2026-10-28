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
    assert.deepEqual(
      publish[0]?.args.filter((arg) =>
        ["--tag", "latest", "--access", "public"].includes(arg),
      ),
      ["--tag", "latest", "--access", "public"],
    );
    // npm authenticates through a config file, so the publication command must
    // carry the registry mapping rather than a bare environment variable.
    assert.match(
      String(publish[0]?.authConfig),
      /^registry=https:\/\/registry\.npmjs\.org\/$/m,
    );
    assert.match(
      String(publish[0]?.authConfig),
      /^\/\/registry\.npmjs\.org\/:_authToken=\$\{NODE_AUTH_TOKEN\}$/m,
    );
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

// Regression: the manifest and both lockfile locations must record one version.
for (const [field, value, expected] of [
  [
    "root",
    "0.1.0",
    /packages\[""\] version 0\.1\.0 do not match package\.json version 0\.1\.1/,
  ],
  [
    "top",
    "9.9.9",
    /top-level version 9\.9\.9 do not match package\.json version 0\.1\.1/,
  ],
] as const) {
  posixTest(
    `a lockfile whose ${field} version disagrees with the manifest is rejected`,
    (t) => {
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
      if (field === "root") root.version = value;
      else lockfile.version = value;
      lockfile.packages[""] = root;
      fixture.write(
        "package-lock.json",
        `${JSON.stringify(lockfile, null, 2)}\n`,
      );
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

      assert.match(result.stderr, expected);
      assert.equal(
        fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
        0,
      );
      assert.equal(fixture.remoteTag("v0.1.1"), "");
    },
  );
}

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

// Regression: a broad npm token must not reach earlier commands or logs, and
// only the publication command may see the registry mapping.
posixTest("only the publication command receives NODE_AUTH_TOKEN", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);

  const result = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(result.status, 0, result.stderr);
  const npm = fixture.calls("npm");
  assert.ok(npm.some(({ args }) => args[0] === "install"));
  assert.ok(npm.some(({ args }) => args[0] === "publish"));
  for (const call of npm) {
    assert.equal(
      call.token,
      call.args[0] === "publish",
      `NODE_AUTH_TOKEN leaked into npm ${call.args.join(" ")}`,
    );
    if (call.args[0] !== "publish") {
      assert.equal(
        call.authConfig,
        null,
        "Only publication may carry registry credentials",
      );
    }
  }
  assert.ok(!result.stdout.includes("test-npm-token"));
  assert.ok(!result.stderr.includes("test-npm-token"));
});

// Regression: metadata and an executable entry point do not prove the packed
// bytes start. A tarball whose CLI throws must not reach the registry.
posixTest(
  "a tarball whose executable fails is rejected before publication",
  (t) => {
    const fixture = createPublishFixture(t, {
      ...readyPackage,
      files: {
        ...readyPackage.files,
        "dist/cli.js": 'throw new Error("broken release artifact");\n',
      },
    });
    const { merge, tarball } = mergedRelease(fixture);

    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );

    assert.match(result.stderr, /--version failed/);
    assert.match(result.stderr, /broken release artifact/);
    assert.match(result.stderr, /No publication stages completed\./);
    assert.equal(
      fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
      0,
    );
    assert.equal(fixture.remoteTag("v0.1.1"), "");
    assert.equal(fixture.state().release, null);
  },
);

// Regression: the installed executable must report the version being released,
// not whatever version the packager happened to leave behind.
posixTest("an executable that reports another version is rejected", (t) => {
  const fixture = createPublishFixture(t, {
    ...readyPackage,
    files: {
      ...readyPackage.files,
      "dist/cli.js": 'console.log("0.0.0");\n',
    },
  });
  const { merge, tarball } = mergedRelease(fixture);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /reports 0\.0\.0, not 0\.1\.1/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
  assert.equal(fixture.remoteTag("v0.1.1"), "");
});

// Regression: a CLI that answers --version says nothing about the shipped
// prompts and initialization assets. Publication stays disabled until the
// package declares its own acceptance check.
posixTest("a package without a declared acceptance check is rejected", (t) => {
  const manifest = { ...readyPackage.manifest } as Record<string, unknown>;
  delete manifest.scripts;
  const fixture = createPublishFixture(t, {
    manifest,
    files: readyPackage.files,
  });
  const { merge, tarball } = mergedRelease(fixture);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /must declare a release:accept check/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
  assert.equal(fixture.remoteTag("v0.1.1"), "");
  assert.equal(fixture.state().release, null);
});

// Regression: a declared acceptance check that fails must block publication.
posixTest("a failing packaged acceptance check blocks publication", (t) => {
  const fixture = createPublishFixture(t, {
    ...readyPackage,
    files: {
      ...readyPackage.files,
      "scripts/release-accept.mjs":
        'console.error("packaged prompts are missing");\nprocess.exit(1);\n',
    },
  });
  const { merge, tarball } = mergedRelease(fixture);

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /packaged acceptance check failed/);
  assert.match(result.stderr, /packaged prompts are missing/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
  assert.equal(fixture.remoteTag("v0.1.1"), "");
  assert.equal(fixture.state().release, null);
});
