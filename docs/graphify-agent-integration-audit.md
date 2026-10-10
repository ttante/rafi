# Graphify implementation audit — 2026-10-10

The four concrete defects found by this audit are now corrected. Broader release certification remains outstanding; the implementation status document lists those validation limits. The A1/A2 descriptions below preserve the original findings and now include their resolutions.

Scope: the current working tree, including the landed preparation implementation, reviewed against `graphify-agent-integration-requirements.md` and `graphify-agent-integration-implementation-plan.md`. The tree contains concurrent, uncommitted work; this is not an audit of a tagged release. Source inspection was used rather than relying on the repository's stale graph. No billed provider evaluation was run.

## Findings resolved after the audit

### A1 — Fixed (original severity: high): worktree exclusions are checked against the wrong directory

`packages/ai-foreman/src/graph/turn.ts:192` creates a derived-access grant using `workspace: context.configRoot`, but takes its exclusions digest from the generation acquired for `context.workspace`. `graph/derived.ts:64` then recomputes that digest in the configuration root. Those directories are intentionally different for branch builds and disposable QA snapshots.

An isolated reproduction published a code-only graph for a separate workspace with different `.gitignore` contents, then requested a planning turn for that workspace. The generation published successfully, but the provider received **zero calls**. Dispatch threw `Graph access changed; provider history and derived output require explicit recovery`. Even a harmless difference in ignore comments reproduces it. This is a fresh valid graph, not an actual revocation.

Impact: branch-specific graph use can block planning/preparation/build work instead of supplying evidence or following the optional-graph fallback. The existing equivalent-snapshot test copies the same ignore file and therefore misses this condition. Requirements 11, 17, 18 and 27; G2/G7/G8; T07/T17/T21.

Required correction: distinguish the durable source workspace whose exclusions authorized the evidence from the project configuration authority and the disposable read snapshot. Capture and validate each applicable policy against its own identity. Retained preparation evidence must remain readable after snapshot cleanup, while later project/source exclusions must still revoke access. Do not fix this by disabling exclusion validation or changing every grant to a temporary snapshot path.

Required tests: a branch with differing root/nested ignores and a valid branch generation; preparation/final QA from its equivalent disposable snapshot; retained evidence after snapshot deletion; subsequent branch and project exclusion revocation. Also assert that an initial optional-evidence mismatch cannot dispatch undisclosed graph content or unnecessarily block source-only work.

Resolution: derived grants now bind the actual durable source workspace and independently record the canonical project's exclusion baseline. Preparation and final QA explicitly pass the Builder's durable workspace when reading a disposable snapshot. Snapshot deletion therefore does not revoke retained evidence; changes to either source-worktree or canonical-project exclusions do. Generation acquisition still checks the actual snapshot's exclusions. Grants are stable per generation during an exchange. Newly stale optional evidence is omitted before first unprepared dispatch; frozen prepared/recovery instructions fail closed for reconciliation. Existing invalid grants are not silently relaxed or rewritten.

Regression evidence: installed-Graphify branch, preparation and final-QA fixtures use different root and nested ignore files; each publishes and reaches the provider. Retained transformed evidence survives snapshot cleanup, then becomes unavailable after worktree or project exclusion changes. A new source-only conversation can proceed when the optional graph is stale.

### A2 — Fixed (original severity: high): response-only paths still bypass graph-session enforcement

An initial `sendGraphTurn` registers provider-session access restrictions. Several later dispatches call `sendTurn` directly, outside `dispatchWithGraphAccess`:

| Path | Direct dispatch | Consequence |
| --- | --- | --- |
| Planner completion-marker correction | `packages/rafi/src/plan.ts:1022` | Reuses a graph-exposed conversation without checking its retained grants. |
| Ticket proposal correction | `packages/rafi/src/ticketPlan.ts:370` | Same issue after proposal validation fails. |
| Builder check-coverage collection | `packages/ai-foreman/src/qaBuilderCoverage.ts:35` | Can consume graph-exposed history and persist transformed coverage without an owning graph-provenance scope. |
| Remediation report correction | `packages/ai-foreman/src/qaFailureDelivery.ts:282` and `:349` | Initial remediation uses the graph wrapper; the later correction calls the direct dispatch path. |
| Foreman response-only send | `packages/ai-foreman/src/foreman.ts:450` | The explicit `!policy?.responseOnly` condition skips the wrapper for repair turns. |

Response-only permission prevents new tools; it does not erase prior graph content from provider history or remove restrictions on derived output. A policy/exclusion/source revocation between turns can therefore fail to prevent another provider call through these paths. Exact-byte protection of an earlier response does not protect newly transformed JSON automatically.

Required correction: use access enforcement on every applicable dispatch while keeping response-only calls exempt from graph requests, scans and maintenance. Keep journal writes and downstream transformations inside the appropriate provenance scope. Recheck internal continuity correction and successor-acceptance paths as part of the same dispatch inventory; a direct send inside an already-protected outer call is different from an independently invoked follow-up and needs an explicit reason.

Required tests: revoke access between actual initial and correction/coverage turns; assert zero later provider calls and no redisclosure from retained outputs. With access still valid, assert transformed coverage/report artifacts are protected and become unavailable after revocation. Cover both providers' host paths without requiring billed runs. Requirements 2, 21, 23 and 30; G3/G5/G7/G10; T21/T24/T33.

Resolution: Planner and ticket-proposal corrections use `sendRoleGraphTurn` with their response-only policy. Foreman no longer skips the graph wrapper for response-only calls. Builder coverage and remediation dispatch/journal handling enforce retained-session grants, with mutable owning scopes covering parsed coverage and report summaries. Planning, Foreman, continuity and handoff acceptance also retain provenance across downstream transformations. Internal continuity repairs and successor acceptance independently recheck access; nesting within an initial turn does not excuse another unchecked provider call. A recovered native session revealed during dispatch is checked before its result leaves the boundary. No response-only path initiates graph scanning/navigation.

Regression evidence: actual remediation delivery covers valid repair plus revocation, and verifies summary withholding. Actual Builder coverage for both providers stores valid parsed claims, withholds those artifacts after revocation and rejects later collection without another provider call. Role correction tests cover retained provenance, and the CLI planner workflow refuses a recovered session with revoked graph history. Durable QA report repair/recovery remains covered by A4.

The independently scheduled release-certification matrix is still larger than these regression tests; resolving A2 does not claim every export/platform/native-provider boundary is certified.

## Corrections made during this audit

### A3 — Fixed: failed graph exchanges lost earlier-turn usage

`graph/turn.ts` accumulated usage in its durable exchange record, but several error returns exposed only the last provider result. Provider failure, continuity failure, a repeated malformed request after terminal fallback, and conflicting request-ID reuse could therefore under-report the owning operation's cost/tokens/turns.

All returned terminal results now use the accumulated totals, retaining unknown usage when any contributing turn is unknown. Four regression cases check the two-turn totals on those failure paths. This correction concerns observed returned usage; it does not estimate the cost of a provider call that never returns.

### A4 — Fixed: durable QA correction bypassed retained-session grants

`qaReview.ts` now wraps the complete durable QA turn—including journal/artifact writes—in `dispatchWithGraphAccess`. Report repairs, recovery acknowledgements and other follow-ups inherit session restrictions without starting graph navigation or changing their existing response-only policies.

The new actual-review regression registers retained session provenance, completes one review response, revokes Graphify before report repair, and asserts that repair is rejected before a second provider call. This supplements the existing helper-level revocation test with a production caller.

## Other reviewed boundaries

| Boundary | Evidence and conclusion |
| --- | --- |
| Preparation phase ownership | Shared gate reserves the owning operation; planner/investigation/assessment/challenge use distinct purposes and preserve independent provider conversations. Repair remains response-only. |
| Preparation receipts | Host replaces candidate-authored receipt IDs. Source references still undergo path/digest verification; graph refs are optional navigation provenance. |
| Deadlines | Preparation checks remaining time around setup and prevents post-timeout continuation dispatch. Semantic worker creation has late-worker teardown. Native subprocess failure/teardown certification remains open. |
| Graph-only contract churn | Authoritative input comparison excludes graph generation identity. Graph navigation alone does not authorize a contract amendment or reduced requirement inventory. |
| Retained preparation data | Store reads enforce grants and inherit them into mutable owning scopes. Empty scopes do not register restrictions. Status/events/metrics withhold revoked data. A2 adds owning scopes at the identified follow-up boundaries; the broader export/log certification inventory remains open. |
| Transfer | Staged-copy normalization includes preparation artifacts/contracts/events and preserves original digest references as unavailable. Existing tests inspect staged SQLite bytes. Full out-of-band export and uninstall certification remain open. |
| Recovery | Graph exchange recovery binds pending prompt, instruction/context and provider session and refuses blind replay. A valid same-root recovery fixture is not coverage of every native provider transition or worktree condition. |
| Performance/evaluation | Cold fixture measurements and an offline evaluation harness exist. Warm-worker performance, cross-platform limits, complete crash-boundary coverage and live quality/cost comparisons remain unproven or explicitly deferred. |

## Original audit validation

The combined graph/preparation/QA regression run passed **125 tests, zero failures and zero skips**, including the five new regression cases. It covered `graph.test.ts`, `graphGaps.test.ts`, `graphPreparation.test.ts`, `qaPrebuildCallers.test.ts`, `qaPreparationIntegration.test.ts` and `qaRecovery.test.ts`. Foreman typecheck and production build passed, as did `git diff --check`. No full-repository or full-CLI rerun is claimed by this audit. These original passing tests did not cover A1/A2; follow-up regression evidence is described above.

The worktree reproduction used installed Graphify 0.9.82 in temporary directories and no provider service. Its result was `generation=published`, `calls=0`, followed by the access error quoted in A1. No repository graph generation or manifest was replaced.

Local run records: `/private/tmp/rafi-graph-audit-regressions.log`, `/private/tmp/rafi-graph-audit-suite.log`, `/private/tmp/rafi-graph-audit-types.log`. The standalone reproduction is `/private/tmp/rafi-graph-worktree-audit.mts`; these temporary files are supporting local evidence, not packaged deliverables.


## Follow-up fix validation

The broader graph/preparation/QA/recovery run completed with **262 tests passed, zero failures/skips**. It covered the original six audit suites plus `graphAccessBoundaries.test.ts`, `qaFailureDelivery.test.ts`, `qaHandbackSafety.test.ts`, `qaHandbackInvestigation.test.ts` and `qaGuidanceDelivery.test.ts`. Final refinements made during that long run were then checked by the focused runs below; the aggregate run is not represented as a second full repository test run. Local log: `/private/tmp/rafi-gap-suite.log`.

The final access-focused run passed **51 tests, zero failures/skips** across `graph.test.ts`, `graphGaps.test.ts`, `graphAccessBoundaries.test.ts` and `qaFailureDelivery.test.ts`. CLI planning, proposal and structured-plan checks passed **32 tests, zero failures/skips**. These include real installed Graphify extraction for branch/snapshot cases and controlled provider fixtures; no billed model runs occurred. Handoff, session-location and unified-continuity checks passed **56 tests, zero failures/skips**. A final remediation run passed **5 tests**, including inherited QA-report provenance after the last refinement. These suites overlap. Foreman and CLI production builds/typechecks passed, and spec production build passed.

New regression cases cover branch-specific ignores, preparation/final-QA snapshot disposal, independent project/worktree revocation, source fallback for stale optional graphs, role correction history, actual Builder coverage for both providers, transformed coverage withholding, actual remediation repair/revocation and withheld summary evidence, and recovered planner-session access.

Graph maintenance was one partial AST refresh of the 18 touched code/test files. Mixed semantic coverage and directionality were preserved; verification found no dangling endpoints, with 51 self-loops remaining (53 before). The semantic tier and unrelated changed inputs remain explicitly stale. The final small remediation inheritance refinement and its test landed after that one allowed batch and remain unstamped for the next refresh. See the implementation status for scope. Local records: `/private/tmp/rafi-gap-final-access-suite.log`, `/private/tmp/rafi-gap-cli-suite.log`, `/private/tmp/rafi-gap-graph-verification.json`.
