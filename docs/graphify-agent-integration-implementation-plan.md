# Graphify integration across Rafi agents: implementation plan

This is the execution handoff for the building agent implementing [Graphify integration requirements](graphify-agent-integration-requirements.md). Those 35 requirements remain authoritative. This plan supplies the design, dispatch inventory, implementation order, acceptance tests, and release gates. Implement the complete supported workflow; adding Graphify to role prompts does not complete the integration.

Coordinate immediately with [QA preparation requirements](qa-prebuild-requirements.md) and the [QA preparation implementation plan](qa-prebuild-implementation-plan.md). Preparation is being built concurrently. Its contract, planner-owned depth, delivery, amendment, and recovery mechanisms own verification authority. Graphify contributes evidence to those mechanisms.

This document is planning output, not a report of implemented behavior. Existing filenames and symbols below were inspected while preparing it; proposed modules, protocols, commands, limits, and tables are implementation decisions. Recheck the current tree before editing, preserve unrelated work, and adapt names to the preparation implementation that actually lands. Do not install or refresh Graphify merely to read this plan. Follow the repository's selective Graphify instructions during implementation.

The requirements/code audit and corrections are recorded in section 16. The plan now has 25 dispatch rows (including one explicitly proposed extraction dispatcher), 13 work packages and 35 behavioral validation cases. These counts describe planned coverage, not passing implementation tests.

## 1. Starting points and decisions

### 1.1 Verified baseline

The runtime has seven named roles: Planner, Builder, QA, Manager, Discovery, Ticket-maker, and Uninstaller. QA preparation/challenge are execution purposes of the QA role in the concurrent preparation plan; do not introduce another configurable role solely for Graphify.

General execution goes through `createRoleBuilder` and `runRoleInstruction` in [agentRun.ts](../packages/ai-foreman/src/agentRun.ts). Build execution also constructs adapters directly in [start.ts](../packages/ai-foreman/src/cli/start.ts), including separate initial, settings-switch, QA, and successor factories. Several callers invoke `sendTurn` directly, bypassing `Foreman.doTurnWith`. Integration only in a role manifest or one factory will miss real work.

[qaSnapshot.ts](../packages/ai-foreman/src/qaSnapshot.ts) freezes product source and creates a disposable review checkout. Ignored root graph/configuration files do not automatically follow that checkout or ticket worktrees. The existing `resolveQaRuntimeMetadata` resolves QA bundles from the QA cwd; the preparation plan already owns fixing effective project configuration delivery. Integrate with that fix rather than implementing a competing one.

[managerEvidence.ts](../packages/ai-foreman/src/managerEvidence.ts) and [Manager CLI](../packages/ai-foreman/src/cli/manager.ts) already implement host-validated bounded evidence requests. Manager is deliberately constructed with denied direct tools. Its graph requests must remain within that boundary.

The locally inspected distribution is `graphifyy==0.9.82`, Python >=3.10, with schema-versioned graph output. Its `cli.py` query/explain/path handlers attempt query-timestamp writes and can log queries. `serve.py` exposes useful traversal helpers, but the full server includes more capabilities and logging than this integration needs. `detect_incremental` can write detection caches. These are reasons for a narrow, tested adapter, not assumptions that every upstream command is a pure read. The [official project](https://github.com/Graphify-Labs/graphify) describes local AST extraction, assistant-backed semantic extraction, and persisted graph schema/package metadata; upstream's moving branch is not the supported-version contract.

No production integration code, fresh graph, provider experiment, or performance benchmark was created for this plan. The earlier graph investigation remains navigation evidence only. The source and dispatch paths were rechecked; preparation modules named in its plan are still proposed at this inspection point.

### 1.2 Adopt these implementation decisions

| Decision | Chosen design and reason |
|---|---|
| Runtime ownership | Shared services in `ai-foreman`; public data contracts in `rafi-spec`; setup/compiler/UI in `@rafi-ai/cli`; concise role/skill content in `special-agents`. Direct `ai-foreman` remains supported. |
| Read access | Host-mediated structured requests and evidence packets. Reuse Graphify traversal behind a packaged Python bridge. Do not expose upstream's entire MCP server or allow arbitrary Python to read-only agents. |
| Provider transport | Use explicit, journaled host evidence exchanges over the existing `sendTurn` interface for both providers. Do not require unverified provider dynamic-tool APIs for the first release. Manager retains its own versioned evidence envelope. |
| Maintenance | Explicit adoption authorizes a scoped, selective coordinator. Immutable generations, per-scope publication ownership, bounded foreground work, no hooks/watchers/daemon. |
| Source authority | Map graph inputs onto existing workspace, frozen QA source, registered-source, and contract identities. A graph digest never replaces those authorities. |
| Query failure | Honest status plus source inspection. Graph unavailability alone does not fail a build or waive a mandatory verification obligation. |
| Dependency baseline | Initially certify exactly `graphifyy==0.9.82` and graph schema 1, subject to the G1 compatibility/security checks below. Broaden only through tested adapter fixtures; do not silently accept arbitrary newer versions. |
| Semantic work | Use the already authorized host/provider mechanism in a separately recorded extraction operation. Never select an external backend from ambient API keys. Preserve mixed coverage. |
| Generated artifacts | Rafi-owned generations under ignored `graphify-out/rafi/`; preserve an existing user's `graphify-out/graph.json` and related upstream artifacts. |
| Native sessions | Package selective instructions and a bounded read CLI. Without a Rafi orchestration host, guidance is instructional and access depends on the native harness's existing permissions. Do not claim automatic receipts or maintenance enforcement. |

**Confirmed setup policy:** Graphify is enabled by default when the user accepts new-project setup. Show it in the setup summary, with a visible opt-out. Setup acceptance authorizes reuse or necessary isolated Graphify installation, the disclosed initial corpus/mode, the first graph, and subsequent selective maintenance; do not ask for a second Graphify confirmation. Existing Rafi projects require explicit adoption. The current `rafi create` command uses `--defaults`, not `--yes`: document `create --defaults` as accepting the disclosed new-project defaults, with `--graph=off` or the corresponding configuration opt-out. A generic `--yes` on unrelated commands never adopts Graphify. Oversized or otherwise unresolved corpus choices still need a concrete scope decision and cannot silently widen the grant.

### 1.3 Alternatives deliberately deferred

Do not build a second graph engine in TypeScript, expose a general MCP/network surface, inject a full maintenance manual into every turn, or share one mutable root graph among branches. A provider-native read tool may replace the evidence exchange later if both providers demonstrate equivalent confinement, request journaling, continuity, and bounded results. Keep the public graph service independent of that transport so this is an additive change.

## 2. Dispatch inventory and coverage contract

Each row below is a required integration/acceptance path. Register an explicit `purpose` at the caller; role name alone is insufficient. Test both Claude and Codex wherever the caller supports them, plus mixed-provider transitions. Existing permissions remain authoritative.

Profiles used in the table:

- **P:** project configuration root and project source workspace; role's existing permissions; host evidence exchange.
- **W:** configuration from the authoritative project, source from the actual current-branch/ticket/shared/stacked workspace; Builder's existing permissions; host evidence exchange.
- **Q:** effective configuration frozen from its owning project; source bound to preparation baseline or final QA snapshot; read-only role and isolated scratch; host evidence exchange.
- **M:** project/run/work scope resolved by Manager's evidence service; no direct agent tools; versioned Manager evidence exchange.
- **N:** compiled/native instructions and scoped CLI outside an orchestration host; native harness permissions; explicit limitations.

For every row, record configuration root, source root/identity, provider/session, effective policy, prompt digest, graph capability, and receipt or fallback in integration tests. The actual adoption/trigger gate still decides whether a query is warranted.

| ID | Caller and purpose | Profile and evidence seeds | Continuity and behavioral assertion |
|---|---|---|---|
| D01 | `rafi/src/plan.ts`: `runPlanWorkflow`, `runPlannerTurn`, `buildPlanAgentRunOptions`; initial/after-create planning | P; current approved sources, feature concepts, known modules; architectural relationships and tests | Initial, standard/exhaustive, resumed/lost interview and accepted user answers receive correctly scoped evidence without changing plan authority. |
| D02 | `rafi/src/ticketPlan.ts`: `runTicketPlan` and its direct turn loop | P; selected feature/milestone/backlog and source reconciliation | Revisions, drift refresh and audit-answer continuations use current context; proposal-format repairs do not open new graph investigations. |
| D03 | `rafi/src/grillAudit.ts`: `runIndependentGrillAudit` | P, read-only; candidate assumptions and referenced interfaces | Independent auditor gets raw evidence without inheriting Planner conclusions as verified facts. |
| D04 | `rafi/src/planningDriver.ts` source intake, feeding D01/D02 | P; registry source IDs and captured versions | Source acquisition stays in the source registry; graph reads cannot refetch URLs or change source-intake envelopes. |
| D05 | `ai-foreman/src/cli/start.ts`: `durableReadOnlyProposal`/`runRoleInstruction` for QA nonconvergence | P, read-only Planner; recurring findings and relevant source | Graph investigation remains a proposal; no direct work admission or ticket dependency creation. |
| D06 | Concurrent `qaPreparation.ts` or landed equivalent: investigation and semantic contract assessment | Q; complete requirement inventory, baseline, depth obligations | All five depths retain full requirements; unavailable graph cannot lower depth or certify no missing obligation. |
| D07 | Concurrent preparation approach/challenge dispatch, including Exceptional fresh assessor | Q; approach, uncertainties, affected boundaries, raw source | Separate authorship/conversation; optional Builder approach stays planning-only; no duplicate challenge. |
| D08 | `ai-foreman/src/foreman.ts`: `runPreflight`, preflight feedback; start approval flow | W; admitted/selected batch and architectural implications | This is Builder planning, not QA preparation or implementation authorization. |
| D09 | `cli/start.ts`: `auditBuilder.sendTurn(buildBranchAuditInstruction(...))`; `branch/planner.ts` | W; selected ticket slices and source relationships | Suggestions require implementation dependency rationale and existing DAG validation; imports alone never order tickets. |
| D10 | `foreman.ts`: `runBatch`, `doTurnWith`, `runInstruction`; `buildAssignment.ts` | W; frozen work, contract if present, affected code/tests | Initial and subsequent current-branch steps, task-file and synthetic work get fresh task context; QA-disabled work is included. |
| D11 | `branch/runner.ts` instruction/resume helpers and `foreman.runInstruction`; `branch/git.ts` | W; actual ticket/shared/stacked workspace | No root-graph substitution; worktree reuse, rebase, merge, kept worktree and cleanup invalidate/rebind as appropriate. |
| D12 | `foreman.ts`; `qaFailureDelivery.ts` `dispatch`/`turnIntent`; `builderGuidanceFollowup.ts` `deliverBuilderGuidanceFollowup`; `buildInterventions.ts`, branch remediation/guidance | W; exact findings, contract checks and authorized Manager guidance | Test ordinary remediation, source-bound failure delivery and direct guidance follow-up separately. Each has its own journal/assignment path; graph subturns consume no new remediation allowance or response-repair slot. |
| D13 | `qaReview.ts`: `oneReview`/`sendDurableQaTurn`; `qaRuntime.ts`, `qaSnapshot.ts` | Q; exact frozen review source, changed paths, applicable contract | First/remediation/fresh review gets matching-current graph or explicitly historical/unavailable navigation plus direct snapshot inspection. |
| D14 | `cli/start.ts`, `qaRecovery.ts`, `qaReview.ts`, `foreman.ts`, branch `qaOnlyRecovery` | Q; bound review basis and retained evidence | Exact QA-only resume, report repair and interrupted finalization never run Builder/preparation or rebuild merely to finalize. |
| D15 | `rafi/src/buildResume.ts`: `collectGuidedCheckpoint` recovery turn loop | Existing selected Builder or read-only QA role; source resolved from recovery authority | Guided troubleshooting cannot confuse project root with retained worktree/snapshot or bypass an exact-recovery boundary. |
| D16 | `cli/manager.ts`, `managerPacket.ts`, `managerEvidence.ts` | M; user question, allowed run/work/source and graph evidence receipts | Historical/current claims distinguished; V1/V2 compatibility retained; model output never authorizes controls. |
| D17 | `rafi/src/createStackInterview.ts` -> `discovery.ts`: `runDiscovery`, `buildDiscoveryRunOptions` | P, read-only even before complete setup; local architecture | Existing compatible graph may be read when authorized; absent graph/config falls back without initialization. |
| D18 | `discovery.ts` continuation and retained-artifact investigation | P; retained history plus current architecture | Runtime history remains direct/host evidence, not inferred graph execution facts. |
| D19 | `cli/tickets.ts`: `buildPopulateAgentRunOptions`/population through Foreman; `ticketPopulation.ts`, `ticketPlanning.ts` | P; approved slices and captured source refs | Preserve approved-plan slice IDs and depth decisions; external-import mode stays distinct. |
| D20 | `rafi/src/uninstall.ts`: `interpretUninstallInstruction` | P, read-only; only explicit dependency/usage questions | Ownership inventory/ordinary cleanup is inapplicable; empty graph does not authorize deletion. |
| D21 | `special-agents/src/compile.ts`, `rafi/src/compiler.ts`, role YAML/Markdown | N or hosted profile; all seven roles, bundled fallback, native Claude/Codex, root/sidecar instructions | Custom artifacts/aliases preserved; actual provider content supplied; no reliance on global machine skill. |
| D22 | Packaged skills `implementor`, `improve-codebase-architecture`, `grill-me`, `write-a-prd`, `prd-to-issues`, `tdd`, `handoff` | N or hosted profile; selective cross-file implementation/review/decomposition | Avoid duplicate packets in hosted use; routine TDD commands/handoff bookkeeping do not trigger graph work or extra agents. |
| D23 | `agentRun.ts`; `start.ts` `createRawBuilder`, `createBuilderForSettings`, `createBuilder`, `createRawQa`, `createQaForSettings` and QA wrappers; `continuity.ts`, `handoffs.ts`, recovering adapters | Same profile as the active purpose, re-resolved for actual successor | Exact/fresh resume, compaction, provider/model switch and live settings retain/revalidate scope and evidence; no remembered skill assumption. |
| D24 | `sessionAvailability.ts`, provider readiness/identity probes; response-only/continuity handshakes; Claude `/context`, `/compact`, `/model`; compiler instruction-update calls; routine `better-sqlite3-rebuild` skill | Explicitly inapplicable | These adapter constructions and turns must not query, scan, build, or request semantic work. |
| D25 | Proposed `graph/semantic.ts` extraction dispatch; no current production caller | Host-owned maintenance operation, captured input packets, selected authorized provider/model, existing role with explicit extraction purpose | Packet-only extraction, no product tools or recursive graph requests; separate journal/session from preparation/final review. Native use requires a supported host extraction exchange or explicit unavailable result. |

G0 must search all production `sendTurn`, `createRoleBuilder`, `runRoleInstruction`, `ClaudeAdapter.create`, and `new CodexAdapter` callers again. Add any newly landed preparation callers to this table and its tests. An allowlisted non-consumer needs a reason; a factory being reachable is not proof that all its purposes are covered.

## 3. Shared services and package boundaries

Proposed files below are new unless an equivalent exists by implementation time. Prefer small services over more logic inside `cli/start.ts`.

| Proposed component | Responsibility |
|---|---|
| `spec/src/graph.ts` plus exports/schemas/validators | Versioned config, requests/results, generation metadata, evidence refs, receipt and maintenance types; strict discriminated validation. |
| `ai-foreman/src/graph/config.ts` | Effective adoption/configuration and per-run restrictions; separate machine-local resolver. |
| `graph/policy.ts` | Purpose registry, selective trigger decisions, evidence budgets and logical task IDs; no filesystem scan to classify routine work. |
| `graph/scope.ts` | Host-authorized project/workspace/review/source handles; identity mapping and path confinement. |
| `graph/corpus.ts` | Eligible code/docs/config plus explicit registered-source snapshots, exclusions, source inventory and projection mapping. |
| `graph/bridge.ts` and packaged `graph/bridge.py` asset | Bounded subprocess protocol, installed-capability checks, version-specific Graphify traversal/extraction adapter. |
| `graph/read.ts` | Pure read operations, pinned generation handles, source/provenance normalization, access filtering, response limits. |
| `graph/store.ts` | Immutable generation metadata and references; workflow DB migrations for receipts, maintenance ownership and retained evidence links. |
| `graph/maintenance.ts` | Authorized initial build/update, task deduplication, leases/fencing, staging, validation and publication. |
| `graph/semantic.ts` | Authorized host semantic dispatch, bounded capture, output validation and generator provenance; separate from graph reads. |
| `graph/context.ts`, `graph/turn.ts` | Purpose-aware initial packets and explicit journaled follow-up exchange; injectable provider-send and phase callbacks. |
| `graph/diagnostics.ts`, `graph/lifecycle.ts` | Cheap status, failure/cost evidence, transfer, retention, revocation and cleanup. |
| `ai-foreman/src/cli/graph.ts` | Read/status and explicit adopt/refresh/configuration command service, exported for Rafi forwarding. |
| `special-agents/content/skills/rafi-graph/SKILL.md` and concise role additions | Selective read guidance, limitations and native invocation; maintenance reference loaded only for authorized operations. |

The Python asset must be shipped in the published `ai-foreman` package, copied by its build, resolved relative to `import.meta.url`, and tested from a packed installation. Invoke an executable with an argv array, never generated shell code. Never mutate the user's upstream installation to patch side effects. Disable bytecode/query logging and use in-memory traversal; audit import-time behavior and external filesystem writes. Extraction runs in a separate write-capable staging process.

The bridge should reuse upstream scoring/traversal/path algorithms, adapting their structured node/edge data before upstream text rendering. Do not parse human-readable CLI prose as authoritative structured evidence. Pin private API calls inside this adapter and test direction (`_src`/`_tgt` where applicable), multi-edges, ambiguity, unresolved targets and future schema rejection. Small normalization/bounding code is expected; duplicating upstream extraction/ranking is not.

## 4. Data model and persistence

Use repository canonical JSON/digest conventions with an explicit domain/version prefix. The following are minimum semantic fields, not complete TypeScript declarations to paste without validators.

```ts
type GraphPurpose =
  | "planning" | "planning-audit" | "source-reconciliation"
  | "qa-preparation" | "preparation-assessment" | "preparation-challenge"
  | "build-preflight" | "branch-dependency-audit" | "implementation"
  | "remediation" | "manager-guidance" | "final-qa" | "qa-recovery"
  | "guided-recovery" | "manager-diagnosis" | "discovery"
  | "ticket-population" | "uninstall-analysis" | "native-investigation";

interface GraphUseContextV1 {
  version: 1;
  operationId: string;
  logicalTaskId: string;
  purpose: GraphPurpose;
  projectRef: string;
  workspaceRef: string;
  sourceRef: string;             // existing source authority, or explicit unknown
  configRef: string;
  runId?: string;
  workId?: string;
  contractRef?: { id: string; revision: number; digest: string };
  reviewBasisRef?: string;
  providerSessionRef?: string;
  policyDigest: string;
  hostWritesAllowed: boolean;
}

type GraphUseDecision = "disabled" | "inapplicable" | "available"
  | "used" | "unavailable" | "degraded";
type GraphResultStatus = "ok" | "no-match" | "ambiguous" | "partial"
  | "empty-corpus" | "unavailable" | "invalid-request";
type GraphFreshness = "matching" | "stale" | "historical" | "unknown";

interface GraphEvidenceRefV1 {
  version: 1;
  evidenceId: string;
  generationId: string;
  graphInputDigest: string;
  corpusDigest: string;
  sourceBindingRef: string;     // validated consumer binding; preserve generation origin
  sourceRef: string;
  operationDigest: string;
  resultDigest: string;
  policyDigest: string;
  freshness: GraphFreshness;
  sourceLocations: GraphSourceLocationV1[];
  requirementRefs: string[];
  checkRefs: string[];
  limitations: GraphLimitationV1[];
}
```

Define and validate these companion records:

| Record | Required fields/semantics |
|---|---|
| `GraphConfigV1` | enabled/adoption state; corpus include/exclude policy and approved-source selection; extraction mode; selective/manual maintenance; budgets/retention; policy/schema version. No committed machine paths or secrets. |
| `GraphAdoptionV1` | Project, approved corpus/policy digest, authorization source/time, initial-build and maintenance grants, extraction/backend choice, ownership of created artifacts. Bind explicit policy changes; ordinary authorized maintenance reuses this grant. |
| `GraphInputIdentityV1` | Existing source authority + workspace incarnation; sorted eligible file paths/content hashes; captured requirement IDs/versions/digests; scope/exclusion digest; parser, Graphify, bridge and semantic-policy versions; extraction mode. HEAD alone is insufficient. |
| `GraphCorpusDigestV1` | Portable extraction-input digest: normalized eligible paths, kinds/modes/content hashes, captured source versions, coverage/exclusion and extraction-policy versions. Excludes machine paths, run/session IDs and workspace incarnation. Used for candidate reuse, never sufficient authorization by itself. |
| `GraphSourceBindingV1` | Current host-validated project/workspace incarnation/source authority mapped to a corpus digest and immutable generation. Full input identity combines this binding with the corpus digest. Rebinding identical bytes to a new QA snapshot requires validation; it never rewrites the generation's original provenance. |
| `GraphGenerationV1` | Immutable ID; graph input identity; actual graph/output hashes; per-input successful extraction fingerprints; parent generation; counts, coverage, package/schema metadata; generator provenance; creation operation. Generation ID binds output bytes, not only inputs. |
| `GraphSourceLocationV1` | Authorized source ID or workspace-relative path, captured version/content fingerprint, optional symbol and line range, relation confidence and origin. Node IDs are generation-local hints. |
| `GraphLimitationV1` | Typed reason, affected inputs/operations, relevance, retryability and next action. Include unsupported parser, semantic failure, exclusion, unresolved cross-package reference, truncation and missing provenance. Distinct reasons for missing graph, corrupt graph, incompatible schema, missing manifest, partial extraction, stale input and failed freshness check; never collapse these into no-match. |
| `GraphReadRequestV1` | Version, request ID, operation, bounded query/seed IDs/path/direction/depth, opaque context handle and optional generation-bound cursor. No arbitrary filesystem roots/URLs/backend options. |
| `GraphReadResultV1` | Request/context binding; actual generation/input/source identity; status and freshness separately; structured nodes/edges/source refs; coverage limitations; truncation/cursor; result digest and measured duration. No-match must not erase stale/partial coverage. |
| `GraphDeliveryReceiptV1` | Logical operation, actual session/workspace/config identity, phase and contract/review association; classification, delivered packet digest, result statuses, time and fallback. Distinguish supplied evidence, requested evidence and any agent acknowledgment; none proves understanding. |
| `GraphMaintenanceV1` | Task key/scope, intended inputs, reason/authorization, state, lease owner/fence, stage/output generation, errors, duration/usage, cancellation and publication acknowledgment. |
| `GraphExchangeV1` | Parent assignment/review/investigation ID, unique subturn/request IDs and payload digests, captured result references, continuation intent/receipt, actual session, remaining cumulative budget and pending/uncertain state. Separate final business-verdict receipt from evidence-only receipts. |

Operations are `status`, `query`, `node`, `neighbors`, `path`, and `impact`. `impact` means candidate affected source obtained from bounded graph traversal, not a completeness or runtime reachability proof. Incoming/outgoing/both directions are explicit; ambiguous endpoints return candidates rather than silently choosing one. A no-path result reports the covered graph and limitations.

Preserve upstream relationship evidence classes `EXTRACTED`, `INFERRED` and `AMBIGUOUS` as validated structured fields, separately from confidence scores, query-label ambiguity and result status. Missing/unknown provenance is explicit, never defaulted to `EXTRACTED`. Neither an extracted label nor a confidence score proves runtime reachability, truth or requirement satisfaction. Preserve generator and source attribution through normalization, semantic cache reuse and packet truncation.

Persist generation references, compact evidence blobs, delivery receipts and maintenance jobs using existing workflow DB/evidence facilities. Add versioned migrations and existing lease/CAS conventions. Large graph files remain rebuildable local artifacts. Do not create a competing run/contract database. Extend `workflowReader.ts` for noncreating metadata reads; missing graph tables in a supported legacy DB mean unavailable, while an unsupported DB schema is a distinct diagnostic. Read-only `status`/query must not construct `WorkflowDb` to initialize/migrate a project. Verify SQLite WAL/SHM behavior in the supported read path, including a concurrently open writer; if a platform cannot provide it without writes, return a limitation rather than claiming a pure read.

Keep graph data immutable. Reader/review retention references and publication pointers are mutable control records outside generation content digests. Contract provenance is optional and immutable for the contract revision; mutable phase receipts live separately. Graph-only publication does not rewrite a contract to point to the latest generation.

Proposed cache layout:

```text
graphify-out/
  graph.json, manifest.json, ...       # existing upstream/user artifacts, preserved
  rafi/
    generations/<generation-id>/      # graph, manifests, coverage, required reports
    staging/<operation-id>/           # unpublished, recoverable or discardable
    scopes/<opaque-scope-id>/          # local references; no model-selected paths
```

Use a project-owned cache with separate scope identities for root/worktrees/snapshots and content-addressed immutable reuse. Do not require graphs in Git worktrees or copy graphs into QA's source clone. A DB generation head is the authoritative Rafi publication pointer. Optional native projection pointers are derived and repairable; do not claim two different storage systems commit atomically. When importing an existing graph, validate and copy/reference it as an explicitly adopted immutable generation without stamping unknown inputs current.

## 5. Agent interaction, relevance, and permissions

### 5.1 Initial context and follow-up requests

Implement a common host turn service accepting `GraphUseContextV1`, the actual provider adapter, the owning phase's dispatch/journal callbacks, and its normal response parser. Register purpose at the caller and share context construction across factories. Do not put hidden provider turns in the Python bridge or a low-level adapter wrapper.

The exchange is:

1. Resolve explicit user restrictions, adoption, source scope and capability without scanning. A disabled integration or routine purpose returns immediately. An explicit scoped read authorization can permit inspection of an existing unadopted graph without granting installation, extraction or maintenance; keep this distinct from adopted runtime use. Preserve no graph output/no graph work for ordinary queue, status, test/build/lint, formatting, instruction-update and handshake paths.
2. For a qualifying purpose, identify relevant seeds from available work/requirements, changed-path inventory and inspected source references. Supply a bounded initial packet with graph evidence or a concrete unavailable/degraded result. Do not run an empty generic query just to record use.
3. Known architecture/cross-component purposes qualify from structured task context. Narrow implementation is conditional: use explicit scope/risk/files already known; when uncertain, include the short request capability and permit the agent to identify the new investigation. An agent's request supplies its purpose and seeds; the host checks scope/limits. Do not run an extra classification model or repository scan for every turn. Record initially inapplicable versus subsequently qualified decisions.
4. Permit the **business response after validated continuity framing** to be one strict JSON object with `kind: "rafi_graph_request"`, `version: 1`, request ID and bounded operations. It may not also contain a plan, verdict, `STEP_STATUS`, source-intake response or completion claims. Hosted Builder/QA still emit their required single-line `RAFI_CONTINUITY_DELTA` outside that JSON; existing wrappers validate and remove it. Use the validated cleaned response for graph parsing, preserve raw bytes in the journal, and reject invalid/multiple continuity records under the owning protocol. Callers without continuity wrapping require the entire final response to be the object. Do not substring-extract requests from prose, source or tool events, and do not send a valid graph request into marker repair because its business payload has no `STEP_STATUS`.
5. Execute approved read operations, record authorized host telemetry, and provide a clearly delimited data packet to the same effective phase/session. The continuation states the original frozen work, applicable contract, remaining budget, and that the packet grants no extra authority. It asks the agent to continue without replaying completed side effects.
6. Repeat only within the frozen exchange budget, then process the phase's ordinary final response once. On query failure or exhausted budget, deliver a terminal limitation and require ordinary source inspection or the phase's existing incomplete/block outcome. No query is a pass, work completion, contract acknowledgment or remediation attempt.

Extend the owning phase's accepted intermediate response union explicitly. In `Foreman.doTurnWith`, the assignment remains one admitted logical action across evidence subturns: do not call `finishBuildAssignment` on a graph request, create a new work assignment for each answer, or let an evidence envelope enter missing-`STEP_STATUS` repair. Preserve its admission/lease checks before every continued implementation dispatch. Raw events/subturn usage stay visible and durable even though only the final business response reaches its parser.

Do not substitute ticket ID for the graph logical task ID: current Foreman turn policy can use a ticket ID across multiple assignments. Use the admitted assignment/operation ID plus purpose (or a persisted investigation ID for non-assignment work), shared by all graph subturns and distinct for a later remediation/guidance assignment. Repeated request IDs must return the same captured result or a conflict for changed payload, never silently consume another round. Durable exchange state distinguishes request received, read completed, continuation intended and continuation completed; a crash after model dispatch remains uncertain until existing recovery resolves it.

Implement D12 at **both additional direct dispatchers**. `deliverBuilderGuidanceFollowup` currently begins and finishes an assignment around one send; keep that assignment open through the exchange. `QaFailureDeliveryService` has a different protocol: `QaDeliveryTurnV3.kind` is only remediation/response-repair, `turnIndex > 0` implies response-only, and each dispatch validates one correlated terminal event and captures post-source state. Add a versioned compatible journal extension with explicit business/evidence-continuation/response-repair kinds and unique per-subturn sequence; stop deriving permissions from a nonzero index. Reserve one remediation allowance for the parent operation, preserve `handback: true` and source/session/admission checks on every dispatch, and validate each provider terminal against that subturn's event slice. Persist and validate intermediate continuity before continuing; do not publish it as remediation completion. Only the final business result enters the remediation report parser. The existing single response-repair allowance applies only to a malformed final report and remains tool-free. Migrate readers/recovery/Manager evidence for this journal version together; never reinterpret legacy V3 rows as graph turns.

For final QA, integrate inside its journaled dispatch path and retained review attempt. Graph request and evidence response are review operations, not a second review or an unjournaled assistant turn. Validate source/confinement and session continuity at existing boundaries. Honor compaction/handoff ordering: restore contract and graph context to the actual successor, then continue the pending action. Never replay a potentially dispatched implementation turn after a graph transport error.

Response-only report repair, marker repair, contract-acceptance handshakes, handoff acceptance and recovery validation do not accept graph requests. Return their existing protocol failure/repair behavior without tools, extraction, or permission changes. Exact interrupted finalization does not dispatch a model simply to establish a graph receipt.

Reserve context for mandatory instructions/contracts, the final business response and continuity before admitting optional evidence. Trim or omit graph packets first if the provider/owning phase's available context is smaller than graph limits; return an explicit limitation. Never truncate mandatory requirements to fit a graph packet. A requested graph continuation that reaches its limit receives one terminal limitation within the existing dispatch budget; do not reset budgets after compaction/recovery or recursively repair graph requests.

### 5.2 Capability and permission matrix

| Context | Graph access and effective restrictions |
|---|---|
| Hosted Planner, Discovery, Ticket-maker, Uninstaller | Host packets/exchange under existing role policy. No new general Bash/Python/write/network allowance. Different callers' existing permissions must be tested rather than inferred from role name. |
| Hosted Builder | Same read service, bound to current worktree and task. Existing product-write authority does not grant graph publication or third-party semantic-backend authority. |
| Hosted preparation/assessment/challenge/final QA | Host reads only. Exact effective role/skill content delivered through preparation's configuration mechanism; no entire `.rafi` copy. Source clone remains immutable; packet content can be injected directly or materialized only in already authorized scratch/control storage. |
| Manager | New tagged Manager graph evidence variant serviced by the host; existing tools stay denied. Operations contain scoped IDs, never a graph path or shell command. |
| Native Claude/Codex, project configured | `rafi graph query/node/path/... --json` delegates to the same read service. The harness may allow that narrow command or provide a packet; the skill does not silently broaden permissions. No arbitrary Python fallback. |
| Native session with no installed Rafi/compatible graph capability | Explain unavailable access and inspect source. Compiled instructions must not pretend an orchestration host is present. |
| User explicitly prohibits host writes | Pure graph reads/in-memory packets only; no receipt DB writes, query logs, cache stamps, detection caches, adoption, extraction or pruning. Record the limitation in the response, not by creating state. |

The pure read service must work without creating reader records on disk. It pins immutable contents/open handles in memory for each response; if publication/pruning wins before acquisition, retry opening the head once or return unavailable. Active hosted reviews acquire durable retention references outside the pure read operation under existing host-write authorization. Pruning honors those references. Native no-write readers retain loaded immutable data for the query; they do not receive a promise of indefinite historical retention.

### 5.3 Compiler and skill delivery

Add concise shared policy to each relevant role through `special-agents/src/compile.ts` and the role composition system. Package `rafi-graph` so both library-fallback and compiled roles can resolve it without a global install. Resolve aliases and runtime-specific skill paths through existing compiler ownership records. For confined QA, preload the exact allowlisted content and digest from the effective configuration resolver.

Root/native instructions identify selective triggers and read commands, refer to the longer maintenance instructions only when applicable, and state native limitations. Do not overwrite a user's general `graphify` skill. Add relevant references to the standalone skills listed in D22; `tdd` only qualifies when failures lead to substantial dependency investigation, and `handoff` carries graph references without refreshing on handoff itself.

Use a context delivery key (purpose, task, session generation, packet digest) to avoid duplicate injected evidence when a skill and host runtime are both active. Re-deliver after actual session/context loss; do not suppress needed context merely because an earlier session received it.

## 6. Configuration, setup and dependency management

Add optional versioned `graph` configuration to `ProjectConfig` in `rafi-spec`, validate/normalize it in `rafi/src/project.ts`, and read the same policy for direct Foreman. Missing legacy configuration means unadopted/disabled, never automatic installation. Persist machine executable/interpreter resolution only in local capability records.

Implement the shared loader in `ai-foreman` using the public `rafi-spec` validator, without importing the Rafi CLI package. Read `rafi-config.yaml` at the authoritative configuration root and handle legacy `project.yaml` explicitly; `foreman.yaml` alone is not an adoption grant. For a Foreman-only project, explicit `graph adopt` can write a documented versioned project-local graph policy/adoption record without manufacturing an entire Rafi project configuration. A canonical project disablement overrides that record. Specify and test this lookup order for direct CLI, Rafi forwarding and worktree/snapshot callers; do not discover another project's policy by walking upward from a review snapshot.

The accepted setup defaults are selective maintenance, local AST plus host semantic extraction for eligible documentation/approved requirement snapshots, the code/test/config/domain-document corpus described below, and section 9 limits. Code-only corpora need no semantic call. A deliberate code-only adoption remains possible with semantic-coverage limitations disclosed; adopting/updating an existing mixed graph must not silently change it to that mode. External semantic backends are outside the default grant. Existing stronger user exclusions remain effective. Show these choices in the setup summary and persist their versioned policy so acceptance is concrete.

Effective precedence is: explicit user restriction or disabled project policy; authorized per-run narrowing/disablement; adopted project corpus/mode/limits; machine capability. An explicit adoption/re-enable operation may change project policy. A run override may not widen corpus, enable an unadopted project or choose another backend without authorization. A model/provider switch, old resume record, global skill or ambient environment variable cannot override a current disablement or access revocation. Configuration defaults do not confer authorization.

Expose the following command family through both CLIs; names are selected for this plan and may be aligned with existing naming during G0 without changing semantics:

| Command | Behavior |
|---|---|
| `graph status [--json]` | Cheap read of policy/capability/last generation and pending jobs. Report last-checked/unknown; no corpus scan, install or DB migration. |
| `graph adopt` | Present/accept scope, exclusions, semantic mode, limits and maintenance policy; reuse compatible installation; explicit first build/import. Interactive setup delegates to this service. |
| `graph query/node/neighbors/path/impact` | Bounded, nonmutating operations with structured status; explicit graph inspection does not imply refresh. |
| `graph refresh` | Explicit scoped maintenance using existing authorization, or explain the needed adoption/scope decision. No automatic backend changes. |
| `graph disable` / `graph enable` | Change use policy deliberately. Disable does not delete caches; enable validates the existing adoption grant or requires adoption. |
| `graph prune` | Explicit or authorized maintenance-time retention cleanup of owned artifacts, with active/historical evidence protection and revocation handling. |

Noninteractive accepted new-project setup uses the disclosed default adoption policy unless opted out. Explicit adoption of an existing project requires graph intent (for example `graph adopt --yes`) and a complete policy. Merely discovering an existing project/configuration does not adopt it. If authorized setup cannot finish graph installation/build offline or lacks Python, preserve the project and recorded adoption, report `enabled-unavailable` with a concrete recovery action, and allow source-based work; do not repeatedly attempt installation in role sessions. An explicit `graph adopt`/`refresh` command returns nonzero when its requested operation fails. Noninteractive corpus overflow returns `scope-decision-required` for the graph operation, not a silent narrowing; setup reports that deferred capability clearly.

In `rafi/src/index.ts`, add the disclosed summary/acceptance checkpoint before Graphify installation or extraction; the current create flow goes from collected answers to configuration/compilation without that graph checkpoint. Persist the choice through `WalkthroughAnswers`, `interviews` create checkpoints and resume. Capture preexisting Rafi configuration/install state **before** create initializes its install manifest: an existing code repository receiving its first Rafi setup is new setup, while re-running create on an already configured Rafi project preserves its graph policy and needs explicit adoption if unadopted. `--force` does not change this. `create --defaults` prints its accepted policy; a non-TTY create without explicit defaults/complete answers must stop or report a pending setup choice instead of waiting on interactive prompts or treating EOF as consent. Resume after acceptance reuses the recorded grant and initial-build idempotency key.

Prefer a discovered compatible installation. If absent and installation is authorized, create a Rafi-owned isolated environment using supported platform tooling; do not modify system Python or upgrade a shared install. A missing Python prerequisite gets instructions, not a silent OS/package-manager install. Test macOS/Linux/Windows argv/path handling, including spaces and non-ASCII paths. Ship the compatibility probe with the bridge and cap its execution. A newer incompatible Graphify install remains untouched; an authorized Rafi-owned pinned environment is separate.

Fresh empty projects can complete adoption with an explicit empty-corpus state and no invented graph nodes. Their first meaningful content task can produce the initial graph under that recorded grant. Documentation-only projects require semantic coverage or an honest incomplete/unavailable outcome; structural parsing of a JSON plan is not equivalent to requirements extraction.

For this repository, preserve the existing machine-wide install and the [local guide](graphify-agent-guide.md)/[workflow](graphify-agent-workflow.md). Upstream hooks, watchers, install-to-all-assistants behavior and broad backend defaults are not inherited into product adoption.

## 7. Corpus, identity and transactional maintenance

### 7.1 Corpus and source identity

Build an explicit corpus inventory from approved code, tests, relevant configuration, architecture/domain docs and current planning inputs. Respect `.graphifyignore`, user exclusions and supported hidden configuration such as CI. Exclude dependencies, generated output, graph/cache files, runtime logs, tickets' bookkeeping and generated agent conclusions by default. Never index saved graph answers/reports as new independent support.

Read captured requirements via `sources/sourceRegistry.ts`. Project them to controlled extraction staging using synthetic source keys, with a mapping back to source ID, captured version, fingerprint, locator and original provenance. Do not broadly unignore `.rafi/`, fetch a source URL, or substitute a later source version. Distinguish approved source material, proposals and historical plans in nodes and responses. Include these captured versions in the graph input identity even when Git HEAD is unchanged.

For worktrees, use existing workspace/session identity plus an incarnation/source binding. Capture eligible content hashes including staged, unstaged, renamed, deleted and untracked files. Recreated path, branch name or matching HEAD alone never validates reuse. For QA, map corpus inventory to `FrozenQaSourceState`/review-basis authority and approved captured-source versions. Old absolute `source_file` paths must resolve through a validated relative/source-ID mapping to the actual workspace/snapshot; paths escaping the scope are rejected.

A compatible immutable base generation can be reused across workspaces when its complete **portable corpus digest** matches and the host validates a new source binding. Full input identities include workspace/source authority and therefore normally differ between a Builder and its disposable QA clone; do not compare those opaque identities for equality to decide byte reuse. Return both the generation's original provenance and the current binding/equivalence evidence. The QA binding must match its complete frozen eligible corpus and requirement snapshots; equivalent cited files alone are insufficient. There is no need to duplicate identical graph bytes. Unknown legacy identity means historical/unknown evidence until verified, not automatic currentness.

A matching label on a mutable Builder checkout is valid only as of its captured source observation. Relevant edits or source changes invalidate that status. Reuse a pinned captured inventory through a bounded investigation; do not scan for each node request. At an existing source-change boundary, mark the view stale or recapture once when justified. Exact QA currentness requires the frozen input match, not unchanged cited files or a graph built on the same commit.

### 7.2 Maintenance state machine and task boundaries

Use `pending -> capturing -> extracting -> validating -> staged -> published`, with `deferred`, `failed`, `cancelled` and `superseded` terminal/repairable outcomes as appropriate. Each job has a stable idempotency key `(scope, logicalTaskId, adoptedPolicyDigest)` and retained intended inputs. A retried completed job returns its result instead of extracting again.

| Execution mode | Logical editing boundary and publication owner |
|---|---|
| Current branch / ticket / synthetic / task file | One admitted implementation assignment or completed logical step that made meaningful indexed changes; host coordinator after the editing turn and before next consumer when feasible. |
| Branch/shared/stacked work | One completed work assignment in that workspace; retain scope-specific dirty/pending state between steps. Merge/rebase/delivery is a separate source transition if it changes graph inputs. |
| Remediation / authorized guidance | New remediation/guidance assignment with meaningful edits, not each tool call or evidence subturn. |
| Standalone native editing | An explicitly declared completed editing task under adopted policy; CLI coordinator uses the same lock/idempotency system. No turn-stop hook. |
| Read-only architecture investigation | At most one pre-query freshness check after qualification; extraction only if needed and authorized, and never under a user prohibition on host writes. No second end-of-investigation refresh. |
| Setup / first adopted content | Initial build under recorded adoption authorization, separate from incremental publication counting. |

Do not subdivide a task just to bypass the one-update rule. A job may perform extraction chunks, but publishes at most one generation for that task. A failed/cancelled job is not a successful publication; a bounded explicit recovery continues its identity. Multiple consumers join/read the pending state rather than each requesting a new refresh. Known meaningful external edits may establish one investigation maintenance job; a session start alone cannot.

After an editing agent exits, the host retains pending maintenance. Attempt it at the next qualifying need or explicit refresh, within the authorized deadline. No background service wakes to chase freshness. A consumer can proceed immediately with historical/degraded navigation and direct source inspection when its own obligations permit it.

### 7.3 Publication algorithm

1. Validate adoption, current access policy, meaningful trigger and idempotency key. Acquire a per-scope lease with an owner/fencing generation through existing workflow mechanisms. Independent scopes may progress concurrently within the process resource cap.
2. Capture the intended input inventory and stable source binding once. Reuse a trusted frozen QA inventory or compatible recorded inventory where available. Read-only detection must avoid upstream cache-writing paths; authorized extraction detection may write only in staging.
3. Resolve a compatible immutable parent; stage outputs under a unique operation directory. Extract from immutable captured input bytes, or an equivalent validated frozen source view, with a provenance map to the real source. Before/after hashes of a mutable path alone do not establish which bytes an extractor read during concurrent edits. Preserve structural and semantic data for unchanged eligible inputs. Process changed/new inputs and remove deleted/newly excluded source contributions. Do not direct upstream writers at the currently published generation.
4. Run local deterministic extraction and authorized semantic chunks. Use the provider/runtime already selected by host policy, with separate purpose/operation accounting. A final-review conversation is not an extraction worker. The preparer/Builder may supply semantic results only through an explicitly recorded extraction operation with origin preserved; independently challenge important semantic claims through source inspection.
5. Validate schema, source mapping, all edge endpoints, direction, confidence/provenance, and input-specific outcomes. A semantic result with no verified content for a changed file is not success. Check shrinkage by attributing removed nodes/edges to deleted, excluded or successfully re-extracted inputs. An unexplained loss fails publication.
6. Write graph, coverage/provenance, required reports and extraction manifests as one staged generation. On this repository's adopted workflow, report and HTML success precede manifest advancement; do not silently omit them. A future portable policy can make presentation outputs optional only as an explicit tested adoption policy. Unknown usage remains unknown.
7. Compare captured source/policy/registered-source identities again before publication. On drift, revocation, cancellation or lease loss, do not advance the head; retain last valid generation and record the deferred/failed reason. Do not loop indefinitely after changing inputs.
8. Seal/checksum and durably place the immutable generation on the same filesystem. Commit the authoritative head with a DB transaction and CAS on the lease fence, prior head and intended input identity. An expired/stolen lease prevents an old writer from publishing even if its Python process finishes later.
9. Acknowledge publication and perform one bounded verification. Old readers keep their acquired generation; new reads receive the new head. Crash before commit leaves an orphan staged/sealed artifact; crash after commit before acknowledgment is recovered as published by operation/generation ID. Reconcile derived native pointers without replaying extraction.

No failed input receives a successful manifest fingerprint. If adopting a partial graph is explicitly permitted by policy, its per-input coverage remains failed/pending and its overall result is partial; never replace missing semantic results with a supposedly complete code-only graph. Prefer retaining the prior mixed generation on update failure. A separate successful exclusion purge can remove unauthorized content without claiming that failed remaining inputs became current.

Preserve the captured tree's relative paths and needed import/configuration context during extraction; a flat directory of hashed files changes AST relationships. Direct upstream caches to owned staging, normalize source paths back through the capture map before hashing/publishing, and reject a parser/helper that reopens live paths or escapes the capture. Cache fingerprints include extraction policy/tool versions and captured bytes. Test equivalent captures in two random staging directories produce equivalent portable source references and structural relationships.

For D25 semantic dispatch, use a fresh, packet-only extraction session through the existing authorized provider factory with a dedicated purpose and output validator; reuse an existing role's authorized provider/model selection without adding a configurable role. Supply captured chunks plus the certified extraction schema, deny product tools/network acquisition, and journal intent/response/usage as maintenance operations. Do not borrow the active Builder, preparer, challenger or final-review conversation, consume their attempt allowance, or recursively inject graph context. Provider cancellation/unknown dispatch follows operation recovery without automatic replay. Native CLI maintenance has no ambient assistant to call: support local AST work and an explicit host exchange that emits captured chunk IDs/digests and accepts validated results for that same job. If no authorized host mechanism is available for required semantics, return `semantic-runtime-unavailable` and preserve the mixed graph. Do not infer authorization for an alternate backend from installed CLIs or credentials.

### 7.4 Access revocation, retention and cleanup

Apply current exclusion/access policy to reads from every generation and cached answer. Reject an opaque cursor if its access-policy revision is obsolete. Suppress edges or excerpts whose provenance includes newly excluded data; if provenance is insufficient to filter safely, withhold that historical result. Purge/redact retained excerpts and affected caches through an authorized cleanup operation, keeping non-content identity/limitation records. Historical retention never authorizes continued disclosure.

Implement revocation beyond `graph/read.ts`: graph packets are also retained inside host instructions, raw provider responses, continuity evidence and Manager pages. Register provenance for those newly created derived blobs, apply policy checks at their Rafi-controlled display/export paths, and withhold whole blobs when safe redaction is impossible. `WorkflowDb.putEvidence` stores content-addressed bytes: never replace content underneath the same digest or silently rewrite a signed contract/review basis. Use a separate tombstone/access record and, if required by policy, delete inaccessible bytes with an explicit unavailable reason. A missing mandatory recovery artifact follows existing recovery rules; a missing optional graph blob does not invalidate a valid certificate. Revocation governs future Rafi delivery and owned retained data; it cannot erase content already seen by an agent or retained in an external provider's session. Remove revoked snippets from future successor prompts and disclose that limit.

Prune only Rafi-owned generations/staging artifacts under configured limits. Protect active reader handles, active review/contract references and small retained evidence blobs. A full cache can be removed while compact source-backed evidence needed for history survives under existing retention/privacy policy. If protected artifacts exhaust the cap, defer new maintenance and report it; do not delete active evidence or grow without bound.

Transfers include portable graph evidence/source references and necessary permitted compact blobs, not Python paths, provider sessions, live worktrees or full graph caches by default. Imported references remain unavailable until destination capability/source validation or explicit reconstruction. Disablement and uninstall stop integration delivery and remove only owned artifacts selected by existing ownership rules. Never uninstall a shared machine Graphify environment as project cleanup.

`stateTransfer.ts` backs up the workflow SQLite DB, so a filesystem allowlist alone does not enforce that graph transfer policy. Normalize the **staged export DB**, never the live DB: omit local capability/cache locator records, export immutable graph references/permitted evidence and historical maintenance outcomes, and make pending jobs/leases explicitly non-executable imported history. Revoke active publication authority on import; an explicit destination recovery creates a new local operation after validation. Add format/schema compatibility checks and graph-specific rebinding to `rewriteWorkflowDb`; preserve existing non-graph transfer semantics and content digests. Test that imported pending jobs cannot execute merely because their source process is absent.

## 8. QA preparation, contracts and final-review integration

Agree on these seams in G0 before Graphify consumer work. Names refer to the preparation plan and must follow landed equivalents.

| Preparation-owned seam | Graphify extension |
|---|---|
| `qaEffectiveConfig.ts` | Include effective `rafi-graph` role/skill content and provenance when enabled; distinguish config root, execution cwd and graph source. Reuse its fix for ignored project QA bundle loss. |
| `qaPreparationPolicy.ts` | Supply source-backed risk evidence and limitations to the planner's existing escalation request. Do not choose/downgrade depth. |
| `qaPreparation.ts` and assessment/challenge operations | Graph evidence provider dependency plus typed phase context; complete requirement inventory always enters preparation even if no graph exists. |
| `qaVerificationContract.ts` | Optional structured graph refs attached to preparation evidence and stable requirement/check IDs. A no-graph contract remains valid under preparation's own rules. |
| `qaPreparationStore.ts`/workflow DB | Reuse contract/evidence storage and migrations. Separate graph publication jobs/receipts from preparation attempts. |
| `qaContractDelivery.ts`/`buildAssignment.ts` | Deliver the applicable contract plus phase-specific graph packet. Graph-delivery record is not contract acceptance; preserve the real session/workspace binding. |
| `qaContractFreshness.ts` | Classify graph-only churn versus substantive requirements/invariant amendments; use its reconciliation of delivered revisions, evidence and active reviews. |
| `qaContractCoverage.ts`, `qaReview.ts`, review basis/certificate | Record actual graph evidence used for navigation; mandatory checks still require independent source/test evidence. Do not make graph availability itself a required check or certificate prerequisite. |

The contract preserves its original preparation provenance. Builder and final QA can use newer generations as source changes while remaining bound to the same applicable contract revision. Stable checks refer to requirements/source fingerprints, never only graph node/community IDs.

When investigation reveals an existing requirement omitted from a contract, use preparation's amendment workflow. Reconcile changed checks and invalidate only evidence affected by changed requirements/source/policy under that workflow. Proposed product scope uses existing approval rules. Pure graph re-extraction with equivalent substantive inputs does not increment a contract revision or erase valid check evidence.

Final QA always starts its required fresh conversation in the existing frozen source environment. Matching-current evidence must match that snapshot's complete eligible graph inputs and captured requirements. Preparation graph `G0`, Builder graph `G1`, and review graph `G2` need not be identical. If `G2` cannot be produced/reused, give QA direct snapshot access and explicitly label any `G0/G1` evidence historical; never force a graph build simply to review.

Compose the initial graph packet at the review-binding seam before the initial instruction/basis is frozen, retaining its digest and the unmodified mandatory instruction/guidance. Currently `sendDurableQaTurn(slot="initial")` reserves guidance and **replaces** its supplied instruction with `guidance.text`; simply appending graph evidence at its caller loses the packet. Update binding construction and initial-dispatch recomposition together so exactly the frozen packet plus still-valid guidance reaches the provider and is represented in instruction receipts. Additional graph results are journaled evidence subturns in the same review with stable basis/source; they do not rewrite its contract or initial basis. Preserve initialization/repair/handoff slot semantics. Track the final business-verdict receipt separately from graph receipts: `binding.lastReceiptDigest` currently follows every send, and a graph request must never become the receipt used to certify a pass. Test actual prompt bytes and certificate-to-verdict linkage through guidance, requests and recovery.

Semantic assertion origin is part of the evidence. Builder-produced or unknown assertions do not become independent facts because their source digest matches. QA checks important claims in source/tests and satisfies the preparation contract independently. Query success is neither coverage nor a test result.

Preserve early routing for `qaFinalizationTicket`, `qaResumedRecovery`, `qaProtocolResumeTicket` and branch `qaOnlyRecovery`. Recovery loads the exact bound contract/review/receipt history. A missing optional graph cache becomes a limitation; it does not erase a valid pass certificate or force a fresh review. A missing mandatory verification artifact follows QA's existing recovery-decision path. Report repair remains response-only. No graph wrapper may fall through to Builder preflight or preparation on those paths.

## 9. Initial resource policy and failure behavior

These are concrete implementation starting limits and benchmark targets, not measured promises. Freeze the effective values per operation/run, permit explicit authorized increases, and document hardware/corpus used to calibrate them. Adopted coverage cannot silently shrink to meet a cap.

| Resource | Initial policy |
|---|---|
| Status | Metadata-only; no Python process or corpus walk in the ordinary case; local target p95 <100 ms. Installation compatibility is last-known unless explicitly checked. |
| Compatibility probe | 5 seconds, no installation/network side effect. |
| Request | 8 KiB JSON, at most 4 operations, query <=2,000 characters, <=16 seed IDs; reject unknown fields. |
| Traversal | Default depth 2, maximum 5; <=500 returned nodes and <=1,000 returned edges before tighter byte/token caps. |
| Result packet | Default 24 KiB serialized JSON, hard maximum 64 KiB; target <=6,000 tokens per default packet. Enforce bytes and actual tokenizer count when available; approximate tokens are labeled. Cursor/narrowing preserves discoverability. |
| Exchange | Initial packet plus at most 3 follow-up rounds, <=12 operations and <=96 KiB aggregate delivered evidence per logical investigation by default. Existing smaller Manager/phase limits win. One format correction at most; no endless model-query loop. |
| Query runtime | Warm target p95 <=1 second on 100k-node fixture; deadline 5 seconds per operation, 15 seconds cold load/request deadline. Kill/reap hung child and fall back. |
| Read worker memory | Default 512 MiB budget, 1 GiB maximum process budget; at most two loaded generations and two read workers per host. Account for Python/NetworkX amplification; reject before unsafe allocation where estimates permit. |
| Inventory | Default ceiling 30 seconds; large-corpus authorized ceiling 120 seconds. One qualifying pre-query inventory, not one per request. Initial planning scope review above 500 files or 2 million words follows adopted Graphify policy. |
| Structural maintenance | Default 5-minute deadline; explicit large-corpus adoption may authorize up to 20 minutes. Cancellation/timeout retains prior generation. |
| Semantic work | Default <=100 changed semantic inputs, <=250k input tokens and <=30k output tokens per maintenance job, 10-minute ceiling; smaller provider/preparation budget wins. Chunk input <=16k estimated tokens, <=4k output, one output-format repair per chunk. Larger initial adoption requires explicit sized policy; never silently skip excess inputs. |
| Consumer wait | At most 30 seconds for pending maintenance by default, always bounded by remaining owning-phase time. Then return degraded/unavailable and direct-source fallback. Maintenance may finish within the owning foreground host operation, but no daemon survives command exit. |
| Retries | One transport/open retry only when non-dispatch or pure-read replay is established; no automatic semantic/provider replay with unknown dispatch. One final verification after publication. Source-drift jobs defer rather than loop. |
| Generation storage | Default 2 GiB/project, retain last 3 unreferenced generations per scope for at most 7 days; protection of active references can stop further writes at the cap. Orphan staging eligible for cleanup after 24 hours and proven inactive ownership. |
| Retained evidence | Compact permitted evidence follows existing run/contract retention; default additional graph evidence ceiling 10 MiB/run. At the ceiling, store IDs/digests/limitations rather than silently retaining unbounded excerpts. Never drop mandatory existing QA artifacts. |

Apply size limits before JSON parsing or graph loading, not only after traversal. Bound child stdout/stderr and framing, cancel the full owned process tree on timeout, and avoid holding unbounded duplicate buffers. Enforce memory using supported OS process controls or a monitored RSS ceiling with documented overshoot; where a hard limit is unavailable, label it accurately and apply conservative input-size/node-count admission limits. Unknown or excessive graph size returns an explicit resource limitation. Disk admission counts staging/captured inputs and concurrent jobs, not only sealed generations; reserve headroom before extraction. These mechanisms require packed tests on each advertised platform.

Prepare benchmark fixtures at approximately 10k/100k nodes and a larger stress fixture, with mixed documents, multiple languages, unresolved imports and repeated queries across worktrees. Measure scan/extraction/load/query wall time, peak RSS, disk usage and provider usage separately. If the default 100k-node workload exceeds limits, optimize or revise the documented tested tier before release; do not falsely advertise that tier. Avoid resuming preparation with a reset budget after graph work consumed its deadline.

Failure outcomes:

| Condition | Required result/action |
|---|---|
| Disabled or unadopted | No install/scan/model call; source inspection; concise explanation only for a relevant explicit/qualifying request. |
| Missing/incompatible runtime/schema | `unavailable` with concrete adopt/repair command; no auto-upgrade or repeated installation. |
| No eligible input | `empty-corpus`, distinct from parser/extraction failure; no invented architecture. |
| No match / ambiguity / partial coverage | Typed result and actionable narrowing/source-inspection instruction; never an absence proof. |
| Stale/unknown generation | Label age/source relationship and verify current claims in source; never certify source match. |
| Failed extraction / source drift / unexplained shrink | Prior generation retained; failed fingerprints unstamped; deferred/failed job recorded. |
| Graph missing during mandatory QA check | Direct inspection/test if it can satisfy the check; otherwise normal unresolved/blocked verification outcome. No automatic pass or depth downgrade. |
| Revoked source / invalid scope / malicious request | Withhold affected evidence; no execution/URL fetch; bounded diagnostic. |
| Quota/timeout/provider cancellation | Preserve partial accounting and existing attempt authority; fallback or phase-incomplete outcome, not empty success. |

## 10. Ordered implementation work packages

Each package is reviewable and must leave older disabled/unadopted projects functional. Add behavioral tests with the corresponding change. The dependencies define implementation order, not permission to spawn agents. Do not advertise full integration until G12 passes.

### G0 — Reconcile current code and preparation interfaces

**Depends on:** none. **Requirements:** R2, R3, R11–14, R34–35.

Recheck the dispatch inventory against all production constructors/sends and newly landed preparation code. Confirm the configuration resolver, contract/provenance extension, review-source identity, delivery receipts, amendment handler and exact QA recovery seams with that code/plan. Record a source revision and any still-unlanded dependencies. Assign phase-specific graph purposes and identify inapplicable handshake/probe paths. Reserve nonconflicting workflow migrations rather than guessing the next migration number while preparation is changing.

**Files:** inventory in this document; current `agentRun.ts`, `cli/start.ts`, `foreman.ts`, `qaReview.ts`, preparation modules; `spec` and workflow migration entry points.

**Exit/tests:** every existing D row has actual caller symbols, profile, normal/recovery branches and planned test; D25 is explicitly a new dispatch to implement. Preparation interface fixture accepts graph-less and graph-referenced evidence without changing authority. Run current relevant tests to establish a recorded baseline; distinguish pre-existing native SQLite/runtime failures from feature failures. No runtime behavior enabled. Resolve routine naming decisions here and confirm the setup handoff; G4 implements it.

### G1 — Shared schemas and certified read bridge

**Depends on:** G0. **Requirements:** R7–9, R22, R30.

Implement strict graph request/result/identity/config types and exported validators. Package the Python bridge and capability probe. Certify 0.9.82/schema 1 against small checked-in sanitized structural/mixed fixtures and upstream helper behavior. Verify supported package provenance/dependency advisories before selecting the release pin; a necessary changed pin requires rerunning this suite, not trusting a newer version. Build bounded query/node/neighbors/path/impact operations and preserve directed evidence despite traversal views. Disable all logging/stamping/save-result/import-time writes and external network/backend calls.

**Files:** new `spec/src/graph.ts`, `schemas.ts`, `validate.ts`, `index.ts`; new bridge/read modules and Python asset; `ai-foreman/package.json` exports/files/build asset step.

**Exit/tests:** T01–T04; all operations against fixtures, ambiguous/empty/partial cases, wrong schemas, path escape and byte caps. Filesystem snapshot/sentinel tests include source, graph/manifest, process cwd, HOME/temp locations, content and modification metadata; unexpected application writes fail. Do not equate filesystem-managed access-time changes caused by reading with a query-stamp write. Pack the package and run the bridge without repository/global skill paths.

**Migration/rollback:** no enablement; optional schemas parse old config. Adapter mismatch returns unavailable. Keep existing upstream graph untouched.

### G2 — Source scopes, corpus inventory and immutable storage

**Depends on:** G1 and G0 source-authority seam. **Requirements:** R17, R21–24, R29–30.

Implement scoped host handles, mapping from existing workspace/frozen QA identities, registered-source projections, input digests and immutable generation/evidence records. Add workflow migrations, retention references and generation head CAS. Implement read-side policy filtering and safe acquisition while publication/pruning occurs. Import an existing graph only as explicitly authorized, with unknown legacy freshness represented.

**Files:** new scope/corpus/store modules; `sources/sourceRegistry.ts`, `qaSnapshot.ts` interfaces, `sessionIdentity.ts`, `workflowDb.ts`/current migrations; lifecycle storage helpers.

**Exit/tests:** T05–T08, T21, T32; different branches/same HEAD/different untracked files, same path/new workspace, source registry version/policy change, escaped symlinks, old absolute paths, current exclusions applied to old generations; equivalent frozen corpora reuse bytes through distinct validated bindings. Updating graph control records must not change product-source identity.

**Migration/rollback:** additive versioned records. Missing graphs/records remain unavailable; no fake backfilled evidence. Disable new use without deleting historical contract authority.

### G3 — Selective policy and journaled evidence exchange

**Depends on:** G1–G2. **Requirements:** R4–5, R8–11, R26–28, R31.

Implement purpose/context construction, initial evidence seeds, typed host exchange and actual delivery receipts. Integrate phase callbacks so intermediate requests are recognized before assignment/verdict/plan parsing. Preserve usage/events across subturns and cap logical-task budgets. Make configuration root, source workspace and actual provider session explicit. Disable graph requests for response-only operations and failed/unknown-dispatch replay. Classify maintenance need separately from a read request.

**Files:** new policy/context/turn modules; `agentRun.ts`, `foreman.ts`, `buildAssignment.ts`; minimal adapter metadata plumbing in `adapters/types.ts`; continuity interfaces. Specify the `qaDeliveryJournal.ts` compatible extension now; implement direct remediation/guidance consumers in G7. QA/Manager consumers arrive in G8/G9.

**Exit/tests:** T09–T11, T29; actual fake-provider dispatch receives seed evidence, follows a scoped request, then completes the original protocol once, including real continuity framing. Malformed/mixed envelopes never execute operations. Subturns do not increment assignments, remediation allowances or review attempts. Trivial dispatch performs zero graph subprocess/inventory/model calls. T35 establishes prompt-headroom and durable exchange budget behavior.

**Migration/rollback:** feature disabled by default until adoption. Existing no-graph send behavior and parsers remain available; unfinished graph exchange restores/falls back within its original logical operation.

### G4 — Adoption, dependency resolution and compiler/native delivery

**Depends on:** G1–G3. **Requirements:** R6–7, R10–11, R20, R29, R31.

Add project schema/normalization, local executable resolution, explicit adopt/enable/disable/status/read CLI and setup checkpoint integration. Installation is isolated and only inside authorized adoption. Define manual vs selective mode and read-only existing-graph use before normal setup. Implement artifact ownership/ignore entries and package `rafi-graph` guidance across compiled, fallback, native and standalone skills. Wire direct Foreman and Rafi forwarded commands; regenerate CLI documentation.

**Files:** `rafi/src/{project,index,compiler,createStackInterview,gitignore,ownership}.ts`, create interview persistence/resume; `special-agents/src/compile.ts` and role/skill content; `ai-foreman/src/cli/graph.ts`, CLI entry/exports; new shared config/dependency resolver. Keep graph output ignored even when users decline broader Rafi ignore entries; disclose and record that narrow owned entry during adoption rather than silently changing their general ignore choice.

**Exit/tests:** T12–T14, T23, T31; clean machine install fixtures, incompatible/offline/missing Python, spaces/Unicode/Windows, disabled precedence, alias/custom skills, new empty/docs-only/existing projects and native host absence. Cover `create --defaults`, cancelled/resumed acceptance, rerun create/force, non-TTY without accepted defaults and direct Foreman-only policy. `compile`, status, queue and tests never install or build. Adoption can be stored pending G6 initial maintenance; do not advertise ready graph service prematurely.

**Migration/rollback:** old config defaults unadopted; preserve existing ignores/skills/install. Removing compiled owned guidance or disabling feature leaves source and user artifacts intact.

### G5 — Planner, Discovery, Ticket-maker and Uninstaller consumers

**Depends on:** G3–G4. **Requirements:** R3, R15, R20–22.

Wire D01–D05 and D17–D20 through explicit task-purpose context, including all planning continuations and source-intake boundaries. Seed queries from actual approved material and preserve source IDs/slices/depth fields. Independent audits get independent evidence delivery. Keep Uninstaller ownership analysis authoritative and only query for explicit dependency questions. Add all negative repair/routine cases.

**Files:** `rafi/src/{plan,ticketPlan,grillAudit,planningDriver,createStackInterview,discovery,uninstall}.ts`; `ai-foreman/src/cli/{tickets,start}.ts`, `ticketPopulation.ts`, `ticketPlanning.ts`.

**Exit/tests:** D01–D05, D17–D20 through both provider fixtures; T09, T12, T15. Approved-plan population cannot invent slices/dependencies from graph edges. Pre-adoption Discovery does not initialize a graph. Source acquisition is never invoked by the graph bridge.

**Migration/rollback:** retain existing planning/continuation envelopes; optional graph receipts do not invalidate prior interview sessions or approved plans. Consumer support can be enabled separately in development but advertised accurately.

### G6 — Authorized semantic work and transactional maintenance

**Depends on:** G2–G4. **Requirements:** R17, R21–27, R29–30.

Implement the publication algorithm, selective task-boundary registration, scoped leases/fencing, cancellation/crash reconciliation, AST and host semantic jobs, manifest success rules and shrink validation. Finish initial adoption/import/refresh and retention commands. Make semantic work an explicit provider operation with isolated protocol and accounted budgets; no hidden extraction from reads. Preserve mixed coverage and current machine-workflow report/HTML requirements.

**Files:** new maintenance/semantic/lifecycle modules and bridge extraction side; workflow job/lease helpers; read/status diagnostics; corpus and config integration.

**Exit/tests:** T16–T19, T21–T22, T32, T34–T35; multiple OS processes publishing one scope, independent scopes, lease loss, provider timeout, source drift, every publication crash boundary, successful publication replay, semantic zero-result/failure, deletion/exclusion and unexplained shrink. Environment credentials never cause external API selection. One logical task never yields two committed incremental generations. Verify D25 session isolation, captured-tree path normalization, native host exchange and honest unavailability without a host.

**Migration/rollback:** retain previous valid head and compatible version adapter. Failed stage artifacts are not current. Rollback disables maintenance and uses prior immutable compatible generations as historical/matching only when proven; no in-place downgrade.

### G7 — All Builder modes and worktree lifecycle

**Depends on:** G3, G6 and preparation's current assignment/delivery seam. **Requirements:** R3, R11, R14, R16–17, R23, R28.

Wire D08–D12, Builder side of D15 and D23 across raw/live-settings/recovery factories. Bind actual workspace and task identity at dispatch, not just adapter construction. Integrate meaningful-change signaling from existing step/change inventories plus agent-reported cross-file discoveries; verify scope before maintenance. Maintain per-worktree graph state across branch/shared/stacked/merge/rebase and QA-disabled work. Carry graph references alongside, not in place of, preparation's contract delivery.

**Files:** `cli/start.ts` all Builder factories, `foreman.ts`, `buildAssignment.ts`, `builderGuidanceFollowup.ts`, `qaFailureDelivery.ts`, `qaDeliveryJournal.ts` and its migrations/readers, `branch/{runner,planner,git}.ts`, `buildInterventions.ts`, `rafi/src/buildResume.ts`, continuity/handoff callers.

**Exit/tests:** T05, T09–T11, T16, T20, T29; initial/next task, synthetic/task-file, branch strategies, all three D12 routes and kept/recreated workspace. Root graph never answers as current for divergent branch; routine test/format edits schedule no update. Graph work does not grant Git authority or complete a ticket. Source-bound remediation preserves per-subturn terminal/source checks and its single final-report repair; guidance keeps one assignment across requests.

**Migration/rollback:** existing work admission and session authority stay unchanged. Old ongoing work without graph refs receives explicit unadopted/unavailable state; no forced build restart or fabricated delivery history.

### G8 — Preparation evidence and exact-source independent QA

**Depends on:** G2–G3, G6–G7 and landed preparation interfaces; coordinate throughout G0 onward. **Requirements:** R12–14, R18, R22, R27–28.

Implement the section 8 seams, D06–D07 and D13–D14. Integrate evidence exchange inside QA's existing dispatch journal and fresh review conversation. Add optional contract provenance, separate per-phase delivery receipts and graph-only-vs-substantive amendment behavior. Validate snapshot matching for full graph inputs; gracefully fall back. Deliver exact project-owned role/skill content through preparation's resolver. Preserve semantic assertion origins.

**Files:** preparation modules/contract schemas as actually landed; `qaReview.ts`, `qaRuntime.ts`, `qaSnapshot.ts`, `qaRecovery.ts`, review-basis validators; `cli/start.ts` all QA factories and early recovery routes; branch finalization.

**Exit/tests:** T06–T08, T10–T11, T17, T20, T30, T32; all depths, independent challenge, staged/unstaged/untracked/deleted/renamed QA input, no-project-bundle-loss, actual initial-packet delivery despite guidance recomposition, final-verdict receipt linkage, drift, amendment, exact QA-only/report repair/finalization. Delete optional graph caches after a valid review and show finalization does not start Builder/preparation/extraction or create a new review attempt.

**Migration/rollback:** preparation works without Graphify. Do not change existing digest formats in place; tagged extensions follow preparation's schema strategy. Legacy contract/review semantics stay explicit. Missing optional graph refs are not corruption of mandatory contract data.

### G9 — Manager graph evidence

**Depends on:** G2–G3, G8 evidence associations. **Requirements:** R19, R22, R26, R30–31.

Add a new tagged Manager evidence request/page version or strictly negotiated capability variant; preserve existing V1/V2 parsing and host controls. Map allowed project/run/work/review IDs to graph scopes. Support status, source relations, impact and bounded maintenance/evidence diagnostics. Reuse existing cursor/artifact/redaction semantics, actual source-time labels and stricter Manager limits. Keep runtime DB facts separate from graph architectural hypotheses.

**Files:** `spec` Manager schemas, `managerEvidence.ts`, `managerPacket.ts`, `cli/manager.ts`, `projectDiagnostics.ts`, Manager role/diagnostics instructions.

**Exit/tests:** T03, T11, T18, T24; valid historical source match, current-only fallback, pruned graph, invalid run/work/path/cursor and hostile evidence. Manager receives useful graph evidence with all direct tools still denied. Model-generated control text remains non-authorizing.

**Migration/rollback:** old request versions remain usable; absent graph capability is explicit. New graph protocol cannot reinterpret an older request as a mutation.

### G10 — Continuity, transfer, revocation and uninstall completion

**Depends on:** G5–G9. **Requirements:** R10–11, R21, R28–31.

Complete D15/D21–D24 transitions and durable evidence retention. Revalidate actual source/workspace/provider on exact/fresh resume, compaction, handoff, live settings and supervisor restart. Recover publication idempotently. Add portable evidence references and staged SQLite normalization to state transfer, capability revalidation on import, ownership-aware cleanup and policy-aware evidence tombstones across history. Native sessions use the same scoped maintenance coordinator when explicitly invoked, with D25's explicit semantic host exchange or fallback.

**Files:** `continuity.ts`, `handoffs.ts`, recovering adapters, `stateTransfer.ts`, `rafi/src/{buildResume,ownership,uninstall}.ts`, graph lifecycle/store/read; CLI recovery diagnostics.

**Exit/tests:** T14, T20–T23, T33; copied state without caches, old schema records, missing skills, mixed-provider handoff, crash after publication and graph read concurrent with pruning. Imported pending jobs cannot acquire execution authority automatically. Explicit disablement/revocation persists through every transition, including derived evidence and exports. Read-only commands do not migrate/create DBs.

**Migration/rollback:** additive retained identities; support declared previous config/receipt schemas, reject newer unsupported versions clearly. Do not roll back QA authority or discard history to turn Graphify off.

### G11 — Observability and usefulness evaluation

**Depends on:** G5–G10. **Requirements:** R1, R5, R26, R31, R33.

Add versioned, replay-deduplicated events for qualification, initial/query delivery, fallback, maintenance/cost and useful source-backed findings. Keep metrics content-light and within existing retention. Show concise relevant failures and cheap status, with no footer on unrelated commands. Build the evaluation fixture set and matched-run reporting described in section 13.

**Files:** graph diagnostics, existing observability/reporting and Manager packet services; evaluation fixtures/scripts and docs.

**Exit/tests:** T25–T27; actual use differs from skill installation, unknown usage stays unknown, blocked/retried/cancelled work accounted, no repeated costs on replay. Do not claim effectiveness without recorded comparisons.

**Migration/rollback:** metrics optional for execution; schema versions identify unavailable historical counters. Disabling metric presentation cannot remove relevant graph failure notices.

### G12 — Packaged validation and release handoff

**Depends on:** all previous packages. **Requirements:** all, particularly R32–35.

Run the complete matrix and scenarios below against packed artifacts and both provider fixtures. Finish release/platform/dependency documentation and CLI docs. Reconcile each requirements row and dispatch row to implemented code and an actual passing test; mark unavailable platform/provider capability explicitly. Release the confirmed setup default only with its opt-out, honest failure behavior and complete supported-path coverage.

**Exit/tests:** T01–T35 and S1–S8; relevant package tests, full build/typecheck/test/docs validation, compatibility/negative tests and recorded performance tier. Live provider tests only when already authorized or deliberately requested; fixture success must not be described as live-provider verification. Do not publish or merge as an incidental implementation test.

**Final handoff:** supported versions/providers/platforms; actual tests and measured budgets; migration/rollback/recovery commands; installation/adoption defaults; remaining material limitations; completed requirement and dispatch traceability. An incomplete consumer path must remain explicitly unsupported rather than being hidden by broad “all agents” claims.

## 11. Behavioral validation matrix

Use small source repositories with known ground-truth relationships, real immutable graph fixtures, fake provider executables/SDK responses, fake clocks, temporary homes, and fault-injectable storage. Preserve current test conventions. Add new graph-focused tests beside existing tests; extend existing call-site tests instead of proving only that a skill name appears in a generated file.

| Test ID | Scenario and observable assertion | Existing test seams / new suite |
|---|---|---|
| T01 | Certified Graphify bridge: structured query/node/directional neighbors/path/impact and schema/version rejection; expected source IDs and edge direction survive normalization | New `graphBridge.test.ts`; packaged Python fixture tests |
| T02 | Every read operation is nonmutating, including failure/import/startup: no graph/manifest/source/HOME/external writes or timestamp/querylog/reflection side effects; no network/backend calls | New `graphRead.test.ts`; read-only permissions/sentinel filesystem fixture |
| T03 | Paths, symlinks, escaped source IDs, oversized JSON, unknown fields, shell fragments and malicious labels/excerpts are data/rejected requests; no unauthorized execution | `policy.test.ts`, `managerEvidence.test.ts`; new graph scope/protocol tests |
| T04 | Empty corpus, missing/corrupt graph, incompatible schema, missing manifest, failed freshness check, unsupported parser, unresolved imports, no match, ambiguity, partial/truncated result and no path remain distinct; evidence classes/provenance survive; narrowing/cursors work | New graph evidence fixtures, schema validator tests |
| T05 | Same HEAD with different untracked/dirty worktree content and two concurrent branches; wrong root/incarnation never presented as current | `branch.test.ts`, `sessionLocation.test.ts`, graph scope/inventory suite |
| T06 | Frozen QA staged/unstaged/renamed/deleted/untracked inputs map to matching graph; earlier graph is historical even if individual cited files match | `qaSnapshot.test.ts`, `qaRuntime.test.ts`, new graph review integration tests |
| T07 | Captured requirement version, extraction mode/parser/policy or exclusion change with unchanged code invalidates compatible-input reuse; no external refetch | `sourceRegistry.test.ts`; new corpus/identity suite |
| T08 | Same substantive contract with graph node churn keeps check IDs/evidence; real amendment reconciles delivery, active reviews and affected findings | Preparation contract freshness/coverage tests as landed; graph provenance tests |
| T09 | Each qualifying evidence consumer D01–D23 through its real dispatcher gets task-relevant seed evidence or explicit fallback, requests another bounded packet, then emits its existing final protocol; D24 stays inapplicable, D25 uses its extraction-only protocol | `plan`, `ticketPlan`, `discovery`, `ticketPopulation`, `foreman`, `branch`, QA and Manager tests; parameterized dispatch fixture |
| T10 | Graph intermediate messages never enter `STEP_STATUS`, plan/source-intake/QA report parsers; one logical action retains admission and accounting across subturns; malformed envelopes cannot complete work | `buildAssignment.test.ts`, `foreman.test.ts`, `qaProtocolV2.test.ts`, planning runtime tests |
| T11 | Both providers preserve actual readonly/sandbox/network controls and exact skills; Manager tools remain denied; response-only repairs/acceptance/probes cannot ask for graph work | `adapters.test.ts`, `codex.test.ts`, `qaRuntime.test.ts`, provider process fixtures |
| T12 | Accepted new setup adopts default; opt-out disables; accepted noninteractive new setup follows documented default; existing projects/ordinary `--yes` do not adopt; missing Python/offline produces honest unavailable state | `rafi` setup/project/compiler tests, new graph CLI fixtures |
| T13 | Compiled/fallback/native/root/sidecar/custom/aliased artifacts resolve on both providers; absent integration skill is diagnosed rather than silently dropping QA instructions | `special-agents/test/compile.test.ts`, `rafi/test/compile.test.ts`, `roles.test.ts` |
| T14 | Native session with and without Rafi/host supports bounded read or explicit fallback, no implied durable enforcement; graph policy edit/skill load does not refresh | New native artifact/command suite; skill compilation tests |
| T15 | Initial/exhaustive/resumed planning, independent grill, source reconciliation, approved-slice population and external import preserve authority; Uninstaller zero-hit cannot authorize deletion | `plan.test.ts`, `ticketPlan.test.ts`, `planningDriver.test.ts`, `ticketPopulation.test.ts`, `uninstallRecovery.test.ts` |
| T16 | One maintenance publication per meaningful task across ordinary, branch, synthetic, QA-disabled and remediation/guidance work; trivial edits/test execution/query rounds yield zero updates | `foreman.test.ts`, `branch.test.ts`, new maintenance scheduling suite |
| T17 | Semantic failure/zero verified result, unsupported parser and unexpected shrink preserve valid mixed graph and failed-input manifest state; ambient keys cannot choose backend | New maintenance/semantic provider fixtures |
| T18 | Competing processes, lease expiry/loss, source drift, cancellation and crash before/after every publication boundary never expose mixed output or stale-writer publication | New multi-process publication/fault tests, existing workflow lease conventions |
| T19 | Repeated queries reuse inventory/generation, respect result/time/memory/round caps, terminate hung child, return cursors and do not silently narrow adoption | New graph budgets/benchmark suite; provider usage fixtures |
| T20 | Exact/fresh resume, compaction, provider switch, live settings, supervisor restart and handoff rebind actual context; exact QA-only/repair/finalization performs no Builder/prep/new review or obligatory rebuild | `unifiedContinuity.test.ts`, `qaHandoffAcceptance.test.ts`, `qaRecovery.test.ts`, `branchFinalization.test.ts`, `handoffCrash.test.ts` |
| T21 | Query/review pins survive publication/pruning; revoked inputs are withheld from old graphs, cached packets and cursors; protected-cache saturation defers writes | New graph lifecycle/revocation suite; evidence retention fixtures |
| T22 | Transfer without graphs, legacy optional fields, incompatible new schema, missing graph on finalization, upgrade/rollback and cleanup preserve authority/history | `stateTransfer.test.ts`, recovery/legacy fixtures; graph migration tests |
| T23 | Packed clean install on supported OSes, spaces/Unicode paths, dependency absent/incompatible, direct Foreman and Rafi forwarding, ownership-aware uninstall preserve existing install/graphs | New packed graph command tests; `managerPackaged.test.mjs` patterns; uninstall/compiler tests |
| T24 | Manager source-backed architecture diagnosis with matched historical evidence vs current-only evidence; invalid scope/cursor, graph absence, cost failures and attempted controls remain bounded | `managerEvidence.test.ts`, `projectDiagnostics.test.ts`, packaged Manager fixture |
| T25 | Relevant use/fallback events are delivered, bounded and replay-deduplicated; role instructions alone are not reported as graph use; unknown usage never becomes zero | `observability.test.ts`, new graph diagnostics tests |
| T26 | Routine queue/status/file lookup/test/build/lint/format/instruction maintenance, provider availability and handshake paths cause zero scans/updates/installs or graph-status noise | CLI negative fixture with all graph dependencies set to throw if invoked |
| T27 | Matched source-grounded usefulness evaluation records omissions, false positives, total cost/time and degraded/cancelled work under equal QA requirements | New deterministic engineering fixtures and evaluation report |
| T28 | All S scenarios run end to end from packed artifacts; requirement/D-row coverage exported to final handoff, including graph-free legacy workflow | Cross-package integration harness and release checklist |
| T29 | Real continuity wrapper accepts graph JSON plus exactly one valid trailer; each D12 dispatcher handles two evidence requests then a final result with one assignment/remediation allowance; final repair stays response-only; uncertain subturn never replays | `unifiedContinuity.test.ts`, `qaFailureDelivery.test.ts`, guidance/assignment tests and versioned journal fixtures |
| T30 | Initial QA packet survives guidance reservation/recomposition and exact prompt journaling; graph subturn receipt cannot certify a pass; final verdict receipt does; recovery retains original basis/packet | `qaProtocolV2.test.ts`, `qaHandoffAcceptance.test.ts`, new QA dispatch fixture |
| T31 | `create --defaults` discloses/accepts default, rerun create/force preserves old policy, acceptance resume is idempotent, unaccepted non-TTY has no graph side effects; direct Foreman-only adoption and canonical disable precedence work | Create/interview/project tests, packed direct CLI fixtures |
| T32 | Identical captured trees at different staging/worktree/QA paths reuse one generation with distinct valid bindings; one changed input rejects equivalence; relative imports resolve; no extractor reopens live source | Corpus/scope/bridge fixtures, `qaSnapshot.test.ts` |
| T33 | Staged SQLite export excludes graph local capabilities/live job authority; destination cannot execute imported pending jobs; revoked packet text in derived prompt/response/Manager/export blobs is withheld without changing content under a digest | `stateTransfer.test.ts`, `managerEvidence.test.ts`, graph lifecycle/retention suite |
| T34 | D25 extracts only captured packets using the authorized provider/model, separate session/journal and no product tools/recursive graph queries; native no-host mixed maintenance returns unavailable, validated host results attach only to their captured job | New semantic provider/native exchange tests |
| T35 | Optional evidence yields to mandatory contract/context reserve; malicious oversized graph/stdout rejected before allocation; process timeout/reaping, platform memory policy, staging reservation and cumulative crash/recovery budgets are enforced | Graph budgets and packed OS fixtures; fault-injected exchange/store suite |

Start with affected unit/integration suites, then run package checks and full checks once changes are stable. Existing root scripts are:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm docs:check
```

When CLI behavior changes, run `pnpm docs:generate` before checking generated docs. Package-specific `pnpm --filter <package> test` checks use package names `rafi-spec`, `special-agents`, `ai-foreman`, and `@rafi-ai/cli`. Add the Python bridge fixture command to the package's check flow so Node tests cannot pass while the installed bridge is broken. Tests use isolated fixture environments; they must not refresh this repository's real graph or overwrite the user's machine configuration. Record which provider checks are fixtures versus actual live tests.

## 12. Representative end-to-end scenarios

Notation: `C1` is a contract revision/digest, `S0/S1` are existing authoritative source identities, `I0/I1` are graph input identities, `G0/G1` are immutable graph generations, and `P0/P1` are provider sessions. These identifiers are separate even when their timestamps align.

### S1 — Planning before adoption, followed by accepted setup

An existing project has no adoption record. Discovery/Planner investigates its architecture at `S0`; it receives unadopted/unavailable evidence and uses source inspection, without installation or graph build. An explicitly permitted compatible legacy graph may be read as historical/unknown input, never automatically adopted or labeled current. Source intake captures approved requirement version `R0` through the registry.

For a new project, the accepted setup summary includes default Graphify enablement and its visible opt-out. Acceptance records adoption policy `A0`, authorizes installation if needed and the initial corpus. An empty project has an honest empty corpus; a docs-only project builds mixed/semantic evidence or reports unavailable/partial coverage. Cancellation or opt-out never creates adoption. Existing projects still require explicit `graph adopt`, not a later queue/status command. Installation failure leaves source-based planning available with a concrete repair action.

### S2 — Ordinary worktree build

Work is admitted into workspace `W1`, source `S0`, captured requirements `R0`. Preparation uses matching `G0/I0` if available, completes its obligations, and publishes `C1`. Builder session `P1` receives `C1` and graph evidence bound to `W1/S0`, with a distinct actual delivery receipt. Another ticket's `W2` graph cannot satisfy this receipt.

Builder completes meaningful changes producing `S1`. The host records one maintenance job for this assignment; successful publication gives `G1/I1`. Final QA freezes `S1` into its review authority, starts fresh `P2`, and receives `C1` plus matching `G1` only after full input equivalence is established. Otherwise it gets the S4 fallback. Completion depends on independent checks/source-bound QA, not graph success. Merge/delivery into another source context triggers identity reassessment without stamping the target current from branch names alone.

### S3 — Deep preparation and independent challenge

Planner owns an Exceptional depth decision for admitted work at `S0/R0`. Preparation uses `G0` to identify a cross-component invariant and links it to a source-backed check in draft `C1`. A fresh challenge session gets the original input inventory and raw graph evidence with semantic origins; it does not inherit the preparer's unverified conclusion as a fact.

The challenge resolves the material concern or preparation remains incomplete. Graph resource exhaustion cannot downgrade depth or remove a mandatory check. A risk recommendation goes to the planner's existing decision mechanism. Ready `C1` enters normal delivery once; Graphify creates no extra challenge/preparation phase. Final QA later uses a new source context and fresh conversation.

### S4 — Stale or unavailable graph during final QA

Contract `C1` is bound to the admitted work. Final QA freezes completed source `S1`, but only baseline graph `G0/I0` for `S0` exists and its semantic update failed. The host labels `G0` historical, supplies the failure limitation, and lets QA inspect/test `S1` directly. It does not claim graph currentness because a few cited files match.

If direct evidence satisfies every mandatory check, QA can pass under its existing certificate rules. If a required check cannot be established, QA returns the appropriate blocked/incomplete/failure outcome; graph failure is not a waiver. Manifests for failed semantic input stay unstamped and the old generation survives. No endless build/review retry is introduced.

### S5 — Graph refresh versus contract amendment

Equivalent source/requirements are re-extracted with different graph node IDs, yielding `G2` while `C1` stays valid. New phase evidence points to `G2`; existing stable requirement/check identities remain intact.

A later captured requirement `R1` or inspected invariant exposes a substantive omission. Preparation's amendment workflow decides authority and publishes `C2` if authorized, retaining `C1` history. Delivered revisions, affected evidence and any active review reconcile under that workflow. Graphify cannot silently attach `C1` evidence to changed `C2` expectations or turn a proposed feature into a mandatory defect. An implementation change outside approved scope goes through existing planning/admission authority.

### S6 — Manager historical diagnosis

User asks why an earlier run failed. Host runtime evidence establishes its run/work/review facts and source `S_old`; Manager requests a relevant architectural relation through its scoped protocol. If retained `G_old` and allowed source evidence match, results are labeled historical and source-backed. If only current graph `G_now` exists, the packet explicitly states current-source context cannot establish historical implementation or causal failure.

Manager can suggest an architectural hypothesis grounded in these limits. A graph label or returned text requesting cancellation/ticket mutation does not authorize a control. Maintenance duration/cost is reported as observed evidence, with unknown usage distinguished from zero.

### S7 — Exact QA-only recovery and interrupted finalization

An interrupted review/finalization has bound `C1`, review basis for `S1`, provider identity/receipts and a valid retained result. Its optional `G1` cache was pruned or is absent after state transfer. Recovery routes directly to the existing QA-only/finalization logic. It reuses valid compact evidence, reports the missing navigation cache if relevant, and does not start Builder, preparation, semantic extraction or a new review merely to recreate graph receipts.

A response-only invalid-report repair uses its original evidence and cannot issue graph queries. If mandatory review authority/evidence is invalid, follow QA's explicit recovery decision while preserving history; never substitute the latest graph/contract and call it the original review. Finalization consumes the original valid certificate only when its own checks still pass.

### S8 — Concurrent publication, revocation and provider transition

Two hosts request maintenance for the same `W1` task. Only the fenced owner can publish. Reader A pins `G0`; publication commits `G1`; Reader A finishes using `G0` and Reader B opens `G1`, with no mixed manifest/graph. Killing the publisher after commit but before acknowledgment does not cause duplicate extraction/publication on resume.

An input is then excluded. Old graph results/cursors cannot disclose its content; pruning/redaction preserves only permitted history/identities. A Claude-to-Codex handoff re-resolves the actual role/skill and `W1` source binding; an old session's receipt does not prove successor access. A simultaneous routine `tickets queue` invokes no graph code. Source inspection remains available during revoked/partial graph recovery.

## 13. Rollout, measurement and rollback

During implementation, maintain an explicit capability registry by consumer purpose/provider. A purpose is supported only when its real dispatch, permissions, fallback and recovery tests pass. Internal rollout can enable certified read-only/planning paths before maintenance/QA, but setup and documentation must accurately describe the supported subset. Full release requires all D rows, including the negative D24 paths, and the confirmed new-setup default with opt-out. Existing projects remain unadopted until explicit adoption.

Build deterministic cases for a missed caller, an undeclared implementation dependency, a cross-layer regression, an omitted existing invariant, and a captured requirement linked to implementation/tests. Include a trivial local change as a negative trigger control. For each, record known source facts, expected relevant paths, deliberately absent/ambiguous edges and unchanged mandatory QA standards. The deterministic release gate is: each qualifying dispatch delivers useful matching or explicitly limited evidence; the fixture's relevant source fact can be found and verified; stale/missing/hostile evidence never creates a false authority claim; trivial work causes zero graph maintenance overhead.

For quality evaluation, use at least 20 matched representative work items across those five nontrivial categories, with graph-enabled and graph-disabled runs from equivalent source baselines, the same approved scope/QA standards, comparable depth and provider/model settings, and cold/warm costs separated. Counterbalance run order and isolate sessions so one condition does not inherit the other's solution. Keep blocked, cancelled, retried and degraded runs in the report rather than filtering only successes. Do not count source-inspection fallback as successful graph retrieval.

Report source-backed useful findings, missed relevant paths, false suggestions, requirement-omission remediation, observed escaped/reopened defects, repeated exploration, total preparation/build/review time, extraction cost, graph overhead and available provider usage. Sample the resulting contracts/reviews for equal coverage. Initial usefulness target: at least a 20% reduction in repeated exploration or omission-driven remediation with no material loss of sampled coverage/correctness, plus an explicit account of total cost/time. This is a pilot target requiring uncertainty/sample disclosure, not proof of general causal improvement. If no reliable benefit is observed, adjust evidence selection/limits and report it rather than weaken verification or claim success from smaller prompts.

Coordinate with preparation's broader quality measurement so runs/costs are not double-counted. Retain classifications for depth, work difficulty, provider, execution mode, semantic mode and unavailable environment. Publish actual achieved latency/memory/storage tiers from T19 rather than treating the starting limits as measured performance.

Rollback is operational disablement first: stop new query injection/maintenance, preserve current/retained generations and evidence history, and continue source-based workflows under existing QA rules. Restore prior compatible adapters/config parsers when appropriate. Never reinterpret newer persisted authority under older schemas, roll back source/contract changes merely because a graph failed, or auto-delete shared installations/user artifacts. In-flight publication is fenced/cancelled; in-flight QA finishes or recovers through its existing bound authority. Already valid graph-free or graph-assisted reviews are not invalidated by disabling the optional navigation capability.

## 14. Requirements and dispatch traceability

Complete this table with final file/test names in the implementation handoff. Each row is an obligation, not an optional suggestion.

| Requirement | Implementation packages / responsible components | Observable acceptance |
|---|---|---|
| R1 Engineering outcomes | G11–G12; diagnostics/evaluation | T27 and matched quality report include correctness, omissions and total effort. |
| R2 Exhaustive entry points | G0, G3, G5–G10; dispatch registry/callers | D01–D25 enumerated; T09/T26/T29/T34 prove actual dispatch, new extraction path or intentional inapplicability. |
| R3 Role/context matrix | G5, G7–G10; all role/phase callers | T09/T28 and role mapping below cover all requirements rows. |
| R4 Selective triggers | G3, G6; policy/maintenance | T16/T26: known meaningful tasks qualify, routine work causes zero scans/updates. |
| R5 Dependable observable use | G3, G11; context/turn/receipts | T09/T25 distinguish task evidence/fallback from installed instructions. |
| R6 Portable adoption/config | G4; config/project/setup | T12/T23/T31: actual defaults flag, accepted setup/resume/opt-out, explicit existing adoption, direct Foreman precedence and offline behavior. |
| R7 Dependency management | G1, G4; bridge/resolver/package | T01/T12/T23: certified version, isolated authorized installation, no repeated auto-upgrades. |
| R8 Shared access contract | G1–G3, G9; spec/read/Manager | T01/T04/T24: common evidence semantics and bounded operations across consumers. |
| R9 Nonmutating reads | G1–G3; bridge/read/host bookkeeping boundary | T02/T11: graph/source/manifest/external files untouched; no permission expansion. |
| R10 Compiler/native/skills | G4, G10; both compilers/role library | T13/T14/T23: exact content accessible from packed/custom/native paths. |
| R11 Factories/providers | G0, G3, G7–G10; context/factories/adapters | T09/T11/T20/T29: both providers, continuity framing, distinct remediation journals and all successor factories preserve scope. |
| R12 Preparation coordination | G0, G8; preparation policy/orchestration seam | T08/T09: no competing phase/depth authority; all selected-depth obligations persist. |
| R13 Optional contract provenance | G0–G2, G8; spec/contract/evidence | T08/T22: no-graph contracts valid; structured source/check provenance retains origin. |
| R14 Same contract, phase graphs | G7–G8; delivery/freshness/review | T06/T08/T20, S2/S5: distinct generations, same applicable contract, explicit amendment. |
| R15 Planning/ticket generation | G5; plan/audit/population/source registry | T15: continuation, independent audit, source/slice/depth authority intact. |
| R16 All Builder modes | G7; Foreman/branch/assignments | T09/T16/T20: current/per-ticket/shared/stacked/synthetic/task-file/QA-disabled and follow-up work. |
| R17 Actual worktree binding | G2, G6–G7; scope/corpus/branch | T05/T07/T32: portable corpus equivalence plus validated incarnation/source binding, not HEAD/path alone. |
| R18 Exact independent QA | G8; snapshot/runtime/review | T06/T11/T20/T30/T32, S4/S7: matching or honest fallback, real prompt delivery, fresh independent session and final-verdict receipt authority. |
| R19 Controlled Manager evidence | G9; Manager protocol/service | T24/S6: host-resolved scope, no direct tools/control authority, historical limits. |
| R20 Discovery/Uninstaller | G4–G5; setup/discovery/uninstall | T12/T15: pre-setup fallback and dependency analysis without deletion authority. |
| R21 Correct corpus/revocation | G2, G6, G10; corpus/source registry/lifecycle | T07/T21/T33: approved hidden inputs versioned; excluded old and derived evidence withheld without corrupting digests. |
| R22 Honest evidence/coverage | G1–G3, G8–G9; result/provenance | T04/T08/T17: confidence, ambiguity, no-match/partial/stale distinctions. |
| R23 Selective transactional updates | G6–G7; maintenance/store | T16/T18: one scoped fenced publication, unchanged/mixed data preserved. |
| R24 Coherent source/generation | G2, G6; identity/store/read | T05/T18/T21: atomic head, actual reader generation, safe source mapping. |
| R25 Authorized semantic work | G6; semantic provider/bridge | T11/T17/T19/T34: separate bounded packet-only operation, native host exchange/fallback, no ambient backend selection or false manifest success. |
| R26 Large-build budgets | G3, G6, G11; policy/bridge/metrics | T19/T25/T35: measured tiers, mandatory context reserve, pre-allocation/process/staging limits, bounded reuse, no silent corpus narrowing. |
| R27 Honest fallback | G3, G5–G9; phase consumers | T04/T17/T20, S4: source-based continuation or mandatory incomplete result, never false pass. |
| R28 Continuity/recovery | G7–G10; continuity/review/jobs | T20/T22/S7: valid bound evidence retained, no unrelated restart or duplicate publication. |
| R29 Lifecycle/upgrades | G2, G4, G10; transfer/ownership/cache | T21–T23/T33: portable references, staged DB normalization, imported jobs non-executable, protected retention, user artifacts preserved. |
| R30 Confined untrusted data | G1–G3, G9–G10; scope/validators/Manager | T02/T03/T21/T24: no path escape, evidence-as-instruction execution or revoked disclosure. |
| R31 Useful diagnostics | G4, G9, G11; cheap status/metrics | T24–T26: relevant failures visible without routine graph noise/scans. |
| R32 Validation matrix | G1–G12; package/provider/OS suites | T01–T35, S1–S8 with real results recorded. |
| R33 Rafi usefulness evaluation | G11–G12; fixtures/cohort report | T27 and section 13 controls, accounting and uncertainty. |
| R34 Executable plan/traceability | G0–G12; this plan/final handoff | Dependencies, schemas, boundaries, tests and all requirement/dispatch rows resolved. |
| R35 Reverified references | G0, G12; source inventory/dependency certification | Current caller symbols, preparation interfaces, certified package baseline and limitations recorded. |

Requirements role/context rows map to dispatch and implementation as follows:

| Required role/context | Dispatch IDs | Work packages / principal acceptance |
|---|---|---|
| Initial Planner, including after create | D01, D04, D23 | G3/G5/G10; T09/T15/T20, S1 |
| Ticket Planner | D02, D04, D23 | G5/G10; T09/T15/T20 |
| Independent planning/grill auditor | D03 | G5; T09/T11/T15 |
| QA-nonconvergence Planner | D05 | G5/G8; T09/T15/T20 |
| QA preparation | D06 | G8; T08/T09/T17, S2/S3 |
| Independent preparation challenge | D07 | G8; T09/T11, S3 |
| Builder preflight | D08 | G7; T09/T16 |
| Builder branch dependency audit | D09 | G7; T09/T15/T16 |
| Builder implementation | D10–D11 | G7; T05/T09/T16, S2 |
| Builder remediation / Manager follow-up | D12, D15 | G7/G10; T09/T16/T20 |
| Independent final QA | D13–D14 | G8/G10; T06/T11/T20, S4/S7 |
| Manager | D16 | G9; T24, S6 |
| Discovery | D17–D18 | G4/G5; T09/T12/T15, S1 |
| Ticket-maker | D19 | G5; T09/T15 |
| Uninstaller interpreter | D20 | G5/G10; T09/T15/T23 |
| Native agents and standalone skills | D21–D22 | G4/G10; T13/T14/T23 |

D23 is a cross-cutting obligation for every hosted successor/resume path; D24 is the negative control for all phases. Passing one role's initial-dispatch test cannot stand in for either. D25 adds the maintenance-owned extraction dispatcher in G6 and is verified by T17/T34; it is not another evidence consumer or configurable role.

## 15. Final implementation cautions and completion criteria

The most consequential implementation risks are the explicit intermediate-message integration with assignment/QA journals, effective configuration delivery into snapshots, Graphify private API drift, multi-process fenced publication, semantic extraction cost/provenance, and exclusion filtering of old evidence. Resolve these through the specified typed seams and fault/provider tests; do not hide them behind prompt instructions.

If the actual preparation implementation changes contract names or review-basis versions, update integration code and this plan's seam map while preserving preparation's authority and the Graphify requirements. If provider APIs cannot support the exchange without violating current journal/continuity contracts, fix that explicit host seam before advertising the consumer. A missing optional navigation capability may fall back; an untested permission or authority boundary may not be represented as implemented support.

The building agent is finished when all 35 requirements and all dispatch rows have implemented behavior or the specified explicit inapplicability/fallback, required checks have actual results, documented limits match measurements, and the release handoff states remaining limitations honestly. Final output should identify the changed files, tests run, supported adoption/provider/recovery behavior and any unresolved required work. Creating schemas, prompts or a partial happy path alone is not completion.

## 16. Requirements and code audit

Audited against all 35 requirements, the concurrent QA preparation plan, and production dispatch/configuration/continuity/QA/storage/transfer code at Git revision `a21480df91615843762f3da895edae2992130a26`. The requirements and both plans are local untracked documents at this audit, so that revision identifies the code baseline, not their document versions. No QA preparation modules had landed in `packages/` at inspection. The corrections below are incorporated above; the building agent must still recheck preparation's actual interfaces in G0.

| Finding | Evidence and implementation risk | Correction / acceptance |
|---|---|---|
| A1 — High: graph envelope conflicts with required continuity | [continuity.ts](../packages/ai-foreman/src/continuity.ts) appends a required delta and validates it before returning. A literally sole raw JSON response triggers continuity failure/repair, especially in durable QA. | Section 5.1 defines strict cleaned business JSON plus validated outer continuity; raw bytes remain journaled. G3, T29. |
| A2 — High: direct remediation/guidance paths need distinct journal changes | [builderGuidanceFollowup.ts](../packages/ai-foreman/src/builderGuidanceFollowup.ts) sends outside Foreman; [qaFailureDelivery.ts](../packages/ai-foreman/src/qaFailureDelivery.ts) treats nonzero turn indexes as response-only and correlates one terminal per dispatch. A generic multi-turn wrapper would finish assignments early or invalidate legitimate continuation. | D12 enumerates all paths; explicit versioned delivery kinds, per-subturn event/source validation, one parent allowance and one final repair. G3/G7, T29. |
| A3 — High: QA initial evidence can be overwritten; wrong receipt can reach certification | `beginV2Review`, `sendDurableQaTurn` and `finishV2Pass` in [qaReview.ts](../packages/ai-foreman/src/qaReview.ts) bind the instruction, replace the initial send with reserved guidance, and use the latest receipt for certification. | Compose/freeze/recompose the actual initial packet with the review binding and guidance; keep final business-verdict receipt separate from graph receipts. G8, T30. |
| A4 — High: source-bound input equality prevents equivalent generation reuse | [qaSnapshot.ts](../packages/ai-foreman/src/qaSnapshot.ts) separates source origin/content and creates a new review checkout. The original plan included incarnation in its input identity while requiring that identity to match across workspaces. | Split portable corpus digest from validated consumer source binding; retain origin provenance and verify the full frozen corpus. Preserve relative extraction paths. G2/G6/G8, T32. |
| A5 — High: filesystem transfer allowlists do not filter graph DB state | [stateTransfer.ts](../packages/ai-foreman/src/stateTransfer.ts) exports the workflow SQLite backup. New graph capabilities, paths and live job ownership would travel inside it even if graph files were excluded. | Normalize staged export and imported graph state, retain portable evidence/history, remove local capabilities/live execution authority. G10, T33. |
| A6 — High: revocation must include derived evidence without corrupting digests | [workflowDb.ts](../packages/ai-foreman/src/workflowDb.ts) stores content-addressed evidence; graph text also enters prompts/responses and Manager history. Filtering only graph queries leaves redisclosure paths; in-place redaction breaks identities. | Derived provenance, access tombstones, display/export filtering and explicit unavailable artifacts; no rewriting bytes under a digest or claiming provider-session erasure. G2/G9/G10, T21/T33. |
| A7 — Medium: setup flag and acceptance assumptions differ from code | [index.ts](../packages/rafi/src/index.ts) has `create --defaults`, initializes install ownership early, and lacks the proposed graph acceptance checkpoint. Rerunning create must not adopt an old project accidentally. | Use actual defaults flag; define first setup vs rerun, summary/opt-out, durable acceptance/resume, non-TTY handling and scope-decision outcomes. G4, T31. |
| A8 — Medium: direct Foreman policy loading was underspecified | [config.ts](../packages/ai-foreman/src/config.ts) loads `foreman.yaml`; [project.ts](../packages/rafi/src/project.ts) owns Rafi config discovery. Importing the CLI into Foreman would invert package ownership; missing Rafi config needs explicit behavior. | Shared spec-validated loader, canonical/legacy/Foreman-only adoption rules, current disable precedence, configuration root supplied explicitly; extend existing pure [workflowReader.ts](../packages/ai-foreman/src/workflowReader.ts). G2/G4, T02/T31. |
| A9 — High: native CLI has no ambient assistant for required semantic work | The original plan promised host semantics and native maintenance without defining their transport/session. Current [agentRun.ts](../packages/ai-foreman/src/agentRun.ts) provides provider dispatch, not an implicit assistant inside every CLI invocation. | D25 defines isolated captured-packet extraction and accounting; native uses an explicit host exchange or honest unavailable result, preserving mixed coverage. G6, T34. |
| A10 — Medium: limits did not specify prompt reserve or pre-allocation enforcement | Existing remediation checks reserve mandatory prompt capacity; proposed optional packets could crowd it out. Return-size caps alone do not bound graph JSON loading, child output, staging or recovery reset. | Mandatory context wins; enforce framing/load/process/disk limits with platform-qualified memory behavior and cumulative durable budgets. Unique assignment/exchange IDs prevent per-ticket dedup collisions. G3/G6/G11, T19/T35. |

The audit preserved the confirmed default-on accepted setup policy, all requirement IDs and authority boundaries. No implementation, application test execution, provider calls, installation, graph queries, freshness scans or graph maintenance were performed for this document review. Validation consists of production source inspection, complete requirement/dispatch/test traceability, local-link checks, reference-number checks and document-diff review. Fixture/provider/performance claims remain release work, not audit results.


## Follow-up source-selection decision (2026-10-10)

The user chose to include active captured sources as reference material when Graphify setup is accepted. Implemented policy: `sourceSelection: active-captured`; newly admitted captured sources are pinned, existing pins do not advance on newer captures or setup retries, and deactivated sources are removed. Source provenance must say reference-only, with no inferred requirement approval. Existing explicit-selection policies remain explicit. Source registry updates reconcile selection metadata without fetching, scanning, extracting or calling a provider. Preparation/work admission remains the authority for requirements.
