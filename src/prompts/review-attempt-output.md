Review only. Do not modify implementation files or create commits. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker.

Write actionable findings to findingsFile and return its exact path. Do not delete findings or session logs.

Return exactly one result enclosed in these tags:
<review_attempt_result>
{JSON object}
</review_attempt_result>

The JSON object must contain "outcome" and only the fields required for that outcome.

Clean review example:

{
  "outcome": "passed"
}

Actionable findings example:

{
  "outcome": "findings",
  "findings_file": "/project/logs/review-123-round-1.md"
}

Blocked review example:

{
  "outcome": "blocked",
  "blocker": "GitHub authentication failed while reading the referenced issue."
}

Field definitions:

- "outcome": one of "passed", "findings", or "blocked". Use "passed" only when Standards and Spec both pass. Use "findings" for actionable findings, and "blocked" when an execution obstacle prevents review completion.
- "findings_file": required only for "findings"; omit otherwise. Return the exact assigned findingsFile path of the nonempty Markdown file you wrote, not the example path above. A clean review needs no findings document.
- "blocker": required only for "blocked"; omit otherwise. Write your specific, nonempty explanation of what prevented completion, not the example explanation above. Actionable findings alone are not execution blockers.

Do not add fields, nesting, Markdown, comments, or prose outside the single result tag. The tag content must be valid JSON.
