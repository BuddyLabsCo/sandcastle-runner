# Review the implementation

The authoritative review input is this JSON handoff:

{{REVIEW_HANDOFF}}

Work only in the Worktree and delivery branch named by the handoff.   

**DO NOT** try to pull latest code from `main` or `{{PROJECT_TARGET_BRANCH}}`.  

Use the `/code-review` skill to review the implementation against Standards and Spec.
Review the diff from reviewBase to implementationHead in the handoff. Read surrounding code as needed.
Only review and write findings to the assigned findingsFile. Do not modify implementation files or create commits.
The original implementation session owns all fixes.

