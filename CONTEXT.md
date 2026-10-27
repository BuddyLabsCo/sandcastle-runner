# Sandcastle Runner

Sandcastle Runner coordinates ticket-driven coding work for configured software projects.

## Language

**Project**:
A configured target repository together with its tracker, code host, and execution policy.
_Avoid_: Workspace, target

**Target Branch**:
The Project branch against which a Run prepares, validates, and integrates Delivery Tickets.
_Avoid_: Main branch, base branch, default branch

**Run**:
One CLI invocation that processes a delivery scope or performs independent Documentation Maintenance for one Project to a terminal outcome.
_Avoid_: Job, session

**Recovery Snapshot**:
The canonical persisted record a Run uses to resume its delivery scope, including associated automatic Documentation Maintenance, after an interruption.
_Avoid_: Checkpoint, state file

**Operator Pause**:
A point at which a Run waits for an operator to retry, cancel, skip the current issue or maintenance occurrence, or instruct a continuable Agent session. Operator input never substitutes for a successful result. Audit failures permit only retry or cancellation.
_Avoid_: Terminal pause, human intervention

**Parent Ticket**:
The GitHub issue supplied to a Run as its delivery scope. Only its same-repository direct children can be Delivery Tickets.
_Avoid_: Parent issue, epic

**Batch**:
Up to the Project-configured maximum number of Delivery Tickets or Standalone Issues worked concurrently and integrated only after every pull request in that group is ready.
_Avoid_: Wave, group

**CI-ready Pull Request**:
A pull request whose check-discovery delay has elapsed and whose returned required CI checks are either empty or all passing.
_Avoid_: Ready PR, merge-ready PR

**Delivery Ticket**:
A same-repository direct child of the Parent Ticket that a Run may select for coding and integration.
_Avoid_: Task, work item

**Issue List**:
A Project-configured list of issue numbers. In a Parent Ticket run it limits processing to listed same-repository direct children; in a value-less `--issue` run it supplies the standalone issues to process.
_Avoid_: Sub-issue list

**Standalone Issue**:
A GitHub issue processed as its own delivery scope rather than as a child of a Parent Ticket.
_Avoid_: Single issue, orphan issue

**Eligible Delivery Ticket***:
An open Delivery Ticket with no non-runner assignee, no complete or partial Reservation, and only closed native blockers.
_Avoid_: Ready ticket, available ticket

**Externally Owned Delivery Ticket**:
An open Delivery Ticket assigned to an account other than the runner. A Run skips it, but it prevents the Parent Ticket from being completed.
_Avoid_: Assigned ticket

**Reservation**:
The combination of the `sandcastle:reserved` label and runner-account assignee that marks a Delivery Ticket as owned by a Run.
_Avoid_: Claim

**Cancellation**:
A Delivery Ticket closed as `not_planned`. It is handled but not delivered, and it satisfies downstream blockers.
_Avoid_: Completion, delivery

**Run cancellation**:
A Run ended by the operator entering `q` or by EOF, producing the existing `cancelled` outcome; operating-system termination is not Run cancellation.
_Avoid_: Abrupt termination, interruption

**Completed Delivery Ticket**:
A Delivery Ticket whose pull request is merged and whose tracker state is confirmed closed with the completed reason.
_Avoid_: Handled ticket, terminal ticket

**Documentation Base**:
The full commit SHA stored by a documentation surface as the latest revision it has completely reviewed.
_Avoid_: Base commit, last documented commit

**Documentation Maintenance**:
A review that brings documentation surfaces up to date with the Target Branch and advances their Documentation Bases. It can follow a completed Batch or be requested independently by an operator.
_Avoid_: Doc update, documentation task

**Documentation Maintenance Trigger Label**:
A Project-selected label on a successfully delivered issue that requests automatic Documentation Maintenance for its Batch. It is distinct from the label identifying a Maintenance Ticket.
_Avoid_: Maintenance Ticket label

**Maintenance Ticket**:
A standalone tracker item whose pull request delivers one Documentation Maintenance occurrence.
_Avoid_: Documentation Delivery Ticket, doc task

**Ticket Closure Policy**:
A Project rule that chooses whether the Runner closes PR-backed tickets after merge or waits for the code host to close linked tickets.
_Avoid_: Auto-close mode, issue-closing flag

**Agent Attempt**:
One invocation using the Project-configured agent, model, and optional native options for implementation, review, CI repair, conflict repair, or Documentation Maintenance. Runner first probes the selected supported agent (Codex, Claude Code, Pi, or CodeBuddy), then resumes that same session through Sandcastle for the substantive work.
_Avoid_: Agent session, worker

**Agent Attempt Result**:
A schema-validated JSON account of an Agent Attempt's outcome, summary, claimed commits, checks, and blockers. It is evidence for the runner, not proof of delivery.
_Avoid_: Completion marker, final message

**Review Attempt Result**:
A schema-validated account of a review's clean, findings, or blocked outcome. A findings result returns only the reviewer-written Markdown path for the original implementation session to fix. A blocked result includes only the obstacle explanation. The original review session reviews subsequent fixes within the same Run. It never owns Pull Request metadata or commit claims.
_Avoid_: Review Handoff, approval

**Verified Handoff**:
An Agent Attempt Result accepted after the runner independently validates the actual branch, commits, and worktree state.
_Avoid_: Agent completion, successful turn

**Operation Retry**: An automatic retry budget for external reads, workflow writes, and agent-session probes.
_Avoid_: Operator retry

**Agent Retry**: An automatic retry budget for recoverable continuation in the same agent session, including process, output, and structured-output recovery.
_Avoid_: Operation retry

**Retry Policy**: The Project-configured operation and agent retry counts plus their delay schedules.
_Avoid_: Retry defaults
