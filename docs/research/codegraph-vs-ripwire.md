# CodeGraph vs. ripwire for coding-agent workflows

Status: comparative research note, not an implementation or an independent benchmark reproduction.
Checked: 2026-09-19.

Primary sources are pinned to:
- CodeGraph commit `ba3c21e50d9129d2f5f3843ec3728868ae6d47a1`.
- ripwire commit `57d713dda2fa8f3d8fcdba7d0f626b60bb291d69`.

## Conclusion

Switching from ripwire to CodeGraph is **not clearly better for general coding-agent workflows**.

CodeGraph is the stronger **persistent semantic index**: it has broader language and agent coverage, a SQLite-backed graph, auto-sync, and a single high-level `codegraph_explore` tool that can replace many grep/read round trips. Its own benchmarks report large throughput wins on single-question orientation tasks. However, its own multi-turn measurements also show that CodeGraph leaves substantially more retrieval context resident in the agent window, which can hurt long sessions. It also introduces a daemon/index lifecycle plus default-on, opt-out telemetry and update checks.

ripwire is leaner and more transparent for token-sensitive agent loops. It is CLI-first, uses a deterministic in-memory graph with content-keyed caching, exposes task-shaped skills, and publishes explicit accuracy floors and counterexamples. It is pre-1.0 and has a narrower language matrix, but it is currently more actively maintained and has stronger published evaluation discipline.

For this repository’s TypeScript coding-agent workflow, ripwire remains the better default. A CodeGraph trial is worth considering only if the main pain is broad multi-language/framework orientation rather than token-efficient change analysis.

## Purpose and maturity

- **CodeGraph** positions itself as a “semantic code intelligence” layer for Claude Code, Cursor, Codex, OpenCode, Hermes, Gemini, Antigravity, Kiro, and GitHub Copilot, with a prebuilt knowledge graph and one-call surgical context. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L9-L18))
- CodeGraph is young but comparatively popular: created 2026-01-18, with 71,430 stars, 4,596 forks, and 44 contributors as of this check. ([repository](https://github.com/colbymchenry/codegraph), [contributors](https://github.com/colbymchenry/codegraph/graphs/contributors))
- Its latest release is `v1.6.0`, published 2026-08-26, and the project follows SemVer and Keep a Changelog. ([release](https://github.com/colbymchenry/codegraph/releases/tag/v1.6.0), [CHANGELOG](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/CHANGELOG.md#L1-L11))
- **ripwire** positions itself as “the ripgrep of AI context”: a map-before-reading tool for coding agents, focused on ranked call graphs, blast radius, and tests to run. ([README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L10-L19))
- ripwire is younger by repository age and remains pre-1.0; its security policy explicitly says it does not yet provide a compatibility guarantee. ([repository](https://github.com/redhat-et/ripwire), [SECURITY](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/SECURITY.md#L30-L32))
- Its latest release is `v0.6.1`, published 2026-09-15. ([release](https://github.com/redhat-et/ripwire/releases/tag/v0.6.1))

## Architecture and indexing

- CodeGraph uses a **hybrid Node/TypeScript + Rust NAPI kernel**. The npm package exposes a `codegraph` CLI and library, while a native Rust extraction kernel handles parsing for 20 languages and falls back per file when needed. ([package.json](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/package.json#L1-L35), [Cargo.toml](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/codegraph-kernel/Cargo.toml#L1-L17), [README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L259-L267))
- Its persistent model is a local SQLite database with symbol nodes, relationship edges, files, unresolved references, and FTS5 search. ([schema.sql](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/src/db/schema.sql#L15-L77), [README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L491-L520))
- CodeGraph auto-syncs through native OS file events with a debounce window, and its MCP server watches the project so the graph stays current while the agent edits. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L271-L309))
- ripwire is a **C++23, zero-runtime-dependency binary** with vendored tree-sitter grammars. Its pipeline is `ingest → graph → rank → serialize → CLI/MCP`, with no back edges. ([README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L902-L907), [ARCHITECTURE](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/docs/ARCHITECTURE.md#L12-L25))
- ripwire’s graph is explicitly approximate and name-based: tree-sitter provides syntax only, references are resolved through a fixed precedence ladder, ambiguous calls split edge weight, and no phantom node is invented. ([ARCHITECTURE](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/docs/ARCHITECTURE.md#L301-L328))
- Its graph is stored as an in-edge CSR and ranked with deterministic Personalized PageRank; output is byte-identical for the same tree. ([ARCHITECTURE](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/docs/ARCHITECTURE.md#L330-L401), [determinism contract](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/docs/ARCHITECTURE.md#L536-L576))
- ripwire uses a content-keyed parse cache rather than a persistent database, and one process answers a query with no daemon or standing server. ([ARCHITECTURE](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/docs/ARCHITECTURE.md#L492-L525), [README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L2674-L2687))

## Language and runtime support

- CodeGraph advertises **20+ languages**, including TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, C, C++, Swift, Kotlin, Scala, Dart, Svelte, Vue, Astro, Lua, R, Erlang, COBOL, Solidity, Terraform, and Nix. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L143-L184), [supported languages](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L806-L844))
- CodeGraph ships self-contained builds for Windows, macOS, and Linux on x64 and arm64, and the CLI does not require a separately installed Node runtime. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L777-L788))
- ripwire ships **25 vendored grammars**, covering C/C++, Objective-C/C++, Metal, CUDA, Python, TypeScript, JavaScript, Java, Ruby, PHP, Lua, Elixir, Dart, Kotlin, GDScript, Bash, Go, Rust, Swift, C#, JSON, TOML, YAML, and Markdown. ([README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L2008-L2041))
- ripwire is a macOS/Linux binary; on Windows it requires WSL2. It has no runtime dependency for the map itself, though history-backed commands need `git`. ([INSTALL](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/INSTALL.md#L1-L5), [system requirements](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L2166-L2178))

## Agent, CLI, and IDE integration

- CodeGraph’s installer auto-configures Claude Code, Cursor, Codex CLI, opencode, Hermes, Gemini CLI, Antigravity, Kiro, and GitHub Copilot surfaces. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L790-L805))
- By default, its MCP server exposes one primary tool, `codegraph_explore`; narrower tools remain available but unlisted unless re-enabled. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L581-L591))
- ripwire treats the CLI as the primary interface and MCP as optional. Its installer activates task-shaped skills for Claude Code and Codex, and optional advisory hooks. ([README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L1836-L1942), [INSTALL](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/INSTALL.md#L73-L108))
- ripwire ships 17 task-shaped skills that teach an agent when to use each verb, plus an optional 31-verb stdio MCP server. ([README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L1918-L1942))
- ripwire’s LSP surface is still a Phase 1 PoC plan, not a shipped general IDE integration. ([LSP](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/docs/LSP.md#L1-L13))

## Performance characteristics

- CodeGraph’s own seven-repo, four-run-per-arm benchmark reports **88% fewer tool calls, 53% faster answers, 62% fewer tokens, and 44% lower cost** versus a file-reading agent on one architecture question per repo. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L188-L240))
- CodeGraph also reports strong indexing/sync performance: a 27k-file Swift compiler index in about 100 seconds, Linux kernel indexing in under 12 minutes on a 2-core/6GB VPS, and sub-second one-file re-syncs. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L259-L267))
- However, CodeGraph’s own multi-turn residual-context measurement found **82% higher retrieval residual** with CodeGraph than with Read/Grep/Bash, and about **546 tokens** of fixed MCP/tool-schema overhead before any tool call. ([residual-context benchmark](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/docs/benchmarks/residual-context-occupancy.md#L169-L280))
- ripwire’s own benchmark table reports token savings across orientation, task packing, callers, impact, stack traces, and PR review, with examples such as 3.6×–4.5× on orientation and 69.2×–89.1× on caller lookup versus a grep/read path. ([README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L136-L160))
- ripwire reports answering mid-task questions at **5.0%** of a grep-and-read pass, `--pack-signatures` returning **74.7% fewer bytes** than full bodies, and parse times of roughly 0.15s cold / 0.10s warm on its own repository. ([README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L632-L655))
- ripwire’s published evaluation doc emphasizes provenance, held-out labels, and counterexamples, and its gate suite contains 637 scripts. ([EVALS](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/docs/EVALS.md#L1-L24))
- The two projects’ numbers are **not directly comparable**: they use different corpora, models, session shapes, and metrics. Both sets are self-published.

## Maintenance and activity

| Metric | CodeGraph | ripwire |
| --- | ---: | ---: |
| Repository created | 2026-01-18 | 2026-07-29 |
| Stars / forks | 71,430 / 4,596 | 2,256 / 145 |
| Contributors | 44 | 22 |
| Latest release | v1.6.0, 2026-08-26 | v0.6.1, 2026-09-15 |
| Commits since 2026-09-01 | 82 | 2,014 |
| Open issues / open PRs | 176 / 345 | 34 / 2 |

Sources: [CodeGraph repository](https://github.com/colbymchenry/codegraph), [CodeGraph contributors](https://github.com/colbymchenry/codegraph/graphs/contributors), [CodeGraph release](https://github.com/colbymchenry/codegraph/releases/tag/v1.6.0), [CodeGraph commit search](https://github.com/search?q=repo%3Acolbymchenry%2Fcodegraph+committer-date%3A%3E%3D2026-09-01&type=commits), [CodeGraph open issues](https://github.com/colbymchenry/codegraph/issues?q=is%3Aissue+is%3Aopen), [CodeGraph open PRs](https://github.com/colbymchenry/codegraph/pulls?q=is%3Aopen); [ripwire repository](https://github.com/redhat-et/ripwire), [ripwire contributors](https://github.com/redhat-et/ripwire/graphs/contributors), [ripwire release](https://github.com/redhat-et/ripwire/releases/tag/v0.6.1), [ripwire commit search](https://github.com/search?q=repo%3Aredhat-et%2Fripwire+committer-date%3A%3E%3D2026-09-01&type=commits), [ripwire open issues](https://github.com/redhat-et/ripwire/issues?q=is%3Aissue+is%3Aopen), [ripwire open PRs](https://github.com/redhat-et/ripwire/pulls?q=is%3Aopen).

## Strengths and limitations

**CodeGraph strengths**
- Broad language, framework, and agent coverage.
- Persistent, auto-syncing SQLite graph with Rust-accelerated extraction.
- Strong single-question throughput results and a simple one-tool MCP surface.
- Supply-chain hygiene through OIDC trusted publishing and artifact attestations. ([release workflow](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/.github/workflows/release.yml#L1-L29), [verified releases](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L750-L775))

**CodeGraph limitations**
- Large verbatim payloads can leave much more context resident in multi-turn sessions. ([residual-context benchmark](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/docs/benchmarks/residual-context-occupancy.md#L169-L280), [issue #1500](https://github.com/colbymchenry/codegraph/issues/1500))
- Anonymous usage telemetry and a background GitHub update check are default-on and opt-out. ([TELEMETRY](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/TELEMETRY.md#L1-L41))
- A daemon, watcher, SQLite index, and writer-lock lifecycle add operational complexity. ([README](https://github.com/colbymchenry/codegraph/blob/ba3c21e50d9129d2f5f3843ec3728868ae6d47a1/README.md#L876-L897))
- Still a young project with a large open issue/PR backlog.

**ripwire strengths**
- Token-efficient, deterministic, and CLI-first.
- Task-shaped skills, test-gate/change-check verbs, and explicit disclosure of floors and ambiguity.
- Strong evaluation provenance and active recent development.
- No telemetry; network is not required for normal build or run. ([SECURITY](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/SECURITY.md#L14-L21), [README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L2166-L2178))

**ripwire limitations**
- Pre-1.0 with no compatibility guarantee. ([SECURITY](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/SECURITY.md#L30-L32))
- Name-based, approximate call graph rather than a compiler-grade semantic index. ([ARCHITECTURE](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/docs/ARCHITECTURE.md#L301-L328))
- Narrower language matrix and no native Windows support. ([README](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L2008-L2041), [system requirements](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/README.md#L2166-L2178))
- Hermes and openclaw integrations are explicitly marked as needing real-install verification. ([INSTALL](https://github.com/redhat-et/ripwire/blob/57d713dda2fa8f3d8fcdba7d0f626b60bb291d69/INSTALL.md#L89-L94))

## Switch recommendation

Do **not** replace ripwire wholesale with CodeGraph for this repository’s coding-agent workflow.

Keep ripwire as the default when the priority is:
- minimal standing context,
- deterministic outputs,
- change review, test selection, and blast-radius checks,
- low operational overhead.

Trial CodeGraph only when the priority is:
- broad multi-language/framework orientation,
- one-call semantic exploration,
- tighter integration with a wider set of agents,
- a persistent graph that stays synchronized during long editing sessions.

A hybrid is plausible, but CodeGraph’s own residual-context and daemon/telemetry tradeoffs mean it is not yet a clear upgrade over ripwire for token-sensitive agent workflows.
