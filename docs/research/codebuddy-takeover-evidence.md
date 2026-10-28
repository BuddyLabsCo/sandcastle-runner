# CodeBuddy takeover and operation evidence

Issue [#264](https://github.com/BuddyLabsCo/sandcastle-runner/issues/264) completes the takeover chain required by [#260](https://github.com/BuddyLabsCo/sandcastle-runner/issues/260). These focused live checks use the production provider, pinned Sandcastle, host launcher, supervision, result schemas, and Git inspection. Automated CLI/Run regressions separately prove routing and concurrent intervention behavior.

## Versions, policy, and isolation

Measurements on 2026-10-27 UTC used Linux, Node.js 24.20.0, CodeBuddy CLI 2.177.1, Sandcastle 0.12.0, and `deepseek-v4.1-flash` through the native authenticated CodeBuddy backend. The backend endpoint was not inspected. No credentials or unrelated transcripts were read or copied.

Both new probes create disposable Git repositories and worktrees under the checkout's ignored `node_modules` directory. Each uses a dedicated absolute `CODEBUDDY_CONFIG_DIR`, an isolated `GIT_CONFIG_GLOBAL`, and the same store for native execution and exact transcript lookup. Cleanup removes these fixtures after confirmed settlement; a process-cleanup failure retains them for investigation. Research branches remain unmerged, and Sandcastle remains pinned.

The tested unattended policy is `dontAsk` with separate trusted `Read`, `Write`, `Edit`, and `Bash` allow rules. The broad Bash rule is an explicit fixture assumption. It is not a default permission grant or evidence that narrower command rules work. The provider keeps native background tasks disabled. No sandbox bypass flag, approval responder, or policy change was introduced.

## Durable context control

`node docs/research/codebuddy-provider-probe.ts` passed again on CLI 2.177.1. It ran four separate real native processes using dedicated state:

| Phase | Elapsed | Immediate transcript bytes | Observation |
| --- | --- | --- | --- |
| `SESSION_READY` | 4,791 ms | 3,130 | Exact ready response persisted |
| Exact-ID continuation | 4,447 ms | 7,684 | Repeated the original ready prompt |
| Store random context marker | 5,313 ms | 13,038 | Marker saved in the same session |
| Recall marker | 4,881 ms | 17,757 | Returned the marker without receiving it again |

All continuations retained the original native ID. Exact transcript lookup took 0–1 ms at the timer's resolution. These observations supplement the earlier [2.177.0 provider evidence](codebuddy-provider-evidence.md).

## Complete live takeover chain

Run `node docs/research/codebuddy-takeover-probe.ts` in a terminal. It prints only the selected fixture's identity and prompts through the real terminal adapter. At the timeout, enter `k`; use another terminal for native manual resume only after settlement. Follow the [operator sequence](../config-guide.md#stop-one-invocation-for-manual-takeover), using the printed store, worktree, session, and Git configuration. Ask the native session to recall the original secret marker and write it to `manual.txt`; do not supply the marker again. Exit that CLI, then press Enter in Runner.

The initial accepted run and a repeat with exact native-storage validation both completed the following chain:

1. Runner's exact `SESSION_READY` probe persisted a native session.
2. Substantive execution resumed that session and read `CODEBUDDY.md`. Its foreground Bash command started a harmless parent and writable descendant.
3. The 30,000 ms overall threshold retained the real CLI, owned descendants, output collection, and pending result. No replacement CLI started.
4. `k` stopped only this invocation. Runner confirmed settlement; independent PID checks found both fixture processes absent. The descendant's output file remained unchanged during a further 150 ms observation window.
5. Exact native transcript lookup succeeded in the dedicated configured store. Runner stayed paused with only two calls so far: the probe and original invocation.
6. A separately launched **interactive native CodeBuddy CLI** resumed the printed ID in the original worktree and store. Its folder-trust prompt was confirmed for this disposable worktree. It recalled the original marker and wrote `manual.txt`, without a commit.
7. `/exit` ended the manual CLI with exit status 0 before input returned to Runner.
8. Enter launched another real native invocation in the original session. It used Write/Edit, ran a Node assertion, committed locally, and returned exactly one valid `agent_attempt_result`.
9. `LocalGitWorkspace.inspect` independently confirmed the expected branch, clean worktree, base, and exact SHA/subject claims. One implementation commit was accepted. Runner-side checks also verified the recalled marker and Node behavior.

The first run's ready probe took 5,120 ms; Runner continuation after manual exit took 18,680 ms. The final repeat's ready probe took 4,963 ms and its Runner continuation took 17,537 ms. Timing excludes operator deliberation and manual CLI interaction.

Sanitized event log from the first successful chain:

```text
Runner: SESSION_READY persisted; same native session selected
Runner: overall threshold reached at 30,006 ms; original invocation retained
Operator: k
Runner: selected CLI and owned descendants settled; writes stopped
Native CLI: exact session/store/worktree resumed
Native CLI: Write(manual.txt) using [original context marker]
Native CLI: MANUAL_DONE
Native CLI: /exit; exit status 0
Operator: Enter
Runner: same-session continuation; tagged result validated
Git inspection: clean=true; branch/base/commit claims matched; commits=1
```

The initial implementation deliberately writes subtraction as a review fixture; this is not a claim about application correctness. The separate operation probe below exercises correction to the intended addition behavior.

## Permission refusal remained actionable

The first manual launch used `--allowedTools Read,Write,Edit,Bash`. Under `dontAsk`, that interactive process denied Write and Bash and returned a tagged blocked result explaining the refusals. It created no file or commit, and Runner remained paused. That result was not accepted as delivery.

After exiting that CLI, another manual launch used the production provider's exact argument form, `--allowedTools Read Write Edit Bash`, with the same tool set, permission mode, worktree, session, and storage. Write passed, the marker matched, and the CLI exited before Runner continued. The repeated complete chain used separate arguments from the start and passed. These observations establish a version/configuration sensitivity; they do not establish the native parser's internal cause or authorize changing another Project's policy.

Sanitized refusal excerpt:

```text
Write: denied because CodeBuddy is running in dontAsk mode
Bash: denied because CodeBuddy is running in dontAsk mode
agent_attempt_result: blocked; commits=[]; checks=[]
blocker: Write and Bash permissions prevent the required file, checks, and commit
```

## Focused live operation coverage

`node docs/research/codebuddy-workflow-probe.ts` passed with the same version, model, isolated state, and trusted policy. It exercises the real executor and native CLI; local fixtures replace remote issues and required-check services. Every committed result is compared with actual Git evidence, including all claimed SHA/subject pairs and worktree cleanliness.

| Live phase | Native task elapsed | Independent observation |
| --- | --- | --- |
| Initial implementation | 18,940 ms | Write/Edit, Node assertion, one commit; instruction-required subject prefix |
| Separate Review | 19,959 ms | Distinct native ID; nonempty findings file; no implementation commits |
| Original-session fix | 13,425 ms | Original implementation ID; addition fixed; two total commits verified |
| Re-review | 10,974 ms | Original review ID; tagged `passed` |
| CI repair | 17,687 ms | Real failing Node assertion repaired; one commit and passing check |
| Conflict repair | 24,920 ms | Real local merge conflict resolved; both intents preserved; target ancestry and one merge commit verified |
| Documentation Maintenance | 18,147 ms | README with Documentation Base; Node check and one commit verified |
| Agent Retry | 15,180 ms, then 9,099 ms | Same native session; exactly one commit after recovery |

Each new role first passed its own ready probe, taking 3,813–5,017 ms. The retry control injects transport loss **after a real native response**, then lets production Agent Retry launch another real CLI. It proves permission coverage and session continuity during recovery; it does not claim a spontaneous backend failure. No remote CI, publication, merge, or tracker mutation occurred.

The maintenance control certifies native reading, editing, testing, committing, and Documentation Base handling. Automated CLI/Run tests establish independent/automatic scheduling and role selection. Likewise, automated CI/conflict regressions establish workflow routing and retry budgets; the live controls prove the corresponding native operations under this policy.

## Automated regressions and limits

The CLI/Run timeout scenarios cover selected-only kill with two active attempts, completion while queued, fresh status at display, independently pending entries, no delivery advancement during manual handling, continuation with zero Agent Retry budget, Review takeover, missing/ambiguous native storage, cleanup failure, and q/EOF cancellation. The real-process harness proves writable descendants stop after confirmed selected kill. Shared cancellation, cleanup gates, native recovery, result validation, review rounds, repairs, maintenance, publication, Reservations, Verified Handoff, and Recovery Snapshot regressions remain in the repository suite.

Final repository verification passed:

- `npm test`: run once at the end; 448 passed, 4 Windows-only skips, zero failures (452 tests total)
- `npm run check`: Prettier, ESLint, and TypeScript passed
- Focused shared lifecycle, native recovery, output-stop, cleanup-gate, and review-round selection: 47 passed, 1 Windows-only skip
- Final CLI timeout/takeover selections: 14 passed, including 8 in the dedicated takeover file
- `git diff --check`: passed

The new scripts contain independent assertions and are focused live probes, not fixtures included in `npm test`. Static ripwire planning reports still flag supervisor length/recent churn and graph reachability gaps, including live probes and documented sections. Those advisory reports are not test execution evidence; the full suite and real-process/live assertions above provide that evidence. No heuristic baseline or suppression was added.

Evidence is limited to this Linux/CLI/model/backend/policy combination. No repeated whole-platform certification or production rollout is claimed. Native interactive trust and permissions must be prepared for the selected Project. Runner gates its own launches; it cannot detect an independently launched session writer, so operator input acknowledges that the manual CLI has exited. A retained invocation is in-memory ownership, not live-process adoption after restart. A native permission refusal, absent transcript, uncertain settlement, invalid result, or mismatched Git evidence cannot count as completed delivery.
