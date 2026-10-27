# Sandcastle Runner

Sandcastle Runner is a local CLI that uses code to manage the routine steps of
delivering GitHub tickets. It selects eligible tickets, prepares isolated
worktrees, verifies and pushes commits, publishes pull requests, waits for CI,
and coordinates merges and ticket closure.

This keeps AI agents focused on writing, reviewing, and repairing code while
reducing unnecessary token use for workflow coordination. Runner invokes agents
through Sandcastle when a task needs code changes or review.

Runner runs on Windows, macOS, and Linux and supports `codex`,
`claude-code`, `pi`, and `codebuddy`. It uses Sandcastle's native factories
and a local CodeBuddy provider; agents run locally on the host.

See the [Project guide](projects/README.md) for workflow details.

## Prerequisites

Install these on the host that runs Runner:

- Node.js 22.18.0 or newer, including its bundled npm.
- Git, with `git` on `PATH`; Runner requires worktree support.
- GitHub CLI (`gh`), with `gh` on `PATH`.
- An installed and authenticated coding-agent CLI for every configured agent,
  directly runnable on `PATH`.
- Native agent permission settings that allow required operations without
  interactive CLI approval prompts.
- A GitHub repository checkout at an absolute path.

Runner supports `codex`, `claude-code`, `pi`, and `codebuddy` profiles.
Prepare each selected agent's own sign-in,
skills, MCP servers, and native configuration. Runner does not install or
normalize them.

Complete authentication and permission setup before starting Runner. Operator
Pause sends recovery instructions after an Agent Attempt stops; conversation
text cannot answer a native approval request or grant a denied permission.

Keep the Runner checkout, project checkout, worktrees, state, logs, temporary
files, and agent session state on paths without Chinese characters.

## Installation

Runner is a checkout-only CLI and is not published to a package registry:

```sh
git clone https://github.com/xiakeng/sandcastle-runner.git
cd sandcastle-runner
npm ci
```

## Windows Setup

Install Node.js, Git, `gh`, and each selected agent CLI. Reopen PowerShell after
installation so `PATH` changes take effect, then verify:

```powershell
node --version       # v22.18.0 or newer
npm --version
git --version
gh --version
codex --version      # replace with the agent CLI you configured
```

Sandcastle's default session lookup reads `HOME` from the process that starts
Runner. Windows may provide only `USERPROFILE`, so configure `HOME` once at the
user level:

```powershell
[Environment]::SetEnvironmentVariable('HOME', $env:USERPROFILE, 'User')
$env:HOME = [Environment]::GetEnvironmentVariable('HOME', 'User')
node -p "process.env.HOME"
```

For a nonstandard storage location, set the explicit native `options.sessionStorage`
lookup root instead:

```yaml
options:
  sessionStorage:
    hostSessionsDir: 'C:\work\agent-sessions\sessions'
```

Codex and Pi use `hostSessionsDir`; Claude Code uses `hostProjectsDir`. These
options select where sessions are looked up and do not relocate agent storage.

Set the credential variables named by `tracker.tokenEnv` and
`codeHost.tokenEnv` in `config.yaml`; the templates use `GH_TOKEN`. As with
`HOME`, configure it once at the user level:

```powershell
[Environment]::SetEnvironmentVariable('GH_TOKEN', 'your-github-token', 'User')
$env:GH_TOKEN = [Environment]::GetEnvironmentVariable('GH_TOKEN', 'User')
node -p "Boolean(process.env.GH_TOKEN)"
```

## macOS and Linux Setup

Install Node.js, Git, `gh`, and each selected agent CLI, then verify the
commands in the shell that will run Runner:

```sh
node --version       # v22.18.0 or newer
npm --version
git --version
gh --version
codex --version      # replace with the agent CLI you configured
export GH_TOKEN='your-github-token'
```

Use a shell profile or another local secret mechanism when appropriate. Never
commit a token.

## CodeBuddy setup

Install and authenticate the `codebuddy` CLI on `PATH`, using your selected
backend and model. Verify `codebuddy --version` and a bounded print request
before starting Runner. The provider was checked with CLI 2.177.0 and
Sandcastle 0.12.0; account access and authentication renewal remain native CLI
prerequisites. Keep credentials outside Project YAML.

Select CodeBuddy independently for any role, for example:

```yaml
agent: codebuddy
model: deepseek-v4.1-flash
options:
  effort: high
  permissionMode: dontAsk
  allowedTools: [Read, Write, Edit, "Bash(git:*)", "Bash(node:*)"]
  env:
    CODEBUDDY_CONFIG_DIR: /absolute/path/to/dedicated-codebuddy-state
```

The default `permissionMode` is `dontAsk`: unapproved operations are denied.
Prepare trusted native allow rules for the Project's required edits, commands,
Git operations, repairs, and Documentation Maintenance. The example rules are
a starting point, not certified operation coverage. Explicit native policy can
still refuse an operation. Runner preserves refusal evidence and requires the
tagged result and independent Git verification, even when the CLI exits zero.
`bypassPermissions` and `-y` do not guarantee unattended execution. Runner rejects
all enabled `CODEBUDDY_IS_SANDBOX` values on the host: `1`, `true`, `yes`, and
`on`, ignoring case and surrounding whitespace.

Supported `options` are `effort` (minimal/low/medium/high/xhigh/max), positive
integer `maxTurns`, `permissionMode` (acceptEdits/bypassPermissions/default/plan/
dontAsk/auto), string `tools` (empty disables tools), string arrays
`allowedTools` and `disallowedTools`, `systemPrompt`, `appendSystemPrompt`, and
a string map `env`. Unsupported options fail visibly. Model support for effort
depends on your backend. Runner disables native background tasks and launches
foreground print/stream execution with its own worktree and Git configuration.

CodeBuddy stores main transcripts under `<CLI-home>/projects/*/<id>.jsonl`.
`options.env.CODEBUDDY_CONFIG_DIR` selects both the CLI store and lookup root;
otherwise the inherited variable applies, then `.codebuddy` under the child's
OS home. Home overrides use `options.env.HOME` on Unix and
`options.env.USERPROFILE` on Windows. Use an absolute custom store or fallback
home; empty or relative fallback homes fail visibly. The provider searches exact
main-session IDs, rejects ambiguity, and excludes subagent transcripts. It never
resumes the latest session, forks, or creates a missing continuation. Separate worktrees and
role sessions remain independent. Sandbox transcript transfer is unsupported
and throws rather than reporting a successful transfer.

CodeBuddy loads `CODEBUDDY.md` before falling back to `AGENTS.md`, and discovers
parent instructions. If both files exist, keep required Project instructions in
the selected file or reference them explicitly from the Project prompt. Check
this precedence before a Run; Runner does not rewrite native instruction files.

The [provider evidence](docs/research/codebuddy-provider-evidence.md) separates
measured durable continuation from remaining live operation and takeover checks.
The shared timeout intervention and manual takeover lifecycle are separate work;
this provider retains the current executor's timeout and cancellation behavior.

## Configuration

Create a project directory under `projects/`:

```text
projects/<project-key>/
  config.yaml
  prompts/
    implement.md
    review.md
    documentation.md
  logs/
```

Start from `projects/sandcastle-runner/config.yaml` and configure the
repository, absolute checkout, target branch, credential variable names,
timeouts, workflow flags, and agent profiles.

The [example configuration](projects/sandcastle-runner/config.yaml) explains each field in YAML comments.
Write repository-specific instructions in the Project prompts; Runner supplies task context and output requirements.

## Run

```sh
npm exec -- sandcastle-runner run --project <project-key> --parent <issue-number>
npm exec -- sandcastle-runner run --project <project-key> --issue <issue-number>
npm exec -- sandcastle-runner run --project <project-key> --issue
npm exec -- sandcastle-runner run --project <project-key> --document
```

`--issue` without a number uses the project's configured `issueList`.
`--document` runs standalone Documentation Maintenance.

Standalone runs request a merge after their pull request is CI-ready. Use
`--no-auto-merge` with a value-bearing `--issue` to leave the pull request open
after validation and cleanup.

An Operator Pause gates new Agent steps and delivery advancement across the Run.
Already-started invocations keep collecting output; Runner retains their results
and logs until every pending pause is resolved. Prompts appear one at a time,
and each response applies only to its displayed invocation. Enter, recovery
instructions, and skip keep their context-specific meanings. `q` or EOF cancels
the Run and settles its owned processes. Other Runs continue independently.

Runner prints the outcome of each Delivery and Maintenance Ticket, remaining
discovery reasons, retained worktrees, and the Audit Log path. `succeeded` and
`no_work` exit successfully; `incomplete`, `cancelled`, and `failed` do not.

## Verification and Development

```sh
npm test                 # full test suite
npm run typecheck        # TypeScript diagnostics
npm run check            # formatting, lint, and typecheck
npm run verify           # tests plus all checks
npm run format           # format source files
```

The test suite uses scripted adapters and harmless local processes. It does not
call authenticated agents or mutate a remote GitHub repository.

## Acknowledgements

Thanks to [Sandcastle](https://github.com/mattpocock/sandcastle) and its
contributors for the agent orchestration library that Runner depends on.
Runner uses Sandcastle's native agent factories to run coding agents.
