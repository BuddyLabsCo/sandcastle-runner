# Interactive terminal orchestration with Herdr and RMUX

Research for issue #304. Checked on 2026-10-29 (Asia/Shanghai).
Repository baseline: `0adf499bf69217b56256ca2affb1c0dca0894110`.
This report proposes an execution model; it does not amend the V1 specification.

## Finding

The proposed experience is technically feasible: keep Runner in the first tab,
launch native interactive Agent sessions in other tabs, and let the operator
interrupt and instruct those same processes directly. Herdr and RMUX expose
programmatic terminal control, so Runner need not implement terminal rendering,
keyboard handling, or a new chat interface. [H1][R1]

Prefer a Herdr-first prototype for the requested workspace/tab experience.
RMUX is a credible alternative, especially when a typed TypeScript SDK or
agent-independent terminal control matters more. Do not implement both before
one completes a real lifecycle test.

The completion boundary needs one adjustment: JSON displayed in a terminal
should trigger investigation at most. A durable, attempt-specific result plus
a safe handoff boundary must authorize downstream work. Delegating PTYs removes
UI ownership; it does not remove result validation, writer coordination, or
failure handling.

## Products and evidence boundary

| Product | Exact upstream | Latest published release observed | Control surface |
| --- | --- | --- | --- |
| Herdr | `herdrdev/herdr` | v0.9.5, 2026-10-14 | JSON-producing CLI; local JSON socket API; lifecycle subscriptions |
| RMUX | `Helvesec/rmux` | v0.10.0, 2026-08-04 | tmux-compatible CLI; daemon SDK; advertised Rust, Python, and TypeScript bindings |

Release identities and dates were checked through GitHub's release API. [V1][V2]
Herdr's automation and Windows documents were also checked at v0.9.5.
RMUX's automation guide was checked at v0.10.0. Website and default-branch
documents can describe newer capabilities; inspect the installed binary's
schema/capabilities before adopting their exact arguments. [H3][H5][R2]

Neither binary was installed on the research machine. No actual native Agent,
human-intervention workflow, package installation, or descendant-cleanup test
was performed. SDK availability in upstream documentation is not proof that a
particular package/version works with this repository's runtime.

## Fit for the proposed experience

| Requirement | Herdr | RMUX |
| --- | --- | --- |
| Keep Runner visible and create Agent terminals | Explicit workspace, tab, and pane APIs | Sessions, windows, and panes through CLI/SDK |
| Start a native interactive Agent | `agent start` for recognized kinds; raw `pane run` otherwise | Run the native CLI as the pane process or send a shell command |
| Operator intervenes in the live conversation | Normal keyboard interaction in that pane | Normal attached terminal interaction |
| Programmatic input and observation | Agent/pane prompt, key, read, and wait methods | Input, capture, streams, and bounded waits |
| Close the terminal | Tab/pane close methods | Window/pane/session control |
| Native Windows | Supported through ConPTY, with documented limitations | Upstream documents native Windows without WSL |
| Recognize Agent lifecycle | Built-in Agent states and integrations | SDK foreground information is best effort; no Agent-name classification |

The table summarizes documented capabilities, not executed acceptance tests.
[H1][H3][H5][R1][R2][R3]

Herdr has explicit Agent concepts and attention states that suit a human
watching several conversations. RMUX has a more general terminal model. Its
advertised `@rmux/sdk` is attractive for a TypeScript Runner, but the CLI is
already sufficient for a first experiment; SDK adoption is not a prerequisite.
[H1][R1][R2]

CodeBuddy is a specific compatibility gap. The Herdr v0.9.5 `agent start`
catalog includes Pi, Claude, and Codex, but not CodeBuddy. CodeBuddy can still
run in a raw pane. Automatic semantic state and native-session restoration
would require a custom integration or separate evidence; do not assume parity
with the recognized Agents. Herdr supports custom state, native session, resume
command, and release reports, but producing accurate reports is additional
integration work. [H3][H6]

## Concrete control options

Herdr's documented CLI supports this sequence, with IDs taken from creation
responses rather than guessed:

```text
herdr tab create --workspace <id> --cwd <worktree> --label <label> --no-focus
  -> result.tab.tab_id
  -> result.root_pane.pane_id

herdr agent start <name> --kind <supported-kind> --pane <pane-id>
herdr agent prompt <name> <short-task-instruction>
herdr agent read <name>
herdr agent send-keys <name> esc
herdr tab close <tab-id>
```

For an unsupported Agent, use the raw pane command surface. Creation supports
per-process environment values, which can carry attempt identity and result
paths. Use explicit workspace/pane IDs throughout; the operator changing focus
must not redirect Runner commands. [H3]

This is a control sketch, not a complete launcher. Startup trust dialogs,
model/options mapping, shell quoting, and prompt submission must be tested.
Store the full task in a file and submit a short instruction to read its
absolute path. This avoids putting a large task body into a shell command.
Invoke the multiplexer with an argument array; never interpolate issue text
into executable shell syntax.

RMUX documents the following observation primitives:

```text
rmux capabilities --json
rmux diagnose --json
rmux stream-pane -t <target> --lines
rmux collect-pane-output -t <target> --until-pane-exit --max-bytes 1048576
```

Its send/wait surface includes `--wait-next-text` and `--wait-pane-exit`.
Verify creation, targeting, and close flags with the installed
`rmux list-commands <command>` before coding against them. [R2][R3]

The release-tagged Rust SDK also supports direct argv launch with cwd and env;
its direct Windows launcher rejects `.cmd`/`.bat` targets. Use a real executable
or an explicit compatible shell for package-manager shims. Window handles
re-resolve a session/index slot, and closing linked/grouped windows can affect
other views. Persist and revalidate terminal identity before cleanup rather
than trusting a reused numeric slot. These are Rust-source findings, not proof
of TypeScript binding parity. [R4][R5]

## Completion must not depend on the screen

Herdr's documented semantics have three consequences:

- `idle`/`done` describe input readiness and attention, not acceptance of an
  Agent Attempt Result.
- A prompt wait does not correlate a unique requested turn; an already active
  turn can satisfy it.
- Output waits search an existing rendered snapshot and can match old text.

Therefore a result-shaped example, an echoed prompt, old scrollback, wrapping,
or an interrupted response can confuse a screen-based completion detector.
Herdr explicitly suggests writing a response to a file when terminal reads
cannot provide the full response. [H1]

RMUX's next-output wait avoids old output, but raw PTY output includes shell
echo. Output quietness is also insufficient to prove success. These are useful
observation tools, not a delivery protocol. [R2]

Recommended minimal contract, owned by Runner:

1. Persist an assignment outside tracked source files, with Run ID, attempt ID,
   operation, exact Worktree/branch/base, prompt path, and result path.
2. Ask the Agent to write the existing result payload inside an envelope bearing
   the assigned attempt ID. Write a temporary file, then rename it within the
   same directory. The ID prevents accidental replay; it is not authentication.
3. Runner reads and validates the exact assigned file. File events are wakeups;
   read on startup and periodically as well, so a missed event is harmless.
4. Record a valid result as a candidate. Establish the handoff boundary before
   Git inspection, publication, cleanup, or another writer starts.
5. Reuse the existing independent Git checks. Persist acceptance once and make
   repeated observations idempotent.

Incomplete JSON, the wrong ID, duplicate conflicting submissions, a closed pane
without a result, and daemon disconnection must never become success.

## Handoff and human intervention

The UX can remove the current stop-and-resume takeover dance: the operator
switches to the Agent tab and uses that Agent's normal interrupt and chat
controls. Runner should not inject automatic recovery prompts while waiting,
because those prompts could compete with the operator.

However, a completed file can appear before the Agent turn ends, and the
operator can start another turn immediately afterward. This creates a
time-of-check/time-of-use problem if Runner verifies Git while a writer remains
active. Neither a terminal close response nor a pane exit event, by itself,
establishes that every writable descendant has settled.

Two implementation policies are possible:

| Policy | Benefit | Required proof |
| --- | --- | --- |
| End the native invocation at each handoff; resume the exact conversation later | Stronger, simpler publication boundary | Preserve native session/store/cwd/options; confirm relevant process settlement |
| Keep the interactive process across implementation/review rounds | Smoothest conversation experience | Explicit control transfer and a reliable no-writer barrier; idle detection alone is insufficient |

For a first prototype, prefer the first policy with one Agent and one Worktree.
The multiplexer owns the terminal and process. Runner still waits for credible
settlement evidence before inspecting or releasing that Worktree. If the
backend cannot provide it, retain the artifacts and report a blocked handoff.
Do not silently weaken the existing guarantee.

Closing a successful tab should be the final presentation cleanup. A failed or
uncertain attempt should leave its terminal and diagnostics available. To keep
the original implementation/review conversations, save native session identity
and reopen those exact sessions when the next phase needs them.

Herdr documents that detach preserves live processes, whereas server restart
reconstructs layout and may resume supported native conversations. Those are
different from restoring Runner's delivery state. Its event history is also
non-durable: loss requires resubscription and authoritative state reads.
Runner must keep its own Recovery Snapshot and reconcile terminals after
reconnection. [H2][H4]

## Mapping to this repository

The current seam is useful, but removing Sandcastle is not a dependency-only
change:

| Surface | Current responsibility | Migration consequence |
| --- | --- | --- |
| `src/run/contracts.ts:AgentExecutor` | Implementation and review attempts | Preserve domain results; reconsider timeout/continuation callback assumptions |
| `src/adapters/sandcastle.ts:runOutput` | Prompt construction, session reuse, retries, output recovery | Replace launch/observation; extract reusable prompt and parsing responsibilities |
| `src/adapters/agent-supervision.ts:superviseInvocation` | Timeouts, retained invocations, takeover coordination | Replace Agent intervention policy with live-terminal waiting and explicit terminal outcomes |
| `src/adapters/no-shell-sandbox.ts` and process settlement | Runner-owned process lifetime | Transfer process ownership while preserving a credible handoff/cleanup barrier |
| `src/adapters/agent-provider.ts` | Sandcastle provider factories | Replace native command/options mapping; preserve configured storage/environment |
| `src/adapters/sandcastle-output.ts` | Result parsing and schemas | Reuse domain validation, remove transport-specific coupling where necessary |
| `src/run/agent-operation.ts:runAgentOperation` | Attempt loop, Git verification, failures, temporary Git config | Retain verification; revise retries and extend resource lifetime until external execution settles |
| Review, repair, and maintenance flows | Reuse sessions and invoke common execution boundary | Apply the same contract to every Agent operation |

These findings come from the local source at the recorded baseline. In
particular, temporary Git configuration currently lives only until
`AgentExecutor.execute` returns. An externally surviving terminal cannot keep
depending on a file Runner has already removed.

The normative `CONTEXT.md`, `docs/specs/v1-orchestration.md`, and
ADR-0001 currently require Sandcastle-backed attempts, bounded same-session
recovery, Process Settlement, and Operator Pause behavior. Adoption requires
explicit amendments and corresponding test updates.

Agent takeover pauses can disappear. Other Operator Pauses also cover GitHub
mutation failures, CI waits, merge rejection, audit errors, and invalid Git
evidence. Eliminating all Operator Pause behavior requires a separate workflow
decision, such as retry-then-exit with resumable state or an explicit Runner
control command. Moving Agent UI to tabs does not resolve those failures.

## Smallest useful prototype and decision gate

Build a disposable Herdr experiment before changing production execution:

1. Launch Runner in the first tab; create one native Agent tab in a known
   Worktree without moving focus. Confirm prompt, cwd, model, options, and
   configured storage.
2. Interrupt a long-running turn manually, diagnose in the same session, and
   resume it. Confirm Runner neither cancels the attempt nor submits another
   prompt.
3. Submit the attempt-specific result file. Confirm malformed, stale, wrong-ID,
   and repeated submissions cannot advance the Run.
4. Keep a harmless writable child alive past candidate submission. Confirm
   verification, tab cleanup, and replacement execution remain blocked until
   the chosen settlement policy is satisfied.
5. Exercise pane closure, CLI crash, Runner restart, and daemon restart.
   Reconcile the same attempt without launching duplicates or accepting stale
   terminal state.
6. Run an implementation/review/fix round with exact conversation reuse, then
   two concurrent issues with isolated result paths and targeting.

On this Windows workspace, also test native PowerShell, executable shims,
paths with spaces, Unicode prompts, multiline input, and keyboard interruption.
Herdr documents native app attachment but excludes direct terminal attachment
and live server handoff on Windows; those limitations do not prevent the
ordinary tab workflow. [H5]

Proceed with replacement only after these checks pass. Until then the outcome
is documented feasibility with specific unproven lifecycle requirements, not
production readiness.

## Primary sources

- [H1: Herdr v0.9.5 agent automation](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/agent-automation.mdx)
- [H2: Herdr socket API](https://herdr.dev/docs/socket-api/)
- [H3: Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
- [H4: Herdr session state and restore](https://herdr.dev/docs/session-state/)
- [H5: Herdr v0.9.5 Windows support](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/windows-beta.mdx)
- [H6: Herdr v0.9.5 custom Agent integration](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/add-herdr-support.mdx)
- [R1: RMUX upstream README](https://github.com/Helvesec/rmux)
- [R2: RMUX v0.10.0 automation guide](https://raw.githubusercontent.com/Helvesec/rmux/v0.10.0/resources/claude/skills/rmux/SKILL.md)
- [R3: RMUX SDK overview](https://github.com/Helvesec/rmux/blob/main/docs/scripting-sdk.md)
- [R4: RMUX v0.10.0 direct process launch source](https://raw.githubusercontent.com/Helvesec/rmux/v0.10.0/crates/rmux-sdk/src/handles/window/new_builder.rs)
- [R5: RMUX v0.10.0 window control source](https://raw.githubusercontent.com/Helvesec/rmux/v0.10.0/crates/rmux-sdk/src/handles/window.rs)
- [V1: Herdr latest release API](https://api.github.com/repos/herdrdev/herdr/releases/latest)
- [V2: RMUX latest release API](https://api.github.com/repos/Helvesec/rmux/releases/latest)
