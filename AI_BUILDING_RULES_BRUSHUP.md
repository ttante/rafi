# AI Building Rules Brush-Up

This is a compact reference for the AI-building rules and concrete AI system patterns in this workspace. It covers two layers:

1. Reusable rules in `rafi/packages/special-agents/content`.
2. Test Champion's concrete architecture and decisions in `newTestChampion`.

Use it when planning, building, reviewing, or debugging software that includes LLMs, AI generation, model calls, AI-assisted decisions, or future model-training plans.

## Source Map

Primary reusable rule sources:

- `rafi/packages/special-agents/content/rules/domain/ai-governance.md`
- `rafi/packages/special-agents/content/rules/domain/ai-reproducibility.md`
- `rafi/packages/special-agents/content/rules/domain/ai-evals.md`
- `rafi/packages/special-agents/content/rules/domain/ai-batch-testing.md`
- `rafi/packages/special-agents/content/rules/domain/ai-safety.md`
- `rafi/packages/special-agents/content/rules/domain/ai-cost.md`
- `rafi/packages/special-agents/content/rules/domain/observability.md`
- `rafi/packages/special-agents/content/rules/domain/data-governance.md`
- `rafi/packages/special-agents/content/rules/process/testing.md`
- `rafi/packages/special-agents/content/rules/process/tdd.md`
- `rafi/packages/special-agents/content/rules/process/ci.md`
- `rafi/packages/special-agents/content/rules/base/definition-of-done.md`

Primary Test Champion sources:

- `newTestChampion/AGENTS.md`
- `newTestChampion/docs/architecture.md`
- `newTestChampion/docs/summary.md`
- `newTestChampion/docs/decisions/0001-evaluator-rubric-and-publish-gate.md`
- `newTestChampion/docs/decisions/0002-canonical-question-and-scoring-schemas-v1.md`
- `newTestChampion/docs/decisions/0003-batch-state-machine-retries-and-idempotency-v1.md`
- `newTestChampion/docs/decisions/0004-taxonomy-vocabulary-and-governance-v1.md`
- `newTestChampion/docs/decisions/0005-authorization-matrix-and-tenant-boundary-model-v1.md`
- `newTestChampion/docs/decisions/0006-modelprovider-contract-and-routing-strategy-v1.md`
- `newTestChampion/docs/decisions/0007-data-governance-retention-and-redaction-v1.md`
- `newTestChampion/docs/decisions/0008-testing-strategy-and-quality-gates-v1.md`
- `newTestChampion/docs/decisions/0010-near-duplicate-prevention-and-publish-novelty-gate-v1.md`
- `newTestChampion/docs/model-benchmark-campaign-runbook.md`
- `newTestChampion/docs/release-readiness-checklist.md`
- `newTestChampion/docs/admin-governance-compliance-runbook.md`
- `newTestChampion/apps/worker/README.md`
- `newTestChampion/packages/db/migrations/*.sql`

Related reusable doc templates:

- `rafi/packages/special-agents/content/docs/ai.md`
- `rafi/packages/special-agents/content/docs/ai-evals.md`
- `rafi/packages/special-agents/content/docs/ai-costs.md`
- `rafi/packages/special-agents/content/docs/data-governance.md`
- `rafi/packages/special-agents/content/docs/operations.md`

## The Core Rule

AI outputs are not trusted product state by default.

Anything important or user-facing must have:

- explicit quality gates
- deterministic validation where possible
- replayable model-run records
- audit-visible decisions
- bounded retry and recovery behavior
- observability for cost, latency, failures, and approval state
- privacy, retention, and access-control rules
- tests/evals that block regressions

## When The AI Rules Apply

The reusable rule pack marks these as `condition: ai`, so they apply to projects or features using AI:

- `ai-safety`
- `ai-governance`
- `ai-evals`
- `ai-reproducibility`
- `ai-cost`
- `ai-batch-testing`

The `observability`, `data-governance`, `testing`, `tdd`, `ci`, and `definition-of-done` rules apply generally, including AI work.

The `builder` agent profile includes the AI packs conditionally when AI is present, plus TDD/testing/security/robustness. The `qa` profile is skeptical by design and checks accuracy, tests, and security.

## Reusable AI Rule Pack

### AI Governance

Required:

- Document approved models/providers, why each is used, fallback models, and model-change approval rules.
- Treat model changes as product changes.
- Before promoting a model change, run relevant evals and document quality, cost, latency, and safety impact.
- Document dataset sources, consent, labeling process, quality thresholds, retention, access controls, and allowed use for evals, fine-tuning, or training.
- Version training/eval datasets where practical.
- Do not use customer/user data for model training unless policy, consent, retention, security, and approvals are documented.
- Keep governance in `docs/ai.md` and `docs/data-governance.md`.

### Replayability And Prompt Tuning

For AI features, build reproducibility and replayability by default.

Record enough to replay meaningful generations:

- prompt version
- rendered prompt
- input data references
- model/provider
- parameters
- tool calls
- retrieval context
- output
- validation results
- cost
- latency
- timestamps
- user/admin decisions

Other requirements:

- Do not store sensitive prompt/input/output data for replay or training unless privacy, consent, retention, and access controls are documented and approved.
- Version prompts and keep prompt change history.
- Treat prompts as product logic: review, test, document purpose, and connect changes to eval results.
- Maintain eval sets with golden examples, edge cases, failure cases, and adversarial cases.
- Prefer structured prompt inputs and structured model outputs.
- Support prompt rollback when prompt changes reduce quality.
- Track prompt experiments, model changes, parameter changes, example changes, and measured impact.

### AI Quality, Confidence, And Evals

Before implementation:

- Define quality gates, confidence scoring, QA checks, and acceptance thresholds for every AI step.
- Assume important AI generations need custom QA steps.
- Match tests, evals, review workflows, or human approval to risk level.
- For generation, QA, and correction prompts, instruct the model to check its work three times by default.
- Make self-check count configurable and toggleable for cost/latency/workflow reasons.
- Consult the user during planning about where self-checking belongs, how many checks are appropriate, and when it can be turned off.

Correct-example libraries:

- Build a library of correct, high-quality examples for every AI step.
- Seed at least one correct example before writing the AI step.
- Prefer diverse examples covering common, edge, and tricky inputs.
- Show full input-to-output mapping.
- Add negative examples when they prevent common failures.
- Version examples alongside prompts.
- Decide whether example injection is static, similarity-retrieved, or model-selected.
- Make example injection toggleable.
- Track exactly which examples were injected for each production generation.
- Prune stale examples and add examples from corrected production failures.

Eval suites:

- Keep eval suites, golden examples, adversarial cases, and regression results in `docs/ai-evals.md`.
- Cover common cases, edge cases, known failures, adversarial inputs, and corrected production failures.
- Track failures, correction rates, confidence, approval outcomes, and quality trends.
- Promote prompt/model/parameter changes only when eval thresholds pass, or document explicit approved risk acceptance.

### AI Batch Execution And Model Comparison

Every AI step should be runnable in batch mode without code changes. This applies to generation, classification, extraction, routing, validation, summarization, and other model-driven operations.

Batch mode must:

- run a set of inputs through the same step
- collect results, scores, costs, and latency for each item
- compare multiple models side-by-side on the same inputs
- record input, model/provider, parameters, output, scoring result, cost, latency, total duration, and timestamp
- record timing at multiple levels, including time-to-first-token, total generation time, and end-to-end step duration
- track timing trends over time
- use an explicit repeatable scoring function
- support golden, synthetic, sampled real, and adversarial inputs
- make it easy to add production failure cases
- track suite coverage
- support partial/incremental batches
- run in CI when prompts, models, parameters, or scoring functions change where practical
- produce diff-friendly reports with pass/fail, score distributions, cost/latency comparison, and recommendation
- block regressions unless there is explicit documented sign-off
- version inputs, expected outputs or scoring criteria, and historical results with the prompts they test

### Observability And Operations

Required for production-relevant services:

- useful logs, monitoring, metrics, alerts, and health checks
- Grafana-compatible dashboards or an equivalent chosen platform
- visible status tracking for key workflows
- AI generation observability: stages, model calls, retries, validation results, confidence, cost, latency, and approval status
- no secrets or sensitive user data in logs
- operational risks, runbooks, cost drivers, and monitoring expectations in docs
- runbooks for common production failures and manual recovery
- retry behavior, failure modes, and manual recovery steps for background jobs, queues, cron tasks, or integrations

### AI Safety

For LLM or AI generation features:

- Plan for adversarial safety and abuse protection.
- Consult the user during planning on enterprise AI safety practices appropriate to the app.
- Protect against prompt injection, jailbreaks, data exfiltration, tool misuse, unsafe generated actions, and hidden instructions in user-supplied content.
- Treat model output as untrusted.
- Validate, constrain, and review AI output before it affects users, data, money, permissions, external systems, or business-critical workflows.
- Use content safety checks, allow/deny rules, scoped tools, permission boundaries, and human review where risk warrants it.
- Monitor suspicious prompts, repeated failures, high-cost usage, policy violations, and unusual generation patterns.
- Red-team prompt injection, jailbreak, data leakage, unsafe action, tool misuse, and cost-abuse cases before high-risk releases.
- Maintain an AI incident plan.
- Document controls, risks, and escalation paths in `docs/ai.md` and `docs/operations.md`.

### AI Cost Tracking And Learning Loop

Required:

- Track cost throughout AI usage.
- Track cost per task: tokens, model/provider, retries, tool calls, retrieval, latency, and success/failure status where available.
- Track other expensive app operations: cloud resources, queues, storage, external APIs, email/SMS, analytics, and heavy DB workloads.
- Keep cost notes in `docs/ai-costs.md`.
- Record generation results so the project can learn from successes and failures.
- Plan correction workflows for failed generations.
- Run QA on corrections.
- Auto-approve corrections only when correction and QA confidence are very high and risk allows it.
- Require admin approval for lower-confidence, high-risk, or ambiguous corrections.
- Preserve approved corrections and failed generations in structured form for future fine-tuning, evals, or training.
- Document custom-model training path, data requirements, quality thresholds, privacy constraints, retention rules, cost, and when it is worth doing.

### Data Governance

Required:

- Classify data as public, internal, confidential, PII, credentials/secrets, regulated data, and training/eval data.
- Collect and retain the minimum data needed for product, operations, safety, and legal requirements.
- Document retention, deletion, export, backup, and recovery.
- Document consent for user data, analytics, AI replay logs, eval datasets, and training.
- Use access controls for sensitive data and audit access where risk warrants it.
- Redact or tokenize PII and secrets before storing prompts, outputs, logs, traces, eval cases, or replay data unless explicitly approved and protected.
- Keep rules current in `docs/data-governance.md`.

### Testing, TDD, CI, And Done

Testing:

- Discover and use existing test, lint, typecheck, build, migration, and formatting commands.
- Add or propose standard quality commands before tooling fragments.
- Run relevant tests during development and the full practical verification suite before completion.
- If tests fail, fix code unless expectations are clearly obsolete.
- Do not claim tests passed unless they actually ran and passed.
- If a command cannot run, report the command, reason, and residual risk.

Preferred verification order:

1. Targeted tests.
2. Typecheck/static analysis.
3. Lint/format.
4. Full test suite.
5. Build.
6. Migration validation.
7. E2E/smoke tests.

TDD:

- Use TDD wherever practical.
- Identify behavior and acceptance criteria first.
- For new behavior or bugs, write/update tests first when practical.
- Cover business logic, API contracts, permissions, data access, validation, errors, and critical UI workflows.
- If TDD is not practical, explain why and still add the best reasonable coverage.

CI:

- Prefer repeatable scripts over one-off commands.
- Keep CI aligned with local verification.
- Add/update CI checks for new test types, generated API docs, migrations, security checks, and build steps.
- For AI features, add/update prompt/eval regression checks where practical.
- Include vulnerability scanning, secret scanning, license checks, SBOM, and container scanning where practical.
- Generated artifacts must be reproducible and documented.
- Do not bypass failing CI without a documented reason and follow-up ticket.

Definition of done:

- Requested behavior implemented.
- Rule compliance reviewed.
- Relevant tests added/updated.
- Relevant tests/checks pass, or inability to run is reported.
- API docs updated for contract changes.
- Developer/user/admin/business/ticket/architecture docs updated where relevant.
- Ticket/follow-ups updated.
- New env vars, migrations, dependencies, and operational steps documented.
- Final handoff explains changes, tests, and risks.

## Test Champion AI Architecture Rules

### Product Priorities

Optimize for:

1. Question quality and evaluator reliability.
2. Traceability of AI-generated artifacts.
3. Inventory auditability and taxonomy quality.
4. Reliable assessment delivery.

### Domain Constraints

- Multiple-choice and fill-in-code are primary v1 question types.
- Question generation and evaluation are separate workflows.
- All model runs must be traceable to prompts, parameters, and outputs.
- All evaluated questions are stored, including low-quality outputs.
- Built-in tests organized by language, role, and difficulty are a core product feature.
- Candidate-facing scoring should be deterministic wherever possible.

### Implementation Defaults

- Put reusable types and schemas in shared packages.
- Validate API input and AI output explicitly.
- Store parsed records and raw model outputs for auditing.
- Version evaluator rubrics and persist threshold decisions.
- Use background jobs for generation/evaluation.
- Keep prompt templates versioned in source control.
- Avoid hard-coding one model provider through the app.
- Avoid implicit/unversioned publish thresholds.
- Never treat taxonomy or audit metadata as optional.

## Test Champion Content-Quality Loop

The core loop:

1. Define generation target by role, language, difficulty, and question type.
2. Generate draft questions in batch.
3. Validate contract/schema.
4. Evaluate draft quality with a separate evaluator model.
5. Run duplicate/novelty checks.
6. Run solve-check where enabled.
7. Auto-publish only items clearing all gates.
8. Route uncertain items to manual review.
9. Retain rejected/failed artifacts for audit and learning.

The invariant:

No item should auto-publish unless it passes rubric threshold, blocker checks, duplicate/novelty checks, and solve-check policy.

## Decision 0001: Evaluator Rubric And Publish Gate

Core rules:

- Evaluation is the v1 publish gate.
- The evaluator uses six categories on an anchored `0-4` scale.
- Hard-fail blockers auto-reject regardless of score.
- Critical dimensions have floor requirements.
- Weighted total score determines publish/manual/reject classification.
- Rubric and threshold policy are versioned and stored with every evaluation.
- Application code computes final publish decision from structured data. The model's free-text pass/fail wording is not authoritative.

Rubric categories:

1. Role/language/difficulty alignment.
2. Concept correctness.
3. Prompt clarity and answerability.
4. Candidate signal quality.
5. Answer key quality and scoring determinism.
6. Fairness and non-deceptive quality.

Hard-fail blockers include:

- no valid answer
- multiple plausible correct answers
- incorrect answer key
- schema/type mismatch
- hallucinated API or language behavior
- unsafe or discriminatory content
- nondeterministic fill-in scoring
- material ambiguity or unanswerable prompt

Publish decision:

- Validate evaluator JSON.
- Normalize category scores.
- Reject if any blocker is true.
- Reject if critical floors are missed.
- Compute weighted total.
- `>= 82`: `auto_publish`
- `70-81.99`: `manual_review`
- `< 70`: `reject`

Persist:

- rubric version
- threshold policy version
- evaluator model/version
- evaluator prompt template version
- category scores
- weighted total
- blocker flags
- rationales
- computed final decision
- raw evaluator output
- parsed evaluator output

Rejected content remains queryable for audit and training candidates. Failed evaluations are not deleted as part of normal pipeline operations.

## Decision 0002: Canonical Question And Scoring Schemas

Core rules:

- Use one canonical contract per question type.
- Require deterministic scoring contracts.
- Use strict JSON validation for generated question payloads and evaluator payloads before publish.
- Store parsed canonical records and raw model artifacts.
- Reject schema mismatches before threshold scoring.

V1 question contracts include:

- `multiple_choice_single_answer`
- `fill_in_code_slots`
- later expanded: `multiple_choice_code_snippet_single_answer`
- later expanded: `code_output_prediction_single_answer`

Deterministic scoring:

- MCQ variants must have exactly one correct option.
- Duplicate option text is blocked after normalization.
- Fill-in slots use closed accepted-answer sets.
- Starter code must contain slot placeholders.
- Deterministic tests, when enabled, are pass/fail confirmation under fixed runtime settings.

Persist:

- canonical parsed `question.v1`
- canonical parsed evaluator payload
- raw generator output
- raw evaluator output
- validation errors on parse failure

## Decision 0003: Batch State Machine, Retries, And Idempotency

Core rules:

- Use two lifecycle levels: `generation_batch` and `generation_item`.
- Retry transient errors only, with bounded attempts and exponential backoff.
- Treat schema validation failures, unsupported models, invalid config, and policy mismatches as permanent.
- Require idempotency keys and unique constraints for generation/evaluation/publish writes.
- Use lease-based claiming so worker crashes recover safely.
- Duplicate delivery must be a no-op or deterministic overwrite for the same idempotency key.
- Candidate-visible publishing is exactly-once by unique constraint.

Required uniqueness:

- generation artifact: `(generation_item_id, generator_prompt_version, generator_model, generator_run_attempt)`
- evaluation: `(generation_item_id, rubric_version, threshold_policy_version, evaluator_model)`
- publish decision: `(generation_item_id, rubric_version, threshold_policy_version)`
- published question: stable `question_id` generated once per item

Progress counters must balance:

- published
- manual review
- rejected
- failed
- canceled
- pending generation/evaluation

## Decision 0004: Taxonomy Governance

Core rules:

- Controlled vocabulary prevents drift in role/language/difficulty/question metadata.
- Canonical terms have namespace, slug, label, description, status, sort order, replacement term, metadata, and audit fields.
- Aliases map normalized input tokens to canonical terms.
- Strict endpoints fail validation on unknown terms.
- Deprecated assignment fails with replacement guidance when available.
- Taxonomy mutations are restricted to admin roles and must include actor, reason, before/after snapshots, mutation type, and timestamp.
- Taxonomy changes must be queryable in admin audit UI.
- Recurring governance checks should detect unknown tokens, deprecated assignments, duplicate-like terms, stale terms, and low-usage active terms.

Architecture later extends controlled taxonomy to:

- inspiration concept tags
- deterministic checks
- inspiration source mode
- generation-time tag policy versions
- question type namespace

Generation/evaluation artifacts persist taxonomy policy and namespace versions for reproducible audits.

## Decision 0005: Authorization And Tenant Boundaries

Core rules:

- Keycloak owns authentication; app database owns business authorization.
- App code depends on internal users, organizations, memberships, roles, and permissions.
- Candidate tokens are scoped to one candidate session.
- Candidates cannot enumerate assessments, organization data, or generation/evaluation artifacts.
- Raw generation/evaluation artifacts and operational logs require internal roles.
- Sensitive actions and denials are audit-logged.
- Audit logs are append-only in normal operations.
- Avoid raw "list all" repository methods for tenant resources.

Sensitive reads include:

- results exports
- artifact access
- operational logs

## Decision 0006: ModelProvider Contract And Routing

Core rules:

- Business code invokes models only through a `ModelProvider` interface.
- Supported provider classes include `openai_compatible` and `local_runtime`.
- Provider/model are pinned per batch stage for reproducibility.
- Controlled fallback is allowed only through explicit routing policy and full audit metadata.
- Same-provider transient retries happen before fallback.
- Fallback attempts create distinct run attempts with provider/model metadata.
- Evaluation fallback is disabled in production by default for quality consistency.
- Do not do automatic quality-based model switching mid-batch.
- Do not let cost optimization override pinned provider/model selections.

Traceability fields:

- task type
- provider
- model
- model version
- prompt template version
- full request params
- raw request/response refs
- parsed output ref
- usage tokens
- latency
- normalized error code
- attempt number
- fallback lineage

Secrets never go into question artifacts. Raw model payloads follow tenant/role controls.

## Decision 0007: Data Governance, Retention, And Redaction

Core rules:

- Keep full generation/evaluation artifacts for quality and auditability, but govern retention.
- Keep canonical published content and audit-critical decision records long-term.
- Apply time-bound retention to raw model payloads, logs, telemetry, and exports.
- Deletion/redaction workflows require audit logs and legal-hold controls.

Retention defaults:

- Retain indefinitely: published canonical content, evaluation decision records, taxonomy/rubric/version history needed for reproducibility.
- Retain 24 months: candidate assessment data and candidate PII linkage.
- Retain 18 months: raw model artifacts, model invocation telemetry, security/access audit logs.
- Retain 30 days: temporary exports/files.

Redaction:

- Used when records must remain for audit but sensitive content should not be recoverable.
- Can remove/mask direct identifiers or raw payload body while retaining decision metadata.

Every purge, redaction, hold, or deletion action is audit-logged.

## Decision 0008: Testing Strategy And Quality Gates

Testing is a merge gate, not best effort.

Required:

- Core feature code requires automated tests before merge.
- Protected branches require typecheck, lint, unit, integration, and changed-module core suites.
- Critical logic uses deterministic fixtures.
- Bug fixes require regression tests that fail before fix and pass after fix.
- AI-agent-produced changes must pass all tests relevant to modified files before acceptance.

Required test layers:

- Unit tests for rubric decisions, schema validators, deterministic scorers, state transitions, auth policy, model routing/fallback, retention/deletion policy.
- Integration tests for API/worker/data boundaries, enqueue-to-publish flow, retries/idempotency, tenant boundaries, retention jobs.
- E2E smoke for admin generation inventory, built-in assessment/candidate submit, reviewer access and unauthorized denial.

Core domain changes require:

- `question_generation` / `question_evaluation`: unit + integration
- `scoring`: unit + integration
- `candidate_sessions`: integration + e2e smoke
- `authorization` / `tenant scope`: unit + integration
- `taxonomy governance`: unit + integration
- `retention/deletion jobs`: unit + integration

Coverage:

- core domain packages: `>= 85%` line coverage
- critical decision functions: `>= 90%` line coverage

Determinism:

- fixed fixtures for rubric/scoring/state-machine tests
- deterministic seeded DB states for integration tests
- no uncontrolled timers/randomness
- model-provider tests use mocked adapters

## Decision 0009: Frontend Candidate Delivery And Enterprise UI

Core rules:

- Candidate test-taking is the primary customer-facing product surface.
- Frontend behavior must preserve deterministic scoring and strict tenant/session boundaries from the backend contracts.
- Candidate delivery and staff workflows should be developed in parallel.
- Candidate flow uses session-scoped access, autosave/submit behavior, and deterministic submission handling.
- Integrity events are captured in a proctoring-ready adapter pattern.
- Staff/admin surfaces include generation jobs, inventory audit, manual review, taxonomy, access, assessment, and candidate-session workflows.
- Frontend implementation follows `0008` quality gates.

Required test mapping:

- Unit tests for route/access helpers, scoring display logic, candidate session runtime behavior, and admin workflow helpers.
- Integration tests for bootstrap, response save, submit idempotency, role-gated staff access, and inventory/audit API interactions.
- E2E smoke for candidate completing an assessment, staff reviewing results, and unauthorized access denial.

## Decision 0010: Duplicate Prevention And Novelty Gate

Core rules:

- High-scoring items can still be duplicates, so novelty is a publish gate.
- Exact duplicates use deterministic canonical fingerprints.
- Near duplicates use scoped similarity checks.
- Ambiguous similarity routes to manual review.
- Dedupe policy is versioned and auditable.
- `DUPLICATE_PREVENTION_ENABLED=true` by default.
- If disabled, bypass reason/toggle state must be captured in execution metadata.
- No item can auto-publish unless the publish-time novelty gate passes.

Pipeline:

1. Optional blueprint novelty precheck before full generation.
2. Deterministic exact-match block.
3. Scoped near-duplicate scoring against published inventory.
4. Threshold routing to `allow`, `manual_review`, or `reject_duplicate`.
5. Persisted dedupe artifacts.

Persist:

- dedupe policy version
- duplicate-prevention enabled state
- exact fingerprint
- similarity score
- matched IDs
- decision
- reason codes
- metadata

Tests:

- fingerprint normalization
- threshold routing
- retry caps
- exact duplicate cannot publish
- near duplicate routes correctly
- intra-batch duplicate suppression
- fixed duplicate corpus for benchmark/tuning

## Staged Generation Runtime

The architecture separates creativity from deterministic checking.

Stages:

- `Planner`: warm novelty; uses taxonomy targets, question type, inspiration results, and duplicate-avoid hints to produce a blueprint.
- `Author`: moderate structured drafting; uses blueprint, type contract, and answer-first constraints to produce strict `question.v1`.
- `Verifier` / evaluator: cold deterministic checks for ambiguity, scoring, and quality.
- `Solve-check`: independently verifies answerability before publish when enabled.
- `Ambiguity rewrite` / repair: bounded correction when verifier/evaluator flags ambiguity or repairable blockers.

Required behavior:

- Use per-question-type prompt templates as contracts.
- Keep prompt templates separate from inspiration seeds.
- Use answer-first authoring for deterministic question types.
- Fill-in templates must guarantee placeholders exist and accepted-answer sets stay closed/deterministic.
- Solve-check defaults on.
- Solve-check bypass requires platform admin, non-empty reason, batch-level persistence, item-level interpretability, and defaults bypassed batches to manual-review-only publish routing.
- Bypass volume spikes should alert operations.
- Standard solve-check failure codes include `answer_mismatch`, `ambiguous_prompt`, and `nondeterministic_scoring`.

Runtime resolution precedence:

1. Per-batch stage override.
2. Stage-level env config.
3. Batch generator/evaluator provider/model.
4. Runtime safe default.

Stage metadata persisted:

- stage name
- resolved provider/model/temperature/max-token/timeout config
- source of each setting
- attempt metadata
- input/output refs
- latency
- token usage when available
- fallback lineage

Failure routing:

- parse/schema failure -> bounded schema retry and optional repair
- ambiguity/unanswerable -> bounded ambiguity rewrite
- repairable quality blocker -> bounded blocker-aware regeneration
- exhausted retries -> `rejected` or `manual_review` per policy

Publish invariants:

- evaluator threshold policy is never bypassed
- active blockers prevent auto-publish
- duplicate gate remains mandatory unless explicit audited bypass is enabled
- solve-check must pass when enabled

## Inspiration And Copy Guards

Inspiration improves creativity but is not source material to copy.

Rules:

- Keep a curated idea/inspiration pool with metadata for type, language, role, difficulty, concept, and novelty hints.
- Inject small retrieval-sized inspiration sets, typically `2-4`, instead of large blended context.
- Apply prompt-level no-verbatim-copy policy.
- Run inspiration-to-output similarity checks.
- Use bounded regeneration when copy risk is detected.
- Validate inspiration metadata with strict taxonomy.
- Persist taxonomy versions and selected inspiration metadata for audit.

## Observability Implemented In Test Champion

Baseline observability:

- health/readiness endpoints
- structured logs
- worker heartbeat timestamps
- stale queued/running detection
- generation ops metrics endpoint
- generation jobs live ops panel
- queue depth
- stale indicators
- failure trend summaries
- remediation actions: `requeue`, `cancel`, `mark_failed`
- persisted `generation_recovery_events`
- model invocation token and latency telemetry where available
- benchmark leaderboards with QA pass rate, blocker-free rate, solve-check pass rate, latency, tokens, and deterministic ranking

Known current limitation:

- Full dashboards/alerting/SLO enforcement are not fully implemented yet; README calls observability "baseline-only."

## Release And Runtime Gates

Core commands:

- `pnpm run ci:verify`
- `pnpm run release:check`
- `pnpm run staging:check`
- `pnpm run dr:backup-verify`
- `pnpm run test:unit`
- `pnpm run test:integration`
- `pnpm run test:e2e`
- `pnpm run db:check-migrations`
- `pnpm run taxonomy:validate-seeds`
- `pnpm run benchmark:run`
- `pnpm run retention:run`
- `pnpm run smoke:api`

Release readiness checks include:

- auth guardrails
- duplicate-prevention posture
- taxonomy strict mode
- release flag safety
- CI gates
- model benchmark gate
- taxonomy seed validation
- migration/seed status
- retention purge flow
- governance/compliance controls
- disaster recovery verification
- API health/readiness/smoke
- generation observability endpoint

Important env/runtime controls:

- `MODEL_RUNTIME_MODE=stub|live`
- `MODEL_RUNTIME_LIVE_STRICT=true|false`
- stage envs for planner/author/evaluator/verifier/solve-check/repair
- `MODEL_RUNTIME_SOLVE_CHECK_ENABLED`
- `GENERATION_CONTRACT_REPAIR_MAX_ATTEMPTS`
- `QUALITY_REPAIR_MAX_ATTEMPTS`
- `DUPLICATE_PREVENTION_ENABLED`
- `DUPLICATE_GENERATION_RETRY_MAX`
- `INSPIRATION_SELECTION_ENABLED`
- `INSPIRATION_COPY_GUARD_ENABLED`
- `INSPIRATION_COPY_GUARD_REJECT_THRESHOLD`
- `RELEASE_FLAG_MODEL_RUNTIME_LIVE_MODE`
- `RELEASE_FLAG_MODEL_RUNTIME_LIVE_PERCENT`
- `RELEASE_FLAG_SUBJECT_KEY`
- `TAXONOMY_STRICT_VALIDATION`
- `TAXONOMY_ALLOW_DEPRECATED_TERMS`
- `PERSISTENCE_MODE`

## Database Artifacts That Enforce The Rules

Important tables/fields from migrations:

- `generation_batches`: batch config, status, counts, provider/model, rubric/policy, runtime profile, stage overrides, guard overrides, solve-check bypass, heartbeat/recovery fields.
- `generation_items`: item lifecycle, attempts, lease fields, solve-check ran/pass/failure fields, heartbeat fields.
- `question_generations`: generator prompt version, provider/model/version, run attempt, request payload, raw output, parsed output, validation errors, retention/legal hold, taxonomy policy/namespace versions.
- `question_evaluations`: rubric/policy, evaluator provider/model/prompt, scores, blockers, rationales, decision, raw/parsed output, retention/legal hold, taxonomy versions.
- `question_publish_decisions`: computed decision, reason codes, weighted total, rubric/policy.
- `model_invocations`: request ID, task type, provider/model/version, prompt template, messages, response format/schema, temperature, max tokens, timeout, metadata, output, token usage, latency, raw refs, normalized error.
- `question_duplicate_checks`: dedupe policy, enabled state, decision, reason codes, fingerprint, matched IDs, similarity score, metadata.
- `generation_recovery_events`: remediation action, actor, previous/next status, reason, metadata.
- `taxonomy_terms`, `taxonomy_aliases`, `taxonomy_audit_events`: controlled vocabulary, aliasing, mutation audit.
- `governance_audit_events`, `security_access_audit_logs`: compliance and sensitive access evidence.
- `benchmark_runs`, `benchmark_run_candidates`, `benchmark_run_cells`, `benchmark_run_summaries`: deterministic model bakeoffs and leaderboards.

## Required Project Docs For AI Apps

Use or create these docs when the project has AI:

- `docs/ai.md`: workflows, providers/models, governance, prompts, safety, red-team cases, incident response, replayability, learning loop, datasets, future training.
- `docs/ai-evals.md`: eval strategy, suites, golden examples, edge/failure/adversarial cases, eval runs, promotion decisions, regressions.
- `docs/ai-costs.md`: cost strategy, cost per task, non-AI cost drivers, cost incidents, optimization ideas.
- `docs/data-governance.md`: classification, inventory, consent, retention/deletion/export, AI data rules, access controls.
- `docs/operations.md`: environments, deployments, monitoring, alerts, runbooks, backups/restore, incidents, AI ops.

## Practical AI Feature Checklist

Before building:

- Name the AI workflow and owner.
- Define risk level and human-review requirements.
- Pick approved model/provider and fallback policy.
- Define schema for inputs and outputs.
- Define deterministic validation and quality gates.
- Define explicit scoring/thresholds.
- Create at least one golden example.
- Add edge, failure, and adversarial eval cases.
- Decide whether self-checking is used and how many checks.
- Decide whether example injection is used and how it is selected.
- Define replay record fields.
- Classify all input/output/replay/eval data.
- Decide retention, redaction, consent, and access controls.
- Define observability signals: stages, retries, validation, confidence, cost, latency, approval, failures.
- Define batch mode and model-comparison report.
- Define abuse monitoring and red-team cases.
- Define correction/learning-loop behavior.
- Define test layers and CI gates.

During implementation:

- Keep AI provider behind an interface.
- Keep prompts versioned.
- Keep prompt/example changes tied to eval changes.
- Use structured outputs where practical.
- Validate model output before side effects.
- Store raw and parsed artifacts when policy permits.
- Make jobs idempotent.
- Use bounded retries/backoff.
- Persist attempt/fallback lineage.
- Add status tracking and manual recovery paths.
- Add unit/integration/e2e tests according to affected domain.

Before release:

- Run relevant tests and evals.
- Run benchmark/model comparison if prompts/models/params changed.
- Confirm no quality regression.
- Confirm cost/latency within threshold.
- Confirm safety/red-team cases pass for the risk level.
- Confirm replay data excludes or protects sensitive content.
- Confirm observability and runbooks exist.
- Confirm migration/readiness/release gates pass.
- Document any accepted risk and approver.

## Quick Mental Model

Treat every AI feature as a pipeline, not a prompt.

Pipeline parts:

1. Input contract.
2. Prompt/template version.
3. Model/provider/routing policy.
4. Runtime parameters.
5. Retrieval/example context.
6. Raw output.
7. Parser/schema validation.
8. Quality/eval gate.
9. Safety/privacy gate.
10. Duplicate/novelty gate if content-producing.
11. Human review or auto-approval decision.
12. Persisted artifacts and replay metadata.
13. Metrics, cost, latency, and failure telemetry.
14. Batch/eval regression suite.
15. Rollback/recovery path.

If one of those is missing, the AI feature is probably not production-ready.

## Triple-Check Notes

I cross-checked this guide against:

- root-like agent/rule locations found in the workspace
- `newTestChampion/AGENTS.md`
- all Test Champion decision logs `0001` through `0010`
- Test Champion architecture/summary/readme/runbooks
- reusable `special-agents` AI/domain/process/base rules
- reusable AI documentation templates
- worker README/runtime controls
- database migrations backing artifact storage, duplicate checks, solve-check, taxonomy snapshots, benchmark runs, and queue reliability

I found `.agents` and `.codex` as top-level directories, but a file scan under both found no readable rule content to include.
