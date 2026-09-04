import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AutonomyConfig,
  AutonomyProfile,
  InterruptionDomain,
  PendingHumanDecision,
  RecoveryDisposition,
  RecoveryRuleId,
  ResolvedAutonomyPolicy,
  StructuredInterruption,
  WorkflowIssueCode,
} from "rafi-spec";
import { WorkflowDb } from "./workflowDb.js";

const RULES: readonly RecoveryRuleId[] = ["qa.nonconvergence", "runtime.transient", "plan.material_change"];

const PROFILE_LIMITS: Record<AutonomyProfile, Omit<ResolvedAutonomyPolicy, "version" | "profile" | "continueIndependentTickets" | "rules" | "supervisorEnabled" | "resolvedAt" | "digest">> = {
  supervised: {
    limits: { builderQaFixesPerTicket: 2, transientPreDispatchRetries: 0, protocolCorrections: 1, reconciledOperationRetries: 0, workerRestartsPerCheckpoint: 0, workerRestartsPerRun: 0 },
    providerFallback: "never", planChanges: "review-all",
  },
  balanced: {
    limits: { builderQaFixesPerTicket: 3, transientPreDispatchRetries: 3, protocolCorrections: 2, reconciledOperationRetries: 2, workerRestartsPerCheckpoint: 3, workerRestartsPerRun: 10 },
    providerFallback: "safe-boundaries", planChanges: "review-material",
  },
  unattended: {
    limits: { builderQaFixesPerTicket: 5, transientPreDispatchRetries: 5, protocolCorrections: 3, reconciledOperationRetries: 4, workerRestartsPerCheckpoint: 5, workerRestartsPerRun: 10 },
    providerFallback: "safe-boundaries", planChanges: "auto-bounded",
  },
};

export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  profile: "balanced",
  continue_independent_tickets: true,
  rules: {
    "qa.nonconvergence": { action: "retry_builder", max_attempts: 3 },
    "runtime.transient": { action: "retry", max_attempts: 3 },
    "plan.material_change": { action: "human_required" },
  },
  supervisor: { enabled: true, max_worker_restarts_per_checkpoint: 3, max_worker_restarts_per_run: 10 },
};

export function loadProjectAutonomyConfig(projectDir: string): AutonomyConfig | undefined {
  const path = join(projectDir, "rafi-config.yaml");
  if (!existsSync(path)) return undefined;
  const raw = parseYaml(readFileSync(path, "utf8")) as { autonomy?: unknown } | undefined;
  return raw?.autonomy === undefined ? undefined : validateAutonomyConfig(raw.autonomy);
}

/** QA precedence: CLI -> frozen run -> canonical project config -> legacy foreman.yaml. */
export function resolveQaEnablement(input: { cli?: boolean; frozen?: boolean; projectDir: string; legacyForeman?: boolean }): { enabled: boolean; source: "cli" | "frozen" | "project" | "legacy-foreman" | "default"; deprecationWarning?: string } {
  if (input.cli !== undefined) return { enabled: input.cli, source: "cli" };
  if (input.frozen !== undefined) return { enabled: input.frozen, source: "frozen" };
  const path = join(input.projectDir, "rafi-config.yaml");
  if (existsSync(path)) {
    const raw = parseYaml(readFileSync(path, "utf8")) as { autonomy?: unknown; harness?: { qa?: unknown } } | undefined;
    if (raw?.autonomy !== undefined) return { enabled: raw.harness?.qa !== false, source: "project" };
  }
  if (input.legacyForeman !== undefined) return { enabled: input.legacyForeman, source: "legacy-foreman", deprecationWarning: "foreman.yaml qa.enabled is deprecated; set harness.qa and autonomy in rafi-config.yaml" };
  return { enabled: true, source: "default" };
}

export function validateAutonomyConfig(value: unknown): AutonomyConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("autonomy must be an object");
  const input = value as Record<string, unknown>;
  rejectUnknown(input, ["profile", "continue_independent_tickets", "rules", "supervisor"], "autonomy");
  if (!(["supervised", "balanced", "unattended"] as unknown[]).includes(input.profile)) throw new Error("autonomy.profile must be supervised, balanced, or unattended");
  if (typeof input.continue_independent_tickets !== "boolean") throw new Error("autonomy.continue_independent_tickets must be a boolean");
  if (!input.supervisor || typeof input.supervisor !== "object" || Array.isArray(input.supervisor)) throw new Error("autonomy.supervisor must be an object");
  const supervisor = input.supervisor as Record<string, unknown>;
  rejectUnknown(supervisor, ["enabled", "max_worker_restarts_per_checkpoint", "max_worker_restarts_per_run"], "autonomy.supervisor");
  if (typeof supervisor.enabled !== "boolean") throw new Error("autonomy.supervisor.enabled must be a boolean");
  positiveInteger(supervisor.max_worker_restarts_per_checkpoint, "autonomy.supervisor.max_worker_restarts_per_checkpoint", true);
  positiveInteger(supervisor.max_worker_restarts_per_run, "autonomy.supervisor.max_worker_restarts_per_run", true);
  const overrides: AutonomyConfig["rules"] = {};
  if (input.rules !== undefined) {
    if (!input.rules || typeof input.rules !== "object" || Array.isArray(input.rules)) throw new Error("autonomy.rules must be an object");
    const rawRules = input.rules as Record<string, unknown>;
    rejectUnknown(rawRules, [...RULES], "autonomy.rules");
    for (const [id, raw] of Object.entries(rawRules)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`autonomy.rules.${id} must be an object`);
      const rule = raw as Record<string, unknown>; rejectUnknown(rule, ["action", "max_attempts"], `autonomy.rules.${id}`);
      const allowed = id === "qa.nonconvergence" ? ["retry_builder", "human_required"] : id === "runtime.transient" ? ["retry", "human_required"] : ["human_required"];
      if (!allowed.includes(String(rule.action))) throw new Error(`autonomy.rules.${id}.action is unsafe or unsupported`);
      if (rule.max_attempts !== undefined) positiveInteger(rule.max_attempts, `autonomy.rules.${id}.max_attempts`, true);
      overrides[id as RecoveryRuleId] = { action: rule.action as "retry_builder" | "retry" | "human_required", ...(rule.max_attempts === undefined ? {} : { max_attempts: Number(rule.max_attempts) }) };
    }
  }
  return {
    profile: input.profile as AutonomyProfile,
    continue_independent_tickets: input.continue_independent_tickets,
    rules: overrides,
    supervisor: { enabled: supervisor.enabled, max_worker_restarts_per_checkpoint: Number(supervisor.max_worker_restarts_per_checkpoint), max_worker_restarts_per_run: Number(supervisor.max_worker_restarts_per_run) },
  };
}

export function resolveAutonomyPolicy(config: Partial<AutonomyConfig> | undefined, profileOverride?: AutonomyProfile, now = new Date()): ResolvedAutonomyPolicy {
  const profile = profileOverride ?? config?.profile ?? "balanced";
  const defaults = PROFILE_LIMITS[profile];
  const supervisor = config?.supervisor ?? DEFAULT_AUTONOMY_CONFIG.supervisor;
  const defaultRules: ResolvedAutonomyPolicy["rules"] = {
    "qa.nonconvergence": { action: profile === "supervised" ? "human_required" : "retry_builder", max_attempts: defaults.limits.builderQaFixesPerTicket },
    "runtime.transient": { action: defaults.limits.transientPreDispatchRetries ? "retry" : "human_required", max_attempts: defaults.limits.transientPreDispatchRetries },
    "plan.material_change": { action: profile === "unattended" ? "retry" : "human_required", max_attempts: profile === "unattended" ? 1 : 0 },
  };
  const policyWithoutDigest = {
    version: 1 as const, profile,
    continueIndependentTickets: config?.continue_independent_tickets ?? profile !== "supervised",
    limits: {
      ...defaults.limits,
      workerRestartsPerCheckpoint: supervisor.max_worker_restarts_per_checkpoint,
      workerRestartsPerRun: supervisor.max_worker_restarts_per_run,
    },
    providerFallback: defaults.providerFallback,
    planChanges: defaults.planChanges,
    rules: Object.fromEntries(RULES.map((id) => [id, { ...defaultRules[id], ...(config?.rules?.[id] ?? {}) }])) as ResolvedAutonomyPolicy["rules"],
    supervisorEnabled: supervisor.enabled,
    resolvedAt: now.toISOString(),
  };
  return { ...policyWithoutDigest, digest: digestPolicy(policyWithoutDigest) };
}

export function mapWorkflowIssueDomain(code: WorkflowIssueCode): InterruptionDomain {
  if (code.startsWith("qa_")) return "qa";
  if (code.startsWith("role_") || code === "unstructured_agent_question") return "agent-protocol";
  if (code.includes("runtime") || code === "session_unavailable") return "runtime";
  if (code.startsWith("session_") || code === "recovery_failure") return "continuity";
  if (code.startsWith("ticket_") || code === "tracker_update_failure") return "tracker/dependency";
  if (code.startsWith("plan_") || code === "slice_mapping_failure" || code === "retirement_authorization_failure") return "gate/plan";
  if (code.startsWith("delivery_") || code.startsWith("remote_action_")) return "delivery";
  if (code === "builder_tool_policy_failure") return "permissions";
  if (code === "terminal_incompatibility" || code === "depth_exceeded") return "process";
  return "unknown";
}

const HARD_BOUNDARY_CODES = new Set<string>([
  "qa_waiver", "builder_tool_policy_failure", "remote_action_denied", "remote_action_uncertain",
  "ticket_corruption", "ticket_validation_failure", "plan_pair_mismatch", "slice_mapping_failure",
  "retirement_authorization_failure", "workspace_integrity_drift", "semantic_scope_ambiguity",
  "invalid_dependency_semantics", "unknown",
]);

export function evaluateRecovery(policy: ResolvedAutonomyPolicy, interruption: StructuredInterruption, attemptsUsed: number): RecoveryDisposition {
  if (interruption.domain === "unknown" || HARD_BOUNDARY_CODES.has(interruption.code)) return disposition("human_required", "pause", "hard safety boundary requires human review", 0, attemptsUsed);
  if (interruption.code === "user_cancelled") return disposition("terminal", "stop", "the user cancelled the run", 0, attemptsUsed);
  if (interruption.dispatchState === "unknown") return disposition("human_required", "pause", "dispatch could not be reconciled; replay may duplicate a mutation", 0, attemptsUsed);
  if (interruption.domain === "qa" && interruption.code === "qa_nonconvergence") {
    const rule = policy.rules["qa.nonconvergence"];
    const max = rule.max_attempts ?? policy.limits.builderQaFixesPerTicket;
    if (rule.action === "retry_builder" && attemptsUsed < max) return { ...disposition("configured_decision", "retry_builder", "frozen qa.nonconvergence rule permits another Builder fix", max, attemptsUsed), rule: "qa.nonconvergence" };
    return { ...disposition("human_required", "pause", "Builder QA fix budget exhausted", max, attemptsUsed), rule: "qa.nonconvergence" };
  }
  if (interruption.domain === "runtime" && ["network", "timeout", "rate-limit", "readiness", "builder_runtime_failure", "qa_runtime_failure"].includes(interruption.code)) {
    const rule = policy.rules["runtime.transient"];
    const max = rule.max_attempts ?? policy.limits.transientPreDispatchRetries;
    if (rule.action === "retry" && attemptsUsed < max && (interruption.dispatchState === "not_dispatched" || interruption.dispatchState === "idempotent")) return { ...disposition("auto_retry", "retry", "transient operation is safe to replay", max, attemptsUsed), rule: "runtime.transient" };
    return { ...disposition("human_required", "pause", "transient retry is unsafe or exhausted", max, attemptsUsed), rule: "runtime.transient" };
  }
  if (interruption.domain === "agent-protocol" || interruption.domain === "continuity") {
    const max = policy.limits.protocolCorrections;
    return attemptsUsed < max ? disposition("auto_retry", "correct_protocol", "bounded protocol/continuity correction", max, attemptsUsed) : disposition("human_required", "pause", "protocol correction budget exhausted", max, attemptsUsed);
  }
  if (interruption.operation && interruption.dispatchState === "dispatched") {
    const max = policy.limits.reconciledOperationRetries;
    return attemptsUsed < max ? disposition("reconcile_then_retry", "reconcile", "external mutation must be reconciled before replay", max, attemptsUsed) : disposition("human_required", "pause", "reconciled operation retry budget exhausted", max, attemptsUsed);
  }
  return disposition("human_required", "pause", "no safe automatic disposition is registered", 0, attemptsUsed);
}

export function qaDecisionChoices(): PendingHumanDecision["choices"] {
  return [
    { id: "retry_builder_once", label: "Retry Builder once" },
    { id: "planner_remediation", label: "Ask Planner for read-only remediation" },
    { id: "waive_qa", label: "Waive QA", requiresConfirmation: true },
    { id: "pause", label: "Pause" },
  ];
}

export class RecoveryDispatcher {
  constructor(private readonly db: WorkflowDb, private readonly policy: ResolvedAutonomyPolicy) {}

  async dispatch(input: {
    interruption: StructuredInterruption;
    reconcile?: () => Promise<"confirmed" | "absent" | "uncertain">;
    execute: (disposition: RecoveryDisposition) => Promise<{ ok: boolean; detail?: string }>;
  }): Promise<{ disposition: RecoveryDisposition; decision?: PendingHumanDecision; attemptId?: string }> {
    const interruption = this.db.recordInterruption(input.interruption);
    let effective = interruption;
    if (effective.dispatchState === "unknown" && input.reconcile) {
      const result = await input.reconcile();
      effective = { ...effective, dispatchState: result === "absent" ? "not_dispatched" : result === "confirmed" ? "dispatched" : "unknown" };
    }
    const operationKey = effective.operation?.idempotencyKey ?? `${effective.domain}:${effective.code}`;
    const attempts = this.db.recoveryAttemptCount(effective.runId, effective.ticket, effective.phase, effective.cause, operationKey);
    const disposition = evaluateRecovery(this.policy, effective, attempts);
    if (disposition.kind === "human_required") {
      const decision = this.db.ensureHumanDecision({
        decisionKey: `${effective.id}:${operationKey}`, runId: effective.runId, interruptionId: effective.id,
        prompt: effective.domain === "qa" ? "QA recovery needs a decision" : disposition.reason,
        choices: effective.domain === "qa" ? qaDecisionChoices() : [{ id: "retry_once", label: "Retry once" }, { id: "pause", label: "Pause" }], evidence: effective.evidence,
      });
      return { disposition, decision };
    }
    if (disposition.kind === "terminal") return { disposition };
    const runId = effective.runId;
    const receipt = this.db.recordRecoveryAttempt({
      attemptId: randomUUID(), runId, ticket: effective.ticket, phase: effective.phase, cause: effective.cause,
      operationKey, attempt: attempts + 1, disposition: disposition.kind, action: disposition.action,
      outcome: "intended", intendedAt: new Date().toISOString(),
    });
    this.db.updateRecoveryAttempt(receipt.attemptId, "started");
    try {
      const result = await input.execute(disposition);
      this.db.updateRecoveryAttempt(receipt.attemptId, result.ok ? "succeeded" : "failed", result.detail);
    } catch (error) {
      this.db.updateRecoveryAttempt(receipt.attemptId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
    return { disposition, attemptId: receipt.attemptId };
  }
}

function disposition(kind: RecoveryDisposition["kind"], action: string, reason: string, maxAttempts: number, attemptsUsed: number): RecoveryDisposition {
  return { kind, action, reason, maxAttempts, attemptsUsed };
}
function positiveInteger(value: unknown, path: string, allowZero = false): void {
  if (!Number.isInteger(value) || Number(value) < (allowZero ? 0 : 1)) throw new Error(`${path} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
}
function rejectUnknown(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}: unknown setting ${key}`);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
function digestPolicy(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
