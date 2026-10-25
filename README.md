# Sandcastle Runner

Sandcastle Runner is a local CLI that takes a configured GitHub parent issue, finds eligible child tickets, runs isolated implementation and review attempts, publishes pull requests, repairs required checks or merge conflicts, and confirms ticket closure.

## Workflow

```mermaid
flowchart TD
    A[Load project and parent issue] --> B[Discover eligible child tickets]
    B --> C[Reserve tickets and create isolated worktrees]
    C --> D[Run implementation and optional review]
    D --> E[Publish pull requests]
    E --> F{Checks pass?}
    F -- No --> G[Repair checks or explicit conflicts]
    G --> E
    F -- Yes --> H[Merge pull requests and close tickets]
    H --> I[Rescan until complete or paused]
```

## Installation contract

Sandcastle Runner is a checkout-only CLI. Clone this repository, install its
locked dependencies, and invoke the local executable through npm:

```sh
git clone https://github.com/xiakeng/sandcastle-runner.git
cd sandcastle-runner
npm ci
npm exec -- sandcastle-runner run --project <project-key> (--parent <issue-number> | --issue [<issue-number>] | --document) [--auto-merge | --no-auto-merge]
```

The Runner is not published to a package registry, globally installed, invoked
through a remote `npx`, distributed as a native installer, or bundled with
Node.js, npm, Git, GitHub CLI, or the selected coding-agent CLI. Install those
external prerequisites separately for your operating system. `npm ci` and local
`npm exec` are the only supported Runner installation and invocation path.

## Prerequisites

Every host needs the following in the same terminal that runs the Runner:

- Node.js **>=22.18.0**. npm is the version bundled with Node.js; do not use a
  separate global npm to satisfy this requirement.
- Git, with `git` directly runnable on `PATH` (Git worktrees are required).
- GitHub CLI (`gh`), with `gh` directly runnable on `PATH`.
- An installed and authenticated coding-agent CLI for every configured agent,
  directly runnable on `PATH`. Runner supports the native Sandcastle
  `codex`, `claude-code`, and `pi` agents; it does not support OpenCode, Cursor,
  or Copilot.
- A GitHub repository checkout at an absolute path.

Paths containing Chinese characters are unsupported for the Runner checkout,
the selected project's Git checkout, Worktrees, state and log directories,
temporary files, or agent session state. Keep these paths free of Chinese
characters.

Missing executables fail on first use through the existing logical-command error
path. The Runner does not start an interactive `gh auth` flow. Authenticate each
selected agent with its own CLI instructions and keep any API key or local
sign-in credential in the process environment, never in `config.yaml`.

### macOS

Install Node.js 22.18.0 or newer from the [Node.js macOS download](https://nodejs.org/en/download), or use a maintained package manager such as Homebrew. npm is bundled with Node.js. Install Git with [Xcode Command Line Tools](https://developer.apple.com/library/archive/technotes/tn2339/_index.html), the [Git macOS installer](https://git-scm.com/install/mac), or your package manager. Install `gh` using the [GitHub CLI macOS instructions](https://github.com/cli/cli#installation), and install each selected coding-agent CLI (for example Codex, Claude Code, or Pi) with its own instructions.

After installation, open the terminal profile used for Runs and verify (the
agent checks below use Codex as an example; verify the CLI you configured):

```sh
node --version       # must be v22.18.0 or newer
npm --version
git --version
gh --version
codex --version
codex login status
command -v node npm git gh
```

Set the credential variable named by both `tracker.tokenEnv` and
`codeHost.tokenEnv` in `config.yaml` (the template uses `GH_TOKEN`) before
starting the Run:

```sh
export GH_TOKEN='your-github-token'
```

Put the export in the shell profile only if that is appropriate for the host,
and never commit the token. Do not run `gh auth login`; the configured
environment token is passed to the non-interactive GitHub operations.

### Windows (native PowerShell)

Install Node.js 22.18.0 or newer with the [Node.js Windows installer](https://nodejs.org/en/download) or a maintained Windows package manager. npm is bundled with Node.js. Install [Git for Windows](https://git-scm.com/install/windows), `gh` from the [GitHub CLI Windows instructions](https://github.com/cli/cli#installation), and each selected coding-agent CLI using its own instructions. Reopen PowerShell after installation so the installers' `PATH` changes take effect.

Verify the commands in the PowerShell session used for Runs (the agent checks
below use Codex as an example; verify the CLI you configured):

```powershell
node --version       # must be v22.18.0 or newer
npm --version
git --version
gh --version
codex --version
codex login status
Get-Command node, npm, git, gh | Select-Object Name, Source
```

`Get-Command npm` must resolve to the npm bundled with the selected Node.js
installation. If a separate global npm shadows it, prepend the Node.js
installation directory to `PATH` for the Run terminal or invoke the bundled
`npm.cmd` directly. Do not replace the machine-wide npm installation.

Set the configured credential variable for the session, or persist it for
future sessions with the normal Windows environment-variable controls:

```powershell
$env:GH_TOKEN = 'your-github-token'
# Optional persistent setup (open a new PowerShell afterwards):
setx GH_TOKEN "your-github-token"
```

The variable name must match `tracker.tokenEnv` and `codeHost.tokenEnv` in
`config.yaml`. Do not run interactive `gh auth login` or commit the token.
The process environment must contain both configured variables even when
`gh auth status` reports a stored login.

The selected project's `checkout` must already exist and be a Git checkout at a
real absolute Windows path. Use YAML quoting that preserves backslashes, for
example:

```yaml
checkout: 'C:\work\repos\example'
```

Runner does not read `CODEX_HOME` or infer any agent session directory from the
operating-system home directory. If Sandcastle's default lookup does not match
where the selected agent actually stores sessions, configure an explicit
native lookup root, for example:

```yaml
options:
  sessionStorage:
    hostSessionsDir: 'C:\work\agent-sessions\sessions'
```

This option selects where Runner looks up sessions; it does not relocate the
agent's own storage. Correct default installations may need no override.

Agent Attempt task identities are passed as native Sandcastle run names and
identify tasks in log output. They do not guarantee Runner-assigned titles in
the agent application's session list. This loss is intentional.

Enable long paths in the selected repository only when its files require them.
The setting must be repository-local because Agent Attempts run with isolated
Git configuration:

```powershell
git -C 'C:\work\repos\example' config core.longpaths true
```

### Linux

Install Node.js 22.18.0 or newer from the [Node.js Linux download](https://nodejs.org/en/download), or from a maintained distribution/package-manager source. npm is bundled with Node.js. Install Git from the distribution or the [Git Linux instructions](https://git-scm.com/install/linux), `gh` from the [GitHub CLI Linux instructions](https://github.com/cli/cli#installation), and each selected coding-agent CLI using its own instructions. Keep each executable on the `PATH` of the shell that starts the Runner.

Verify the commands (the agent checks below use Codex as an example; verify the
CLI you configured):

```sh
node --version       # must be v22.18.0 or newer
npm --version
git --version
gh --version
codex --version
codex login status
command -v node npm git gh
```

Set the credential variable named in `config.yaml` before invoking the Runner:

```sh
export GH_TOKEN='your-github-token'
```

Use a shell profile or another local secret mechanism only when appropriate;
never commit the token. Interactive `gh auth` is not used.

These instructions describe the checkout contract on the three native OS
families. They do not promise a broader OS or tool-version matrix,
WSL-specific behavior, or a live authenticated agent compatibility guarantee.
The configured repository and tracker must use GitHub; the Runner mutates
issues, branches, worktrees, pull requests, and merges, so use a test repository
when experimenting.

## Configuration and usage

Create a project directory with this layout:

```text
projects/<project-key>/
├── config.yaml
├── prompts/
│   ├── implement.md
│   ├── review.md
│   ├── ci-repair.md
│   ├── conflict-repair.md
│   └── documentation.md
└── logs/
```

Start from [`projects/trickplay-cropper`](projects/trickplay-cropper) and set the repository, absolute checkout, target branch, credential variable, agent profiles, timeouts, and workflow flags in `config.yaml`. Enabled workflow nodes require their prompt file; implementation and repair prompts must be non-empty. Configuration files use YAML and support `#` comments.

Each `agents.<purpose>` profile requires a nonempty `agent` and `model` string
and accepts an optional native `options` object. Native options are forwarded
to the selected Sandcastle factory without renaming, flattening, or
translation:

```yaml
agents:
  implement:
    agent: codex
    model: gpt-6-sol
    options:
      effort: max
  review:
    agent: claude-code
    model: claude-opus-4-8
    options:
      effort: high
  ciRepair:
    agent: pi
    model: claude-sonnet-4-6
    options:
      thinking: high
```

Agent, model, and workflow purpose are distinct: a model prefix never selects
the agent, and changing agents does not promise the previous native options
remain valid. Profiles migrated from older configuration must add `agent` and
move the former `reasoningEffort` value into `options.effort`; Runner rejects
the obsolete field instead of converting it.

Every Agent Attempt starts with a `SESSION_READY` probe using the selected
profile, then resumes that same session for the substantive work. Sandcastle
owns invocation and session resumption; Runner owns bounded retry and Operator
Pause policy. When automatic recovery cannot continue, Operator Pause shows the
selected agent, session ID when available, working directory, diagnostic log,
and the Runner actions currently permitted. Runner does not print a
copyable agent-specific resume command; to take over manually, use the selected
agent's own recovery interface with the displayed session, working directory,
and diagnostic log.

Install dependencies and run a parent issue:

```sh
npm ci
npm exec -- sandcastle-runner run --project <project-key> (--parent <issue-number> | --issue <issue-number> | --document)
```

The command ends with a human-readable report of every processed Delivery and
Maintenance Ticket, followed by any remaining discovery reasons, Retained
Worktrees, and the Audit Log path. `succeeded` and `no_work` exit with status 0;
`incomplete`, `cancelled`, and `failed` exit non-zero.

By default, a standalone Run requests a merge after its Pull Request is CI-ready. With `--no-auto-merge`, the Runner creates and validates the Pull Request, then removes the Worktrees and local branches created by the current Run for that ticket, along with its Agent logs. It retains the remote branch, Reservation, Pull Request, and Recovery Snapshot, reports `PR ready`, and requests neither merge nor closure. Explicit auto-merge flags require a value-bearing `--issue <issue-number>` and accept no value.

`--document` runs one fresh, complete Documentation Maintenance occurrence for the selected Project without a Parent Ticket or Delivery Ticket scope. It ignores `issueList`, does not resume prior maintenance recovery, and may be used when the automatic trigger label is empty.

## Local development

```sh
npm ci
npm test                 # run tests
npm run check            # format check, lint, and typecheck
npm run typecheck        # TypeScript build-time validation
npm run verify           # tests plus all checks
npm run format           # format source files
```

Repository text files are checked out with LF line endings through
`.gitattributes`, including on Windows hosts configured with
`core.autocrlf=true`. This keeps the documented checkout compatible with the
format check.

The test suite uses scripted tracker, code-host, Git, agent, clock, and terminal boundaries. It does not call authenticated agent/Sandcastle services or mutate a remote GitHub repository.

The generic host executor owns each Agent process it launches and uses
OS-bound process-tree termination. Runner waits for an explicit settlement
result after every invocation. Pending settlement blocks the next automatic
probe, task, or output correction; failed settlement enters the existing manual
handling path instead of starting another writer in the same Worktree. This
does not claim termination of arbitrary detached descendants, independently
managed servers, or remote jobs.

Cancellation stops probe retries, execution retries, retry backoff,
missing-output recovery, and structured-output correction after owned-process
settlement. A substantive timeout uses one total deadline across those
automatic steps, then waits for settlement and enters Operator Pause without
automatically restarting the timed-out invocation.
