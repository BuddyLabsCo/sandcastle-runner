# Changelog

## 1.0.1

- - fix: [issue-308] handle long-path Worktree cleanup safely (#309)

## 0.1.3

- - docs: [issue-273] add Simplified Chinese README and configuration guide (#302)


## 0.1.2

- - feat: [issue-298] add npm keywords for coding-agent orchestration and GitHub Issues (#300)
- - feat: [issue-287] publish npm releases with OIDC (#299)
- - fix: [issue-295] trust npm publish exit status over latest (#296)



## 0.1.1

- - test: [issue-292] await timeout test log completion (#293)




## 0.1.0

- - feat: [issue-286] ship the installable issue-runner CLI (#290)
- - chore: propose release v0.1.0 (#289)
- - feat: [issue-285] automate release proposals and gated publication (#288)
- - feat: [issue-269] simplify terminal progress and unresolved skips (#272)
- - fix: [issue-270] default CodeBuddy to unattended sandbox full pass (#271)
- - feat: [issue-264] support settled kill and manual takeover (#268)
- - feat: [issue-263] retain invocations during timeout pauses (#267)
- - feat: [issue-262] coordinate Run-wide Operator Pause (#266)
- - feat: [issue-261] add CodeBuddy provider with durable sessions (#265)
- - feat: [issue-249] separate review and implementation sessions (#250)
- - fix: [issue-247] enforce pause actions and issue-scoped skip (#248)
- - docs: [issue-242] explain workflow ownership and credit Sandcastle (#243)
- - chore: [issue-240] retain only the sandcastle-runner project (#241)
- - fix: [issue-229] retry opted-in workflow writes regardless of error text (#239)
- - fix: [issue-237] remove empty per-run Worktree parent (#238)
- - refactor: [issue-235] remove provider mapping and simplify setup (#236)
- - Remove installation contract section from README
- - docs: [issue-226] reconcile native agent and recovery guidance (#234)
- - test: [issue-225] cover native diagnostic attribution and pause guidance (#233)
- - fix: [issue-223] recover generic session invocation failures (#232)
- - fix: [issue-222] stop recovery on cancellation and timeout (#231)
- - feat: [issue-224] support native Sandcastle agents per purpose (#230)
- - fix: [issue-221] gate continuation on process settlement (#228)
- - refactor: [issue-220] use native Sandcastle run names (#227)
- - fix: [issue-203] restore native Windows execution (#204)
- - feat: [issue-189] skip documentation maintenance occurrences (#202)
- - feat: [issue-188] skip delivery tickets after Pull Request creation (#199)
- - prompt update
- - fix: [issue-191] clean local artifacts after no-auto-merge reaches CI-ready (#198)
- - fix: [issue-190] align Worktree cleanup with ticket lifecycle (#197)
- - feat: [issue-187] skip pre-PR delivery tickets (#196)
- - feat: [issue-185] render human-readable run report (#195)
- - feat: [issue-186] add stage-aware Agent log lifecycle (#194)
- - refactor: [issue-183] remove disableWebSearch configuration (#193)
- - fix: [issue-184] make operator diagnostics readable (#192)
- - Remove redundant review instruction from code review guidelines
- - config update
- - feat: [issue-180] load project configuration from YAML (#181)
- - project update
- - fix: [issue-178] process eligible issues in a value-less --issue Run (#179)
- - test: [issue-174] accept valid project web-search settings (#175)
- - test update
- - fix: [issue-169] name runner-created Codex sessions (#173)
- - feat: add per-project Codex web search override (#171) (#172)
- - update config.json
- - feat: [issue-161] make batch size configurable (#168)
- - feat: [issue-164] trigger documentation maintenance by label (#167)
- - fix: [issue-165] support value-less issue list runs (#166)
- - doc update
- - requirement update
- - prompt update
- - prompts update
- - feat: [issue-159] add CAC CLI parsing and standalone no-auto-merge mode (#160)
- - update doc
- - remove effort limit
- - corret reasoningEffort
- - remove model and effort hardcode
- - update context
- - set doc maintain to false on helm
- - add new project
- - adjust config order
- - feat: [issue-149] add configurable issue list selection (#158)
- - feat: [issue-144] configure operation and agent retries (#157)
- - fix: [issue-152] make no-sandbox execution OS-neutral (#156)
- - term update
- - fix: [issue-154] use basic auth for git remotes (#155)
- - feat: [issue-145] add standalone issue runs (#153)
- - code review update
- - feat: add Sandcastle Runner project config
- - fix: [issue-140] comment no-change summaries (#141)
- - docs: [issue-134] document checkout installation contract (#139)
- - fix: [issue-131] use OS-neutral process boundaries (#138)
- - fix: [issue-132] preserve portable recovery and cancellation (#137)
- - fix: [issue-130] remove Parent Ticket locking (#136)
- - docs: [issue-127] record cross-platform prerequisites and project defaults (#128)
- - docs: [issue-124] scope documentation maintenance paths (#125)
- - docs: [issue-115] clarify Run cancellation terminology (#122)
- - fix: [issue-117] preserve output protocol on continuation (#118)
- - feat: [issue-105] retry safe external writes (#106)
- - update (#104)
- - docs: [issue-102] clarify PR metadata handoff prompts (#103)
- - refactor: [issue-100] enforce 500-line file limit (#101)
- - fix: [issue-98] resume agent sessions after invocation failures (#99)
- - fix: [issue-96] clean test temp artifacts on termination (#97)
- - fix: [issue-94] preserve structured retry protocol (#95)
- - fix: preserve structured output retry results (#93)
- - fix: [issue-90] harden agent recovery and reservations (#91)
- - feat: [issue-88] configure maintenance tickets and update project prompts (#89)
- - test: [issue-81] verify agent pause run seam (#85)
- - fix: apply shared continuation contract across Agent Attempts
- - Expose complete Agent Pause diagnostics and structured audit transitions
- - fix: [issue-78] complete shared attempt continuation flow
- - test: demonstrate composed restart recovery (#69)
- - fix: recover documentation maintenance at startup (#68)
- - fix: [issue-55] clean terminal ticket worktrees (#67)
- - fix: [issue-54] retain completed recovery evidence
- - fix: [issue-53] persist conflict repair recovery state
- - fix: resume repairs through fresh guarded worktrees
- - feat: [issue-51] reconcile publication after restart
- - fix: [issue-50] persist Parent recovery state
- - feat: [issue-49] provide copyable example Project (#61)
- - feat: [issue-48] gate publication on fresh-context review (#60)
- - feat: [issue-47] make documentation maintenance optional (#59)
- - fix: [issue-46] use branch-safe prompt inputs (#58)
- - docs: [issue-42] document Codex App Server recovery semantics (#43)
- - test: [issue-18] verify complete Run scenarios (#35)
- - feat: [issue-17] deliver documentation maintenance between batches (#34)
- - feat: [issue-16] repair merge conflicts on original pull request (#33)
- - feat: [issue-15] repair failed required CI (#32)
- - feat: [issue-14] deliver dependency-driven Batches (#31)
- - feat: squash-merge a CI-ready pull request and confirm delivery (#30)
- - feat: [issue-12] publish verified handoffs for CI readiness (#27)
- - update (#26)
- - feat: [issue-11] implement verified agent handoffs (#25)
- - feat: [issue-10] select and reserve eligible delivery tickets (#24)
- - feat: [issue-9] run supervised no-delivery outcomes (#23)
- - init (#21)
- - docs: add V1 specification and published ticket plan
- - docs: define verified Agent Attempt handoff
- - docs: link published wayfinder map
- - docs: add feasibility research and wayfinder draft
