# Project Template

This directory is a project template for Sandcastle Runner. Copy it to `projects/<project-key>` and adapt `config.yaml` and the prompts.

## `config.yaml`

- `repository`: GitHub repository in `owner/name` form.
- `checkout`: absolute path to that repository.
- `issueList`: unique positive issue numbers used to limit Parent Runs or drive value-less Standalone Runs.
- `maxBatchSize`: required positive safe integer limiting newly discovered Parent and Standalone Batches.
- `targetBranch`: branch to update.
- `tracker`: GitHub settings: `tokenEnv` names the credential variable; `runnerAccount` is the bot/user; `reservationLabel` marks reserved tickets.
- `codeHost`: GitHub settings; `tokenEnv` names the credential variable and `adminMerge` controls administrative merge requests.
- `workflow.review`: enable or disable the review attempt.
- `workflow.docMaintainTriggerLabel`: exact, case-sensitive label that triggers automatic Documentation Maintenance after a successful Batch. Omitted, empty, or whitespace-only values disable automatic maintenance.
- `agents`: an `agent`, `model`, and optional native `options` for `implement`, `review`, `ciRepair`, `conflictRepair`, and `documentation` purposes. Each purpose is independent, and the same agent may be reused. `review` is needed when enabled; `documentation` is needed for a nonempty trigger label or `--document`, and both automatic and standalone Documentation Maintenance use it.
- `timeouts`: required positive minute limits for agent attempts, required checks, and merge queue confirmation.
- `operationRetry` and `agentRetry`: non-negative automatic retry counts; the corresponding `*Delay` arrays are positive delays in seconds. Follow [ADR-0001](../docs/adr/0001-configurable-retry-policy.md): counts are additional attempts after the initial one, and the final delay is reused.
- `ticketClosure`: `runner` or `code_host`.
- `maintenanceTicket`: title, body, and `doc-maintain` label for maintenance tickets.

If Sandcastle's default session lookup does not
match the agent's actual storage, set the native lookup root:
`sessionStorage.hostSessionsDir` for Codex or Pi, or
`sessionStorage.hostProjectsDir` for Claude Code.

## Operator Pause actions

| Context | Actions |
| --- | --- |
| Usable Agent session | Enter sends `continue`; other text supplies recovery instructions; `s` skips; `q`/EOF cancels |
| Unavailable Agent session, including a failed probe | Enter starts a fresh attempt; `s` skips; `q`/EOF cancels; other text stays paused |
| Non-Agent operation within one issue | Enter retries; `s` skips that issue; `q`/EOF cancels; other text stays paused |
| Startup, discovery, shared Batch fetch, final Parent closure | Enter retries; `q`/EOF cancels; other text stays paused |
| Audit creation or append, in every context | Enter retries the same log action; `q`/EOF cancels; all other input, including `s`, stays paused |

Maintenance preparation permits `s` before its issue exists. Skip ends that occurrence or issue's remaining work while other issues continue. Existing PRs, comments, branches, and merges remain. Before publication, the Runner attempts Reservation release; `s` at a failed release abandons it and reports possible residue. After delivery, skip preserves completion and leaves unfinished cleanup or release pending. Skipped work and unfinished cleanup return `incomplete`.

Input never replaces successful results, acknowledges writes, accepts audit gaps, or marks cleanup complete. Agent JSON is ordinary recovery text in a usable session, and all subsequent results undergo normal validation. Unsupported input explains the actions without retrying the operation or resetting its budget.

Enter retries reads, creation, label/assignee writes, push, and Worktree creation directly. An unobserved creation may leave an unknown resource; creation retries can produce duplicates. Repair partial Worktree state before retrying its command. Merge retries refresh status and HEAD, proceeding if merged and waiting if accepted or queued. Check and repair timeouts refresh evidence before waiting or repairing. Closure and publication recovery recheck current state. Cleanup retries remaining owned artifacts. Audit retries never replay a business action that already completed.

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

Delivery-time labels are stored in the Recovery Snapshot. On restart, the current `config.yaml` trigger is evaluated against that stored evidence. An empty or newly nonmatching trigger stops continuation without closing or deleting the existing Maintenance Ticket, Pull Request, branch, or Worktree; their recorded locations are reported for manual handling.

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
