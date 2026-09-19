# Project Template

This directory is a project template for Sandcastle Runner. Copy it to `projects/<project-key>` and adapt `config.json` and the prompts.

## Checkout installation contract

The Runner is used from a checkout only. Follow the root [installation
contract](../README.md#installation-contract), including the native
[macOS](../README.md#macos), [Windows](../README.md#windows-native-powershell),
and [Linux](../README.md#linux) prerequisite, `PATH`, and credential
guidance. From the repository root, run:

```sh
npm ci
npm exec -- sandcastle-runner run --project <project-key> (--parent <issue-number> | --issue [<issue-number>] | --document) [--auto-merge | --no-auto-merge]
```

The root contract requires Node.js **>=22.18.0** with its bundled npm, Git,
GitHub CLI (`gh`), an installed and authenticated Codex CLI, and an absolute
checkout path. Keep all executables on `PATH` in the terminal that invokes the
Runner; no Codex version floor is claimed here.

Set the environment variable named by both `tracker.tokenEnv` and
`codeHost.tokenEnv` in this template's `config.json` before invoking the Runner:

```sh
export GH_TOKEN='your-github-token'       # macOS/Linux
```

```powershell
$env:GH_TOKEN = 'your-github-token'       # Windows PowerShell
```

The token must be present in the process environment; never commit it. The
Runner uses non-interactive GitHub operations, so interactive `gh auth login` is
not used. Missing tools fail on first use through the existing logical-command
error path. Registry/global/remote-`npx` installation, a native Runner
installer, bundled prerequisites, broader OS/tool-version guarantees, and
permanent cross-platform CI are unsupported; see the root contract for details.

## `config.json`

- `repository`: GitHub repository in `owner/name` form.
- `checkout`: absolute path to that repository.
- `targetBranch`: branch to update.
- `tracker`: GitHub settings: `tokenEnv` names the credential variable; `runnerAccount` is the bot/user; `reservationLabel` marks reserved tickets.
- `codeHost`: GitHub settings; `tokenEnv` names the credential variable and `adminMerge` controls administrative merge requests.
- `workflow.review`: enable or disable the review attempt.
- `workflow.docMaintainTriggerLabel`: exact, case-sensitive label that triggers automatic Documentation Maintenance after a successful Batch. Omitted, empty, or whitespace-only values disable automatic maintenance.
- `agents`: model and reasoning effort for `implement`, `review`, `ciRepair`, `conflictRepair`, and `documentation` attempts. `review` is needed when enabled; `documentation` is needed for a nonempty trigger label or `--document`.
- `timeouts`: positive minute limits for agent attempts, required checks, and merge queue confirmation.
- `operationRetry` and `agentRetry`: non-negative automatic retry counts; the corresponding `*Delay` arrays are positive delays in seconds.
- `ticketClosure`: `runner` or `code_host`.
- `maintenanceTicket`: title, body, and `doc-maintain` label for maintenance tickets.

Keep credentials in the environment, for example `export GH_TOKEN=...`. `workflow.review` defaults to `true`; `workflow.docMaintainTriggerLabel` defaults to an empty string. `$comment` fields are ignored.

## Documentation Maintenance workflow

At the normal post-Batch scheduling point, one automatic occurrence is required when at least one successfully delivered issue had the configured `workflow.docMaintainTriggerLabel` when its merged, completed closure was confirmed. Multiple matches in the same Batch still schedule one occurrence. Parent labels, delivery counts, Parent closeout, failed Batches, cancellation, and CI-ready unmerged Pull Requests do not trigger maintenance.

```mermaid
flowchart TD
    A[Batch integrations complete] --> B{Any completed issue has exact trigger label?}
    B -- No --> C[Continue delivery or Parent closeout]
    B -- Yes --> D[Create or resume Maintenance Ticket]
    D --> E[Run documentation prompt]
    E --> F{Result}
    F -- no_change --> G[Close Maintenance Ticket]
    F -- committed --> H[Publish, checks, repair, merge, and confirm closure]
    F -- blocked or failed --> I[Retain barrier for automatic recovery]
```

Delivery-time labels are stored in the Recovery Snapshot. On restart, the current `config.json` trigger is evaluated against that stored evidence. An empty or newly nonmatching trigger stops continuation without closing or deleting the existing Maintenance Ticket, Pull Request, branch, or Worktree; their recorded locations are reported for manual handling.

`--document` runs one fresh, complete occurrence without a Parent or issue scope. It ignores `issueList`, does not require a trigger label, never resumes prior maintenance, and preserves the ordinary no-change behavior without creating an empty Pull Request.

## Review enabled versus disabled

```mermaid
flowchart TD
    A[Implementation attempt] --> B{workflow.review}
    B -- true --> C[Fresh-context review]
    C --> D{Review passes?}
    D -- No --> E[Fix, commit, and review again]
    E --> C
    D -- Yes --> F[Publish pull request]
    B -- false --> F
    F --> G[Checks, repair if needed, merge, and close ticket]
```

## Prompt placeholders

- `implement.md`: `TICKET_NUMBER` (issue number), `TICKET_REFERENCE` (authoritative issue reference), `WORKTREE_PATH` (isolated worktree), `SOURCE_BRANCH` (delivery branch), `BASE_SHA` (worktree base commit), `PROJECT_TARGET_BRANCH` (configured target branch).
- `ci-repair.md`: the implementation fields above, plus `PULL_REQUEST_NUMBER` and `PULL_REQUEST_URL` (existing pull request), and `FAILED_CHECKS` (failed required checks and links).
- `conflict-repair.md`: the same ticket, worktree, branch, and base fields, plus `PULL_REQUEST_NUMBER`, `PULL_REQUEST_URL`, `TARGET_BRANCH_SHA` (fresh target branch commit), and `MERGE_CONFLICT` (reported conflict details).
- `documentation.md`: `TICKET_NUMBER`, `TICKET_REFERENCE`, `WORKTREE_PATH`, `SOURCE_BRANCH`, and `PROJECT_TARGET_BRANCH`.
- `review.md`: `REVIEW_HANDOFF`, a JSON review context containing repository, branches, worktree, fixed point, ticket/spec snapshots, instructions, and reported checks.

## Run

From the Sandcastle Runner repository:

```sh
npm ci
npm exec -- sandcastle-runner run --project <project-key> (--parent <issue-number> | --issue <issue-number> | --document)
```
