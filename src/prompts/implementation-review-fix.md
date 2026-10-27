Continue in the original implementation session. Read the reviewer-written findings document at:

{{FINDINGS_FILE}}

Fix all actionable findings, run relevant checks, and commit only inside the supplied Worktree on the delivery branch. Report only commits created after {{BASE_SHA}} in this fix turn.

If a finding cannot be resolved or you dispute its validity, return outcome "blocked" with the specific reason you cannot proceed. Do not silently ignore findings or report no_change. Do not push, operate CI, merge, mutate the tracker, or create or modify a Pull Request.
