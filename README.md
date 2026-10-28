# Sandcastle Runner

Sandcastle Runner is a local CLI that uses code to manage the routine steps of
delivering GitHub tickets. It selects eligible tickets, prepares isolated
worktrees, verifies and pushes commits, publishes pull requests, waits for CI,
and coordinates merges and ticket closure.

This keeps AI agents focused on writing, reviewing, and repairing code while
reducing unnecessary token use for workflow coordination. Runner invokes agents
through Sandcastle when a task needs code changes or review.

Runner runs on Windows, macOS, and Linux and supports `codex`,
`claude-code`, `pi`, and `codebuddy`. Agents run locally through Sandcastle.

The npm package and executable are both named `issue-runner`. See the
[Project guide](projects/README.md) for workflow details.

## Prerequisites

The npm package supplies only the Runner. Install these on the host that runs
it:

- Node.js 22.18.0 or a Node 24 release (24.0.0 or newer), including its bundled
  npm.
- Git, with `git` on `PATH`; Runner requires worktree support.
- GitHub CLI (`gh`), with `gh` on `PATH`.
- An installed and authenticated coding-agent CLI for every configured agent,
  directly runnable on `PATH`.
- Native agent permission settings that allow required operations without
  interactive CLI approval prompts.
- A GitHub repository checkout at an absolute path.

Prepare each selected agent's own sign-in, skills, MCP servers, and native
configuration. Runner does not install or normalize them.

Complete authentication and permission setup before starting Runner. Operator
Pause accepts recovery instructions after an Agent Attempt stops. Timeout pauses
keep the original invocation alive. Conversation text cannot answer a native
approval request or grant a denied permission.

Keep the project checkout, worktrees, state, logs, temporary files, and agent
session state on paths without Chinese characters.

## Installation

Use `npx` for the current release, or pin an exact version for repeatable
execution:

```sh
npx issue-runner@latest --help
npx issue-runner@0.1.0 --help
```

Install globally when you want `issue-runner` directly on `PATH`:

```sh
npm install --global issue-runner@latest
issue-runner --version
```

`npx` downloads the requested version into its own cache and runs the same
published artifact. Project files are never written into that cache. Global
installation writes the package into npm's global prefix and places the
`issue-runner` executable shim on `PATH`. Upgrade manually:

```sh
npm install --global issue-runner@latest
```

An upgrade replaces only the installed package. It never rewrites Project
configuration or prompts you created with `init`; your edits stay in place.

The npm/npx tool version and registry metadata are separate from the executing
CLI version. `issue-runner --version` prints the version of the package that is
actually running.

## Initialize a Project

Run initialization from the directory that should contain the Project. The
launch directory is the only place Runner looks:

```sh
cd /work/my-projects
npx issue-runner@latest init --project my-project
```

This creates exactly:

```text
my-project/
  config.yaml
  prompts/
    implement.md
    review.md
    documentation.md
```

Initialization copies reviewed templates only. It performs no placeholder
substitution, machine probing, credential read, network call, agent login, or
target-checkout access. It refuses an existing destination, including an empty
directory, a file, or a symbolic link; there is no overwrite, merge, or force
mode. A failed copy keeps partial output for inspection and exits unsuccessfully
with the destination path.

The Project key may use letters, digits, dot, underscore, and hyphen. It must
name one child of the launch directory; separators, traversal, `.`, and `..`
are rejected before any write.

### Edit the placeholders

Replace every placeholder in `my-project/config.yaml`:

- `repository`: the target GitHub repository in `owner/repository` form.
- `checkout`: the absolute path to that repository's checkout. On Windows use
  a path such as `C:\work\your-repository`.
- `targetBranch`: the branch to integrate into, or omit it to use the
  repository default.
- `tracker.runnerAccount`: the GitHub account that owns Reservations.
- Every `agents.*.model`: a model name your configured agent accepts.
- Each `agents.*.agent` when you use another supported agent CLI.
- `agentMinutes`, the retry delays, and other limits when the template values
  do not fit the project.
- `maintenanceTicket` when Review or Documentation Maintenance uses a
  different ticket template.

Set the environment variables named by `tracker.tokenEnv` and
`codeHost.tokenEnv`; the template uses `GH_TOKEN`. Never commit a token.

Replace the repository-specific instructions in the three prompts as well.
Runner supplies task context, restrictions, and output protocols; the prompts
carry only repository practices and review or documentation criteria.

### Existing checkout users

A checkout keeps its Projects under the checkout's `projects/` directory. To
select the same physical Project and runtime files, launch Runner from that
directory:

```sh
cd /path/to/sandcastle-runner/projects
npx issue-runner@latest run --project sandcastle-runner --parent 42
```

If you move a Project directory, saved absolute Worktree and native-session
paths can still point at the old location. Runner never searches ancestors, the
installed package, or a `projects/` subdirectory on your behalf, and it does not
migrate Recovery Snapshots or Worktrees.

## Run

```sh
issue-runner run --project <project-key> --parent <issue-number>
issue-runner run --project <project-key> --issue <issue-number>
issue-runner run --project <project-key> --issue
issue-runner run --project <project-key> --document
```

`run --project <key>` reads only `cwd/<key>`. A missing or invalid Project is a
startup failure; there is no fallback to another configuration.

`--issue` without a number uses the Project's configured `issueList`.
`--document` runs standalone Documentation Maintenance.

Standalone runs request a merge after their pull request is CI-ready. Use
`--no-auto-merge` with a value-bearing `--issue` to leave the pull request open
after validation and cleanup. `--auto-merge` and `--no-auto-merge` are mutually
exclusive, reject supplied values, and require a value-bearing `--issue`.

Audit logs, agent logs, review findings, Recovery Snapshots, and Worktrees stay
under the selected Project. Runner never writes Run data into the installation
directory, npm's global prefix, or the npx cache.

An Operator Pause gates new Agent steps and delivery advancement across the Run.
Already-started invocations keep collecting output; Runner retains their results
and logs until every pending pause is resolved. Prompts appear one at a time,
and each response applies only to its displayed invocation. Enter, recovery
instructions, and skip keep their context-specific meanings. `q` or EOF cancels
the Run and settles its owned processes. Other Runs continue independently.

Runner prints the outcome of each Delivery and Maintenance Ticket, remaining
discovery reasons, retained worktrees, and the Audit Log path. `succeeded` and
`no_work` exit successfully; `incomplete`, `cancelled`, and `failed` do not.

## Help and version

```sh
issue-runner --help
issue-runner -h
issue-runner run --help
issue-runner run -h
issue-runner init --help
issue-runner --version
```

Both help surfaces accept the long and short form. Informational output
succeeds before required-argument, Project, credential, or external-tool
validation and does not write files or start a Run. `--version` reads the
executing package's own metadata, so direct and `npx` execution agree for the
same artifact.

## Node support

`package.json` declares `engines.node` as `^22.18.0 || ^24.0.0`. That range
accepts only the Node 22 and Node 24 families and refuses untested Node 23 or
later majors. The floors are the lowest tested patches in each family: 22.18.0
covers `import.meta.dirname`, the pinned `cac` requirement, and the Node 22
release family; 24.0.0 is the lowest tested Node 24 patch. The published
executable does not require runtime TypeScript stripping, and entry detection
compares resolved paths instead of depending on `import.meta.main`.

Artifact smoke evidence in this repository was collected on Linux x64 with Node
22.18.0, Node 24.0.0, and Node 24.20.0: the packed tarball installs and its npm
executable shim runs help, version, initialization, and Project lookup without
credentials. The repository CI matrix runs the same packaged acceptance on
Ubuntu and Windows at both declared floors, 22.18.0 and 24.0.0, and exercises
the Windows `.cmd` shim. macOS execution is not yet verified in this repository;
it remains part of the declared range rather than recorded evidence.

npm's global executable shims are POSIX links on Linux and macOS and `.cmd`
shims on Windows. Both forms start the same compiled JavaScript entry point.

## Windows setup

Install Node.js, Git, `gh`, and each selected agent CLI. Reopen PowerShell after
installation so `PATH` changes take effect, then verify:

```powershell
node --version       # v22.18.0+ (22.x) or v24.0.0+
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
`codeHost.tokenEnv` in `config.yaml`; the template uses `GH_TOKEN`. As with
`HOME`, configure it once at the user level:

```powershell
[Environment]::SetEnvironmentVariable('GH_TOKEN', 'your-github-token', 'User')
$env:GH_TOKEN = [Environment]::GetEnvironmentVariable('GH_TOKEN', 'User')
node -p "Boolean(process.env.GH_TOKEN)"
```

## macOS and Linux setup

Install Node.js, Git, `gh`, and each selected agent CLI, then verify the
commands in the shell that will run Runner:

```sh
node --version       # v22.18.0+ (22.x) or v24.0.0+
npm --version
git --version
gh --version
codex --version      # replace with the agent CLI you configured
export GH_TOKEN='your-github-token'
```

Use a shell profile or another local secret mechanism when appropriate. Never
commit a token.

## Verification and Development

```sh
npm test                 # full test suite, including packaged-tarball acceptance
npm run typecheck        # TypeScript diagnostics
npm run check            # formatting, lint, and typecheck
npm run build            # compile ESM JavaScript into dist/
npm run release:accept   # accept a packed tarball (RELEASE_TARBALL=<path>)
npm run verify           # tests plus all checks
npm run format           # format source files
```

The test suite uses scripted adapters and harmless local processes. It does not
call authenticated agents or mutate a remote GitHub repository. Packaging tests
build and pack the real artifact, install it into a temporary prefix, and run
the npm executable shim from unrelated directories.

## Acknowledgements

Thanks to [Sandcastle](https://github.com/mattpocock/sandcastle) and its
contributors for the agent orchestration library that Runner depends on.
Runner uses Sandcastle's native agent factories to run coding agents.
