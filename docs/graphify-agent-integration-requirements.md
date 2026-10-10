# Requirements for Graphify integration across Rafi agents

Plan the implementation of **Graphify as a shared capability for Rafi's agents**, particularly Planner, Builder, QA preparation, independent QA, and Manager, with selective use by Discovery, Ticket-maker, Uninstaller, and relevant standalone agent workflows.

The objective is to help Rafi carry out large buildouts with better architectural understanding, dependency analysis, requirement discovery, implementation targeting, and regression assessment. The integration must work in projects built with Rafi, across Claude and Codex, rather than depending on the machine configuration used to develop Rafi itself.

Produce a thorough implementation plan grounded in the current codebase. **Do not implement changes as part of the planning task.** Investigate the actual launch, orchestration, configuration, permissions, persistence, recovery, and artifact paths before choosing the design. Treat the requirements below as desired behavior; proposed interfaces and command names are examples unless explicitly stated otherwise.

**QA preparation is being implemented concurrently.** Coordinate with that implementation from the first planning step. Its requirements are in [qa-prebuild-requirements.md](qa-prebuild-requirements.md). Integrate with its shared verification contract, preparation-depth policy, work-admission rules, and delivery records. Do not create a competing preparation phase or assume that the earlier investigation still describes the latest implementation.

The confirmed setup default is to enable Graphify when new-project setup is accepted, with a visible opt-out, selective runtime use, and reuse of a compatible existing installation. Show the initial corpus, extraction mode, installation and maintenance policy in the setup summary; acceptance authorizes those operations without a second Graphify confirmation. Existing projects need an explicit adoption or migration path. Adoption establishes the scope and maintenance policy once; ordinary authorized use should not repeatedly ask the user to enable the same capability. This product policy does not authorize installation or graph builds merely to prepare the implementation plan. The execution handoff is [graphify-agent-integration-implementation-plan.md](graphify-agent-integration-implementation-plan.md).

The numbered requirements describe target behavior, including behavior Rafi does not yet implement. Keep their numbers stable for planning traceability. Example command names, transport choices, and the suggested delivery sequence are design options. Repository and installed-package observations are investigation baselines to reverify. Where requirements interact, explicit user restrictions and existing source/contract authority take precedence; the fallback rules in requirement 27 qualify graph-availability requirements throughout this document.

1. **Define success through useful, source-backed engineering outcomes.**

   Evaluate whether the integration helps agents locate relevant implementation, recognize cross-component dependencies, prepare complete verification requirements, discover regression risks, and resolve failures with less repeated exploration.

   Measure combined preparation, implementation, and review effort. A lower query count, smaller prompt, or faster graph operation alone does not establish a better build outcome. Do not claim Graphify guarantees completeness or correctness.

   Graph-derived context must not weaken approved requirements, independent QA, work ownership, permission boundaries, or source-bound completion checks.

2. **Investigate every agent entry point and task purpose.**

   Build an exhaustive dispatch inventory before proposing edits. Record the command or caller, actual role, task purpose, provider, configuration root, execution workspace, permissions, prompt construction, graph access method, and recovery path.

   At the investigation baseline, Rafi has seven named roles: `planner`, `builder`, `qa`, `manager`, `discovery`, `ticket-maker`, and `uninstaller`. General roles use `createRoleBuilder`/`runRoleInstruction`; build orchestration also constructs Builder and QA adapters directly. There are multiple factories for initial sessions, live settings, handoffs, and recovery. Confirm the current equivalents.

   Do not equate task purpose with role name. Builder performs build preflight and branch dependency audits. Planner participates in independent planning audits and QA nonconvergence. QA preparation may introduce additional roles or execution purposes; discover and include the implementation that actually ships.

3. **Cover the full role and context matrix.**

   The implementation plan must map each row to concrete dispatch sites, supplied evidence, selective-use conditions, and verification tests.

   | Role or purpose | Required Graphify use when the task qualifies | Authority boundary |
   |---|---|---|
   | Initial Planner, including planning after `rafi create` | Existing architecture, reusable components, affected systems, vertical slices, integration boundaries, risks, and test implications | Approved requirements and inspected source remain authoritative |
   | Ticket Planner | Feature and milestone planning, audits, backlog changes, source reconciliation, and dependency analysis | Preserve ticket state, source references, and approved scope |
   | Independent planning/grill auditor | Check architectural assumptions and discover repository-answerable questions | Preserve audit independence and its existing output contract |
   | Planner invoked for QA nonconvergence | Trace recurring failures, missing integration work, and possible remediation slices | Return proposals under existing scope and approval rules |
   | QA preparation | Discover relevant invariants, affected components, verification obligations, baseline risks, and regression candidates | Use the preparation workflow's contract and planner-owned depth policy |
   | Independent preparation challenge, where required | Challenge cross-component assumptions, proposed coverage, and unresolved risks | Preserve the independence and completion obligations of the selected preparation depth |
   | Builder preflight | Understand selected work and its implementation dependencies | Remain within admitted work and approved planning scope |
   | Builder branch dependency audit | Find undeclared dependencies and shared implementation boundaries in the selected batch | Code relationships are evidence, not automatic ticket dependencies |
   | Builder implementation | Orient substantial cross-file work, inspect affected callers and tests, diagnose unfamiliar failures, and investigate newly discovered interactions | Use the actual worktree and frozen work scope |
   | Builder remediation and manager-guided follow-up | Trace findings and guidance through affected behavior and assess regression implications | Use current source evidence and existing attempt/admission controls |
   | Independent final QA | Independently investigate affected callers, integrations, invariants, and verification coverage | Use the exact frozen review source and the applicable verification contract |
   | Manager | Explain architectural context around build/QA problems and assess guidance | Query through controlled host evidence operations; runtime records govern execution claims |
   | Discovery | Existing-project setup, architectural inventory, and continuation discovery | Combine graph evidence with direct inspection of retained history and artifacts |
   | Ticket-maker | Improve likely files, required tests, integration details, and dependency rationale | Preserve approved-plan slices and the separate external-import mode |
   | Uninstaller interpreter | Analyze usage or dependency consequences when explicit uninstall instructions require it | Graph absence never proves a target is safe to delete or grants deletion authority |
   | Native agents and standalone skills | Architecture exploration, scoped implementation, independent review, PRD work, and decomposition | Apply the same selective policy outside the Foreman loop and preserve host-owned QA when present |

4. **Apply a selective trigger policy before scans and queries.**

   Qualifying triggers are an explicit graph operation; a substantial architecture, dependency, impact, or cross-file investigation where graph navigation is useful; or meaningful changes to indexed relationships or documented domain behavior.

   Meaningful changes include module/public-symbol additions and removals, changed calls/imports/contracts, runtime integration changes, substantive domain or architecture documentation changes, and deliberate corpus-exclusion changes. Changed bytes alone are insufficient.

   Routine queue/status commands, ticket bookkeeping, ordinary file lookup, test/build/lint execution, formatting, session startup, tool calls, and agent-policy edits must not trigger a graph scan or update solely by occurring. A failed test may lead to a qualifying investigation; running the test itself is not the trigger.

   Evaluate purpose using available task context before scanning. Do not scan the repository merely to decide whether a trivial task needs a scan. Preserve applicable repository/user restrictions and explicit read-only instructions.

5. **Make qualifying use dependable and observable.**

   Do more than add a suggestion to a role prompt. Define how qualifying tasks receive useful initial graph context and how agents request additional focused evidence when necessary.

   Record whether the integration was disabled, inapplicable, available, used, unavailable, or degraded, with a concise reason. Record actual query delivery and result status separately from the presence of instructions saying to use Graphify.

   Do not require meaningless queries to satisfy a usage counter. Do not claim an agent understood the graph merely because the host supplied a packet. Tests must establish the intended instructions and accessible evidence were delivered through real dispatch paths.

   Define who classifies task relevance and how an agent can request graph evidence after discovering a new relationship or failure. A qualifying enabled task must receive task-relevant evidence, or an explicit unavailable/degraded outcome with a source-inspection fallback. Explain how this is enforced in host-managed sessions and what is only instructional in native sessions. A skill being installed or listed is insufficient acceptance evidence.

6. **Make configuration portable and adoption explicit.**

   Provide versioned project configuration for enablement, corpus scope, extraction mode, maintenance policy, and resource limits. Resolve machine-local executables separately from committed project settings.

   Standard setup should expose the integration and opt-out, reuse compatible tools, and establish authorization for the initial graph and subsequent selective maintenance. Define behavior for new empty projects, documentation-only projects, and existing codebases. Discovery can run before complete project configuration exists, so it needs deliberate handling of an existing graph or a limited fallback.

   Existing projects must not acquire a new Python installation or graph build merely because they ran `status`, `compile`, a test, or a ticket command. Provide a deliberate adoption/migration flow, including noninteractive configuration and offline operation. Ordinary compilation must remain bounded artifact generation.

   Preserve existing `.graphifyignore`, ignore rules, graph coverage, custom skills, and user configuration. Do not hard-code the development machine's home directory or interpreter path.

   Define precedence among user instructions, project adoption settings, per-run overrides, and machine capability. Disabled integration must not be re-enabled by a global skill, existing graph, environment credential, provider switch, or resumed session. Define explicit re-enablement and scope changes without conflating disablement with cache deletion. Noninteractive setup must have a documented deterministic outcome when adoption authorization or capabilities are absent.

7. **Manage the Graphify dependency once, outside ordinary agent work.**

   Use the official `graphifyy` package from [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify). At the investigation baseline, the installed version is `0.9.82`, requires Python 3.10 or later, and produces graph schema version 1. Verify the supported version and capabilities when planning; do not assume moving upstream documentation exactly matches the installed package.

   Define a tested compatibility range or pinned version and an isolated installation strategy. Reuse a compatible machine installation. Do not modify system Python or automatically upgrade a user's existing installation.

   Handle absent Python, unavailable installation/network access, incompatible versions, paths containing spaces, and supported operating systems. Diagnostics should identify a concrete recovery action without repeating installation attempts inside every role session.

   Do not install Graphify hooks, watchers, background daemons, hosted services, or broad provider configuration as a side effect of adoption. Any future optional mode must remain explicit and separate from the default integration.

8. **Provide one shared graph access contract.**

   Expose bounded operations for focused queries, node details, relationship/path tracing, affected-code lookup, and coverage/status inspection. The implementation planner may choose a small bridge, restricted tool transport, or another suitable mechanism, but every role must consume the same semantics.

   Prefer reusing Graphify's traversal and extraction capabilities over maintaining a separate graph engine. Isolate version-specific or private library APIs behind a tested adapter. Define incompatible-schema behavior explicitly.

   Return structured evidence with graph/source identities, source locations, relation types, confidence, relevant provenance, result limits, and limitations. Preserve edge direction and distinguish incoming from outgoing relationships. Handle ambiguous labels and unresolved cross-package references without inventing connections.

   Proposed CLI operations include setup, status, query, and refresh under a Rafi graph command. Final names are a design choice. Preserve direct `ai-foreman` use as well as commands forwarded through `rafi`.

9. **Make the read interface genuinely nonmutating.**

   Querying through Planner, QA, Discovery, Manager, or another read-only caller must not refresh manifests, save answers, write query timestamps, create reflection files, perform extraction, or modify source/configuration.

   The installed Graphify CLI query path attempts to write a query timestamp; optional query logging and skill workflows can create additional artifacts. Verify all selected operations rather than assuming commands named `query`, `explain`, or `status` are side-effect free.

   Separate explicitly permitted host observability writes from the graph read operation and the agent's permissions. Use existing logging/retention rules; do not introduce unrequested global query logs. Test source, graph, manifest, and external-path write behavior.

10. **Deliver consistent guidance through compilation and runtime injection.**

    Ship concise Rafi-specific integration guidance, with detailed maintenance references loaded only when needed. A distinct skill name such as `rafi-graph` can avoid replacing the user's general Graphify skill; the final name is not prescribed.

    Cover compiled role bundles, library defaults, Claude native agent files, Codex native agent files, root instructions, overflow sidecars, and relevant standalone skills. Do not preload a long extraction manual into every agent turn.

    Respect existing/custom artifact ownership and runtime-specific paths or aliases. Resolve the actual provider's instructions when switching providers. Missing integration artifacts must produce explicit recovery/fallback behavior instead of disappearing silently or crashing isolated QA through an unresolved skill name.

    Apply the policy to standalone implementation, architecture, review, PRD, decomposition, and handoff workflows when relevant. Preserve their host-owned orchestration rules; Graphify does not authorize extra reviewers or parallel agents.

    State the supported capability matrix for native sessions outside a running Rafi process: how they locate scoped read access, request authorized maintenance, and report limitations. Do not imply that generated instructions provide host enforcement, durable receipts, or a maintenance coordinator by themselves. Avoid duplicate graph context when both a native skill and runtime injection are active.

11. **Unify integration across agent factories and permission models.**

    Identify and cover general role construction, direct build factories, live-settings factories, resumed sessions, and handoff successors. Use a shared integration contract/helper so behavior does not drift between duplicated paths.

    Distinguish the configuration root from the execution workspace and graph source root. Project instructions may originate from the configuration root while source evidence must describe the actual working tree or frozen review snapshot.

    Preserve Claude's explicit tool policy and Codex's effective sandbox restrictions. Do not enable arbitrary Python/shell execution, graph rebuilding, network acquisition, or write access for a read-only role just to provide graph queries. Verify actual provider behavior rather than assuming the adapters enforce identical controls.

    Keep graph protocol messages separate from `STEP_STATUS`, plan proposals, QA reports, source-intake envelopes, and response-only repairs.

12. **Coordinate with the QA preparation implementation immediately.**

    Inspect the current preparation code and agree on integration seams before designing new contract fields, phases, or persistence. Reuse preparation's source identities, requirement references, stable check IDs, depth decisions, and work-admission mechanisms where appropriate.

    Graphify should help preparation investigate callers, integration boundaries, existing invariants, failure paths, relevant tests, and uncertainty. Its absence must not be interpreted as evidence that those obligations are absent.

    Preparation depth changes investigation effort, not baseline requirement completeness. Graph results may support a risk-escalation recommendation, but the planner continues to own the authoritative depth decision and the host continues to enforce minimums. Graph failures, expense, or budget exhaustion do not authorize a downgrade.

    At a depth requiring independent challenge, give that reviewer appropriate graph access and provenance without substituting the preparer's conclusions for independent investigation. Avoid duplicating a challenge or QA phase already supplied by the preparation workflow.

13. **Extend the verification contract with optional, structured graph provenance.**

    Allow preparation to ship and function independently of Graphify. A contract without graph references must remain representable and valid under the preparation workflow's own completeness rules. When the integration is enabled, distinguish graph use, inapplicability, unavailability, and unresolved investigation explicitly.

    Graph evidence references should identify the graph generation, preparation source baseline, relevant query or evidence digest, source locations/fingerprints, confidence, coverage limitations, and related requirement/check identities. Exact schema design belongs to implementation planning.

    Distinguish explicit requirements, source-verified invariants, derived verification checks, inferred risks, and proposed scope changes. An inferred graph edge must not automatically become a mandatory requirement.

    Use existing contract revision and authorized amendment rules when investigation exposes a real omission. Rebuilding the graph or changing community/node IDs must not silently rewrite requirements, change check identities, or invalidate a contract whose substantive inputs remain equivalent.

14. **Deliver the same requirements contract with phase-appropriate graph evidence.**

    Preparation, Builder, and final QA must agree on the applicable contract revision. They need not use the same graph generation: preparation describes a baseline, Builder changes that baseline, and final QA evaluates completed source.

    Preserve the distinction between contract identity, source identity, graph generation, and provider session identity. Bind each phase's graph evidence to its actual source context while retaining the contract's provenance.

    Extend existing contract-delivery and review records as necessary. A successful graph query is not a contract acknowledgment, and contract delivery is not proof that graph evidence was available in an isolated workspace.

    New findings must follow preparation's distinction between applicable existing requirements and newly proposed scope. Graph enrichment cannot bypass scope approval or retroactively turn advisory suggestions into unexplained completion blockers.

    Distinguish a graph-only refresh from a substantive contract amendment. For an amendment, use preparation's reconciliation rules for already-delivered contracts, collected evidence, active reviews, and completed findings. A newer graph must neither invalidate valid checks merely through node churn nor silently carry old evidence forward against changed requirements.

15. **Cover planning, source intake, and ticket generation end to end.**

    Integrate initial planning, planning after setup, standard and exhaustive ticket planning, independent grill audits, resumed interviews, source-intake continuations, and Planner remediation after QA nonconvergence.

    Use graph evidence to ground likely files, affected layers, dependency rationale, testing implications, and risks. Verify relevant source before treating those suggestions as facts.

    Preserve approved-plan slice identities and authoritative source references through ticket population. Supporting graph context cannot replace the approved plan or generate unrelated slices. Keep external ticket import a separate mode and preserve its provenance/state rules.

    Code dependency graphs and ticket delivery graphs represent different relationships. An import, shared file, or graph path does not by itself prove one ticket must precede another. Require a source-backed implementation dependency and retain existing cycle, scope, and delivery validation.

16. **Cover all Builder execution modes and follow-ups.**

    Include current-branch work, per-ticket worktrees, shared delivery branches, stacked delivery, task-file work, synthetic work, initial and subsequent steps, and QA-disabled builds.

    Include build preflight, branch dependency auditing, initial implementation, QA remediation, manager-guided Builder follow-up, and guided recovery. Do not rely on a session remembering graph instructions or requirements from a prior ticket.

    Reassess graph relevance when work moves into another component or concrete failures reveal broader interactions. A prior query for unrelated work must not satisfy the new investigation.

    Preserve existing work admission, attempt budgets, Git authority, and ticket completion rules. Maintenance must not count as a completed ticket, consume a QA remediation allowance accidentally, or authorize additional implementation.

17. **Bind graph generations to actual worktree content.**

    Identify graph sources using canonical project/workspace identity and source fingerprints that account for relevant working-tree changes, not only branch name or HEAD. Include additions, deletions, renames, and eligible untracked source.

    Ticket worktrees under `.foreman/worktrees/` are separate source contexts. Scanning the root project cannot stand in for scanning a ticket worktree, particularly when `.foreman/` is excluded.

    Reuse an immutable base generation only after confirming compatible source identity, coverage, exclusions, and extraction configuration. Subsequent updates must describe the correct worktree. Never expose one branch's mutable graph as another branch's current evidence.

    Include non-code corpus inputs in compatibility checks: captured requirement versions, semantic extraction policy, relevant parser/package versions, and extraction configuration can change graph meaning without changing Git HEAD. Define a graph-input identity mapped to existing workspace/review identities rather than replacing Rafi's authoritative source identity with an independently competing one.

    Define graph handling after merges/rebases, branch changes, recreated worktrees, failed delivery, kept worktrees, and cleanup. Avoid relying on ignored graph files being copied by Git.

18. **Bind independent QA to the exact reviewed source.**

    Any graph evidence presented as current QA evidence must correspond to the frozen QA snapshot, including relevant staged, unstaged, and untracked changes. Use existing frozen-source and review-basis identities where possible. If matching evidence cannot be supplied, follow requirement 27: use direct snapshot inspection and label older graph evidence as historical navigation only. Do not force a rebuild for every review or present a stale graph as matching merely because some cited files are unchanged.

    Resolve effective project role instructions, integration instructions, and skills deliberately from their owning configuration context. Deliver their exact content/provenance to the isolated session. Do not copy the entire `.rafi/` directory or other mutable control state into the review clone.

    QA must remain read-only and independently verify source and tests. Give it access to raw structural evidence and appropriately labeled preparation evidence; do not substitute a Builder-authored graph summary for independent review.

    Preserve preparation's fresh final-review conversation boundary. Shared immutable graph data is reusable evidence, not permission to reuse Builder/preparation provider sessions. Record the origin of semantic assertions when available, including Builder-produced assertions, and label unknown provenance honestly; source matching alone does not make a semantic assertion independently verified.

    Cover first review, remediation review, fresh review, exact recovery, invalid-report recovery, accepted handoff, provider switch, and source drift. A graph from an earlier review may be historical context but must not support current-source assertions without revalidation.

    Graph availability does not establish a passing test, complete coverage, or satisfaction of a mandatory check. Preserve existing QA report and pass-certificate protections.

19. **Integrate Manager through controlled host evidence operations.**

    Manager's intended evidence boundary is host-controlled diagnostic requests. Extend that boundary with strictly validated graph operations and bounded results, preserving compatibility with existing request versions and lookup controls.

    The host must resolve allowed project, run, work, source, and graph identities. Do not accept arbitrary shell commands, filesystem paths, SQL, source URLs, or graph-write requests from Manager model output.

    Runtime records and QA evidence remain authoritative for execution history, timings, status, ownership, delivery, and outcomes. Graph evidence can explain source relationships and possible architectural implications; it cannot prove why a particular historical run failed.

    Historical claims require matching retained source/graph evidence or an explicit limitation. Clearly label current-source context when only the current checkout is available. Preserve existing rules that only explicit original user actions authorize Manager controls.

20. **Provide selective support for Discovery and Uninstaller.**

    Discovery should use an available appropriate graph for substantial architecture and continuation questions, including existing-project setup before normal compilation. Rafi history, runtime state, and local artifacts still require their own direct or host-mediated evidence.

    Uninstaller should query only when interpreting explicit instructions requires understanding usage or dependencies. Generated-file inventory, ownership checks, and routine cleanup do not automatically justify a graph investigation.

    Keep uninstall proposal validation, ambiguity handling, and ownership protections authoritative. A disconnected node, missing edge, excluded source, or zero-hit query does not establish safe deletion.

21. **Index the right corpus, including requirements hidden from ordinary scans.**

    Include application code, tests, relevant configuration, architecture/domain documentation, and current approved planning material. Support a documentation-only project before implementation exists and avoid treating a structurally parsed JSON plan as necessarily equivalent to semantic requirement coverage.

    Exclude dependencies, generated output, graphs/caches, secrets, and irrelevant runtime/ticket bookkeeping. Preserve user exclusions and meaningful hidden project inputs such as CI configuration when appropriate. Exclusion changes need traceable handling.

    Apply exclusions to returned evidence and retained generations as well as new extraction. When a user removes authorization for an input or excludes sensitive content, prevent old cached results from exposing it and define the applicable purge/redaction policy for retained excerpts. Preserve necessary historical identities and limitation records without using historical retention as authority to continue disclosing excluded content.

    Rafi's registered sources can live in excluded locations such as `.rafi/source-cache/`. Include approved source snapshots through an explicit, versioned input mechanism rather than indiscriminately indexing `.rafi/`. Preserve source IDs, captured versions, fingerprints, and original provenance.

    Use Rafi's source registry as the authority for external-source acquisition. Graph operations must not independently refetch private services or URLs, silently change the captured requirement version, or bypass existing source authorization.

    Separate current approved material, proposals, historical plans, runtime evidence, and generated agent conclusions. Avoid feedback loops that reindex graph reports or saved answers as independent factual support.

22. **Expose coverage and evidence limitations honestly.**

    Distinguish `EXTRACTED`, `INFERRED`, and `AMBIGUOUS` relationships. An extracted relationship still needs to be interpreted in context; its label does not prove runtime behavior or requirement satisfaction.

    Report missing/unsupported languages or parsers, extraction failures, excluded sources, unresolved external references, incomplete semantic coverage, stale inputs, and truncated results where they affect the answer.

    Preserve source-file and location references and validate important claims against current source. Do not infer absence from a missing node, missing path, or incomplete query result. Graph communities are navigation aids, not authoritative module or ownership boundaries.

    Stable source identities and evidence digests must support contract/recovery references even if graph node IDs or communities change after extraction or an upgrade.

    Distinguish an intentionally empty eligible corpus from a malformed graph or an extraction failure. Return explicit no-match, ambiguous-match, partial/truncated, stale, and unavailable outcomes; an empty result must not collapse them into apparent proof that no dependency or obligation exists.

23. **Make updates coordinated, selective, and transactional.**

    One authorized coordinator owns publication for each graph source scope/generation. Agent readers and parallel workers must not race to mutate shared graphs. Account for multiple Rafi processes and native agent sessions, even where one build currently uses a single Builder. Independent scopes may progress concurrently; a global daemon or machine-wide serialization is not required.

    Batch at most one incremental publication for a qualifying logical editing task, followed by bounded verification. A later remediation task with new meaningful changes may require a new generation; a session restart or repeated tool call does not itself create a new maintenance obligation.

    Define the logical task boundary in each execution mode, including ticket/step completion, remediation, and merge/delivery. Specify when pending maintenance is attempted before a consumer needs current evidence, when it is deferred, and who owns it if the editing agent exits. Keep initial adoption separate from incremental maintenance. A consumer request or session boundary alone must not multiply refreshes.

    A qualifying investigation may perform one freshness check before its first query. Read-only user instructions prohibit incidental refreshes and cache writes unless separately authorized. Existing stale evidence may be used for navigation with limitations and direct source verification when appropriate.

    Use scoped locking/ownership, staged output, source stability checks, integrity validation, and atomic publication. Retain the prior valid generation on failure. Do not advance extraction manifests for failed or unverified inputs.

    Handle added, changed, deleted, renamed, and newly excluded sources. Preserve unchanged data, edge direction, and mixed semantic/structural coverage. Verify unexpected graph shrinkage rather than replacing a good graph with an incomplete result.

24. **Define publication and freshness around source identity.**

    Graph data, extraction manifests, coverage metadata, and published references must identify one coherent generation. A crash between writing these artifacts must not expose a mixed generation as current.

    Pin each response to the generation actually read, and keep referenced artifacts usable for the lifetime of an active reader/review. Publication and pruning must not redirect a query halfway through traversal or leave an evidence receipt naming a different generation. Validate mapping from stored paths to the authorized worktree/snapshot; absolute paths from another checkout are not valid current-source locations.

    A source change during extraction must cause a bounded retry, deferred publication, or explicitly stale result. Do not loop indefinitely to chase a changing repository.

    A missing graph, corrupt graph, incompatible schema, missing manifest, partial extraction, stale source, and failed freshness check are distinct outcomes. Unknown freshness is not currentness, and current hashes do not guarantee semantic accuracy.

    Define which artifacts are necessary for runtime use and which reports/visualizations are optional. Preserve the applicable adopted workflow's publication guarantees; optional presentation work should not create repeated expensive maintenance during large builds.

25. **Use the authorized assistant runtime for semantic work.**

    Structural extraction should remain local and deterministic where supported. Semantic extraction consumes model work and must use the authorized Rafi assistant runtime/model policy unless a separate backend is explicitly configured and authorized.

    Environment credentials alone must not silently select another provider. Do not launch another agent backend or ask for an unrelated API key to make semantic extraction work.

    Define how semantic work is orchestrated through the available host/provider capabilities, including read-only planning and QA contexts. Agents may return validated semantic results for host publication; read-only agents must not be granted graph-write authority merely to support extraction.

    Keep extraction separate from the read contract and covered by existing adoption or explicit operation authorization; do not require repeated approval for maintenance already authorized. Distinguish a read-only agent operating in an adopted project from a user request that prohibits host writes as well. Validate semantic output structure, source references, and captured-input identity before publication; schema validity alone cannot certify the truth of inferred relationships. Record extraction mode and available generator/model/policy provenance without claiming nondeterministic semantic output is reproducible from source hashes alone.

    Bound semantic work, record its purpose and outcomes, preserve partial/failure information, and avoid contamination of ticket markers or QA verdict protocols. Do not substitute a code-only rebuild for an adopted mixed graph.

26. **Budget for large buildouts without forcing expensive routine work.**

    Provide limits for corpus size, query depth, result bytes/tokens, query rounds, extraction duration, semantic work, and retry count. Reuse validated generations and cached extraction where identity and coverage permit it.

    Prefer targeted evidence over repeated whole-report reads. Surface truncation with a way to narrow or retrieve remaining evidence. Enforce Rafi's response limits even if an upstream token budget is approximate.

    Define how repeated reads reuse a pinned generation and existing source inventories without rescanning the entire repository per query. Measure representative large-repository scan, extraction, load, query, memory, and storage costs; establish concrete budgets in the implementation plan rather than leaving “bounded” undefined.

    Resolve oversized initial corpus scope during adoption rather than repeatedly interrupting later agents with the same decision. Do not silently narrow adopted coverage to fit a budget.

    Record measured duration and available usage/cost, distinguishing authoritative provider measurements from estimates and unknowns. A graph budget limit cannot silently remove mandatory QA/preparation obligations.

27. **Handle graph failures without false confidence or unnecessary build stoppage.**

    When Graphify is unavailable or unsuitable, report the limitation and use source inspection where that can satisfy the task. Do not indefinitely retry failed extraction, installation, or graph queries.

    Distinguish an optional navigation failure from inability to establish a mandatory requirement or verification result. Graph failure alone should not automatically stop every build; unresolved mandatory evidence must still follow preparation/QA readiness and completion rules.

    An explicitly requested graph operation must report its failure accurately. Preserve the last valid generation and describe whether it is usable as historical or stale context.

    Do not treat unknown, blocked, not run, or unavailable as empty, not applicable, or passed. Define recoverable states and concrete next actions consistent with Rafi's existing recovery framework.

28. **Preserve integration through session continuity and recovery.**

    Cover exact resume, fresh sessions, compaction, accepted handoff, provider/model changes, live settings changes, interrupted planning interviews, guided recovery, and supervisor restarts.

    Retain graph generation/source references, relevant evidence receipts, limitations, contract associations, and pending maintenance state in durable records where necessary. Summaries in model memory are insufficient.

    Treat exact QA-only recovery, invalid-report repair, and interrupted QA finalization as distinct paths. Graph integration must not trigger Builder preflight/dispatch, unrelated preparation, new review attempts, or graph reconstruction merely to finalize an already-authorized result. Reuse the bound review evidence where valid; missing optional graph caches must not erase a valid review or manufacture a fresh one. If evidence required by an active review is unusable, follow explicit QA recovery rules and preserve history.

    Revalidate workspace/source identity before reusing graph evidence. Reacquire missing local artifacts through authorized maintenance or fall back with a limitation. Never mistake a recreated worktree at the same path for the original source state.

    Keep maintenance idempotent and separate from implementation/review attempt accounting. Recovery must not replay a completed extraction/publication unnecessarily or treat interrupted maintenance as completed product work.

29. **Handle transfer, cleanup, uninstall, and upgrades deliberately.**

    Treat full graph caches as rebuildable local artifacts by default. Preserve the small evidence/provenance records required to explain past contracts and reviews. Decide explicitly how retained historical evidence survives graph pruning.

    State transfer must distinguish portable references from machine-specific paths, provider sessions, and live worktrees. Revalidate destination capabilities and source identity before using an imported or reconstructed graph. Do not require a full graph cache merely to import otherwise valid Rafi state.

    Register Rafi-owned integration artifacts with existing ownership/uninstall mechanisms. Preserve pre-existing Graphify installations, graphs, custom skills, exclusions, and unrelated user changes. Do not remove a shared machine installation as incidental project cleanup.

    Keep generated graphs local and ignored under `graphify-out/` for this repository. Define the portable project/worktree cache layout and owned ignore entries for Rafi users without committing generated graphs by default. Set retention/size limits and protect active readers, review references, and authorized historical evidence during cleanup; apply the exclusion/privacy policy in requirement 21.

    Define compatibility behavior for old configurations, absent optional fields, older contracts, compiled bundles, recovery records, graph schemas, and supported Graphify upgrades. Avoid changing a graph in place merely because a newer executable is present.

30. **Keep evidence access confined and distinguish data from instructions.**

    Scope operations to authorized projects, worktrees, snapshots, and registered sources. Validate paths, symlinks, identities, request sizes, and timeouts at the host boundary. Do not allow a model-supplied graph path or external source to escape that scope.

    Treat source excerpts, documentation, graph labels, stored answers, and query results as evidence rather than executable instructions. Preserve existing protections against evidence causing tool execution, state changes, or Manager actions.

    Keep credentials and sensitive excluded files out of graphs and logs. Do not broaden network or source access merely because Graphify supports additional backends, ingestion, or PR tools.

31. **Make diagnostics useful without adding noise.**

    Provide a read-only way to inspect enablement, installation compatibility, adopted corpus, latest graph generation, coverage limitations, and pending/deferred maintenance. Clearly distinguish a cheap status read from a corpus freshness scan.

    During substantive work, surface concise evidence of graph use, fallback, or a relevant failure. Do not add graph-status messages to unrelated commands or every agent turn.

    Manager should be able to inspect graph availability and maintenance cost/failure evidence through its host protocol. Do not claim those observations explain hidden model reasoning or establish causal attribution by themselves.

32. **Test behavior across providers, roles, and execution contexts.**

    Extend existing unit, integration, packaged-command, and provider-fixture tests at the relevant seams. Do not settle for prompt snapshots or a test that merely finds the skill name in a manifest.

    Required coverage includes:

    | Scenario | Required observation |
    |---|---|
    | Every row in the role/context matrix | Correct instructions, graph scope, evidence access, and authority boundary reach the actual dispatch |
    | Claude-only, Codex-only, mixed providers, and provider switch | Consistent behavior under the actual provider's permissions and skill resolution |
    | Compiled, library-fallback, and custom/aliased artifacts | Intended integration content is accessible and attributable |
    | New empty or documentation-only project | Honest corpus handling and usable requirement context without invented implementation |
    | Existing project before full setup | Discovery/adoption behavior is explicit and portable |
    | Current branch, per-ticket, shared, stacked, synthetic, and QA-disabled work | Correct maintenance boundaries and no missing runtime path |
    | Two branches with different implementations | Each reader receives its own source generation |
    | QA review of staged, unstaged, renamed, deleted, and untracked source | Evidence claimed as current matches frozen reviewed content; unavailable matching evidence uses explicit fallback |
    | Preparation baseline, Builder, and final QA | Same applicable contract, correctly distinct source/graph identities |
    | Graph-only refresh versus substantive contract amendment | Stable check identity for equivalent inputs; explicit reconciliation for changed requirements |
    | Missing or failed Graphify during preparation | Complete requirement rules remain enforced with honest fallback/incomplete status |
    | Required independent preparation challenge | Appropriate graph access without losing independence or duplicating review |
    | Exact resume, fresh recovery, compaction, handoff, and live settings | Context is retained and revalidated against the actual successor |
    | Exact QA-only recovery, report repair, and interrupted finalization | No Builder dispatch, unrelated preparation, fabricated review attempt, or obligatory graph rebuild |
    | Manager historical/current questions | Host-scoped evidence and explicit source-time limitations |
    | Read-only query operations | No graph/source/manifest writes, backend calls, or permission expansion |
    | Missing, corrupt, stale, incompatible, and partial graphs | Distinct status, bounded recovery, and no false currentness |
    | Empty corpus, no match, ambiguity, and truncation | Distinct evidence limitations without an invented absence claim |
    | Disabled integration and noninteractive adoption | No implicit enablement, installation, scanning, or graph work |
    | Unchanged code with changed requirement snapshot or extraction policy | Reuse decisions account for all graph inputs |
    | Failed semantic extraction or unexpected shrink | Prior valid generation survives and failed inputs remain unstamped |
    | Concurrent updates, source drift, cancellation, and crash during publication | Coherent generations, safe ownership, and bounded recovery |
    | Publication/pruning while a query or review is active | Evidence remains pinned to the generation actually consumed |
    | Runtime/source state transfer and cache pruning | Provenance remains explainable and unavailable artifacts are handled explicitly |
    | Newly excluded input in an older graph or cached answer | Current access policy prevents disclosure through retained evidence |
    | Routine queue, status, test, formatting, and instruction maintenance | No incidental graph scan/build/update |
    | Adversarial paths, labels, source text, and requests | Evidence remains confined data and cannot authorize unrelated actions |
    | Published packages on a clean machine | No dependence on this repository's global skills, Python paths, or ignored artifacts |
    | Native/standalone session without a running Rafi host | Documented access and fallback work without claiming nonexistent host enforcement |

33. **Evaluate engineering usefulness against the existing workflow.**

    Use representative tasks where cross-file evidence matters: a missed caller, an undeclared ticket dependency, a cross-layer regression, an existing invariant omitted from verification, and a requirement linked to relevant implementation/tests.

    Compare source-backed findings, correctness, actionable preparation coverage, missed relevant paths, repeated exploration, elapsed time, and available model usage with and without the integration. Include a trivial task to verify selective-use overhead remains negligible.

    Do not rely solely on upstream benchmark claims. Establish Rafi-specific acceptance criteria and disclose coverage limitations. Graph adoption should improve useful evidence without making unsupported completeness claims.

    Define matched baseline tasks or another practical comparison, work difficulty/preparation depth/provider controls, and accounting for blocked, retried, cancelled, and degraded runs. Include omissions and escaped regressions where observable. Higher pass rates achieved by weaker checks, or cost shifted into uncounted extraction, must not count as improvement.

34. **Produce an implementation plan with explicit dependencies and boundaries.**

    The planning agent's deliverable must include the verified dispatch inventory; decisions and alternatives for graph access/maintenance; proposed schemas and compatibility rules; configuration/adoption behavior; QA-preparation coordination; source/worktree/snapshot identity handling; permission analysis; failure/recovery behavior; resource limits; and a concrete validation matrix.

    Break implementation into reviewable slices with dependencies, likely files, acceptance criteria, tests, migration/rollback behavior, and remaining decisions. A reasonable dependency order is shared contract/read access, setup/compiler delivery, planning/discovery/ticket generation, Builder/worktree maintenance, QA binding, Manager evidence, and recovery/lifecycle validation. Adjust that order to the current preparation implementation and avoid treating it as a mandatory file layout.

    Align the preparation-contract interface in the first slice, even if some graph consumers ship later. Do not defer that coordination until final QA integration.

    Provide a traceability table mapping each numbered requirement and role/context row to implementation slices, responsible components, and observable acceptance checks. Distinguish full-release obligations from incrementally enabled capabilities; partial rollout must not advertise uncovered roles or paths as supported. Include representative end-to-end scenarios for planning before adoption, an ordinary worktree build, deep preparation with independent challenge, stale/unavailable graph during final QA, a contract amendment, Manager historical diagnosis, and exact QA-only recovery. State the graph/source/contract identities and permitted outcome at each phase.

    Ask the user only about consequential unresolved product decisions that cannot be established from current instructions or code. Resolve routine design choices with reasoned recommendations. Do not start implementation, install tools, refresh graphs, or alter another agent's concurrent work merely to produce the implementation plan without applicable authorization.

35. **Use the investigation references as starting points and reverify them.**

    These files identify the main seams found during the read-only investigation. They are not an exhaustive or immutable implementation map, especially while QA preparation is changing.

    | Area | Starting points |
    |---|---|
    | Preparation requirements under active implementation | [qa-prebuild-requirements.md](qa-prebuild-requirements.md) |
    | Existing local Graphify setup and selective policy | [graphify-agent-guide.md](graphify-agent-guide.md), [graphify-agent-workflow.md](graphify-agent-workflow.md), repository `AGENTS.md` |
    | Configuration and schemas | [project.ts](../packages/rafi/src/project.ts), [types.ts](../packages/spec/src/types.ts), [schemas.ts](../packages/spec/src/schemas.ts) |
    | Content, native agents, and compiled bundles | [special-agents compilation](../packages/special-agents/src/compile.ts), [role manifests](../packages/special-agents/content/agents), [project compiler](../packages/rafi/src/compiler.ts), [role loader](../packages/ai-foreman/src/roles.ts) |
    | General role execution and provider adapters | [agentRun.ts](../packages/ai-foreman/src/agentRun.ts), [Claude adapter](../packages/ai-foreman/src/adapters/claude.ts), [Codex adapter](../packages/ai-foreman/src/adapters/codex.ts), [permission policy](../packages/ai-foreman/src/permissions/policy.ts) |
    | Build factories, preflight, assignments, and loop | [start.ts](../packages/ai-foreman/src/cli/start.ts), [foreman.ts](../packages/ai-foreman/src/foreman.ts), [buildAssignment.ts](../packages/ai-foreman/src/buildAssignment.ts) |
    | Branch/dependency and worktree flows | [branch planner](../packages/ai-foreman/src/branch/planner.ts), [branch runner](../packages/ai-foreman/src/branch/runner.ts), [branch Git operations](../packages/ai-foreman/src/branch/git.ts) |
    | Independent QA and review recovery | [qaSnapshot.ts](../packages/ai-foreman/src/qaSnapshot.ts), [qaReview.ts](../packages/ai-foreman/src/qaReview.ts), [qaRuntime.ts](../packages/ai-foreman/src/qaRuntime.ts), [qaRecovery.ts](../packages/ai-foreman/src/qaRecovery.ts) |
    | Initial/ticket planning and independent audit | [plan.ts](../packages/rafi/src/plan.ts), [ticketPlan.ts](../packages/rafi/src/ticketPlan.ts), [grillAudit.ts](../packages/rafi/src/grillAudit.ts), [planningDriver.ts](../packages/rafi/src/planningDriver.ts) |
    | Setup discovery | [createStackInterview.ts](../packages/rafi/src/createStackInterview.ts), [discovery.ts](../packages/rafi/src/discovery.ts) |
    | Ticket generation and registered sources | [tickets CLI](../packages/ai-foreman/src/cli/tickets.ts), [ticketPopulation.ts](../packages/ai-foreman/src/ticketPopulation.ts), [sourceRegistry.ts](../packages/ai-foreman/src/sources/sourceRegistry.ts) |
    | Manager host protocol | [Manager CLI](../packages/ai-foreman/src/cli/manager.ts), [managerPacket.ts](../packages/ai-foreman/src/managerPacket.ts), [managerEvidence.ts](../packages/ai-foreman/src/managerEvidence.ts), [Manager instructions](../packages/special-agents/content/agents/manager-diagnostics.md) |
    | Continuity and lifecycle | [continuity.ts](../packages/ai-foreman/src/continuity.ts), [handoffs.ts](../packages/ai-foreman/src/handoffs.ts), [buildResume.ts](../packages/rafi/src/buildResume.ts), [stateTransfer.ts](../packages/ai-foreman/src/stateTransfer.ts), [ownership.ts](../packages/rafi/src/ownership.ts), [uninstall.ts](../packages/rafi/src/uninstall.ts), [gitignore.ts](../packages/rafi/src/gitignore.ts) |

    Consult the [official Graphify repository](https://github.com/Graphify-Labs/graphify) and the actual supported installed version's code/skill references. The machine-wide guide describes this development machine, not a portable dependency contract for Rafi users.

    The investigation used the existing mixed graph with 6,024 nodes and 17,310 edges for navigation and verified important execution paths directly in source. A read-only hash comparison found five indexed files changed; it was not a complete new/excluded-file scan, and the graph was not refreshed. Do not treat that graph or these baseline findings as a substitute for inspecting the latest implementation.


## Accepted source-selection clarification (2026-10-10)

The user selected inclusion of active captured sources as reference material for accepted Graphify setup. Newly captured active references may enter under that persisted selection policy; existing captured-version pins must not silently advance. Deactivated sources must be withheld. Reference inclusion is not evidence of requirement approval, proposal acceptance or work authority, and responses must retain that distinction. Existing explicit source-ID policies remain explicit.
