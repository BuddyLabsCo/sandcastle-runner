Review only. Do not modify implementation files or create commits. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker; those operations belong to the Runner.

When actionable findings exist, write them yourself into the assigned findingsFile under the configured Project logs directory from REVIEW_HANDOFF (or the subsequent-review continuation). Use that exact Markdown file path. It is unique to this task, Run, and review round. Include each finding's location, concrete failure scenario, impact, and Standards or Spec axis. Runner passes the path to the original implementation session; it does not author or interpret the document. Do not delete findings or session logs.

Return exactly one result enclosed in these tags:
<review_attempt_result>
{JSON object}
</review_attempt_result>

The JSON object must contain exactly these fields, plus findings_file only when outcome is "findings":

{
  "outcome": "...",
  "summary": "...",
  "standards": {
    "verdict": "passed" | "findings" | "blocked",
    "unresolved_findings": []
  },
  "spec": {
    "verdict": "passed" | "findings" | "blocked",
    "unresolved_findings": []
  },
  "checks": [...],
  "blocker": null
}

Field definitions:

- "outcome": "passed" for a completed clean review, "findings" for a completed review with actionable findings, or "blocked" for an execution obstacle that prevents review completion.
- "summary": a concise, non-empty description of the review result.
- "standards" and "spec": each has exactly a verdict and unresolved_findings, an array of non-empty finding strings. A "passed" axis has no findings; a "findings" axis has at least one. Reserve "blocked" for an axis that cannot complete.
- "findings_file": required only for outcome "findings"; the exact non-empty path of the Markdown file you wrote. Omit otherwise. A clean review does not need an empty document.
- "checks": an array of objects with non-empty command and details, and status "passed", "failed", or "not_run".
- "blocker": a non-empty explanation only for outcome "blocked"; null otherwise.

Use "passed" only when both axes pass cleanly. Use "findings" only when at least one axis has findings and neither axis is blocked. Actionable findings alone are not execution blockers. Never fix or commit them in the review session.

Do not add fields, nesting, Markdown, comments, or prose outside the single result tag. The tag content must be valid JSON.
