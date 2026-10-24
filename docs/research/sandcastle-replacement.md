# Controlling Codex without Sandcastle

**Issue:** [#200](https://github.com/BuddyLabsCo/sandcastle-runner/issues/200)

Checked on 2026-10-24 against installed `codex-cli 0.164.0`, the published `@openai/codex-sdk@0.164.0` package, generated protocol bindings, and official OpenAI documentation. App-server fits the requested session lifecycle: create and name a thread before asking the model to work. Replacing Sandcastle with the TypeScript SDK alone does not change its underlying `exec` transport.

## What this repository uses from Sandcastle

The implementation review uses fetched `origin/main` commit [`365e147`](https://github.com/BuddyLabsCo/sandcastle-runner/tree/365e14729a54223878a82bbfae0b043b0b0e01f4). The original checkout is at `b2d02af` with a local prompt commit; it was left unchanged. The relevant execution behavior matches, except that the original checkout retains a web-search configuration removed from main.

Production imports of `@ai-hero/sandcastle@0.12.0` are confined to three files:

| File | Imported capability | Replacement work |
| --- | --- | --- |
| `src/adapters/sandcastle.ts` | `run`, `Output.object`, `StructuredOutputError`, execution/result types | Own the execution transport, terminal status, output extraction, and error diagnostics; preserve the existing retry policy |
| `src/adapters/codex-agent.ts` | `codex` provider factory | Replace CLI command construction and provider-specific stream parsing with an app-server client |
| `src/adapters/no-shell-sandbox.ts` | Sandbox provider and execution option types | Remove the Sandcastle-shaped facade; retain reusable Windows executable/shim handling |

Each task uses `maxIterations: 1`, `branchStrategy: { type: "head" }`, an existing worktree, inline prompts, file logging, and `completionSignal: []`. Sandcastle builds `codex exec --json` or `codex exec resume`, passes model/effort and approval flags, normalizes assistant/tool/session/usage events, checks exit status, maintains idle timing, and checks host session storage when resuming. Its lifecycle also writes safe-directory and author settings into the isolated `GIT_CONFIG_GLOBAL` supplied by the Runner. These behaviors were checked in the installed package's `dist/index.d.ts` and source maps for `AgentProvider.ts`, `Orchestrator.ts`, `run.ts`, and `SandboxLifecycle.ts`.

Sandcastle's `Output.object` extracts tagged JSON and calls the Runner's supplied validator. It does not use Codex's native `outputSchema`. Its automatic structured-output retries are disabled with `maxRetries: 0`; the Runner implements those retries itself. The Runner consumes stdout, validated output, session IDs, and structured error context, rather than trusting Sandcastle's returned commit claims. See the [execution adapter](https://github.com/BuddyLabsCo/sandcastle-runner/blob/365e14729a54223878a82bbfae0b043b0b0e01f4/src/adapters/sandcastle.ts).

The Runner already owns prompt substitution, result business rules, model/effort configuration, retry delays, Operator Pause, fresh-context review, worktree management, branch/commit verification, publication, CI, maintenance, audit, and Recovery Snapshots. Keep those boundaries. In particular, keep [result validation](https://github.com/BuddyLabsCo/sandcastle-runner/blob/365e14729a54223878a82bbfae0b043b0b0e01f4/src/adapters/sandcastle-output.ts), [independent Git verification](https://github.com/BuddyLabsCo/sandcastle-runner/blob/365e14729a54223878a82bbfae0b043b0b0e01f4/src/run/agent-operation.ts), and the existing [`AgentExecutor` interface](https://github.com/BuddyLabsCo/sandcastle-runner/blob/365e14729a54223878a82bbfae0b043b0b0e01f4/src/run/contracts.ts).

## Assessing the three replacement reasons

**Other agent CLIs:** The installed package has no built-in Qoder factory, but exports a custom `AgentProvider` contract. A downstream provider could implement command construction, stream parsing, and optional session storage without removing Sandcastle. This Runner is also Codex-specific: CLI wiring constructs one executor, configuration contains only model/effort, and diagnostics hardcode `provider: "codex"`. Removing the package alone does not add Qoder support. An owned adapter boundary is reasonable, but Qoder still needs verified launch, continuation, output, and cancellation semantics.

**Session probes and names:** `prepareSession` sends `Reply with exactly: SESSION_READY`, waits for that invocation, stores the returned ID, and then calls the local `renameCodexSession`. That probe is Runner policy, not a Codex requirement. Even Sandcastle exposes raw stream events through file logging, so capturing `thread.started` during actual work can remove the extra probe. App-server goes further: it creates and names the thread before actual work. The repository already implements naming through `thread/name/set` in [codex-session-name.ts](https://github.com/BuddyLabsCo/sandcastle-runner/blob/365e14729a54223878a82bbfae0b043b0b0e01f4/src/adapters/codex-session-name.ts).

**Operator Pause prompts:** `runOutput` appends `agent-attempt-output.md` or `review-attempt-output.md` to every continuation unless already present. Tests explicitly require this behavior. Sandcastle does not force that text. Removing the append is possible independently, although the current adapter still requires a tagged result. Native per-turn schemas can replace the formatting instructions; semantic validation and the behavioral rule reserving push/PR/tracker operations for the Runner must remain. A plain conversational reply still needs a structured handoff before this workflow can continue.

## Invocation choices

| Interface | Session identification | Naming and lifecycle | Fit for this runner |
| --- | --- | --- | --- |
| `codex exec --json` | Streams `thread.started` with `thread_id` during startup | No title/name flag in installed help; resume by stored ID | Smallest process adapter; no separate model probe is required to capture an ID during actual work |
| TypeScript Codex SDK | New `Thread.id` starts as `null`; `thread.started` populates it | `startThread`, `run`, `runStreamed`, and `resumeThread`; no name setter in inspected public types | Convenience wrapper over `exec`, so it does not create a pre-generation ID by itself |
| `codex app-server` | `thread/start` returns `thread.id` before a model turn | `thread/name/set`, `thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt` | Best match for controlling creation, naming, continuations, and output format |
| Python Codex SDK | Uses app-server JSON-RPC | Creates a thread separately from running a prompt | Supported alternative, but introduces Python into this TypeScript runner |
| `codex agents` | Browses sessions on the shared local daemon | Interactive command center | Useful operator UI; use the underlying app-server protocol for automation |

The JSONL event and structured-output interfaces are documented in [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode). The SDK entry points and Python transport are documented in [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk). The CLI command center and app-server command caveats are documented in [Developer commands](https://learn.chatgpt.com/docs/developer-commands).

The TypeScript SDK transport and lazy ID claims above were checked directly in the distributed package: `package/dist/index.js` creates new threads with `id = null`, spawns `exec --experimental-json`, and assigns the ID on `thread.started`. The inspected artifact was downloaded with `npm pack @openai/codex-sdk --pack-destination /tmp --ignore-scripts --json`; its version was `0.164.0` and SHA-1 was `11e628a0dcd9b0d0bbe823c2b540c33c585a6c6b`. This package was inspected, not installed into the repository.

## Create and name a thread before generation

Start `codex app-server --listen stdio://`. Wait for each request's response before sending the dependent request. The following wire messages show the sequence; replace `thread_uuid` with the ID returned by request 2:

```jsonl
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"sandcastle_runner","version":"0.1.0"}}}
{"method":"initialized"}
{"id":2,"method":"thread/start","params":{"cwd":"/path/to/worktree","approvalPolicy":"never","sandbox":"workspace-write"}}
{"id":3,"method":"thread/name/set","params":{"threadId":"thread_uuid","name":"issue-200 implementation"}}
{"id":4,"method":"turn/start","params":{"threadId":"thread_uuid","input":[{"type":"text","text":"Implement the ticket.","text_elements":[]}]}}
```

Requests 1 through 3 do not start a model turn. Naming is a separate API call, not a `title` parameter to `thread/start`. `clientInfo.title`, when supplied during initialization, identifies the integration and does not name the conversation. The installed generated `ThreadStartParams` has neither `name` nor `title`; `ThreadSetNameParams` requires `threadId` and `name`.

The [App-server protocol documentation](https://learn.chatgpt.com/docs/app-server) separates threads from generation turns. It documents turn-scoped `outputSchema`, interruption, and resuming stored threads. It also distinguishes `thread.id` from `thread.sessionId`: forks can share a root session ID. Persist the thread ID used for resume; do not substitute a fork's root session ID.

Generate bindings from the pinned runtime with `codex app-server generate-ts --out /tmp/protocol`. The installed `0.164.0` binding uses `sandbox: "workspace-write"` for `thread/start`; the website's current example uses `"workspaceWrite"`, which this binary rejects. `turn/start.sandboxPolicy` is a different type. Prefer the installed schema when examples disagree.

## Local verification without a model request

A smoke check used a new temporary `CODEX_HOME`, removed `OPENAI_API_KEY` and `CODEX_API_KEY` from the child environment, and ran outside the repository. It sent no `turn/start`, so it requested no inference and made no worktree changes. Results were:

1. `initialize` succeeded without credentials.
2. `thread/start` returned an ID, matching root `sessionId`, `ephemeral: false`, and a rollout path.
3. `thread/name/set` succeeded before any model turn.
4. `thread/read` returned the supplied name.
5. After terminating the server, the rollout file existed.
6. A new server using that temporary home returned the name through `thread/read` and successfully resumed the same ID through `thread/resume`.

This confirms that this installed version can persist, name, and resume a new thread without a probe turn. It is not a latency benchmark or a guarantee for older Codex versions. Verification metadata is in `/tmp/sandcastle-codex-rpc-verification.json`; generated bindings are in `/tmp/sandcastle-codex-protocol-0164`.

## Continuations and operator control

For a completed turn, start another turn on the same thread with only the operator's message. For an active turn, use `turn/steer`; for cancellation, use `turn/interrupt`. Supply `outputSchema` only when a runner-readable result is needed. Omitting a new schema does not erase output-format instructions already present in conversation history, so removing repeated prompt text also requires changing the runner's prompt construction.

Returning free text cannot replace the runner's validated Agent Attempt Result without another handoff step. A useful design is free-form operator turns followed by a separate structured handoff turn. Keep independent branch and commit verification after that handoff.

Thread visibility needs separate verification. The documented `thread/list` defaults to interactive source kinds; `exec` and `appServer` are distinct supported filters. Sharing `CODEX_HOME` makes stored data available, but a private stdio server is not automatically the shared daemon displayed by `codex agents`. No desktop or TUI discoverability test was performed.

## Other interfaces named agents

The OpenAI Agents SDK and managed Agents API are separate integration choices. The Agents SDK runs an agent loop inside the application; the Agents API runs an OpenAI-managed Codex harness with service-side sessions. Those session resources are not interchangeable with local Codex threads. See [Agent runtime choices](https://developers.openai.com/api/docs/guides/agents) and [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview).

Use a local app-server adapter for the requested local worktree workflow. Managed Agents API would change deployment, authentication, state ownership, and billing assumptions without solving the cross-CLI adapter requirement.

## Minimum migration scope

Keep `AgentExecutor.execute` and `executeReview`, and implement a Codex app-server adapter behind them. Start with one owned server per concurrent worktree/attempt lineage rather than adding an unrelated shared-daemon manager. Reuse it for continuation turns until the attempt lineage completes. This is a proposed boundary, not an implemented design.

The change must reach these surfaces:

1. Replace `sandcastle.ts` transport calls with request/response correlation, notification handling, `thread/start`, `thread/name/set`, `thread/resume`, and turn lifecycle handling. Capture IDs before work; distinguish completed, failed, and interrupted turns. Preserve logs, assistant replies, timeouts, and diagnostics.
2. Remove the session probe and integrate the existing rename helper's behavior. Replace the XML extraction and Sandcastle error types with native structured output plus existing result validation. Preserve the current automatic retry and Operator Pause semantics unless explicitly changing their contract.
3. Remove the provider factory and sandbox type dependency. Preserve argument-array spawning, Windows shim support, Git identity, safe-directory handling, and environment isolation. The current host sandbox has no child-process cancellation and maps `exitCode: null` to zero; do not copy those behaviors into the new lifecycle.
4. Update `src/cli.ts` construction, package manifests/lockfile, Sandcastle-specific test doubles, execution/result/name tests, and operator continuation expectations. Test failed turns, missing/invalid results, startup failure before ID creation, timeouts, cancellation, and same-thread continuation.
5. If Qoder is in the accepted implementation scope, add provider selection to `AgentConfig`, parsing, executor dispatch, provider diagnostics, examples, and configuration tests. Reuse the existing executor boundary; do not prebuild a framework for unverified future CLIs.
6. Update retry documentation and the glossary's probe references while preserving the boundary in [ADR-0001](../adr/0001-configurable-retry-policy.md). If recovery must resume an active attempt after restarting the Runner, extend the Recovery Snapshot deliberately: the current adapter's session map exists only in memory.

Switching transport does not solve orphan-process recovery. The earlier [App Server recovery investigation](codex-app-server-recovery.md) establishes why persisted IDs alone do not supervise an old execution after a server crash. That note checks an older runtime; verify the supported runtime's shutdown and descendant-process behavior before claiming stronger guarantees. No existing ADR requires keeping Sandcastle.

This is a contained execution-adapter replacement, with additional configuration work for multiple providers. It does not require rewriting the ticket workflow, Git/PR/CI adapters, or result business rules. No implementation change is included in this research.

## Limits

No model task, production recovery scenario, desktop UI, or Qoder CLI was tested. App-server is marked experimental by the installed CLI and official command documentation; pin the supported runtime and test the protocol and crash-recovery behavior before migrating production runs.
