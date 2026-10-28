# Release automation

Two workflows turn release-eligible changes on `main` into a reviewed release
and an npm publication. Both invoke production scripts under `scripts/release/`;
the workflows carry only events, permissions, checkout, toolchain setup, and
credential wiring.

## Release Proposal

`.github/workflows/auto-release-pr.yml` runs on every push to `main`.

- The job mints a repository-scoped GitHub App installation token before
  checkout and checks out with it. The default `GITHUB_TOKEN` stays read-only,
  and workflow-created pull requests stay unapproved: the App never bypasses
  required checks, approves its own pull request, or merges it.
- `scripts/release/auto-release-pr.ts` decides eligibility. Files under
  `.github/` are not release content; shipped Markdown prompts and every other
  shipped path are. A push that only changes the proposal's manifest, lockfile,
  and changelog and whose head commit is the merged release pull request's
  merge commit is the release merge and proposes nothing, even when it does not
  raise the version. The proposal commit title is a fallback for that identity,
  so an edited squash title or a rebase that ends with a maintainer commit is
  still recognized.
- The first proposal is `0.1.0`, including when packaging already seeds that
  version. Later proposals increase the patch of the latest `v<version>` tag,
  while a manifest version the maintainer already raised is proposed unchanged.
- One open `auto-release` pull request is refreshed in place. A maintainer edit
  to a minor or major version is preserved, and no second proposal is opened.
- The proposal writes `package.json`, `package-lock.json`, and `CHANGELOG.md`
  together so manifest, lockfile, and changelog agree.
- The script authors the proposal commit as `github-actions[bot]`, so a fresh
  runner needs no preconfigured Git identity.

Merge the proposal with squash or rebase. A merge commit is rejected before
publication writes anything.

## Publication

`.github/workflows/publish-release.yml` runs when a pull request into `main`
closes.

- The job condition accepts only a merged pull request from this repository's
  `auto-release` branch. The script repeats that check against the event
  inputs, so a manual run cannot bypass it.
- The checks job reuses `.github/workflows/ci.yml` at the exact
  `merge_commit_sha`. Ubuntu and Windows checks therefore cover the merged
  commit, not the moving `main` tip.
- The publish job checks out that commit, installs dependencies, runs the build
  when one exists, packs the candidate tarball, and passes its path to
  `scripts/release/publish-release.ts`.
- The script verifies the checkout, the single-parent merged commit, manifest
  and both lockfile version fields, package readiness, and the tarball's name,
  version, and declared executable before it touches the registry.
- It then accepts the artifact itself: it installs the packed tarball into a
  temporary prefix and runs the installed executable with `--version`, requiring
  exit status zero and the release version. A tarball whose CLI fails to start,
  or reports another version, blocks publication.
- Finally it runs the package-owned `release:accept` script with
  `RELEASE_TARBALL` pointing at the candidate. That script inspects the dry-run
  and actual tarballs against the package allowlist, installs the same bytes,
  and exercises the npm executable shim, help, version, credential-free
  initialization, and no-fallback Project lookup. Publication stays disabled
  while the script is absent or failing, so version output alone cannot admit
  an incomplete package.
- Publication runs npm, then the tag, then the GitHub Release. Each stage is
  read first and reused only when its identity matches, so a retry resumes the
  missing stages without republishing a version or moving a tag. A local tag
  left by a failed push is reused when it points at the release commit.
- `NODE_AUTH_TOKEN` is wired only into the step that runs the publication
  script. The script passes it only to `npm publish`, together with a temporary
  npm user config that maps the token to `registry.npmjs.org`; every earlier
  command runs without the token or the registry mapping.

## Publication gates

The script refuses any package whose manifest is private or source-only, lacks
the `issue-runner` name, a files allowlist, supported Node engines, a packaged
executable, or a `release:accept` check. The manifest now supplies those fields
and points the executable at compiled `dist/cli.js`; the build emits the
JavaScript, copies the seven internal prompts, and the allowlist ships only
`dist/`, `templates/`, the manifest, README, and license.

A release still requires a human-merged release proposal. An implementation
merge on its own neither proposes nor publishes a release, and the first
proposal remains `0.1.0`.

## Running the scripts outside Actions

Both scripts take explicit environment inputs and report failures through
output and exit status.

```sh
# Release Proposal, in a clean checkout of main with full history and tags.
# PUSH_BEFORE is the commit before the pushed range.
PUSH_BEFORE="$(git rev-parse HEAD~1)" GH_TOKEN="$(gh auth token)" \
  node scripts/release/auto-release-pr.ts

# Release Publication, in a clean checkout of the merged release commit.
npm ci
npm pack --pack-destination /tmp/release
GITHUB_REPOSITORY=BuddyLabsCo/sandcastle-runner \
PR_NUMBER=123 PR_MERGED=true PR_HEAD_REF=auto-release PR_BASE_REF=main \
PR_HEAD_REPOSITORY=BuddyLabsCo/sandcastle-runner MERGE_SHA="$(git rev-parse HEAD)" \
TARBALL=/tmp/release/issue-runner-0.1.0.tgz NODE_AUTH_TOKEN="<npm token>" \
  node scripts/release/publish-release.ts
```

`gh`, `git`, and `npm` must be authenticated for the account that owns the
repository and the package.

## Verification status

This automation slice is verified by the release script tests in
`tests/release/`, which run both entry points against disposable Git
repositories with controlled `gh` and `npm` commands. `tests/package/` builds
and packs the real artifact, then runs the production acceptance script against
that tarball. No workflow authentication check has run: GitHub App token
generation, the workflow access token, npm authentication, a real publication,
and OIDC trusted publishing remain unexercised, and repository Secret names
alone do not establish valid credentials. The first reviewed workflow run is the
evidence for those checks.
