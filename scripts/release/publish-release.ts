// Publishes the npm tarball of a human-merged release pull request and records
// the matching tag and GitHub Release.
//
//   GITHUB_REPOSITORY=<owner/repo> PR_NUMBER=<n> PR_MERGED=true \
//   PR_HEAD_REF=auto-release PR_BASE_REF=main \
//   PR_HEAD_REPOSITORY=<owner/repo> MERGE_SHA=<squash commit> \
//   TARBALL=<packed tarball> NODE_AUTH_TOKEN=<npm token> \
//     node scripts/release/publish-release.ts
//
// Requires git, gh, and npm in a clean checkout of MERGE_SHA. The tarball must
// have been packed from that same commit after the required checks passed.
// Tests: node --test "tests/release/publish-release*.test.ts"
//
// Only a merged pull request from this repository's release branch into the
// target branch may publish, and the merged commit must be a squash or rebase
// result contained in the target branch. Every registry, tag and Release write
// is preceded by read-only validation, and a re-run reuses stages that already
// match the release identity instead of republishing them.
//
// NODE_AUTH_TOKEN is read at the publication boundary only: every earlier
// command runs without it.
import {
  LOCKFILE_FILE,
  MANIFEST_FILE,
  PACKAGE_NAME,
  RELEASE_BRANCH,
  TARGET_BRANCH,
  execute,
  gh,
  git,
  lockfileVersion,
  manifestVersion,
  readJsonText,
  readManifest,
  readTextAt,
  tagName,
  withoutNpmToken,
} from "./release-lib.ts";
import { inspectPackageArtifact } from "./package-artifact.ts";

const completed: string[] = [];

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function isAncestor(commit: string): boolean {
  return (
    execute(
      "git",
      ["merge-base", "--is-ancestor", commit, `origin/${TARGET_BRANCH}`],
      {
        env: withoutNpmToken(),
      },
    ).status === 0
  );
}

// The workflow filters on the release branch; this is the authority that
// rejects every other input before a registry, tag or Release write.
function validateMergedPullRequest(): string {
  const repository = requireEnvironment("GITHUB_REPOSITORY");
  if (requireEnvironment("PR_MERGED") !== "true") {
    throw new Error("Only a merged pull request can publish a release");
  }
  if (requireEnvironment("PR_HEAD_REF") !== RELEASE_BRANCH) {
    throw new Error(
      `A release must be published from the ${RELEASE_BRANCH} branch`,
    );
  }
  if (requireEnvironment("PR_BASE_REF") !== TARGET_BRANCH) {
    throw new Error(`A release must be merged into ${TARGET_BRANCH}`);
  }
  if (requireEnvironment("PR_HEAD_REPOSITORY") !== repository) {
    throw new Error(
      `A release must come from ${repository}, not ${String(process.env.PR_HEAD_REPOSITORY)}`,
    );
  }
  requireEnvironment("PR_NUMBER");
  const merge = requireEnvironment("MERGE_SHA");
  if (!/^[a-f0-9]{40}$/.test(merge)) {
    throw new Error(`MERGE_SHA must be a commit SHA, found ${merge}`);
  }
  git(
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${TARGET_BRANCH}:refs/remotes/origin/${TARGET_BRANCH}`,
  );
  const head = git("rev-parse", "HEAD");
  if (head !== merge) {
    throw new Error(
      `Check out the merged release commit ${merge}; the checkout is at ${head}`,
    );
  }
  const [commit, ...parents] = git("rev-list", "--parents", "-n", "1", merge)
    .trim()
    .split(" ");
  if (commit !== merge) {
    throw new Error(`Merge commit ${merge} is not in this checkout`);
  }
  if (parents.length !== 1) {
    throw new Error(
      `Release pull requests must be squashed or rebased into ${TARGET_BRANCH}, not merged with a merge commit`,
    );
  }
  if (!isAncestor(merge)) {
    throw new Error(
      `Merge commit ${merge} is not contained in origin/${TARGET_BRANCH}`,
    );
  }
  return merge;
}

interface Release {
  version: string;
  tag: string;
}

function validateReleaseCommit(merge: string): Release {
  const manifestText = readTextAt(merge, MANIFEST_FILE);
  if (manifestText === null)
    throw new Error(`The release commit does not contain ${MANIFEST_FILE}`);
  const manifest = readManifest(manifestText, "release");
  const version = manifestVersion(manifest, "release");
  if (version === null) {
    throw new Error(`The release ${MANIFEST_FILE} must declare a version`);
  }
  const lockfileText = readTextAt(merge, LOCKFILE_FILE);
  if (lockfileText === null) {
    throw new Error(`The release commit does not contain ${LOCKFILE_FILE}`);
  }
  const locked = lockfileVersion(
    readJsonText(lockfileText, LOCKFILE_FILE),
    "release",
  );
  if (locked !== version) {
    throw new Error(
      `${LOCKFILE_FILE} version ${String(locked)} does not match ${MANIFEST_FILE} version ${version}`,
    );
  }
  return { version, tag: tagName(version) };
}

// Publication stays disabled until packaging makes the manifest and the tarball
// publishable; every problem is reported together.
function validateReadiness(
  manifest: Record<string, unknown>,
  committedManifestText: string,
  artifact: ReturnType<typeof inspectPackageArtifact>,
  release: Release,
): void {
  const problems: string[] = [];
  if (manifest.private === true)
    problems.push(`${MANIFEST_FILE} must not be private`);
  if (manifest.name !== PACKAGE_NAME) {
    problems.push(
      `${MANIFEST_FILE} must name ${PACKAGE_NAME}, found ${String(manifest.name)}`,
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    problems.push(`${MANIFEST_FILE} must declare a files allowlist`);
  }
  const engines = manifest.engines;
  if (
    typeof engines !== "object" ||
    engines === null ||
    Array.isArray(engines) ||
    typeof (engines as Record<string, unknown>).node !== "string"
  ) {
    problems.push(`${MANIFEST_FILE} must declare the supported Node engines`);
  }
  const bin = manifest.bin;
  const executable =
    typeof bin === "object" && bin !== null && !Array.isArray(bin)
      ? (bin as Record<string, unknown>)[PACKAGE_NAME]
      : undefined;
  if (typeof executable !== "string" || executable.length === 0) {
    problems.push(
      `${MANIFEST_FILE} must declare the ${PACKAGE_NAME} executable`,
    );
  } else if (!artifact.files.includes(executable)) {
    problems.push(
      `the tarball must contain the declared executable ${executable}`,
    );
  }
  if (
    artifact.manifest.name !== PACKAGE_NAME ||
    artifact.manifest.version !== release.version
  ) {
    problems.push(
      `the tarball is ${String(artifact.manifest.name)}@${String(artifact.manifest.version)}, not ${PACKAGE_NAME}@${release.version}`,
    );
  } else if (artifact.manifestText !== committedManifestText) {
    problems.push(
      "the tarball package.json does not match the release commit; pack from the validated commit",
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `${PACKAGE_NAME} ${release.version} is not publication-ready:\n- ${problems.join("\n- ")}`,
    );
  }
}

function viewField(args: string[], label: string): string | null {
  const result = execute("npm", args, { env: withoutNpmToken() });
  if (result.status === 0) return result.stdout.trim();
  const detail = `${result.stdout}\n${result.stderr}`;
  if (/E404|404 Not Found/.test(detail)) return null;
  throw new Error(
    `npm ${args.join(" ")} failed (${label}): ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

// The registry is the authority for immutable versions. Any failure other than
// a real 404 is an authentication or network problem, never an absence.
function publishedIntegrity(version: string): string | null {
  const value = viewField(
    ["view", `${PACKAGE_NAME}@${version}`, "dist.integrity", "--json"],
    "published integrity",
  );
  return value === null ? null : (JSON.parse(value) as string);
}

function latestDistTag(): string | null {
  const value = viewField(
    ["view", PACKAGE_NAME, "dist-tags.latest", "--json"],
    "latest dist tag",
  );
  return value === null ? null : (JSON.parse(value) as string);
}

function remoteTagCommit(tag: string): string | null {
  const peeled = git("ls-remote", "origin", `refs/tags/${tag}^{}`).trim();
  const reference =
    peeled.length > 0
      ? peeled
      : git("ls-remote", "origin", `refs/tags/${tag}`).trim();
  return reference.length > 0 ? (reference.split(/\s+/)[0] ?? null) : null;
}

function releaseState(
  tag: string,
): { tagName: string; isDraft: boolean } | null {
  const result = execute(
    "gh",
    ["release", "view", tag, "--json", "tagName,isDraft"],
    {
      env: withoutNpmToken(),
    },
  );
  if (result.status !== 0) {
    if (/not found|HTTP 404|release not found/i.test(result.stderr))
      return null;
    throw new Error(`gh release view ${tag} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as { tagName: string; isDraft: boolean };
}

function publishToRegistry(tarball: string, version: string): void {
  const token = requireEnvironment("NODE_AUTH_TOKEN");
  const result = execute(
    "npm",
    ["publish", tarball, "--tag", "latest", "--access", "public"],
    { env: { ...process.env, NODE_AUTH_TOKEN: token } },
  );
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    if (/E401|E403|ENEEDAUTH|authenticate|permission/i.test(detail)) {
      throw new Error(`npm publish was rejected by the registry: ${detail}`);
    }
    throw new Error(`npm publish ${PACKAGE_NAME}@${version} failed: ${detail}`);
  }
  completed.push("npm");
}

function ensureTag(tag: string, merge: string): void {
  const existing = remoteTagCommit(tag);
  if (existing !== null) {
    if (existing !== merge) {
      throw new Error(`Tag ${tag} already points at ${existing}, not ${merge}`);
    }
    console.log(`Tag ${tag} already points at ${merge}.`);
    return;
  }
  git("tag", tag, merge);
  git("push", "origin", `refs/tags/${tag}`);
  completed.push("tag");
  console.log(`Created tag ${tag} at ${merge}.`);
}

function publishRelease(tag: string, notes: string): void {
  const state = releaseState(tag);
  if (state !== null && !state.isDraft) {
    console.log(`GitHub Release ${tag} is already published.`);
    return;
  }
  if (state === null) {
    gh(
      "release",
      "create",
      tag,
      "--title",
      tag,
      "--notes",
      notes,
      "--verify-tag",
    );
    completed.push("release");
    console.log(`Created GitHub Release ${tag}.`);
    return;
  }
  gh("release", "edit", tag, "--draft=false");
  completed.push("release");
  console.log(`Published the draft GitHub Release ${tag}.`);
}

function main(): void {
  const merge = validateMergedPullRequest();
  const release = validateReleaseCommit(merge);
  const tarball = requireEnvironment("TARBALL");
  const artifact = inspectPackageArtifact(tarball);
  const manifestText = readTextAt(merge, MANIFEST_FILE);
  if (manifestText === null)
    throw new Error(`The release commit does not contain ${MANIFEST_FILE}`);
  validateReadiness(
    readManifest(manifestText, "release"),
    manifestText,
    artifact,
    release,
  );

  const published = publishedIntegrity(release.version);
  const latest = latestDistTag();
  if (published !== null) {
    if (published !== artifact.integrity) {
      throw new Error(
        `${PACKAGE_NAME}@${release.version} is already published with different contents (${published}); corrections use a new version`,
      );
    }
    if (latest !== release.version) {
      throw new Error(
        `npm latest points at ${String(latest)}, not ${release.version}; refusing to re-publish a different release`,
      );
    }
    console.log(
      `${PACKAGE_NAME}@${release.version} is already published with the candidate contents.`,
    );
  }

  const tagCommit = remoteTagCommit(release.tag);
  if (tagCommit !== null && tagCommit !== merge) {
    throw new Error(
      `Tag ${release.tag} already points at ${tagCommit}, not ${merge}`,
    );
  }

  if (published === null) publishToRegistry(tarball, release.version);
  const latestAfterPublish = published === null ? latestDistTag() : latest;
  if (latestAfterPublish !== release.version) {
    throw new Error(
      `npm latest points at ${String(latestAfterPublish)} after publication, not ${release.version}`,
    );
  }
  ensureTag(release.tag, merge);
  const notes = gh(
    "pr",
    "view",
    requireEnvironment("PR_NUMBER"),
    "--json",
    "body",
    "--jq",
    ".body",
  );
  publishRelease(release.tag, notes);
  console.log(
    completed.length === 0
      ? `Release ${release.tag} was already complete for ${merge}.`
      : `Published ${release.tag} from ${merge}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    completed.length === 0
      ? "No publication stages completed."
      : `Completed stages: ${completed.join(", ")}. A re-run resumes the missing stages.`,
  );
  process.exitCode = 1;
}
