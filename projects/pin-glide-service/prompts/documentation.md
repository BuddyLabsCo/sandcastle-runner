# Maintain documentation for Ticket {{TICKET_NUMBER}}

Work only in the supplied Worktree `{{WORKTREE_PATH}}` on delivery branch `{{SOURCE_BRANCH}}`, for Project Target Branch `{{PROJECT_TARGET_BRANCH}}`. The authoritative Maintenance Ticket is `{{TICKET_REFERENCE}}`.

Review the organization and naming of code files in the current repository and check whether they still comply with `code-architecture.md`. If they do not comply, review the relevant code and the code architecture rules, then analyze whether `code-architecture.md` should be updated, the code should be changed, or both.

Please note that `code-architecture.md` is only a high-level code placement description, it's not designed to present every code files.

If you saw code file or functionality described in `code-architecture.md` cannot be found in the code, review if there are any exising unresolved tickets for them. 
If it's covered by existing unresovled ticket, no update required for the finding.

If update is required, save the analysis result as a Markdown document in a local temporary directory, then stop the session and wait for user review. In the returned JSON object, set the `outcome` field to "blocked" and use the `blocker` field to briefly summarize the analysis conclusion and the location of the saved Markdown document.

If no update needed, `outcome` field of the returned JSON object should be "no_change".

Do not make any changes until user explicitly instruct you to proceed with changes.
