# Project setup

Copy `projects/sandcastle-runner/` to `projects/<project-key>/`, then edit
`config.yaml` and `prompts/*.md`. Install and authenticate Git, GitHub CLI, and
each selected agent CLI on the host; see [host setup](../README.md#prerequisites).
Export the credential variables named in your config, for example `GH_TOKEN`.
Keep tokens out of committed files.

## Configuration

- `repository`: GitHub `owner/name`; `checkout`: absolute repository path.
- `targetBranch`: branch to integrate into; omitted means resolve it from GitHub.
- `issueList`: unique positive issue numbers; `[]` leaves Parent Runs unrestricted.
  Value-less `--issue` processes this list as Standalone Issues.
- `maxBatchSize`: required positive integer limiting concurrent tickets.
- `tracker`: `type: github`, credential `tokenEnv`, `runnerAccount`, and
  `reservationLabel`. `codeHost`: `type: github`, credential `tokenEnv`, and
  required `adminMerge` boolean.
- `agents`: profiles for `implement`, `review`, `ciRepair`, `conflictRepair`,
  and `documentation`. Each needs an explicit `agent` and `model`; optional
  native `options` pass through unchanged. Supported agents are `codex`,
  `claude-code`, and `pi`. Codex/Claude Code use `options.effort`; Pi uses
  `options.thinking`. Switching agents may require different options.
- `workflow.review`: defaults to `true`; enabled review needs its profile and
  prompt. `workflow.docMaintainTriggerLabel`: exact, case-sensitive label for
  automatic maintenance; omitted or blank disables it. Maintenance needs its
  profile, prompt, and `maintenanceTicket` title, body, and label, including
  when invoked with `--document`.
- `operationRetry` and `agentRetry`: required non-negative counts of additional
  automatic attempts. Required `operationRetryDelay` and `agentRetryDelay` arrays
  contain positive seconds; the final delay repeats. See [retry policy](../docs/adr/0001-configurable-retry-policy.md).
- `timeouts`: required positive minutes for `agentMinutes`,
  `requiredChecksMinutes`, and `mergeQueueMinutes`.
- `ticketClosure`: `runner` closes tickets after merge; `code_host` waits for
  GitHub to confirm closure from the agent-authored PR body.

If native session lookup misses the agent's actual storage, set
`agents.<purpose>.options.sessionStorage.hostSessionsDir` for Codex/Pi or
`hostProjectsDir` for Claude Code. These paths select existing session storage.

## Running a project

From the Runner checkout:

```sh
npm exec -- sandcastle-runner run --project <project-key> --parent <issue-number>
npm exec -- sandcastle-runner run --project <project-key> --issue <issue-number>
npm exec -- sandcastle-runner run --project <project-key> --issue
npm exec -- sandcastle-runner run --project <project-key> --document
```

Runner reserves eligible tickets, prepares worktrees, implements, optionally
reviews, publishes, checks CI, repairs, merges, and confirms ticket closure.
Use `--no-auto-merge` with a numbered `--issue` to leave its validated PR open.

Automatic Documentation Maintenance runs once after a Batch if a successfully
delivered issue had the trigger label at completion. `--document` starts a fresh
standalone occurrence regardless of that label or `issueList`. No-change
maintenance closes its ticket without an empty PR. Delivery Runs resume from
Recovery Snapshots; disabling or changing the trigger can leave recorded
maintenance artifacts for manual handling. Check the final report for retained
worktrees, PRs, and logs.

## Operator Pause

Non-agent operations, including audit writes and completion checks, offer:

```text
Operation failed. Enter to retry, q to cancel.
>
```

Fix the external problem, then press Enter to retry with a fresh automatic
budget where applicable. Enter `q`, or send EOF, to cancel. Other input stays
paused and prints `Unsupported input. Enter to retry, q to cancel.` It cannot
mark an operation successful, confirm a merge/closure, or accept an audit gap.

An agent blocked in an existing session offers recovery instructions:

```text
Outcome: blocked
Reason: Repository access is unavailable
Agent: codex
Provider session: session-123
Working directory: /workspace/project/worktree
Diagnostic log: /workspace/project/logs/agent.log
Actions: Enter to continue, s to skip, q to cancel, or provide recovery instructions.
> Repository access is restored. Continue the task.
```

Use the session ID with the selected agent's recovery interface, inspect the
working directory and diagnostic log, then enter instructions to continue that
session. Enter sends a continuation; `s` skips this ticket's attempt; `q` or EOF
cancels. Follow the displayed actions; there is no universal resume command.

A failed implementation attempt can instead accept a trusted result:

```text
Outcome: failed
Reason: Provider session unavailable or unrecoverable for continuation
Agent: codex
Provider session: session-123
Working directory: /workspace/project/worktree
Diagnostic log: /workspace/project/logs/agent.log
Actions: Enter to retry, s to skip, q to cancel, or supply a trusted result.
> {"outcome":"committed","pr_title":"fix: [issue-42] restore repository access","pr_body":"Restore repository access.\n\nCloses #42"}
```

This trusted input requires `outcome: "committed"` and nonempty `pr_title` and
`pr_body` for initial implementation or maintenance. It bypasses normal agent
result and Git handoff verification, so use it only after independently
confirming the work. It is distinct from instructions sent to the agent.
Failed repair attempts can reuse existing PR metadata. A failed session probe
without a usable session offers only Enter to retry, `s` to skip, or `q`/EOF to
cancel; it accepts neither instructions nor trusted success.

## Prompt placeholders

Use `{{NAME}}` in prompt files. Common fields are `TICKET_NUMBER`,
`TICKET_REFERENCE` (authoritative issue), `WORKTREE_PATH`, `SOURCE_BRANCH`,
`BASE_SHA`, and `PROJECT_TARGET_BRANCH`.

- `implement.md`: all common fields.
- `ci-repair.md`: common fields plus `PULL_REQUEST_NUMBER`,
  `PULL_REQUEST_URL`, and `FAILED_CHECKS`.
- `conflict-repair.md`: common fields plus `PULL_REQUEST_NUMBER`,
  `PULL_REQUEST_URL`, `TARGET_BRANCH_SHA`, and `MERGE_CONFLICT`.
- `documentation.md`: common fields except `BASE_SHA`.
- `review.md`: `REVIEW_HANDOFF` (JSON with ticket/spec snapshots, standards,
  branch/worktree context, fixed point, and reported checks), plus
  `PROJECT_TARGET_BRANCH`.

Runner appends its output protocol; project prompts describe the task.
