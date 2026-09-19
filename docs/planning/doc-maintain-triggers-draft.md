# Documentation Maintenance Trigger Requirements

Status: requirements decisions confirmed. This session remains analysis-only; implementation is not authorized.

## Session boundaries

- Requirements analysis and local documentation only.
- No implementation, commits, issue creation, pull requests, or remote changes.
- Project configuration migration below is future implementation scope, not authorization to edit configuration during this session.
- This draft describes requested behavior, not the current implementation.

## Confirmed decisions

### Configuration and automatic triggering

- Remove `workflow.documentationMaintenance`; do not introduce the previously proposed `workflow.docMaintain` boolean.
- Use only `workflow.docMaintainTriggerLabel` to configure automatic triggering. An omitted field is equivalent to an empty string. Trim surrounding whitespace; an empty result disables automatic Documentation Maintenance. Reject non-string values. Match nonempty label names exactly and case-sensitively; no multi-label syntax, wildcards, or expressions.
- In the future implementation, migrate every existing Project config to `"docMaintainTriggerLabel": ""` and remove the old boolean. This deliberately disables automatic maintenance for all existing Projects until a trigger label is configured.
- Replace both delivery-credit and Parent closeout automatic triggers with label-driven triggering.
- Apply the same label policy to Parent Ticket and standalone-issue runs. A single standalone issue forms a one-issue Batch.
- Inspect the actual processed issues, not the Parent Ticket's labels.
- One successfully delivered issue bearing the configured label is sufficient; multiple matches within a Batch cause only one maintenance occurrence.
- Use labels read when each issue's delivery is confirmed as the label evidence. Preserve that evidence for automatic-run recovery and reevaluate it against the current configured trigger label at startup or recovery.
- Success means the pull request has merged and the issue is confirmed closed as completed, not merely successful agent execution or passing CI.
- Preserve existing CI repair, merge-conflict repair, retries, Operator Pause, and cancellation behavior. Evaluate the label trigger only at the normal post-Batch scheduling point after successful integration; do not interrupt repairs or pauses, and do not add maintenance before a failure or cancellation exit.

### Explicit invocation

- Add a value-less `--document` CLI flag, mutually exclusive with `--parent` and `--issue`.
- Select one Project but do not require or read a Parent Ticket, process delivery issues, or apply the Issue List.
- No trigger label is required for explicit invocation.
- Execute the complete existing Documentation Maintenance workflow, including its standalone Maintenance Ticket and applicable pull-request, check, and integration steps, rather than only invoking a documentation agent.
- Require configuration needed by the maintenance workflow; exit after one maintenance occurrence.
- Every `--document` invocation starts a fresh complete maintenance occurrence. Do not resume or reconnect to an earlier occurrence, whether it succeeded or was interrupted.
- Preserve the existing no-change outcome: complete the Maintenance Ticket and exit successfully without an empty pull request.

### Recovery and sequencing

- Automatic-run recovery remains in scope, but the current `config.json` is authoritative. Previously scheduled maintenance is not an unconditional obligation to finish.
- An empty current trigger label disables automatic maintenance, including continuation of previously scheduled automatic maintenance.
- If the trigger changes to another nonempty label, reevaluate the stored delivery-time labels. Do not continue the previous maintenance occurrence if there is no match. Read configuration at startup or recovery; do not add live configuration reload.
- When current configuration stops pending automatic maintenance, do not add a cleanup workflow or automatically close or delete its existing ticket, pull request, branch, or worktree. Report leftover artifact locations for manual handling and stop automatic continuation.
- The normal automatic-maintenance barrier remains: while maintenance is required by the current configuration, do not start the next Batch or complete Parent closeout until it succeeds.
- Explicit `--document` invocations are fresh-only, not resumable invocations.

### Explicitly out of scope

- Concurrent invocations for the same Project: do not add Project-level run locking for this requirement.
- Compatibility or migration for old-version recovery snapshots.

## Verified scheduling facts

- Existing CI repair, merge-conflict repair, retry budgets, and Operator Pause remain inside publication/integration processing; a failure or exhausted repair budget is not itself a maintenance scheduling point.
- Operator retry continues that processing. Operator cancellation or an unsuccessful terminal integration result exits the Run before the normal post-Batch maintenance check.
- Current automatic maintenance is checked only after successful Batch integration, at Parent closeout with remaining credit, or when recovering an existing maintenance barrier. This requirement replaces the first two trigger policies, not the repair/pause machinery.
- Evidence: `src/run/run.ts:259-330,463-474,518-532`, `src/run/pull-request-repair.ts:426-467`, and `src/run/operations.ts:143-156`.

### Confirmed scheduling rule

Preserve repair, retry, pause, and cancellation behavior. At the normal post-Batch scheduling point, run maintenance once if at least one successfully delivered issue matches the trigger label. Do not interrupt repair or Operator Pause to run maintenance, and do not introduce a maintenance-on-failure-exit path.

## Acceptance scenarios

| Scenario | Required result |
| --- | --- |
| Trigger field omitted, empty, or whitespace-only | Automatic maintenance is disabled. |
| Trigger field is not a string | Configuration validation fails. |
| Normal Batch completion with at least one successfully delivered issue matching the configured label | Run one maintenance occurrence before the next Batch or Parent closeout. |
| Multiple successful issues match in the same Batch | Run one occurrence, not one per matching issue. |
| Three or more issues delivered but none match | Do not trigger maintenance from the former credit threshold. |
| Parent becomes eligible for closeout without a matching completed Batch | Do not add a final maintenance occurrence. |
| Only the Parent bears the trigger label | Do not trigger maintenance from the Parent label. |
| Standalone-issue Batch completes with a matching issue | Apply the same automatic trigger rule as a Parent Ticket run. |
| An issue is waiting for CI repair, conflict repair, retry, or Operator Pause | Continue existing handling; do not start maintenance at that point. |
| Run exits through cancellation or unsuccessful integration | Do not add a maintenance-on-exit step. |
| Automatic Run resumes with an unchanged matching trigger and unfinished maintenance | Resume the same required maintenance occurrence rather than duplicate it. |
| Current trigger becomes empty or no longer matches stored delivery-time labels | Stop automatic continuation; preserve existing artifacts and report their locations. |
| `--document` with an empty or missing trigger label | Start a fresh complete maintenance occurrence, provided maintenance prerequisites are valid. |
| `--document` combined with `--parent` or `--issue` | Reject invalid CLI arguments before starting the workflow. |
| `--document` invoked after a previous invocation | Start fresh, even if the previous occurrence was interrupted. |
| Maintenance finds no documentation changes | Complete its Maintenance Ticket successfully without creating an empty pull request. |

## Open decisions

None remaining from the requirements interview.

## Vocabulary

Documentation Maintenance retains its existing domain name. The trigger label selects delivery issues that request maintenance; it is distinct from the label applied to a Maintenance Ticket. A Run can deliver issues or perform independent Documentation Maintenance.

## Superseded proposals

- Renaming the old boolean to `docMaintain` was superseded by removing the boolean entirely.
- Requiring a nonempty trigger label whenever an enablement boolean is true no longer applies.
- Running maintenance immediately after a partial integration failure was rejected. Existing repair, pause, and exit behavior stays intact; matching one delivered issue is sufficient only when the normal post-Batch scheduling point is reached.
- Continuing previously scheduled maintenance regardless of the current configuration was rejected; current configuration is authoritative.
- Resuming a previous explicit `--document` occurrence was rejected; each invocation starts fresh.
- Project-level concurrency protection and legacy recovery migration were excluded from scope.
