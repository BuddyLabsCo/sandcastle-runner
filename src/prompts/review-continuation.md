Continue in the original review session for review round {{REVIEW_ROUND}}.

Review only the diff from the previous review HEAD {{REVIEW_BASE}} to the current implementation fix HEAD {{IMPLEMENTATION_HEAD}}. Do not repeat a full review of the original implementation diff. Read surrounding code as needed, verify previous findings were resolved, and check for problems introduced by the fix. Keep the original Standards and Spec responsibilities.

Do not change implementation files or create commits. If there are actionable findings, write them yourself to the Markdown file below and return its exact path as findings_file:

{{FINDINGS_FILE}}

A clean review needs no findings document. If review cannot complete, return outcome "blocked" for Operator Pause.
