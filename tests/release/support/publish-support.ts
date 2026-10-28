import {
  createReleaseFixture,
  type FixtureOptions,
  type ReleaseFixture,
} from "./release-fixture.ts";

export const releaseRepository = "BuddyLabsCo/sandcastle-runner";

export const readyPackage = {
  manifest: {
    name: "issue-runner",
    version: "0.1.0",
    description: "Ticket-driven delivery runner",
    license: "MIT",
    type: "module",
    bin: { "issue-runner": "dist/cli.js" },
    files: ["dist", "README.md", "CHANGELOG.md"],
    engines: { node: ">=22.18.0" },
    scripts: { "release:accept": "node scripts/release-accept.mjs" },
  },
  files: {
    // Stands in for the packaged CLI: it must start from installed bytes and
    // report the version of the installed manifest.
    "dist/cli.js": [
      'import { readFileSync } from "node:fs";',
      'const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));',
      'if (process.argv.includes("--version")) console.log(manifest.version);',
      "",
    ].join("\n"),
    // The package-owned acceptance check receives the candidate tarball.
    "scripts/release-accept.mjs": [
      'import { existsSync } from "node:fs";',
      "const tarball = process.env.RELEASE_TARBALL;",
      'if (!tarball || !existsSync(tarball)) { console.error("RELEASE_TARBALL is missing"); process.exit(1); }',
      "",
    ].join("\n"),
    "README.md": "# issue-runner\n",
    "CHANGELOG.md": "# Changelog\n",
  },
};

export const releaseBody =
  "## Proposed release 0.1.1\n\n### Changelog\n\n- fix: [issue-7] repair publication\n";

export function createPublishFixture(
  t: { after: (fn: () => void) => void },
  options: FixtureOptions = readyPackage,
): ReleaseFixture {
  return createReleaseFixture(t, options);
}

export function publishEnvironment(
  mergeSha: string,
  tarball: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    GITHUB_REPOSITORY: releaseRepository,
    PR_NUMBER: "18",
    PR_MERGED: "true",
    PR_HEAD_REF: "auto-release",
    PR_BASE_REF: "main",
    PR_HEAD_REPOSITORY: releaseRepository,
    MERGE_SHA: mergeSha,
    TARBALL: tarball,
    NODE_AUTH_TOKEN: "test-npm-token",
    ...overrides,
  };
}

// A merged release pull request for 0.1.1 and the tarball packed from the
// merged commit, exactly as the publication job provides them.
export function mergedRelease(fixture: ReleaseFixture): {
  merge: string;
  tarball: string;
} {
  fixture.propose("0.1.1");
  const merge = fixture.squashMerge();
  fixture.configureGitHub({
    pullRequest: {
      number: "18",
      title: "chore: propose release v0.1.1",
      body: releaseBody,
    },
  });
  return { merge, tarball: fixture.pack(fixture.artifacts) };
}
