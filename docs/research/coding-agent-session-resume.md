# Coding Agent CLI session resumption

Research for issue #306. Checked on 2026-10-29 (Asia/Shanghai).
Repository baseline: `0adf499bf69217b56256ca2affb1c0dca0894110`.

## Conclusion and scope

Claude Code, Codex, Pi, OpenCode, Cursor Agent CLI, Qoder CLI, and CodeBuddy
CLI document native conversation resumption by a specific session reference.
They can therefore fit a configurable resume command rather than a Core-owned
Agent allowlist. [CLAUDE][CODEX][PI-CLI][OPENCODE][CURSOR][QODER][CODEBUDDY]

The name `dsh` needs qualification. Official DeepSeek Harness persists sessions
and supports their reuse, including an exact-ID headless command. Its documented
shipped profiles do not establish a built-in interactive terminal application.
The third-party `dsh-cc` TUI distribution documents exact-ID interactive resume.
Do not attribute its terminal behavior to the default upstream installation.
[DSH][DSH-HELP][DSH-CC]

This report concerns saved conversation context. It does not establish that
resume restores live shell jobs, an interrupted tool invocation, or original
processes. It also does not establish that one generic prompt can retrieve the
current native identity in every CLI without configuration.

No Agent was installed or invoked for this research, and no authenticated
cross-process context-recall test was performed. Commands below are documented
examples, not commands executed against a real conversation.

## Resume capability

The commands in this table select an existing native conversation. They do not
include a new task prompt: Runner can send that separately after interactive
startup, as required by the proposed design.

| Product | Exact reference, interactive | Latest or picker alternatives | Evidence |
| --- | --- | --- | --- |
| Claude Code | `claude --resume <session-id>` | `claude -c`; bare `claude --resume` | CLI reference also accepts a session name or absolute JSONL transcript path. Omit `--fork-session` when preserving identity. [CLAUDE] |
| Codex | `codex resume <session-id>` | `codex resume --last`; bare `codex resume` | `--last` is normally cwd-scoped; `--all` widens discovery. A differing cwd can trigger a directory-choice prompt; an explicit `--cd` takes precedence. [CODEX] |
| Pi coding agent | `pi --session <session-file-or-id>` | `pi -c`; `pi -r` picker | Pi accepts a persistent JSONL path or session ID. Ephemeral `--no-session` conversations cannot resume after exit. [PI-CLI][PI-SESSIONS] |
| OpenCode | `opencode --session <session-id>` or `opencode -s <session-id>` | `opencode -c`; `opencode session list --format json` | These are TUI options; `opencode run` is a separate non-interactive route. [OPENCODE] |
| Cursor Agent CLI | `agent --resume <chatId>` | `agent resume`; `agent --continue`; `agent ls` | Current official documentation names the executable `agent`; use the executable actually installed. [CURSOR] |
| Qoder CLI | `qoder --resume <session-id>` or `qoder -r <session-id>` | `qoder -c`; bare `qoder --resume` | Session state is stored per project; `QODER_CONFIG_DIR` can select another storage root. [QODER] |
| CodeBuddy CLI | `codebuddy --resume <session-id>` or `codebuddy -r <session-id>` | `codebuddy -c`; bare `codebuddy -r` | Official CLI documentation describes interactive startup and persisted conversation continuation. [CODEBUDDY] |
| Official DeepSeek Harness | Interactive command depends on the installed profile | Profile-dependent | `dsh headless --session-id <existing-id> "continue"` is confirmed, but is non-interactive. Unknown IDs are errors. [DSH-HELP] |
| Third-party dsh-cc | `dsh-cc --resume <session-id>` | `dsh-cc -c`; project auto-resume; `-n` starts fresh | The wrapper boots a configured Harness TUI profile. [DSH-CC] |

Latest-session shortcuts and pickers are useful to humans but are unsuitable as
the identity contract for several concurrent Runner conversations. Retain an
exact reference and the associated worktree and configured storage.

## Obtaining a reference for a file-based Session Probe

The transport can be generic: write an attempt-specific temporary JSON file,
then rename it to the assigned final path. The origin of the native session
reference can vary without requiring Core to understand the reference itself.

| Product | Evidence-backed identity route | Important qualification |
| --- | --- | --- |
| Claude Code | Preassign a UUID with `claude --session-id <uuid>`; or capture `session_id` from a hook. [CLAUDE][CLAUDE-HOOKS] | A universally available model-shell session environment variable was not established. Preassignment avoids needing to discover a generated ID. |
| Codex | Hook input contains `session_id` and optional `transcript_path`; `SessionStart` covers startup and resume. [CODEX-HOOKS] | Earlier in this chat, a targeted local check found matching `CODEX_THREAD_ID` and `CODEX_SESSION_ID`. That observation is specific to this host execution environment, not a guarantee for every Codex distribution. |
| Pi | `PI_SESSION_ID` and `PI_SESSION_FILE` are explicitly documented for model-callable `bash` and `powershell` tools. `--session-id <id>` can also open or create an ID. [PI-ENV][PI-CLI] | User `!`/`!!` commands do not receive those metadata variables; custom shell tools can disable exposure. The file variable is absent for ephemeral sessions. |
| OpenCode | Session hooks expose `sessionID`; a plugin can write the probe file or add tool environment. SDK session creation returns an ID. [OPENCODE-PLUGIN][OPENCODE-TYPES][OPENCODE-SDK] | No default model-shell session environment variable was established. Adding a plugin or using SDK precreation is additional setup, not an already-proven prompt-only probe. |
| Cursor | `agent create-chat` creates an empty chat and returns its ID before interactive resume. [CURSOR] | Headless JSON also contains `session_id`, but that is not evidence of automatic identity exposure inside interactive shell tools. Generic Cursor hook parity with CLI was not fully verified. |
| Qoder | `qoder --session-id <uuid>` preassigns the ID; hook input contains `session_id` and `transcript_path`. [QODER][QODER-HOOKS] | The settings reference lists `QODER_SESSION_ID`, but does not by itself establish automatic injection into model-callable shell tools. [QODER-SETTINGS] |
| CodeBuddy | Official reference documents `--session-id <uuid>`; hook input includes `session_id` and `transcript_path`. [CODEBUDDY-REFERENCE][CODEBUDDY-HOOKS] | UUID preassignment was documented, not live-tested in this pass. Do not infer that template expansion syntax is necessarily a shell environment variable. |
| Official Harness / dsh-cc | Persisted sessions exist; dsh-cc prints the session ID and resume command on exit. [DSH-HELP][DSH-CC-BASICS] | Current-session ID retrieval by the model during a fresh live TUI conversation was not established. Resume input variables are not proof of new-session identity exposure. |

Preassigned identity and a model-written Session Probe are alternatives, not
mandatory additions to one another. Where a CLI permits Core or a configured
launcher to select a native ID first, the configured value can be recorded
directly and later verified through restoration. Otherwise the Agent or a
configured hook/wrapper can submit the real native reference using the same
file protocol.

The reference must identify the actual selected conversation, not a newly
invented Runner UUID presented as if it were a native ID. A matching opaque
string alone also does not prove that a later resume restored the intended
history; that requires a context-recall acceptance test.

## Product and version qualifications

- Pi's former `badlogic/pi-mono` entry now directs users to
  `earendil-works/pi`. The CLI and environment documentation above was checked
  at release **v1.4.0**, published on **2026-10-21**. Its `--session-id` may
  create a missing session, so this option alone is not a strict
  "resume must already exist" check. [PI-RELEASE][PI-CLI][PI-ENV]
- OpenCode plugin session fields were checked against **v1.19.5** source,
  published on **2026-10-28**. Current web documentation also discusses V2;
  do not assume full V1/V2 CLI and plugin parity without testing the selected
  executable. [OPENCODE-RELEASE][OPENCODE-TYPES]
- Official Harness is the `deepseek-ai/deepseek-harness` project and
  `@deepseek-ai/dsh` package. `dsh-cc/dsh-cc` and `@dsh-cc/cli` are a separate
  third-party distribution. Upstream launcher help shows `dsh tui --resume`
  as an example of arguments forwarded to a custom profile, not evidence that
  a standard TUI profile ships in the base package. [DSH][DSH-HELP][DSH-CC]
- For the remaining products, evidence is from current official documentation,
  rather than an assertion that every historical installed version implements
  every option shown here.

## Implication for issue-runner-core

The research supports the proposed design:

1. Keep one CLI and independently installed environment plugins.
2. Configure Agent start and resume commands rather than a Core-owned brand
   allowlist. Keep prompt submission separate from those commands.
3. Treat `session_ref` as opaque. A configured command, Agent tool call,
   hook, or wrapper establishes it.
4. Use separate file handoffs for Session Probe and substantive results;
   retain existing result schemas and independent Git verification.
5. Prove exact-session restoration on the selected executable, worktree, and
   storage configuration before claiming that configuration is supported.

This does not require returning to screen-based work-completion detection.
It does leave the already-identified startup-readiness and input-submission
questions to the terminal execution design.

For CodeBuddy, this repository separately contains earlier authenticated
cross-process continuation and manual native takeover evidence in
`codebuddy-provider-evidence.md` and `codebuddy-takeover-evidence.md`.
Those recorded Linux/CLI/backend versions are historical evidence, not new
measurements or proof of every platform/configuration.

## Primary sources

- [CLAUDE: Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [CLAUDE-HOOKS: Claude Code hook reference](https://code.claude.com/docs/en/hooks)
- [CODEX: OpenAI Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [CODEX-HOOKS: OpenAI Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [PI-CLI: Pi v1.4.0 CLI guide](https://raw.githubusercontent.com/earendil-works/pi/v1.4.0/packages/coding-agent/docs/cli.md)
- [PI-ENV: Pi v1.4.0 environment variables](https://raw.githubusercontent.com/earendil-works/pi/v1.4.0/packages/coding-agent/docs/environment-variables.md)
- [PI-SESSIONS: Pi sessions guide](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sessions.md)
- [PI-RELEASE: Pi v1.4.0 release](https://github.com/earendil-works/pi/releases/tag/v1.4.0)
- [OPENCODE: OpenCode CLI reference](https://opencode.ai/docs/cli/)
- [OPENCODE-PLUGIN: OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OPENCODE-TYPES: OpenCode v1.19.5 plugin types](https://raw.githubusercontent.com/anomalyco/opencode/v1.19.5/packages/plugin/src/index.ts)
- [OPENCODE-SDK: OpenCode SDK](https://opencode.ai/docs/sdk/)
- [OPENCODE-RELEASE: OpenCode v1.19.5 release](https://github.com/anomalyco/opencode/releases/tag/v1.19.5)
- [CURSOR: Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters)
- [QODER: Qoder sessions](https://docs.qoder.com/cli/sessions)
- [QODER-HOOKS: Qoder hook reference](https://docs.qoder.com/cli/hooks-reference)
- [QODER-SETTINGS: Qoder settings reference](https://docs.qoder.com/cli/settings-reference)
- [CODEBUDDY: CodeBuddy CLI reference](https://www.codebuddy.ai/docs/cli/cli-reference)
- [CODEBUDDY-REFERENCE: CodeBuddy command reference](https://www.codebuddy.ai/docs/cli/reference)
- [CODEBUDDY-HOOKS: CodeBuddy hooks](https://www.codebuddy.ai/docs/cli/hooks)
- [DSH: Official DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DSH-HELP: Official Harness generated CLI help](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cli-help.md)
- [DSH-CC: dsh-cc CLI reference](https://dsh-cc.github.io/zh/reference/cli.html)
- [DSH-CC-BASICS: dsh-cc interactive basics](https://dsh-cc.github.io/zh/guide/interactive-basics.html)
