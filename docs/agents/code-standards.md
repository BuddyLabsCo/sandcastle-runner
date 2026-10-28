# Code Architecture

Use this map to decide where TypeScript code belongs. It describes the current
V1 layout. Keep small helpers inside their owner. `npm run check` owns
formatting, lint, and type diagnostics.

## Directory ownership

```text
src/
  cli.ts          Command parsing, informational output, production wiring, exit status
  init.ts         Reviewed initialization assets and destination creation
  project-directory.ts  Project-key validation and launch-directory child resolution
  config.ts       Project configuration, credentials, prompt paths
  audit.ts        Diagnostic JSONL serialization and filesystem writes
  recovery.ts     Durable recovery snapshot I/O
  run/            Workflow decisions and in-memory Run state
  adapters/       GitHub, Git, Sandcastle, clock, and terminal operations
  prompts/        Runner-owned task-context, continuation, and output prompts
templates/        Reviewed initialization configuration and Project prompts
scripts/
  build.ts        Emit compiled ESM modules and package-relative prompts into dist/
  npm-command.ts  Portable npm entry-point launch for package checks on every platform
  package-acceptance.ts  Inspect a packed tarball and exercise its installed executable
  release/        Standalone release proposal and publication entry points
tests/
  recovery.test.ts Recovery snapshot behavior
  run/            Behavioral scenarios through the real Run
  adapters/       Adapter contract, recovery, and local process-lifecycle checks
  package/        Built-tarball and npm executable-shim acceptance
  release/        Release script and workflow boundary checks
  support/        Scripted fakes and controlled time
```

`cli.ts` constructs adapters and passes them to the Run entry point. It keeps
informational flags and `init` ahead of Project loading, and detects direct
execution without relying on a runtime version-specific entry flag. `init.ts`
copies `templates/` unchanged into the launch-directory child; it performs no
project-key substitution or environment probing. `project-directory.ts` is the
single definition of the `--project` key boundary for both initialization and
loading. `config.ts` reads and validates Project files and resolves credential
references; it does not select tickets or start agents. Project YAML and
Markdown prompts, logs, and Recovery Snapshots remain external files in their
configured locations. Runner-owned templates under `src/prompts/` supply task context, execution restrictions,
continuation instructions, and output contracts. Project prompts contain only
repository-specific instructions.

## Release scripts

`scripts/release/` holds the production entry points that the release workflows
invoke. They are not part of the Runner CLI or the published package. Release
eligibility, version and changelog decisions, release pull request updates,
publication validation, and retry behavior live there; workflows supply only
events, permissions, checkout, toolchain setup, and credential wiring.
`scripts/build.ts` emits the published JavaScript and copies package-relative
Markdown prompts into `dist/`; `scripts/package-acceptance.ts` accepts the
packed tarball that publication will upload. Neither script is shipped.

Each entry point runs outside Actions with explicit environment inputs and
reports failures through output and exit status. `release-lib.ts` owns shared
Git, `gh`, version, manifest, and changelog helpers; `package-artifact.ts` reads
a packed npm tarball. Release scripts import each other and Node built-ins,
never `src/`. Tests drive the entry points in disposable Git repositories with
controlled `gh` and `npm` commands instead of importing private helpers.

## Workflow modules

Place these modules under `src/run/`. Each owns a cohesive workflow responsibility.

| Module | Code that belongs here |
| --- | --- |
| `run.ts` | Public Run entry point; Run-local state; Batch concurrency, all-ready barrier, ordered integration, rescans, maintenance scheduling, and terminal outcomes. |
| `report.ts` | Ordered per-ticket Run outcome presentation and final operator report rendering, including short PR hyperlinks and unresolved Operator Pause skips. |
| `progress.ts` | Per-Attempt terminal progress lines: issue and phase labels, review rounds, and retry marking. |
| `run-input.ts` / `run-batch.ts` | Run contracts and the wiring from a reserved Batch into Agent Attempts. |
| `discovery.ts` / `discovery-state.ts` | Eligibility, Reservations, Parent/child/blocker reads and revalidation, exhaustion, and Parent closeout eligibility. |
| `attempt.ts` / `agent-operation.ts` / `review-attempt.ts` | Worktree preparation, per-Attempt Git configuration, prompt metadata, Agent and Review Attempt execution, the alternating review/fix loop with independent in-process session reuse, and Verified Handoff decisions using observed Git state. Reused for implementation, repairs, and maintenance. |
| `agent-pause.ts` | Operator Pause presentation for Agent Attempt failures, ticket-bound skip decisions, and audit-only disposal of skipped Agent logs. |
| `agent-logs.ts` | Stage-specific Agent Attempt log naming, review findings Markdown lifecycle, owned-stage cleanup, and deletion-failure evidence. |
| `operation-audit.ts` | Workflow operation audit appends and audit-only Agent log cleanup failures. |
| `pull-request.ts` / `pull-request-core.ts` | Publication/readiness, integration, merge confirmation, and Ticket Closure Policy. It never decides Batch order. |
| `pull-request-recovery.ts` / `pull-request-repair.ts` | Durable publication recovery, required-check polling, and CI/conflict repair budgets. |
| `maintenance.ts` | One maintenance occurrence: ticket creation, documentation attempt, ordinary PR lifecycle reuse, or direct no-change closure. Label-trigger scheduling stays in `run.ts`. |
| `cleanup.ts` | Terminal Worktree enumeration, exact ownership matching, removal, and retry evidence. |
| `run-coordination.ts` | Run-scoped intervention ownership, advancement gates, and cancellation wake-up. Shared through scoped OperatorIO and passed to Agent Executor launches. |
| `operations.ts` | Shared Operation Retry for external reads and workflow writes, plus serialized Operator Pause actions, explicit issue scope, cancellation, takeover acknowledgement, and operation audit events. It shares one Run-scoped coordination boundary across workflow writes, Agent results, and execution launches. Operator input never substitutes for observed results. |
| `standalone-discovery.ts` | Direct issue eligibility, Reservation, and terminal handling without Parent or child discovery. |
| `standalone-run.ts` | Standalone issue orchestration through implementation, Review, publication, integration, and cleanup. |
| `publication-input.ts` | Shared construction of publication inputs for Parent and standalone runs. |
| `write-reconciliation.ts` | Pre/post-write reconciliation for Parent closure. It does not perform writes or own workflow state. |
| `contracts.ts` | Injected boundary interfaces and cross-module input/result types. Keep operation-specific types beside their owner. |

Keep audit serialization and file writes in `audit.ts`; workflow policy for audit
failures belongs in `operations.ts`. Configuration and audit use the filesystem
directly, including temporary directories in tests; add no filesystem interface.

## Adapters and dependency direction

Under `src/adapters/`, implement only operations the current implementation needs:

| File / interface | Responsibility |
| --- | --- |
| `github-tracker.ts` / `Tracker` | Issue hierarchy, dependencies, state, assignees, labels, and issue mutations. |
| `github-code-host.ts` / `CodeHost` | Repository metadata, PRs, required checks, merge requests, and queue observations. |
| `git-workspace.ts` / `GitWorkspace` | Fetch, Worktree creation/inspection/closure, commits, working-tree evidence, and push. |
| `sandcastle.ts` / `AgentExecutor` | Sandcastle invocation with the selected agent, model, and options, native run names, streaming, silent Sandcastle startup banners, the `SESSION_READY` probe, same-session continuation, generic invocation/output recovery under Agent Retry, shared per-invocation supervision, and cancellation handling. Every automatic follow-up requires explicit owned-process settlement and resolved Run-wide interventions. Run names identify tasks in log output but do not title the agent application's session list. Delegate invocation and native session resumption to Sandcastle; keep execution-level retry mechanics here, while workflow modules own Operator Pause policy. |
| `agent-provider.ts` | Resolves the explicit local `codebuddy` provider or the configured member of Sandcastle's exported agent factories. Requires an explicit configured agent, forwards the model and options, and never infers the agent from the model. Keep the explicit CodeBuddy registration local; do not add a provider framework or app-server session-title integrations. |
| `codebuddy.ts` | Local Sandcastle-compatible CodeBuddy provider: foreground print commands, supported native options, stream translation, terminal failure evidence, and exact main-session lookup using the CLI storage configuration. It owns no workflow decisions or permission approval transport. |
| `no-shell-sandbox.ts` | Generic host command parsing and launch, plus per-invocation owned-handle settlement of host processes started by the Runner's no-sandbox provider. It does not inspect agent names or provider output. |
| `process-settlement.ts` | Invocation settlement capture and nonretryable cleanup-failure diagnostics that block the next automatic process launch. |
| `agent-supervision.ts` | Per-invocation idle and overall thresholds, raw process activity, retained outcomes through timeout acknowledgement, selected-only kill, exact native transcript lookup for manual takeover, and cancellation settlement. Uses the Run-provided timeout pause and advancement gate; disables Sandcastle's native idle-kill timer. |
| `process-errors.ts` | External command startup diagnostics and Agent Attempt output errors. It does not classify failures by agent name or message text. |
| `process-tree.ts` | OS-bound termination of a Runner-owned child process and its descendants. |
| `sandcastle-output.ts` | Agent and Review Attempt output schemas, strict validation, structured-output diagnostics, and prompt placeholder replacement. |
| `clock.ts` / `Clock` | Time, delays, and timeouts. |
| `terminal.ts` / `OperatorIO` | Display and input/EOF; workflow code interprets operator decisions. |

`cli.ts` imports workflow and concrete adapters. Workflow code imports contracts,
never concrete adapters. Adapters implement contracts and translate external
data; they do not call workflow modules or decide eligibility, scheduling,
repair, or completion. The Agent Executor may own execution-level retry and
timeout mechanics defined by its input policy. The two GitHub adapters may
share private transport code while retaining separate responsibilities.

Within the workflow, `run.ts` coordinates discovery, attempts, PR operations, and
maintenance. Maintenance reuses attempts and PR operations; PR repairs reuse
attempts. Lower-level modules never call back into `run.ts`. Keep workflow
state in-memory and instance-owned; the Recovery Snapshot is the only persisted
delivery evidence, and audit logs are not recovery storage.

## Evolving the structure

When this layout no longer fits the current implementation needs, adapt it.
Keep related behavior together, give each module a clear responsibility, and
maintain explicit, acyclic dependencies. Place tests with the behavior they verify
within the test layout.

Update this document in the same change to reflect the resulting directories,
module responsibilities, and dependency direction. Keep the documented structure
aligned with the code as it evolves.
