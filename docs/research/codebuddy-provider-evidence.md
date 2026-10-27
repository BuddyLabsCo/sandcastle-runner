# CodeBuddy provider evidence

Issue [#261](https://github.com/BuddyLabsCo/sandcastle-runner/issues/261) adds a local provider under the [settled parent specification](https://github.com/BuddyLabsCo/sandcastle-runner/issues/260). Durable continuation passed a live check. Basic native operations and instruction precedence also passed bounded controls. Full workflow operation coverage and the retained-invocation/manual-takeover chain remain acceptance work for the final takeover ticket.

## Versions and isolation

Measurements on 2026-10-27 UTC used Linux, Node.js 24.20.0, CodeBuddy CLI 2.177.0, and pinned Sandcastle 0.12.0. The selected model was `deepseek-v4.1-flash` through the authenticated native CodeBuddy backend. The backend endpoint was not inspected. Model authentication worked through the CLI's existing authentication storage; no credentials, personal settings, or prior transcripts were read or copied into the dedicated CLI state.

Each live check used a disposable Git repository, dedicated `CODEBUDDY_CONFIG_DIR`, and temporary `GIT_CONFIG_GLOBAL`. The durable check used a separate Git worktree. Calls ran through the production provider, pinned Sandcastle, and Runner's shell-free launcher and process-settlement boundary. All completed with settlement reported as `settled`; this does not certify the future retained-invocation lifecycle. Temporary session state and repositories were removed after each check.

## Measured durable continuation

Run the bounded live check from the Runner checkout with an authenticated CLI:

```sh
node docs/research/codebuddy-provider-probe.ts
```

Two production-provider runs passed, including a repeat after the final parser changes. The table records the final run. The script asserts real transcript discovery and context recall; temporary-store unit fixtures do not satisfy it. It uses `dontAsk`, disables tools, and supplies a 45-second deadline per invocation. The script prints sanitized measurements and removes its disposable state.

| Separate CLI process | Elapsed | Immediate transcript size | Observed result |
| --- | --- | --- | --- |
| Exact Runner `SESSION_READY` probe | 4,920 ms | 3,170 bytes | `SESSION_READY`; exact-ID lookup took 1 ms after return |
| Resume probe ID | 4,628 ms | 7,420 bytes | Quoted the entire previous user prompt: `Reply with exactly: SESSION_READY` |
| Resume same ID, store random marker | 5,099 ms | 12,135 bytes | `MARKER_SAVED` |
| Resume same ID, recall marker | 5,143 ms | 16,889 bytes | Returned the random UUID exactly without receiving it again |

All three resumed processes returned the original native ID. Lookup took less than 1 ms at the timer's resolution on the later calls. The script independently read the dedicated transcript and found the marker. These results establish immediate persistence and cross-process exact-context continuation for this CLI/backend combination.

A preliminary direct CLI call returned `SESSION_READY` in 5,109 ms. Only the subsequent production-provider measurements above serve as the provider's durable acceptance evidence. The sanitized stream fixture preserves the observed system-init/status, assistant-text, and final-result shapes; identifiers, paths, and thinking text are replaced. Tool/error cases mutate these shapes or use controlled CLI events and are identified as automated coverage below.

## Measured permissions and instructions

Fresh live sessions with tools disabled returned `CODEBUDDY_WINS` in 4,808 ms when both instruction files existed. After removing `CODEBUDDY.md`, a new session returned `AGENTS_FALLBACK` in 4,510 ms. Each file defined its own response to `INSTRUCTION_PROBE`. This checks the documented precedence without reading personal instruction files.

Under `dontAsk`, a trusted allow list containing `Read`, `Write`, `Edit`, and `Bash` completed a bounded capability prompt in 9,342 ms. The agent created a file using Write, changed it using Edit, ran a Node assertion, and committed the file. Runner-side checks independently confirmed exact file contents, a clean worktree, and the expected Git commit subject. This checks basic operations, not every Project command or protected path. A broad trusted Bash rule is an operator policy choice, not a provider default or universal permission guarantee.

Two earlier implementation probes used narrower `Bash(git:*)` and `Bash(node:*)` rules. One returned a schema-valid blocked Agent Attempt Result. The second created and edited the requested file, but native Bash refused verification because approval was unavailable. Its final response included forbidden `pr_title`/`pr_body` null fields and failed the existing result schema. No commit or delivery was accepted. These observations show both policy sensitivity and model output variability; neither justifies relaxing validation or permissions. They do not prove that every command matching those patterns is refused.

The closed, unmerged prerequisites PR [#257](https://github.com/BuddyLabsCo/sandcastle-runner/pull/257) contributed no files to this branch. This change includes its required authentication/permission prerequisite language in the current README. Ordinary recovery text cannot grant native tool permission, and no host sandbox-bypass flag or approval responder was added.

## Automated contract and workflow coverage

The provider tests cover exact main-transcript lookup, missing and subagent-only sessions, ambiguity, invalid IDs, custom storage, native options, foreground ownership restrictions, and the sanitized stream fixture. Lookup scans direct project directories by validated ID, avoiding a duplicate implementation of CodeBuddy's Unicode/path compression. Unused sandbox transfer methods reject rather than claim persistence.

The controlled CLI tests run the real executor and Sandcastle with the production provider. They check both tagged schemas, native continuation, supplied cwd/Git configuration, stdin and argument quoting, missing/malformed/duplicate/misleading output, nonzero exits, terminal errors, cancellation despite success flags, retained retry context, and zero-exit permission refusals. Native success flags and denial metadata never substitute for output validation or Git verification. Malformed/unknown events are tolerated as log input but cannot supply a final result.

Existing resolver identities and shell-free command-shim tests also include CodeBuddy. Existing executor, native-recovery, output-stop, cleanup-gate, process-lifecycle, review-round, Agent/Operation Retry, CI/conflict repair, Documentation Maintenance, full-contract, and restart tests protect shared behavior. No provider-specific workflow branch, executor replacement, dependency, or public export layer was introduced.

Final repository verification passed:

- `npm test`: 398 passed, 4 platform skips, zero failures; full suite run once after the review fixes
- `npm run check`: formatting, ESLint, and TypeScript checks passed
- Focused provider/resolver/launcher selections: 34 passed, 3 platform skips
- Selected executor/recovery/output/cleanup/process and workflow regressions: 79 passed, 1 platform skip
- `git diff --check`: passed

Review regressions also verify rejection of every native truthy sandbox-bypass spelling in explicit and inherited environments. No bypass-enabled CLI was launched. Session lookup now follows the child home environment, checked against a harmless Node child's `os.homedir()` result. Empty or relative fallback homes fail visibly. These configuration checks required no additional live backend calls.

## Remaining live acceptance work

The parent specification assigns the complete timeout intervention and takeover chain to the final ticket. It must demonstrate retained output/outcomes, Run-wide gating, selected-only kill, confirmed CLI/descendant settlement, manual resume in the original worktree/store/session, manual exit, and Runner continuation accepted by normal validation and independent Git verification.

Also verify real implementation/review session separation, original-session fixes, Agent Retry, CI repair, conflict repair, and independent/automatic Documentation Maintenance under the chosen Project permissions. Automated workflow regressions establish routing and safeguards; they do not certify native permission coverage for those operations. The basic operation control used raw final text, while controlled CLI tests exercise both tagged contracts through the real executor. The live blocked/schema-failure cases are not successful delivery certification.

The standard installed CLI has no product-specific data-layout override. Custom distributions that change the native CLI home need separate verification. Existing Runner platform evidence is inherited only for the unchanged provider-independent launcher/workflow paths; these live measurements cover Linux and this CLI version. No additional whole-platform certification, production rollout, or manual takeover claim is made here.
