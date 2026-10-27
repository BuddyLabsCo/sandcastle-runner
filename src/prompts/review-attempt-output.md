Review only. Do not modify implementation files or create commits. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker.

Write actionable findings to findingsFile and return its exact path. Do not delete findings or session logs.

Return exactly one JSON result enclosed in these tags:
<review_attempt_result>
{JSON object}
</review_attempt_result>

Use exactly the fields for the applicable outcome:

- Clean review: {"outcome": "passed"}. Both Standards and Spec must pass. No findings document is needed.
- Actionable findings: {"outcome": "findings", "findings_file": "/exact/assigned/path.md"}.
- Execution obstacle: set "outcome" to "blocked" and include "blocker" with your specific, nonempty explanation of what prevented completion. Actionable findings alone are not execution blockers.

Do not add fields, nesting, Markdown, comments, or prose outside the single result tag. The tag content must be valid JSON.
