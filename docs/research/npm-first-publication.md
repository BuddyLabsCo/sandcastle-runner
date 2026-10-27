# npm first-publication prerequisites

Research for [Research: npm package availability and first-publication prerequisites](https://github.com/BuddyLabsCo/sandcastle-runner/issues/278), observed on 2026-10-28. The requested unscoped name is already registered. This research does not establish publishing rights or select a release policy.

## Package-name evidence

The following read-only query targeted the public registry explicitly:

```sh
npm view sandcastle-runner name version dist-tags maintainers \
  --registry=https://registry.npmjs.org --json
```

It returned `sandcastle-runner`, version `0.1.1`, `latest: 0.1.1`, and maintainer username `yolochkas`. A second metadata query reported creation on 2026-09-29 and a `sandcastle-runner` binary at `dist/cli.js`. These are observations of [public registry metadata](https://registry.npmjs.org/sandcastle-runner), not proof that this repository or its developer controls that package. No package code was downloaded or executed. The built-in web fetcher could not open the registry JSON; `npm view` supplied the evidence.

The release decision must establish ownership or select another name. An owned scope permits a name such as `@owned-scope/sandcastle-runner`; its npx/install examples must include that scope. Public scoped publication can explicitly use `--access public`. No scope or alternative name was checked or reserved. [npm scoped-package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)

## Human account prerequisites

An npm account needs a verified email before publishing. Account creation, login, and any account recovery remain human actions. [npm account setup](https://docs.npmjs.com/creating-a-new-npm-user-account/)

Interactive publishing requires account two-factor authentication (2FA). Granular tokens with bypass-2FA permission are another current direct-publication route, subject to package policy. Package settings can disallow those tokens. Governance actions still require interactive 2FA; a bypass token cannot establish package ownership. [npm publication authentication](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)

Current npm documentation schedules removal of granular-token direct publishing in January 2027. It describes stage-only tokens as an alternative for automation. This is a time-sensitive policy, not a reason to introduce token automation for this first release. [npm access-token policy](https://docs.npmjs.com/about-access-tokens/)

## First publication and later automation

For an owned name, manual publication uses an authenticated npm session and an interactive 2FA challenge. Staging is another option: a maintainer reviews and approves staged contents with 2FA. Staging a nonexistent package creates a publicly available placeholder immediately, so it is already an external publication action. Neither route was attempted. [npm first-publication guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

Trusted publishing exchanges GitHub Actions identity for short-lived npm credentials. It requires npm >=11.5.1, Node >=22.14.0, a GitHub-hosted runner, and `id-token: write`. Configure the exact owner, repository, workflow filename, and optional environment in npm package settings. The workflow file must exist. `repository.url` must match the publishing repository. These are publisher requirements, not the Runner's consumer runtime baseline. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

New trusted-publisher configurations allow staging by default; direct publication and dist-tag changes require separate permissions. A configuration must complete its first successful publish within two days. GitHub trusted publishing generates provenance automatically for public packages from public repositories. The repository is currently public. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

The documented setup starts on an existing package's settings page. It does not document creating a new package name through OIDC alone. A first-publish failure report remains open in the official documentation repository. Therefore, do not promise unattended OIDC bootstrap; plan a human bootstrap or verify another supported route before implementation. This is a bounded recommendation, not proof that every possible OIDC bootstrap fails. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [official documentation issue](https://github.com/npm/documentation/issues/1926)

## Version, metadata, and license choices

At inspected commit `abd8c21bbfbeedb458e6a1ca4194b80fa6acd418`, this repository's manifest has `private: true`, no version or license field, and a TypeScript binary. No tracked license file was found. Those are local observations, not evidence that the existing registry package belongs to this project. [inspected manifest](https://github.com/BuddyLabsCo/sandcastle-runner/blob/abd8c21bbfbeedb458e6a1ca4194b80fa6acd418/package.json)

A published package requires a name and version. The owner must select license terms and appropriate metadata; npm documents SPDX identifiers and custom license files. Do not infer MIT permission from the unrelated registry package's metadata. [npm manifest documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)

A published name/version pair cannot be reused, even after unpublishing. npm accepts a local tarball as publication input. A failed release therefore needs a new version rather than replacement contents under an existing version. [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

Publishing updates `latest` unless another tag is selected. Bare installation resolves `latest`; a prerelease should use an explicitly chosen tag such as `next` if it must not become the default. Tags can later point to an existing version. Initial version and tag remain human decisions. [npm dist-tags](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)

## Proposed artifact verification

The following is a proposed release gate, not work performed by this research:

1. Resolve name ownership, license, version, tag, and public registry destination before preparing publication.
2. Run the repository checks and build. Use `npm pack --dry-run --json` to inspect included files, then `npm pack --json` to create the candidate tarball. Confirm executable output, runtime assets, template files, and license while excluding logs, state, credentials, and local configuration edits. [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)
3. Test that exact tarball through npx/npm-exec and an isolated global prefix from unrelated directories. Exercise init, existing-destination protection, and Run argument/configuration resolution without delivering real issues. Package implementation research defines the detailed commands and assertions.
4. Have the authorized publisher publish the reviewed tarball with the selected access and tag. Repacking different contents would invalidate the artifact checks. [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
5. Read back the exact published version and integrity metadata. In fresh directories/cache/prefix, verify version-pinned npx and global installation, then check the documented default tag. Do not execute today's registered package as a substitute for this repository's candidate.

## Verification limits

Only documentation, repository metadata, and public registry metadata were inspected. No account credentials, ownership permissions, authenticated publication, OIDC exchange, staging, installation, or runtime behavior was tested. The two release routes remain alternatives for the human decision ticket.
