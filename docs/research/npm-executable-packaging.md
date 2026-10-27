# npm executable packaging and runtime requirements

Research for [Research: npm executable packaging and runtime requirements](https://github.com/BuddyLabsCo/sandcastle-runner/issues/277), checked on 2026-10-28. This note establishes packaging constraints and verification requirements; it does not choose the Project layout, publishing identity, or release policy.

## Findings that constrain the package

One npm package with a `sandcastle-runner` executable can support both npx and global installation. npm exposes `bin` entries through global links or Windows command shims. Keep the executable's `#!/usr/bin/env node` header. A CLI does not need a public JavaScript library API merely to expose this command. [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin)

Publishing the current `.ts` executable unchanged will fail. Node refuses native TypeScript stripping inside `node_modules`, including cached npm installations. Increasing the Node version does not remove that restriction. [Node TypeScript documentation](https://nodejs.org/docs/latest-v22.x/api/typescript.html#type-stripping-in-dependencies)

The recommended candidate is compiled ESM JavaScript using the already-installed TypeScript compiler. `rewriteRelativeImportExtensions` rewrites relative TypeScript import extensions in emitted files. Keep `type: module`, point `bin` at the emitted CLI, and copy Markdown assets with their expected relative paths. This recommendation adds no runtime transpiler or bundler. A runtime loader or a bundle are alternatives, but neither is required by the inspected code. [TypeScript compiler option](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)

## Current repository boundary

The inspected source revision is [`abd8c21bbfbeedb458e6a1ca4194b80fa6acd418`](https://github.com/BuddyLabsCo/sandcastle-runner/tree/abd8c21bbfbeedb458e6a1ca4194b80fa6acd418). Its manifest has `private: true`, no version or engine declaration, and `bin` points at `src/cli.ts`. Its TypeScript configuration checks without emitting. `private: true` prevents publication; a publishable version and distribution manifest are still needed. [Manifest](../../package.json), [compiler configuration](../../tsconfig.json), [npm manifest rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)

The production entry sets its root from its own module directory. `loadProject` appends `projects/<key>`. Compiling alone therefore continues to read Projects under the installed package. The npm feature must separate package assets from the operator-selected configuration and writable runtime directories. The Project layout remains a decision. [CLI entry](../../src/cli.ts), [Project loading](../../src/config.ts)

The existing CLI supports `run --project` with exactly one of `--parent`, `--issue [number]`, or `--document`. Explicit merge flags require a numbered `--issue`. There is no `init` command. [Argument parsing](../../src/cli.ts)

## Required and excluded assets

A candidate package needs:

- Emitted JavaScript for `src/`, retaining its directory relationships
- All seven internal Markdown templates from `src/prompts/`, placed beside emitted modules as expected
- A reviewed initialization configuration plus `implement.md`, `review.md`, and `documentation.md`
- The manifest and package-facing documentation, with the selected license material

Internal prompts are loaded relative to modules, rather than the launch directory. TypeScript emission does not copy Markdown. Initialization assets should likewise be package-relative, while their copies belong in the selected destination. [Agent adapter](../../src/adapters/sandcastle.ts), [review flow](../../src/run/review-attempt.ts), [Project template guide](../../projects/README.md)

Use a `files` allowlist rather than publishing the repository tree. npm always includes some metadata and entry files, so inspect the resulting tarball too. Exclude Project logs, Recovery Snapshots, worktrees, temporary files, local credentials, tests, and unrelated research. The live sample configuration contains repository/account/checkout and agent choices; review its portability before adopting it as a public default. The main worktree's modified sample was neither changed nor copied into this research artifact. [npm included-file rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files)

## Runtime versions and prerequisites

The current entry uses `import.meta.main`, introduced in Node 22.18.0, and `import.meta.dirname`. Compilation preserves these APIs. The README's current Node minimum therefore remains relevant even when TypeScript stripping is removed. Beware a broad semver range: Node 24.0.0 does not document `import.meta.main`, despite being numerically newer than 22.18.0. Choose and test supported release lines or replace the entry detection; do not infer coverage from a single lower bound. [Node 22 ESM API](https://nodejs.org/docs/latest-v22.x/api/esm.html#importmetamain), [Node 24.0 ESM API](https://nodejs.org/download/release/v24.0.0/docs/api/esm.html#importmeta)

The inspected direct runtime dependencies declare these engine requirements:

| Dependency | Version | Declared Node requirement |
| --- | --- | --- |
| cac | 7.0.0 | >=20.19.0 |
| cross-spawn | 7.0.6 | >=8 |
| yaml | 2.9.1 | >=14.6 |
| @ai-hero/sandcastle | 0.12.0 | No engines field |

Sources: [cac manifest](https://github.com/cacjs/cac/blob/v7.0.0/package.json), [cross-spawn manifest](https://github.com/moxystudio/node-cross-spawn/blob/v7.0.6/package.json), [yaml manifest](https://github.com/eemeli/yaml/blob/v2.9.1/package.json), [Sandcastle manifest at its previously verified release revision](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json).

The local lockfile's runtime closure adds `@clack/prompts` 1.8.0 and `@clack/core` 1.5.0, both declaring Node >=20.12.0; no declared runtime engine floor exceeds cac's. Sandcastle ships JavaScript and declares `@clack/prompts: ^1.1.0`. Absence of an engine declaration is not a compatibility guarantee. Transitive resolution on consumer installation can differ from this repository's lockfile. [Lockfile](../../package-lock.json), [Sandcastle manifest](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json)

The host still needs Git, GitHub CLI, authenticated configured agent CLIs, credential variables, native permissions, and a target checkout. npm supplies the Runner package and its dependencies, not those external tools or their authentication. The repository promises Windows, macOS, and Linux workflows, but this research does not establish a new platform guarantee. [Existing prerequisites](../../README.md#prerequisites)

## npx and global usage

npx uses npm's executable resolution. Missing packages are installed in npm's cache, with an interactive confirmation when applicable. This avoids a separate global installation step; it does not mean no files are downloaded or installed. Offline execution requires cached packages. An unversioned name can select a local dependency, so it does not guarantee the latest registry version. Explicit `@latest` and exact versions express different intentions. npx options belong before the package; Runner arguments follow it. [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/)

`npm install -g sandcastle-runner` makes its binary available through the configured global prefix. Its executable directory must be on PATH. That installed version remains selected for direct invocations until changed. Both forms can use the same artifact. [npm folders](https://docs.npmjs.com/cli/v11/configuring-npm/folders/), [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/)

## Checks performed and release acceptance checks

On Linux with Node 24.20.0 and npm 11.19.0, isolated probes established:

1. A typed `.ts` file placed under a temporary `node_modules` failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
2. Existing TypeScript 6.0.3 compiled the unchanged `src` tree with emission and relative-extension rewriting enabled. Compilation succeeded, preserved the CLI shebang, and left no relative `.ts` import suffixes in output. The temporary config set type roots explicitly because it lived outside the repository.
3. Emitted JavaScript plus internal prompts, placed under a temporary `node_modules/sandcastle-runner`, reached startup from an unrelated directory. It then reported the missing configuration under the package directory, confirming the root-path problem without invoking remote operations.

These were feasibility probes, not a release artifact or an end-to-end Run. They reused already-installed dependencies. They did not test a minimum Node version or another operating system.

The implementation's artifact checks should:

1. Build from a clean checkout and run `npm pack --dry-run --json` to inspect included files. Create the tarball with `npm pack` and inspect its actual contents. [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)
2. From a new unrelated directory and isolated npm cache, run the tarball through `npm exec --yes --package=/absolute/package.tgz -- sandcastle-runner ...`. Use the agreed `init` syntax and verify the exact destination, contents, and existing-file behavior.
3. Install that same tarball globally into a temporary prefix, expose its bin directory on PATH, and invoke the command directly. Confirm command shims on Windows.
4. Exercise every existing Run selector against scripted dependencies, verifying configuration lookup, internal prompt reads, and runtime output locations. Compare package contents before and after to detect writes into the installation.
5. Repeat artifact smoke checks on each declared Node release line and supported operating system. After publication, verify the actual registry command and exact published version, because local tarball checks do not verify registry naming or tags.

No public npm release, global host installation, authenticated agent Run, or remote repository mutation was performed. Package ownership, licensing, release automation, default template content, and destination semantics remain open decisions.
