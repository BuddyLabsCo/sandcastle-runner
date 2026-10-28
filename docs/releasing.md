# Maintainer releases

Routine releases of `issue-runner` use npm OIDC Trusted Publishing. The GitHub
App credentials `APP_ID` and `APP_PRIVATE_KEY` remain separate: they authorize
release PR automation, not npm publication.

## Reviewed release flow

Eligible changes on `main` maintain one `auto-release` PR. A human reviews and
merges that PR. `.github/workflows/publish-release.yml` repeats Ubuntu and Windows
checks on its exact merged commit, builds and packs that commit, then invokes
`scripts/release/publish-release.ts`.

The script rejects untrusted events, wrong commits, inconsistent versions and
conflicting artifacts/tags. It accepts the packed executable and package assets
before publishing that exact tarball on `latest`, creating `v<version>`, and
creating the matching GitHub Release with the release PR's notes. A retry compares
registry integrity and tag identity, reuses completed stages, and reports partial
completion. An npm failure stops before tag/Release creation.

Only the GitHub-hosted `publish` job has `id-token: write`. It uses Node 22.18.0
and explicitly installs npm 11.19.0, without package-manager caching. Publication
uses isolated registry configuration and strips `NODE_AUTH_TOKEN`, `NPM_TOKEN`,
and all inherited `npm_config_*` environment settings (case-insensitively) from
the publication command. This includes registry-scoped authentication settings;
routine releases have no stored-token fallback.

## Package authorization

Policy revalidated on **2026-10-29** against the
[npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/):
Node >=22.14.0 and npm >=11.5.1 are required, and a new binding must first publish
successfully within two days. Only supported hosted CI runners can use it.

An authorized npm package administrator manages the package-specific publisher
in the `issue-runner` package's Settings, using npm's authenticated management UI.
Match these fields exactly:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `BuddyLabsCo` |
| Repository | `sandcastle-runner` |
| Workflow filename | `publish-release.yml` |
| Environment | Unset (the publication job declares none) |
| Allowed action | Allow direct publishing with `npm publish` |
| Package `repository.url` | `git+https://github.com/BuddyLabsCo/sandcastle-runner.git` |

Stage-only permission does not authorize this release flow. No separate dist-tag
management permission is needed by the script. npm recommends Publishing access
of **Require two-factor authentication and disallow tokens**; this still allows
Trusted Publishing. Account changes require the authorized administrator.

The [maintainer's 2026-10-28 confirmation](https://github.com/BuddyLabsCo/sandcastle-runner/issues/287#issuecomment-6472394652)
reports token revocation and publisher configuration.
[Ticket #286's evidence](https://github.com/BuddyLabsCo/sandcastle-runner/issues/286#issuecomment-6472535307)
also records confirmed package publishing permissions and the successful first
formal `0.1.0` publication. A fresh read on 2026-10-29 confirmed that the repository
Secrets contain only `APP_ID` and `APP_PRIVATE_KEY`, with `NPM_TOKEN` absent; npm
still returns the recorded `0.1.0` identity, repository and SHA-512 integrity.
Token revocation and account permissions are maintainer-confirmed, not
independently inspected account settings.

## Next authorized real release

Actual OIDC publication is **pending execution acceptance**. Saved configuration,
Secret-name presence, public registry reads and local command fakes do not prove
working publication authorization. `npm whoami` is not an OIDC authorization check.

Before the next real release is ready for human merge, have the authorized
administrator confirm the binding's creation time, exact fields and direct
publishing permission. The October 28 comment is not the creation timestamp and
does not establish a precise expiry deadline. Schedule publication within the
binding's two-day window. If expired, the administrator must delete and recreate
it near that release, then record the new deadline. Do not create a dummy version
or release to validate authentication.

After the authorized human merge:

1. Record the release PR, human merge, exact merged SHA and successful publication
   job, including its Node/npm versions and OIDC/provenance evidence.
2. Check `npm view issue-runner@<version> name version repository.url maintainers
   dist.integrity dist.attestations --json` and
   `npm view issue-runner dist-tags.latest --json`. Compare integrity to the tested
   candidate and verify the intended package owner and repository.
3. Check that the GitHub tag targets the merged SHA and its published, non-draft
   Release has the same version and reviewed notes.
4. From an unrelated directory, use fresh temporary npm caches and a global
   prefix to run `npm exec --yes --package issue-runner@<version> -- issue-runner
   --version` and install `issue-runner@<version>` globally. Execute that prefix's
   installed CLI and record the version, Node/npm versions and platform.

Record real OIDC evidence separately from local test results and bootstrap
publication evidence. This implementation does not authorize a merge, account
change, Secret change or registry publication.

## Authorization failures and recovery

Missing OIDC identity fails with guidance to check `id-token: write` and the hosted
runner. Registry authorization rejection reports the underlying npm error and
directs the administrator to the exact publisher fields, direct publishing,
expiry, metadata and toolchain requirements. npm validates these settings during
publication, not when they are saved.

Correct authorization through the administrator route, then retry the reviewed
workflow for the same merged commit. Keep all artifact, version, check and tag
gates. For partial completion, inspect the reported stages and let the script
reconcile them. Conflicting immutable versions require a new reviewed version.
Do not restore the revoked bootstrap token, add token Secrets, publish manually,
switch to staging, or bypass release gates to make authentication succeed.
