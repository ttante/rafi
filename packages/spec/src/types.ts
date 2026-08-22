/**
 * Rafi neutral schema — the shapes that the `special-agents` library and the
 * `ai-foreman` runtime must agree on. Authoring inputs (rule packs, skills,
 * agent manifests) and the per-project configuration that drives composition.
 */

// ───────────────────────────── Rule packs ─────────────────────────────

/** Which category a rule pack belongs to (drives default load behavior). */
export type PackCategory = "base" | "process" | "domain" | "templated";

/**
 * When a pack applies. `always` packs load for every project; the others load
 * only when the matching project flag is on (see {@link ProjectFlags}).
 */
export type PackCondition = "always" | "frontend" | "ai" | "cloud" | "backend";

/** The YAML front-matter carried by each rule pack markdown file. */
export interface RulePackFrontmatter {
  /** Unique, kebab-case identifier (e.g. `security`). */
  name: string;
  category: PackCategory;
  /** One-line summary used in indexes and pack pickers. */
  description: string;
  condition: PackCondition;
  /** True when the body contains `{{placeholders}}` / `{{#if}}` directives. */
  template: boolean;
  /** When true, the pack is omitted while the foreman ticket tracker is active. */
  supersededByForeman?: boolean;
}

/** A fully loaded rule pack: its front-matter plus the markdown body. */
export interface RulePack extends RulePackFrontmatter {
  /** The rule text (bullets) below the front-matter. */
  body: string;
}

// ───────────────────────────── Skills ─────────────────────────────

/** How a skill should be treated when flattening for Codex (which can't lazy-load). */
export type CodexPriority = "inline" | "reference";

/**
 * A skill manifest. Keeps the existing Anthropic `SKILL.md` format and adds two
 * optional composition fields that non-Rafi tools can safely ignore.
 */
export interface SkillManifest {
  /** Unique, kebab-case identifier matching the skill directory name. */
  name: string;
  /** One-line trigger description (the cheap progressive-disclosure index). */
  description: string;
  /** Rule packs this skill wants loaded alongside it. */
  pins?: string[];
  /** Whether Codex flattening should inline this skill's body or just reference it. */
  codexPriority?: CodexPriority;
  /** The skill body (instructions). Optional in metadata-only contexts. */
  body?: string;
}

// ───────────────────────────── Agents (roles) ─────────────────────────────

/** The role an agent fills, mapped to an ai-foreman turn-type or command. */
export type AgentRole = "builder" | "qa" | "planner" | "ticket-maker" | "uninstaller";

/** Reasoning effort levels accepted by the builders. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh";

/** Packs added to a role only when the matching project flag is on. */
export interface ConditionalPacks {
  ai?: string[];
  frontend?: string[];
  cloud?: string[];
  backend?: string[];
}

/**
 * A role manifest: a named composition of rule packs + skills that the runtime
 * loads for a given turn-type.
 */
export interface AgentManifest {
  /** Unique, kebab-case identifier (usually equals {@link role}). */
  name: string;
  description: string;
  role: AgentRole;
  /** Pack references; globs like `base/*` are allowed and expanded at compile time. */
  packs: string[];
  /** Skill names this role preloads. */
  skills: string[];
  /** Extra packs gated on project flags. */
  conditionalPacks?: ConditionalPacks;
  /** Model override; null inherits the runtime's `--model`. */
  model?: string | null;
  /** Effort override; null inherits the runtime's `--effort`. */
  effort?: EffortLevel | null;
}

// ───────────────────────────── Project config ─────────────────────────────

/** Which harness targets to emit native config for. */
export type HarnessTarget = "claude" | "codex";

/** The stack choices collected by `rafi create` (free-text strings). */
export interface ProjectStack {
  frontend: string;
  backend: string;
  database: string;
  cloud: string;
  packageManager: string;
}

/** Boolean flags that gate conditional packs and docs. */
export interface ProjectFlags {
  hasFrontend: boolean;
  usesAI: boolean;
  runsInCloud: boolean;
}

/** Harness emission + QA preferences. */
export interface HarnessConfig {
  targets: HarnessTarget[];
  qa: boolean;
}

/** How Rafi should handle existing root instruction files. */
export type AgentFileMode = "append" | "update" | "overwrite";

/** Root instruction files used by Codex and Claude. */
export interface AgentFilesConfig {
  mode: AgentFileMode;
  codex: string;
  claude: string;
}

/** Project documentation root used for Rafi starter docs and tracker docs. */
export interface DocsConfig {
  root: string;
}

/** Input documents carried from create into planning. Ticket setup has its own sources. */
export interface PlanningConfig {
  sources?: string[];
}

// ───────────────────────────── Workflow state ─────────────────────────────

export type PlanningMode = "standard" | "exhaustive";
export type WorkflowOutcomeKind = "completed" | "paused" | "cancelled" | "blocked" | "failed";

/** Returned by nested workflows. Only a top-level CLI maps this to an exit code. */
export interface WorkflowOutcome<T = undefined> {
  outcome: WorkflowOutcomeKind;
  stage: string;
  diagnostic?: string;
  retryCommand?: string;
  manualCommand?: string;
  value?: T;
}

export type InterviewStageStatus =
  | "not_offered" | "offered" | "accepted" | "running" | "completed"
  | "skipped" | "paused" | "failed" | "cancelled";
export type InterviewWorkflowStatus =
  | "in_progress" | "paused" | "needs_review" | "completed" | "incompatible";

export interface InterviewStageState {
  status: InterviewStageStatus;
  updatedAt: string;
}

export interface InterviewRuntimeAttempt {
  runtime: "claude" | "codex";
  at: string;
  outcome: "ready" | "failed" | "cancelled";
  category?: RuntimeProbeCategory;
}

export interface InterviewRecordV2 {
  version: 2;
  id: string;
  journeyId: string;
  parentId?: string;
  childIds: string[];
  workflow: "create" | "plan" | "tickets-plan" | "tickets-setup-init" | "tickets-setup-update";
  status: InterviewWorkflowStatus;
  checkpoint: string;
  stages: Record<string, InterviewStageState>;
  planningMode?: PlanningMode;
  invocation: Record<string, unknown>;
  decisions: Record<string, unknown>;
  runtimeAttempts: InterviewRuntimeAttempt[];
  effectiveSettings?: ResolvedAgentSettings;
  sessionIds: Record<string, string>;
  continuityLost: boolean;
  outputs: Array<{ path: string; sha256: string | null }>;
  configFingerprint?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failure?: { checkpoint: string; summary: string; at: string };
}

export type ProjectLifecycleKind = "uninitialized" | "initializing" | "initialized" | "partial" | "corrupt";
export interface ProjectLifecycleState {
  state: ProjectLifecycleKind;
  reasons: string[];
  repairCommand?: string;
  canCreate: boolean;
}

export type RuntimeProbePhase =
  | "sdk-load" | "authentication" | "compiler-update" | "capability-discovery"
  | "planning" | "ticket-planning" | "ticket-population" | "builder" | "qa"
  | "recovery" | "uninstaller" | "readiness";
export type RuntimeProbeCategory =
  | "ready" | "missing-executable" | "sdk-load" | "authentication" | "authorization"
  | "configuration" | "rate-limit" | "network" | "timeout" | "malformed-protocol"
  | "agent-stream" | "compiler-update" | "capability-discovery" | "unknown";
export interface RuntimeProbeResult {
  ok: boolean;
  runtime: "claude" | "codex";
  phase: RuntimeProbePhase;
  category: RuntimeProbeCategory;
  executable: string;
  cwd: string;
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  diagnostics: string;
  environmentNames: string[];
  recoveryChoices: Array<"retry" | "switch" | "cancel">;
}

export type ConfigurableAgentRole = AgentRole;
export type SessionStrategy = "compact" | "fresh";
export interface AgentRoleDefaultsV1 {
  /** Persisted fields are independent overrides. Resolution always fills them. */
  make?: "claude" | "codex";
  model?: string;
  reasoning?: string;
  fast?: boolean;
  session_strategy?: SessionStrategy;
}
export interface AgentDefaultsV1 {
  version: 1;
  /** Monotonically increases whenever `rafi agents` publishes new defaults. */
  revision?: number;
  roles: Partial<Record<ConfigurableAgentRole, AgentRoleDefaultsV1>>;
}
export interface ResolvedAgentSettings {
  role: ConfigurableAgentRole;
  make: "claude" | "codex";
  model: string;
  reasoning: string;
  fast: boolean;
  session_strategy: SessionStrategy;
  settings_revision: number;
  source: "cli" | "resume" | "project" | "manifest" | "provider";
}

// ───────────────────────────── Structured plans ─────────────────────────────

export interface StructuredPlanSlice {
  slice_ref: string;
  title: string;
  summary: string;
  acceptance: string[];
  required_tests: string[];
  likely_files: string[];
  depends_on: string[];
}

export interface StructuredPlanDeliveryUnit {
  id: string;
  slice_refs: string[];
  branch_mode: "current" | "per-ticket" | "shared";
  completion: TicketBuildCompletionMode;
  provider: TicketBuildProvider;
  pr_ready: boolean;
  merge_method: TicketBuildMergeMethod;
  cleanup: boolean;
  depends_on: string[];
  dependency_mode: "combine" | "wait" | "stack";
}

export interface StructuredPlanStack {
  stack_id: string;
  name: string;
  /** Ordered root-to-tip delivery-unit membership. */
  units: string[];
}

export interface StructuredPlanV1 {
  version: 1;
  plan_id: string;
  revision: number;
  content_digest: string;
  summary: string;
  assumptions: string[];
  implementation_changes: string[];
  acceptance_criteria: string[];
  test_plan: string[];
  slices: StructuredPlanSlice[];
  delivery_units: StructuredPlanDeliveryUnit[];
  stacks: StructuredPlanStack[];
}

export type WorkflowIssueCode =
  | "role_marker_missing" | "role_marker_malformed" | "role_marker_duplicated"
  | "role_marker_non_final" | "role_marker_invalid" | "role_protocol_exhausted"
  | "unstructured_agent_question" | "builder_runtime_failure" | "builder_tool_policy_failure"
  | "qa_runtime_failure" | "qa_marker_failure" | "qa_fix_status_failure"
  | "qa_nonconvergence" | "qa_file_modification"
  | "ticket_selection_failure" | "tracker_update_failure" | "ticket_completion_failure"
  | "ticket_validation_failure" | "ticket_corruption"
  | "plan_pair_mismatch" | "slice_mapping_failure" | "retirement_authorization_failure"
  | "delivery_validation_failure" | "session_missing" | "session_compaction_failure"
  | "session_model_switch_failure" | "recovery_failure" | "remote_action_denied"
  | "remote_action_failed" | "remote_action_uncertain" | "user_cancelled"
  | "terminal_incompatibility" | "depth_exceeded";

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  role?: ConfigurableAgentRole;
  phase: string;
  step?: number;
  ticket?: string;
  stack?: string;
  qa_cycle?: number;
  provider?: "claude" | "codex";
  model?: string;
  detail: string;
  human_required: boolean;
  recoverable: boolean;
  suggested_action: string;
  occurred_at: string;
}

export type OperationLifecycle = "planned" | "in_progress" | "confirmed" | "failed" | "uncertain";

export type BuildRunStatus = "running" | "interrupted" | "recoverable" | "blocked" | "completed" | "failed";
export interface BuildRunRecordV1 {
  version: 1;
  runId: string;
  status: BuildRunStatus;
  tickets: string[];
  deliveryUnit?: string;
  branchMode: "current" | "per-ticket" | "shared";
  checkpoint: string;
  currentTicket?: string;
  builder?: { settings: ResolvedAgentSettings; sessionId?: string };
  qa?: { settings: ResolvedAgentSettings; sessionId?: string };
  repository: {
    root: string;
    branch?: string;
    worktree: string;
    baseHead?: string;
    startHead?: string;
    partialFingerprint?: string;
  };
  receipts: Record<string, { completedAt: string; externalId?: string; detail?: string }>;
  lease?: { hostname: string; pid: number; processStart: string; heartbeatAt: string };
  failure?: { category: string; summary: string; at: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  legacy?: boolean;
}

export type InstallOwnershipMode = "created" | "managed-block" | "modified" | "generated" | "runtime-produced";
export interface InstallManifestEntryV1 {
  path: string;
  sha256: string | null;
  mode: InstallOwnershipMode;
  origin: string;
  marker?: string;
  backup?: string;
}
export interface InstallDependencyV1 {
  manager: "npm" | "pnpm" | "yarn" | "bun";
  package: string;
  previous?: string | null;
  installed: string;
  manifests: string[];
}
export interface InstallManifestV1 {
  version: 1;
  createdAt: string;
  updatedAt: string;
  files: InstallManifestEntryV1[];
  dependencies: InstallDependencyV1[];
}

export interface PlanningAssessmentArea {
  finding: string;
  basis: string;
  resolution: string;
  userJudgmentRequired: boolean;
}
export interface PlanningAssessment {
  scope: PlanningAssessmentArea;
  dependencies: PlanningAssessmentArea;
  failureAndEdgeCases: PlanningAssessmentArea;
  compatibilityAndRollout: PlanningAssessmentArea;
  verification: PlanningAssessmentArea;
}

export interface BuilderQaHandoff {
  ticket: string;
  requirements: string[];
  builderResult: string;
  worktree: string;
  diffSummary: string;
  tests: string[];
  evidence: string[];
}
export interface QaResult {
  outcome: "approve" | "reject" | "needs_input";
  findings: Array<{ severity: "blocking" | "warning" | "note"; message: string; evidence?: string }>;
}

export interface UninstallProposal {
  operations: Array<{
    kind: "keep" | "delete" | "edit" | "remove-dependency";
    target: string;
    reason: string;
    confidence: "high" | "medium" | "low";
  }>;
  followUpQuestion?: string;
}

/** Ticket source configured in the top-level rafi-config.yaml. */
export type TicketSetupSource =
  | {
      type: "local";
      paths: string[];
    }
  | {
      type: "linear";
      api_key_env?: string;
      team_key?: string | null;
      filter?: string | null;
    }
  | {
      type: "jira";
      site: string;
      email_env?: string;
      token_env?: string;
      jql: string;
    }
  | {
      type: "url";
      url: string;
    };

export type TicketPopulateAgentPreference = "configured" | "claude" | "codex";
export type TicketPopulateEnrichmentPolicy = "none" | "recommendations" | "agent";
export type TicketBuildBranchStrategy = "branch-per-ticket" | "batch";
export type TicketBuildCompletionMode = "pr" | "auto-merge" | "direct-merge" | "none";
export type TicketBuildProvider = "auto" | "github" | "gitlab" | "local";
export type TicketBuildMergeMethod = "squash" | "merge" | "rebase";

export interface TicketPopulateDefaultsConfig {
  source_handling?: "saved" | "prompt" | "manual";
  agent_preference?: TicketPopulateAgentPreference;
  import_cap?: number;
  comment_limit?: number;
  enrichment?: TicketPopulateEnrichmentPolicy;
  recommend_split_for_xl?: boolean;
}

export interface TicketBuildDefaultsConfig {
  branch_strategy?: TicketBuildBranchStrategy;
  completion?: TicketBuildCompletionMode;
  provider?: TicketBuildProvider;
  pr_ready?: boolean;
  merge_method?: TicketBuildMergeMethod;
  cleanup?: boolean;
  auto_merge_wait?: boolean;
  auto_merge_timeout_minutes?: number | null;
}

export interface TicketsSetupConfig {
  sources?: TicketSetupSource[];
  populate?: TicketPopulateDefaultsConfig;
  build?: TicketBuildDefaultsConfig;
}

/** Per-runtime paths for a skill or agent artifact. */
export type ArtifactSource = "rafi" | "existing";

export interface RuntimeArtifactConfig {
  artifact_source: ArtifactSource;
  claude: string;
  codex: string;
}

/**
 * The committed `rafi-config.yaml` in a target repo. Skipping the walkthrough uses
 * the library defaults, which reproduce today's hardcoded guidance.
 */
export interface ProjectConfig {
  appName: string;
  timezone: string;
  stack: ProjectStack;
  flags: ProjectFlags;
  harness: HarnessConfig;
  agent_files: AgentFilesConfig;
  docs?: DocsConfig;
  planning?: PlanningConfig;
  tickets?: TicketsSetupConfig;
  agent_defaults?: AgentDefaultsV1;
  agents: Record<string, RuntimeArtifactConfig>;
  skills: Record<string, RuntimeArtifactConfig>;
}
