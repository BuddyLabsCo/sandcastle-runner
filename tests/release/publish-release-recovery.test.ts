import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { posixTest } from "./support/release-fixture.ts";
import {
  createPublishFixture,
  mergedRelease,
  publishEnvironment,
} from "./support/publish-support.ts";

function integrityOf(tarball: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
}

// Regression: a failed Release write after a successful registry publication
// must report the partial state and a retry must not republish the version.
posixTest(
  "npm success followed by a GitHub failure resumes without republishing",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    fixture.configureGitHub({ fail: "release create" });

    const failed = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );

    assert.match(failed.stderr, /simulated gh release create failure/);
    assert.match(failed.stderr, /Completed stages: npm, tag\./);
    assert.equal(fixture.remoteTag("v0.1.1"), merge);
    assert.equal(fixture.state().release, null);

    fixture.configureGitHub({ fail: "" });
    const retry = fixture.run(
      "publish-release",
      publishEnvironment(merge, tarball),
    );

    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(
      fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
      1,
    );
    assert.equal((fixture.state().release as { draft: boolean }).draft, false);
  },
);

// Regression: a retry after a completed release must reuse the registry
// version, the tag and the Release instead of mutating them again.
posixTest("a completed release is reused without any further mutation", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  assert.equal(
    fixture.run("publish-release", publishEnvironment(merge, tarball)).status,
    0,
  );
  const githubCalls = fixture.calls("gh").length;

  const retry = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /already complete/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    1,
  );
  const mutations = fixture
    .calls("gh")
    .slice(githubCalls)
    .filter(({ args }) => args[0] === "release" && args[1] !== "view");
  assert.deepEqual(mutations, []);
});

// Regression: the registry already holds the version with identical bytes, so
// the missing tag and Release are completed without a second publication.
posixTest(
  "a matching registry version is reused and the remaining stages complete",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    fixture.configureNpm({
      registry: { "0.1.1": integrityOf(tarball) },
      latest: "0.1.1",
    });

    const result = fixture.run(
      "publish-release",
      publishEnvironment(merge, tarball),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
      0,
    );
    assert.equal(fixture.remoteTag("v0.1.1"), merge);
    assert.deepEqual(fixture.state().release, { tag: "v0.1.1", draft: false });
  },
);

// Regression: registry contents are immutable. Different bytes for the same
// version must stop the release before the tag or Release is written.
posixTest(
  "a conflicting registry version is rejected without a tag or Release",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    fixture.configureNpm({
      registry: { "0.1.1": "sha512-conflicting" },
      latest: "0.1.1",
    });

    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );

    assert.match(result.stderr, /already published with different contents/);
    assert.equal(fixture.remoteTag("v0.1.1"), "");
    assert.equal(fixture.state().release, null);
    assert.equal(
      fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
      0,
    );
  },
);

// Regression: an expired or under-scoped token must be reported as an
// authorization failure, not as a successful or absent release.
posixTest(
  "an npm authorization failure is reported and stops the release",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    fixture.configureNpm({
      fail: "publish",
      message:
        "npm error code E401\nnpm error Unable to authenticate, need: Bearer",
    });

    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );

    assert.match(result.stderr, /rejected by the registry/);
    assert.match(result.stderr, /No publication stages completed\./);
    assert.equal(fixture.remoteTag("v0.1.1"), "");
    assert.equal(fixture.state().release, null);
  },
);

// Regression: a network failure while reading the registry must never be
// mistaken for an unpublished version.
posixTest("a registry network failure is not treated as an absence", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureNpm({
    fail: "view",
    message:
      "npm error code EAI_AGAIN\nnpm error network request to registry.npmjs.org failed",
  });

  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.match(result.stderr, /npm view .* failed \(published integrity\)/);
  assert.equal(
    fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
    0,
  );
  assert.equal(fixture.remoteTag("v0.1.1"), "");
  assert.equal(fixture.state().release, null);
});

// Regression: an interrupted Release publication leaves a draft that a retry
// publishes instead of creating a second Release.
posixTest("a draft Release is published instead of recreated", (t) => {
  const fixture = createPublishFixture(t);
  const { merge, tarball } = mergedRelease(fixture);
  fixture.configureGitHub({ release: { tag: "v0.1.1", draft: true } });

  const result = fixture.run(
    "publish-release",
    publishEnvironment(merge, tarball),
  );

  assert.equal(result.status, 0, result.stderr);
  const edits = fixture
    .calls("gh")
    .filter(({ args }) => args[0] === "release" && args[1] === "edit");
  assert.equal(edits.length, 1);
  assert.ok(edits[0]?.args.includes("--draft=false"));
  assert.equal(
    fixture
      .calls("gh")
      .filter(({ args }) => args[0] === "release" && args[1] === "create")
      .length,
    0,
  );
  assert.deepEqual(fixture.state().release, { tag: "v0.1.1", draft: false });
});
