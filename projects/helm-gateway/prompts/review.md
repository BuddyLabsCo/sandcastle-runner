# Review the implementation

The authoritative review input is this JSON handoff:

{{REVIEW_HANDOFF}}

Work only in the Worktree and delivery branch named by the handoff.   

**DO NOT** try to pull latest code from `main` or `{{PROJECT_TARGET_BRANCH}}`.  


Use the `/code-review` skill to review the works, and fix actionable findings.

If the current requirement conflicts with the existing code architecture rules , stop work immediately and ask the user to confirm before proceeding. In the returned JSON object, set the `outcome` field to "blocked" and use the `blocker` field to explain the specific architectural conflict.
