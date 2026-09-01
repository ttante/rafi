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

/** Legacy planning hints. New writes use the project-wide source registry. */
export interface PlanningConfig {
  sources?: string[];
}

export type SourceSnapshotStorage = "local" | "tracked";
export type ProjectSourceType = "local" | "url" | "github" | "gitlab" | "linear" | "jira";

/** A normalized locator. Credentials are represented only by environment-variable names. */
export interface ProjectSourceLocator {
  path?: string;
  description?: string;
  url?: string;
  repository?: string;
  mode?: "issue" | "issues" | "project" | "board";
  issue?: number;
  project?: string;
  filters?: Record<string, string>;
  api_key_env?: string;
  team_key?: string | null;
  filter?: string | null;
  site?: string;
  email_env?: string;
  token_env?: string;
  jql?: string;
}

/** Immutable source capture metadata. Versions are append-only. */
export interface ProjectSourceVersion {
  fingerprint: string;
  captured_at: string;
  storage: SourceSnapshotStorage;
  snapshot_path: string;
  manifest_path: string;
  content_type?: string;
  bytes?: number;
  item_count?: number;
}

export interface ProjectSourceEntry {
  id: string;
  type: ProjectSourceType;
  label: string;
  active: boolean;
  locator: ProjectSourceLocator;
  versions: ProjectSourceVersion[];
}

export interface PendingSourceDescription {
  description: string;
  created_at: string;
}

export interface SourceRegistryConfig {
  version: 1;
  snapshot_storage: SourceSnapshotStorage;
  entries: ProjectSourceEntry[];
  pending?: PendingSourceDescription[];
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
  | "agent-stream" | "session-unavailable" | "compiler-update" | "capability-discovery" | "unknown";
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
  /** Show authoritative provider cost or trustworthy cumulative tokens. */
  display_session_cost?: boolean;
  /** Builder/QA live context threshold. Missing values normalize to 50. */
  auto_compact_threshold_percent?: number;
  /** Builder/QA successful compactions allowed per provider session. */
  compact_maximum?: number;
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
  /** Required after normalization; legacy on-disk omissions resolve to false. */
  display_session_cost: boolean;
  /** Required after normalization; legacy on-disk omissions resolve to 50. */
  auto_compact_threshold_percent: number;
  /** Required after normalization; legacy on-disk omissions resolve to 10. */
  compact_maximum: number;
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
  source_refs?: SourceVersionRef[];
}

/** Stable registry/version provenance, also accepted alongside legacy source/item fields. */
export interface SourceVersionRef {
  source_id: string;
  fingerprint: string;
  item?: string;
  url?: string | null;
  note?: string | null;
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
  | "session_model_switch_failure" | "session_unavailable" | "recovery_failure" | "remote_action_denied"
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

export type BuildRunStatus = "running" | "interrupted" | "recoverable" | "blocked" | "completed" | "failed" | "superseded";
export interface BuildRunRecordV1 {
  version: 1;
  runId: string;
  status: BuildRunStatus;
  tickets: string[];
  deliveryUnit?: string;
  branchMode: "current" | "per-ticket" | "shared" | "mixed";
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

export interface BuildGitSnapshotV2 {
  baselineHead?: string;
  baseRef?: string;
  branch?: string;
  startHead?: string;
  worktree: string;
  worktreeIdentity?: string;
  statusPaths: string[];
  initialStatusPaths: string[];
  runOwnedPaths: string[];
  createdBranch: boolean;
  createdWorktree: boolean;
  upstream?: string;
}

export interface BuildRunRecordV2 extends Omit<BuildRunRecordV1, "version" | "repository" | "legacy"> {
  version: 2;
  repository: BuildRunRecordV1["repository"] & { git: BuildGitSnapshotV2; baselineComplete: boolean };
  progress: {
    completedTickets: string[];
    completedOperations: string[];
    currentStep?: string;
    remainingTickets: string[];
    lastSuccessfulAction?: string;
    nextAction?: string;
    validation?: { status: string; qa?: string; evidence?: string[] };
  };
  interruption?: { category: string; summary: string; lastError?: string; at: string };
  supersededBy?: string;
  /** True only when this V2 view was upgraded from a record with incomplete V1 metadata. */
  legacy?: boolean;
  /** Frozen run-level workflow/Git decisions. Optional on old V2 records. */
  runDecisions?: {
    workMode: TicketBuildBranchStrategy;
    workModeSource: "project" | "cli" | "resume";
    branchPrefix: string;
    branchPrefixSource: "project" | "cli" | "builtin" | "resume";
    autoCompactThresholdPercent: number;
    thresholdSource: "project" | "cli" | "live" | "resume";
  };
  recoveryDecision?: BuildRecoveryDecisionReceipt;
  /** Canonical provider conversations observed for this run. Raw role sessionIds remain compatibility mirrors only. */
  sessionBindings?: ProviderSessionRefV1[];
}
export type BuildRunRecord = BuildRunRecordV1 | BuildRunRecordV2;

export type InstallOwnershipMode = "created" | "managed-block" | "modified" | "generated" | "runtime-produced";
export interface InstallManifestEntryV1 {
  path: string;
  sha256: string | null;
  mode: InstallOwnershipMode;
  origin: string;
  marker?: string;
  backup?: string;
}
export type InstallOwnershipCategory =
  | "tickets" | "plans" | "skills" | "agents" | "rules" | "config"
  | "documentation-created" | "documentation-modified" | "managed-gitignore"
  | "runtime-state" | "generated-other";
export interface InstallManifestEntryV2 extends InstallManifestEntryV1 {
  category: InstallOwnershipCategory;
  preimageSha256?: string | null;
  installedSha256?: string | null;
  lastRafiWriteAt?: string;
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
export interface InstallManifestV2 {
  version: 2;
  createdAt: string;
  updatedAt: string;
  repository: {
    rootIdentity: string;
    preInstallHead?: string;
    initialBranch?: string;
    initialDirtyDigest?: string;
    dirtyChoice: "clean" | "snapshot-and-continue" | "stop-and-clean" | "legacy-unknown";
    baselineComplete: boolean;
  };
  files: InstallManifestEntryV2[];
  dependencies: InstallDependencyV1[];
}
export type InstallManifest = InstallManifestV1 | InstallManifestV2;

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
export type TicketBuildBranchStrategy = "current" | "batch" | "branch-per-ticket";
export type TicketBranchPolicyMode = "global" | "size";
export type TicketTitleStyle = "ticket-title" | "conventional" | "none" | "custom";
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
  base_branch?: string;
  branch_prefix?: string;
  branch_policy?: {
    mode: TicketBranchPolicyMode;
    global_strategy: TicketBuildBranchStrategy;
    by_size: Record<"XS" | "S" | "M" | "L" | "XL", "shared" | "per-ticket">;
  };
  review?: {
    title_style: TicketTitleStyle;
    title_template?: string | null;
    description_sections: string[];
  };
  validation_checklist?: string[];
}

export interface TicketsSetupConfig {
  sources?: TicketSetupSource[];
  populate?: TicketPopulateDefaultsConfig;
  build?: TicketBuildDefaultsConfig;
  limits?: { implementation: number; view: number };
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
  sources?: SourceRegistryConfig;
  tickets?: TicketsSetupConfig;
  agent_defaults?: AgentDefaultsV1;
  agents: Record<string, RuntimeArtifactConfig>;
  skills: Record<string, RuntimeArtifactConfig>;
}

// ───────────────────────── Ticket creation groups ─────────────────────────

export type TicketGroupId = `TG-${number}`;
export type TicketGroupOrigin =
  | "ticket-plan" | "ticket-populate" | "import" | "future-work"
  | "production" | "legacy" | "repair";

export interface SavedTicketDefinitionSnapshot {
  version: 1;
  ticketId: string;
  definition: unknown;
  digest: string;
  validatedAt: string;
}

export interface TicketGroupMember {
  groupId: TicketGroupId;
  ticketId: string;
  position: number;
  snapshot: SavedTicketDefinitionSnapshot;
}

export interface TicketGroup {
  id: TicketGroupId;
  sequence: number;
  origin: TicketGroupOrigin;
  createdAt: string;
  legacy: boolean;
  operationId: string;
  members: TicketGroupMember[];
}

export type RequestedTicketResetTarget =
  | { kind: "all-groups" }
  | { kind: "recent-groups"; count: number }
  | { kind: "group"; groupId: TicketGroupId }
  | { kind: "group-index"; position: number }
  | { kind: "ticket"; ticketId: string }
  | { kind: "scope"; scope: "all" | "completed-and-unfinished" | "unfinished" }
  | { kind: "run"; ticketIds: string[] };

export type DeletedTicketResetPolicy = "ignore" | "restore";
export interface ResolvedTicketResetSelection {
  version: 1;
  requested: RequestedTicketResetTarget;
  resolvedAt: string;
  groups: Array<{ id: TicketGroupId; sequence: number; memberTicketIds: string[] }>;
  ticketIds: string[];
  previewRows: Array<{ ticketId: string; title: string; status: string; definitionMissing: boolean; restoreDefinition: boolean }>;
  definitionRestorations: Array<{ ticketId: string; digest: string; restore: boolean; dependencyOnly?: boolean }>;
  relatedRuns: Array<{ runId: string; status: string; tickets: string[] }>;
  inputFingerprint: string;
}

// ─────────────────────── Context/session observability ─────────────────────

/** Location-scoped provider conversation identity. */
export interface ProviderSessionRefV1 {
  version: 1;
  provider: "claude" | "codex";
  sessionId: string;
  role: ConfigurableAgentRole;
  stream: string;
  /** Zero-based conversation generation. Native compaction does not change it. */
  generation: number;
  /** Canonical provider working directory. */
  cwd: string;
  /** Canonical project root containing Rafi configuration and durable recovery state. */
  configRoot: string;
  workspaceIdentity?: string;
  ticketId?: string;
  deliveryUnitId?: string;
  source: "observed" | "legacy-inferred";
  createdAt: string;
  validatedAt?: string;
}

export type SessionAvailabilityStatus = "available" | "unavailable" | "unknown";
export type SessionAvailabilityReason =
  | "not-found"
  | "cwd-mismatch"
  | "config-root-mismatch"
  | "workspace-mismatch"
  | "provider-mismatch"
  | "role-mismatch"
  | "stream-mismatch"
  | "legacy-unscoped"
  | "attach-failed"
  | "probe-failed";

/** Result of validating a scoped provider conversation. Only `available` authorizes exact resume. */
export interface SessionAvailabilityV1 {
  version: 1;
  status: SessionAvailabilityStatus;
  checkedAt: string;
  reason?: SessionAvailabilityReason;
  observedCwd?: string;
  detail?: string;
  sessionRef?: ProviderSessionRefV1;
}

export type ContextSampleSource = "provider-event" | "provider-query" | "post-compact";
export type ContextSampleFreshness = "measuring" | "fresh" | "stale" | "unavailable";
export interface ContextSample {
  version: 1;
  runId: string;
  role: "builder" | "qa";
  provider: "claude" | "codex";
  providerSessionId?: string;
  sessionRef?: ProviderSessionRefV1;
  sessionKey?: string;
  model: string;
  observedAt: string;
  source: ContextSampleSource;
  freshness: ContextSampleFreshness;
  used?: number;
  maximum?: number;
  percentage?: number;
  settingsRevision: number;
  compactionCount: number;
  handoffGeneration: number;
}

export interface SessionUsageSample {
  version: 1;
  runId: string;
  role: "builder" | "qa";
  provider: "claude" | "codex";
  providerSessionId?: string;
  sessionRef?: ProviderSessionRefV1;
  sessionKey?: string;
  observedAt: string;
  source: "provider" | "turn-aggregate" | "unavailable";
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeTotalTokens?: number;
  authoritativeCostUsd?: number;
}

export interface LiveSettingsRevision {
  revision: number;
  publishedAt: string;
  settings: AgentDefaultsV1;
}
export interface LiveSettingsAcknowledgment {
  runId: string;
  role: "builder" | "qa";
  providerSessionId?: string;
  sessionRef?: ProviderSessionRefV1;
  sessionKey?: string;
  revision: number;
  acknowledgedAt: string;
}

// ───────────────────── Continuity, handoff, and recovery ───────────────────

export type ContinuityHeadState = "current" | "degraded" | "stale" | "invalid";
export interface ContinuityDelta {
  version: 1;
  decisions: string[];
  constraints: string[];
  discoveries: string[];
  completedActions: string[];
  evidence: string[];
  failures: string[];
  blockers: string[];
  openWork: string[];
  nextAction: string;
}
export interface ContinuityEvent {
  sequence: number;
  runId: string;
  role: "builder" | "qa" | "host";
  kind: string;
  payload: unknown;
  digest: string;
  authoritativeStateRevision: number;
  createdAt: string;
  sessionRef?: ProviderSessionRefV1;
  sessionKey?: string;
}
export interface ContinuityCheckpoint {
  checkpointId: number;
  runId: string;
  role: "builder" | "qa";
  sequence: number;
  state: ContinuityHeadState;
  delta: ContinuityDelta;
  digest: string;
  predecessorDigest?: string;
  authoritativeStateRevision: number;
  createdAt: string;
  sessionRef?: ProviderSessionRefV1;
  sessionKey?: string;
}
export interface ContinuityHead {
  runId: string;
  role: "builder" | "qa" | "run";
  state: ContinuityHeadState;
  sequence: number;
  digest: string;
  authoritativeStateRevision: number;
  updatedAt: string;
}

export interface HandoffManifestV1 {
  version: 1;
  runId: string;
  generation: number;
  role: "builder" | "qa";
  reason: string;
  predecessorSessionId?: string;
  successorSessionId?: string;
  predecessorSessionRef?: ProviderSessionRefV1;
  successorSessionRef?: ProviderSessionRefV1;
  predecessorManifestDigest?: string;
  continuityCheckpointDigest: string;
  authoritativeStateDigest: string;
  cumulative: ContinuityDelta;
  roleState: Record<string, unknown>;
  lineage: string[];
  sessionUsage?: SessionUsageSample;
  compactionCount: number;
  compactMaximum: number;
  resources: Array<{ label: string; digest: string; authoritative: boolean }>;
  createdAt: string;
}
export interface HandoffLineage {
  runId: string;
  generation: number;
  manifestDigest: string;
  markdownDigest: string;
  predecessorSessionId?: string;
  successorSessionId?: string;
  predecessorSessionRef?: ProviderSessionRefV1;
  successorSessionRef?: ProviderSessionRefV1;
  state: "staged" | "accepted" | "failed";
  createdAt: string;
  acceptedAt?: string;
}

export type BuildRecoveryMode = "exact-session" | "fresh-with-handoff" | "fresh-recovery-only" | "guided-recovery";
export interface BuildRecoveryDecisionReceipt {
  version: 1;
  mode: BuildRecoveryMode;
  runId: string;
  tickets: string[];
  role: "builder" | "qa";
  checkpointDigest?: string;
  handoffDigest?: string;
  authoritativeStateDigest: string;
  settings: ResolvedAgentSettings;
  worktree: string;
  branch?: string;
  predecessorSessionId?: string;
  predecessorSessionRef?: ProviderSessionRefV1;
  successorSessionRef?: ProviderSessionRefV1;
  sessionAvailability?: SessionAvailabilityV1;
  requestedSuccessor?: { agent?: "claude" | "codex"; model?: string };
  /** Invocation-scoped policy for implementation-plan reviews in the resumed process. */
  planUpdateApproval: "auto" | "review";
  decidedAt: string;
}
