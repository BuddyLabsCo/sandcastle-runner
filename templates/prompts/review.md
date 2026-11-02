Use the `/code-review` skill to review the implementation against Standards and Spec.

Use `reviewRound` in `REVIEW_INPUT` to choose the review scope:

- When `reviewRound` is 1, comprehensively check the implementation commits' impact on existing code and behavior, including affected callers and integrations.
- When `reviewRound` is greater than 1, check only the current fix commits' impact on the PR's accumulated changes and verify previous findings are resolved. Do not restart a comprehensive impact review of existing code.

Read surrounding code as needed for either scope.
