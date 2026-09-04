import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import type { AutonomyProfile, BuildRunRecord, BuildRunRecordV1, BuildRunRecordV2, BuildRunRecordV3, ProviderSessionRefV1, ResolvedAgentSettings, ResolvedAutonomyPolicy, SessionAvailabilityV1 } from "rafi-spec";
import { WorkflowDb, heartbeatCurrentWorkflowLease, readCurrentWorkflowLease, type WorkflowRunStatus } from "./workflowDb.js";
import { WorkflowReader } from "./workflowReader.js";
import { canonicalSessionPath, captureWorkspaceIdentity, createProviderSessionRef, latestSessionBinding, upsertSessionBinding } from "./sessionIdentity.js";
import { resolveProviderSessionAvailability, type ResolveSessionAvailabilityOptions } from "./sessionAvailability.js";
import { captureCurrentWorkflowSessionIdentity, currentWorkflowIdentityKey } from "./branch/currentGuard.js";
import { isTicketsInitialized, loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import { loadProjectAutonomyConfig, resolveAutonomyPolicy } from "./recoveryPolicy.js";

export const BUILD_RUN_VERSION = 3;
export const BUILD_RUN_DIRECTORY = ".foreman/runs";
export const BUILD_HEARTBEAT_MS = 10_000;
export const BUILD_LEASE_STALE_MS = 45_000;

export interface CreateBuildRunInput {
  runId?: string;
  tickets: string[];
  deliveryUnit?: string;
  branchMode?: BuildRunRecordV2["branchMode"];
  repositoryRoot: string;
  worktree?: string;
  branch?: string;
  baseHead?: string;
  baseRef?: string;
  startHead?: string;
  builder?: LegacyResolvedAgentSettings;
  qa?: LegacyResolvedAgentSettings;
  runDecisions?: BuildRunRecordV2["runDecisions"];
  autonomyProfile?: AutonomyProfile;
  frozenPolicy?: ResolvedAutonomyPolicy;
  qaEnabled?: boolean;
  now?: Date;
}

export function createBuildRun(input: CreateBuildRunInput): BuildRunRecordV2 {
  const now = input.now ?? new Date();
  // Complete the one-time legacy import before the new mutable build snapshot
  // exists, so a brand-new run is never mistaken for legacy input.
  const migration = new WorkflowDb(input.repositoryRoot);
  migration.close();
  const stamp = now.toISOString();
  const worktree = resolve(input.worktree ?? input.repositoryRoot);
  const snapshot = captureGitSnapshot(worktree, input);
  const frozenPolicy = input.frozenPolicy ?? resolveAutonomyPolicy(loadProjectAutonomyConfig(input.repositoryRoot), input.autonomyProfile, now);
  const run: BuildRunRecordV3 = {
    version: 3,
    runId: input.runId ?? randomUUID(),
    status: "running",
    tickets: [...input.tickets],
    deliveryUnit: input.deliveryUnit,
    branchMode: input.branchMode ?? "current",
    checkpoint: "created",
    currentTicket: input.tickets[0],
    builder: input.builder ? { settings: normalizeCapturedSettings(input.builder) } : undefined,
    qa: input.qa ? { settings: normalizeCapturedSettings(input.qa) } : undefined,
    repository: {
      root: resolve(input.repositoryRoot),
      worktree,
      branch: input.branch ?? snapshot.branch,
      baseHead: input.baseHead ?? snapshot.baselineHead,
      startHead: input.startHead ?? snapshot.startHead,
      git: snapshot,
      baselineComplete: Boolean(snapshot.baselineHead && snapshot.startHead && snapshot.branch),
    },
    progress: { completedTickets: [], completedOperations: [], remainingTickets: [...input.tickets], nextAction: input.tickets[0] ? `Start ${input.tickets[0]}` : "Plan next work" },
    frozenPolicy,
    phase: "created",
    qaEnabled: input.qaEnabled ?? Boolean(input.qa),
    recoveryAttempts: [],
    supervisor: { status: frozenPolicy.supervisorEnabled ? "starting" : "disabled", generation: 0, workerGeneration: 0, checkpointRestarts: 0, runRestarts: 0 },
    pendingDecisions: [],
    deferredTickets: [],
    runDecisions: input.runDecisions,
    receipts: {},
    lease: currentLease(now),
    createdAt: stamp,
    updatedAt: stamp,
  };
  const saved = saveBuildRun(input.repositoryRoot, run, now);
  const workflow = new WorkflowDb(input.repositoryRoot);
  try { workflow.acquireLease(saved.runId, undefined, now, BUILD_LEASE_STALE_MS); } finally { workflow.close(); }
  return saved;
}

export function resumeBuildRun(projectDir: string, runId: string, patch: { builder?: LegacyResolvedAgentSettings; qa?: LegacyResolvedAgentSettings; builderSessionId?: string | null; builderSessionRef?: ProviderSessionRefV1 | null }, now = new Date()): BuildRunRecordV2 {
  const existing = readBuildRuns(projectDir).find((run) => run.runId === runId);
  if (!existing) throw new Error(`recoverable build run not found: ${runId}`);
  if (existing.status === "completed") throw new Error(`build run ${runId} is already complete`);
  const workflow = new WorkflowDb(projectDir);
  try { workflow.acquireLease(runId, undefined, now, BUILD_LEASE_STALE_MS); } finally { workflow.close(); }
  const clearBuilderSession = patch.builderSessionId === null && patch.builderSessionRef === null;
  const builderSessionId = clearBuilderSession
    ? undefined
    : patch.builderSessionRef?.sessionId ?? patch.builderSessionId ?? existing.builder?.sessionId;
  return saveBuildRun(projectDir, {
    ...existing, status: "running", checkpoint: "recovery-resumed", completedAt: undefined,
    builder: patch.builder ? { settings: normalizeCapturedSettings(patch.builder), ...(builderSessionId ? { sessionId: builderSessionId } : {}) } : existing.builder,
    qa: patch.qa ? { settings: normalizeCapturedSettings(patch.qa), sessionId: existing.qa?.sessionId } : existing.qa,
    sessionBindings: patch.builderSessionRef ? upsertSessionBinding(existing.sessionBindings, patch.builderSessionRef) : existing.sessionBindings,
    lease: currentLease(now),
  }, now);
}

type LegacyResolvedAgentSettings = Omit<ResolvedAgentSettings, "session_strategy" | "settings_revision" | "display_session_cost" | "auto_compact_threshold_percent" | "compact_maximum"> & Partial<Pick<ResolvedAgentSettings, "session_strategy" | "settings_revision" | "display_session_cost" | "auto_compact_threshold_percent" | "compact_maximum">>;
function normalizeCapturedSettings(settings: LegacyResolvedAgentSettings): ResolvedAgentSettings {
  return {
    ...settings,
    session_strategy: settings.session_strategy ?? (["builder", "qa", "ticket-maker"].includes(settings.role) ? "compact" : "fresh"),
    display_session_cost: settings.display_session_cost ?? false,
    auto_compact_threshold_percent: settings.auto_compact_threshold_percent ?? 50,
    compact_maximum: settings.compact_maximum ?? 10,
    settings_revision: settings.settings_revision ?? 0,
  };
}

export function saveBuildRun(projectDir: string, run: BuildRunRecordV2, now = new Date()): BuildRunRecordV2 {
  validateBuildRun(run);
  const directory = join(resolve(projectDir), BUILD_RUN_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const upgraded = upgradeBuildRun(run, projectDir, now);
  const completedOperations = Object.keys(upgraded.receipts).sort();
  let next: BuildRunRecordV3 = {
    ...upgraded,
    progress: { ...run.progress, completedOperations, remainingTickets: remainingTickets(run) },
    updatedAt: now.toISOString(),
  };
  const workflow = new WorkflowDb(projectDir);
  try {
    const frozenPolicy = workflow.freezeAutonomyPolicy(next.runId, next.frozenPolicy, now);
    next = { ...next, frozenPolicy, recoveryAttempts: workflow.recoveryAttempts(next.runId), pendingDecisions: workflow.pendingHumanDecisions(next.runId), supervisor: workflow.supervisorState(next.runId) ?? next.supervisor };
    const existing = workflow.getRun(next.runId);
    if (!existing) workflow.createRun({
      runId: next.runId, kind: "build", checkpoint: next.checkpoint,
      originalWork: { tickets: next.tickets, deliveryUnit: next.deliveryUnit, branchMode: next.branchMode },
      remainingWork: { tickets: remainingTickets(next) }, state: next as unknown as Record<string, unknown>,
    }, now);
    else workflow.transition(next.runId, {
      status: workflowStatus(next.status), checkpoint: next.checkpoint,
      remainingWork: { tickets: remainingTickets(next) }, state: next as unknown as Record<string, unknown>, event: "build_snapshot",
    }, now);
    if (next.builder?.sessionId) workflow.recordSession(next.runId, "builder", "builder", latestSessionBinding(next.sessionBindings, "builder", next.builder.sessionId) ?? next.builder.sessionId, "checkpoint", next.builder.settings, now);
    if (next.qa?.sessionId) workflow.recordSession(next.runId, "qa", "qa", latestSessionBinding(next.sessionBindings, "qa", next.qa.sessionId) ?? next.qa.sessionId, "checkpoint", next.qa.settings, now);
  } finally { workflow.close(); }
  const target = join(directory, `${run.runId}.json`);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
  return next;
}

export function checkpointBuildRun(
  projectDir: string,
  run: BuildRunRecordV2,
  checkpoint: string,
  patch: Partial<BuildRunRecordV2> = {},
): BuildRunRecordV2 {
  return saveBuildRun(projectDir, { ...run, ...patch, checkpoint, receipts: patch.receipts ?? run.receipts });
}

export function persistBuildSession(
  projectDir: string,
  run: BuildRunRecordV2,
  role: "builder" | "qa",
  session: string | ProviderSessionRefV1,
): BuildRunRecordV2 {
  const current = run[role];
  if (!current) throw new Error(`${role} settings were not captured for run ${run.runId}`);
  const sessionId = typeof session === "string" ? session : session.sessionId;
  const sessionBindings = typeof session === "string" ? run.sessionBindings : upsertSessionBinding(run.sessionBindings, session);
  return checkpointBuildRun(projectDir, { ...run, sessionBindings, [role]: { ...current, sessionId } }, `${role}-session-ready`);
}

/** Latest scoped binding, with the narrow legacy Builder inference allowed by the recovery protocol. */
export function buildRunSessionBinding(run: BuildRunRecordV2, role: "builder" | "qa", sessionId?: string): ProviderSessionRefV1 | undefined {
  const bound = latestSessionBinding(run.sessionBindings, role, sessionId);
  if (bound) return bound;
  if (role === "qa") return undefined;
  const raw = sessionId ?? run.builder?.sessionId;
  if (!raw || !run.builder || !existsSync(run.repository.worktree)) return undefined;
  return createProviderSessionRef({
    provider: run.builder.settings.make,
    sessionId: raw,
    role: "builder",
    stream: "builder",
    generation: 0,
    cwd: run.repository.worktree,
    configRoot: run.repository.root,
    workspaceIdentity: run.branchMode === "current" && run.repository.git.branch
      ? currentWorkflowIdentityKey({ worktree: canonicalSessionPath(run.repository.worktree), ref: `branch:${run.repository.git.branch}` })
      : run.repository.git.worktreeIdentity ?? captureWorkspaceIdentity(run.repository.worktree),
    ticketId: run.currentTicket,
    deliveryUnitId: run.deliveryUnit,
    source: "legacy-inferred",
    createdAt: run.createdAt,
  });
}

export function recordBuildReceipt(
  projectDir: string,
  run: BuildRunRecordV2,
  operationId: string,
  detail?: { externalId?: string; detail?: string },
): BuildRunRecordV2 {
  if (run.receipts[operationId]) return run;
  const next = saveBuildRun(projectDir, {
    ...run,
    receipts: { ...run.receipts, [operationId]: { completedAt: new Date().toISOString(), ...detail } },
  });
  const workflow = new WorkflowDb(projectDir);
  try {
    workflow.planOperation({ runId: run.runId, idempotencyKey: operationId, kind: operationId.split(":", 1)[0] ?? "operation", intent: { checkpoint: run.checkpoint } });
    workflow.updateOperation(operationId, "confirmed", { externalId: detail?.externalId, result: { detail: detail?.detail } });
  } finally { workflow.close(); }
  return next;
}

export function heartbeatBuildRun(projectDir: string, run: BuildRunRecordV2, now = new Date()): BuildRunRecordV2 {
  const lease = readCurrentWorkflowLease(projectDir);
  if (!lease || lease.runId !== run.runId) throw new Error("workflow lease ownership changed");
  const next = heartbeatCurrentWorkflowLease(projectDir, lease, now);
  return { ...run, lease: { hostname: next.host, pid: next.pid, processStart: next.processStart, heartbeatAt: next.heartbeatAt } };
}

export function releaseBuildLease(projectDir: string, run: BuildRunRecordV2, status: BuildRunRecordV2["status"] = "interrupted"): BuildRunRecordV2 {
  const saved = saveBuildRun(projectDir, { ...run, status, lease: undefined }); releaseWorkflowLease(projectDir, run.runId); return saved;
}

export function completeBuildRun(projectDir: string, run: BuildRunRecordV2, now = new Date()): BuildRunRecordV2 {
  const saved = saveBuildRun(projectDir, { ...run, status: "completed", checkpoint: "complete", lease: undefined, completedAt: now.toISOString(), progress: { ...run.progress, completedTickets: [...run.tickets], remainingTickets: [], nextAction: "None; build complete" } }, now); releaseWorkflowLease(projectDir, run.runId, now); return saved;
}

export function readBuildRuns(projectDir: string): BuildRunRecordV2[] {
  const directory = join(resolve(projectDir), BUILD_RUN_DIRECTORY);
  if (!existsSync(directory)) return [];
  const workflow = existsSync(join(resolve(projectDir), ".rafi", "recovery.sqlite3")) ? new WorkflowDb(projectDir) : undefined;
  const runs = readdirSync(directory).filter((name) => name.endsWith(".json")).flatMap((name) => {
    try {
      const projection = JSON.parse(readFileSync(join(directory, name), "utf8")) as BuildRunRecord;
      validateBuildRun(projection);
      const authoritative = workflow?.getRun(projection.runId)?.state as unknown as BuildRunRecord | undefined;
      const run = authoritative?.runId ? authoritative : projection;
      const upgraded = upgradeBuildRun(run, projectDir);
      return [{ ...upgraded, frozenPolicy: workflow?.autonomyPolicy(run.runId) ?? upgraded.frozenPolicy, recoveryAttempts: workflow?.recoveryAttempts(run.runId) ?? upgraded.recoveryAttempts, pendingDecisions: workflow?.pendingHumanDecisions(run.runId) ?? upgraded.pendingDecisions, supervisor: workflow?.supervisorState(run.runId) ?? upgraded.supervisor }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  workflow?.close();
  return runs;
}

export function recoverableBuildRuns(projectDir: string, now = new Date()): Array<BuildRunRecordV2 & { active: boolean }> {
  const databaseLease = readCurrentWorkflowLease(projectDir);
  return readBuildRuns(projectDir)
    .filter((run) => run.status !== "completed")
    .map((run) => ({ ...inferLegacyRunTickets(projectDir, run), active: databaseLease?.runId === run.runId ? workflowLeaseLooksLive(databaseLease, now) : isLeaseActive(run, now) }));
}

function workflowLeaseLooksLive(lease: NonNullable<ReturnType<typeof readCurrentWorkflowLease>>, now: Date): boolean {
  if (now.getTime() - new Date(lease.heartbeatAt).getTime() > BUILD_LEASE_STALE_MS) return false;
  if (lease.host !== hostname()) return true;
  try { process.kill(lease.pid, 0); return lease.processStart === processStartIdentity(lease.pid); } catch { return false; }
}

/**
 * Current-branch runs created before ticket checkpointing did not retain their
 * selected ticket. Recover it from Foreman's tracker events so --ticket can
 * still address those durable runs without rewriting the legacy record.
 */
function inferLegacyRunTickets(projectDir: string, run: BuildRunRecordV2): BuildRunRecordV2 {
  if (run.tickets.length > 0 || !isTicketsInitialized(projectDir)) return run;
  let db: Database.Database | undefined;
  try {
    const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
    if (!existsSync(paths.stateDb)) return run;
    db = new Database(paths.stateDb, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT ticket_id
      FROM ticket_events
      WHERE actor = 'foreman'
        AND ticket_id IS NOT NULL
        AND julianday(timestamp) >= julianday(?)
        AND julianday(timestamp) <= julianday(?)
      ORDER BY timestamp, id
    `).all(run.createdAt, run.updatedAt) as Array<{ ticket_id: string }>;
    const tickets = [...new Set(rows.map((row) => row.ticket_id).filter(Boolean))];
    if (tickets.length === 0) return run;
    return { ...run, tickets, currentTicket: tickets.at(-1) };
  } catch {
    return run;
  } finally {
    db?.close();
  }
}

export function isLeaseActive(run: BuildRunRecordV2, now = new Date()): boolean {
  if (!run.lease) return false;
  const age = now.getTime() - new Date(run.lease.heartbeatAt).getTime();
  if (age > BUILD_LEASE_STALE_MS) return false;
  if (run.lease.hostname !== hostname()) return true;
  try {
    process.kill(run.lease.pid, 0);
    return run.lease.processStart === processStartIdentity(run.lease.pid);
  } catch {
    return false;
  }
}

export function buildRecoveryPreview(run: BuildRunRecordV2): string[] {
  const completed = Object.keys(run.receipts).sort();
  return [
    `run ${run.runId}`,
    `ticket ${run.currentTicket ?? run.tickets[0] ?? "unknown"}`,
    `checkpoint ${run.checkpoint}`,
    `worktree ${run.repository.worktree}`,
    `branch ${run.repository.branch ?? "current"}`,
    `baseline ${run.repository.baselineComplete ? `${run.repository.git.baseRef ?? "recorded"} @ ${run.repository.git.baselineHead}` : "incomplete legacy baseline"}`,
    `preserved paths ${run.repository.git.runOwnedPaths.join(", ") || run.repository.git.statusPaths.join(", ") || "none recorded"}`,
    `completed operations ${completed.length ? completed.join(", ") : "none"}`,
    `session ${buildRunSessionBinding(run, "builder") ? "Builder session candidate requires validation" : "fresh Builder session required"}`,
    `QA session ${buildRunSessionBinding(run, "qa") ? "QA session candidate requires validation" : "fresh QA session required"}`,
  ];
}

export interface BuildRecoveryProjection {
  run: BuildRunRecordV2;
  ticketId?: string;
  ticketTitle?: string;
  compactLabel: string;
  compactHint: string;
  completed: string[];
  remaining: string[];
  lastSuccess: string;
  interruption: string;
  validation: string;
  expectedChanges: string[];
  unexpectedChanges: Array<{ path: string; risk: string }>;
  nextAction: string;
  worktree: string;
  branch?: string;
  exactSessionId?: string;
  exactSessionRef?: ProviderSessionRefV1;
  sessionCandidateRef?: ProviderSessionRefV1;
  sessionAvailability?: SessionAvailabilityV1;
}

export function projectBuildRecovery(projectDir: string, run: BuildRunRecordV2, now = new Date(), ticketOverride?: string, sessionAvailability?: SessionAvailabilityV1): BuildRecoveryProjection {
  let operationNames: string[] = [];
  let issues: string[] = [];
  let workflowState: Record<string, unknown> = {};
  if (existsSync(join(resolve(projectDir), ".rafi", "recovery.sqlite3"))) {
    const workflow = new WorkflowReader(projectDir);
    try {
      operationNames = workflow.operations(run.runId).filter((operation) => operation.status === "confirmed").map((operation) => operation.kind);
      issues = workflow.issues(run.runId).map((issue) => issue.detail);
      workflowState = workflow.getRun(run.runId)?.state ?? {};
    } finally { workflow.close(); }
  }
  const stateTicket = typeof workflowState.currentTicket === "string" ? workflowState.currentTicket : undefined;
  const ticketId = ticketOverride ?? stateTicket ?? run.currentTicket ?? run.progress.remainingTickets[0] ?? run.tickets[0];
  let ticketTitle: string | undefined;
  if (ticketId && isTicketsInitialized(projectDir)) {
    try {
      const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
      ticketTitle = loadTickets(paths.tickets).find((ticket) => ticket.id === ticketId)?.title;
    } catch { /* durable run data remains enough for a legacy preview */ }
  }
  const stateWorktree = typeof workflowState.worktree === "string" ? workflowState.worktree : undefined;
  const recoveryWorktree = stateWorktree && existsSync(stateWorktree) ? stateWorktree : run.repository.worktree;
  const stateBranch = typeof workflowState.branch === "string" ? workflowState.branch : undefined;
  const expectedChanges = gitStatusPaths(recoveryWorktree);
  const baseChanges = resolve(run.repository.root) === resolve(recoveryWorktree) ? [] : gitStatusPaths(run.repository.root);
  const identityChanged = recoveryWorktree === run.repository.worktree && run.repository.git.worktreeIdentity && worktreeIdentity(recoveryWorktree) !== run.repository.git.worktreeIdentity;
  const branchNow = gitValue(recoveryWorktree, ["branch", "--show-current"]);
  const expectedBranch = stateBranch ?? run.repository.git.branch;
  const branchChanged = Boolean(expectedBranch && branchNow && branchNow !== expectedBranch);
  const unexpectedChanges = baseChanges.map((path) => ({ path, risk: "base-worktree changes may conflict with recovery" }));
  if (identityChanged) unexpectedChanges.push({ path: recoveryWorktree, risk: "preserved worktree identity changed" });
  if (branchChanged) unexpectedChanges.push({ path: recoveryWorktree, risk: `branch changed from ${expectedBranch} to ${branchNow}` });
  const completed = [...new Set([...run.progress.completedTickets, ...run.progress.completedOperations, ...operationNames])];
  const remaining = run.progress.remainingTickets.length ? run.progress.remainingTickets : remainingTickets(run);
  const interruption = run.interruption?.lastError ?? run.interruption?.summary ?? run.failure?.summary ?? issues.at(-1) ?? run.status;
  const validation = run.progress.validation
    ? `${run.progress.validation.status}${run.progress.validation.qa ? `; QA ${run.progress.validation.qa}` : ""}`
    : run.qa?.sessionId ? "QA session checkpointed" : "no completed QA/validation checkpoint recorded";
  const nextAction = ticketOverride
    ? `Resume ${ticketOverride} from ${run.checkpoint}`
    : run.progress.nextAction ?? (ticketId ? `Resume ${ticketId} from ${run.checkpoint}` : `Resume from ${run.checkpoint}`);
  const primary = ticketId ? `${ticketId}${ticketTitle ? `: ${ticketTitle}` : ""}` : "legacy run (ticket unavailable)";
  const stateSessionId = typeof workflowState.sessionId === "string" ? workflowState.sessionId : undefined;
  const sessionCandidateRef = buildRunSessionBinding(run, "builder", stateSessionId ?? run.builder?.sessionId);
  const exactSessionRef = sessionAvailability?.status === "available" ? sessionAvailability.sessionRef ?? sessionCandidateRef : undefined;
  return {
    run, ticketId, ticketTitle,
    compactLabel: `${primary} — ${run.status}`,
    compactHint: `${run.builder?.settings.make ?? "runtime unavailable"}; ${stateBranch ?? branchNow ?? run.repository.branch ?? "current branch"}; updated ${relativeTime(run.updatedAt, now)}`,
    completed, remaining,
    lastSuccess: run.progress.lastSuccessfulAction ?? run.checkpoint,
    interruption,
    validation,
    expectedChanges,
    unexpectedChanges,
    nextAction,
    worktree: recoveryWorktree,
    branch: stateBranch ?? branchNow ?? run.repository.git.branch ?? run.repository.branch,
    ...(sessionCandidateRef ? { sessionCandidateRef } : {}),
    ...(sessionAvailability ? { sessionAvailability } : {}),
    ...(exactSessionRef ? { exactSessionRef, exactSessionId: exactSessionRef.sessionId } : {}),
  };
}

export async function resolveBuildRecoveryProjection(
  projectDir: string,
  run: BuildRunRecordV2,
  now = new Date(),
  ticketOverride?: string,
  probe: ResolveSessionAvailabilityOptions = {},
): Promise<BuildRecoveryProjection> {
  const frozen = projectBuildRecovery(projectDir, run, now, ticketOverride);
  const candidate = frozen.sessionCandidateRef;
  if (!candidate) return frozen;
  const availability = await resolveProviderSessionAvailability(candidate, {
    ...probe,
    cwd: frozen.worktree,
    configRoot: run.repository.root,
    workspaceIdentity: run.branchMode === "current" ? safeCurrentIdentity(frozen.worktree) : captureWorkspaceIdentity(frozen.worktree),
    now,
  });
  return projectBuildRecovery(projectDir, run, now, ticketOverride, availability);
}

function safeCurrentIdentity(worktree: string): string | undefined {
  try { return captureCurrentWorkflowSessionIdentity(worktree); } catch { return undefined; }
}

export function formatBuildRecoveryProjection(projection: BuildRecoveryProjection): string[] {
  const { run } = projection;
  const lines = [
    `run ${run.runId}`,
    `ticket ${projection.ticketId ?? "unavailable"}${projection.ticketTitle ? `: ${projection.ticketTitle}` : ""}`,
    `status ${run.status}; checkpoint ${run.checkpoint}`,
    `completed ${projection.completed.join(", ") || "none recorded"}`,
    `current ${run.progress.currentStep ?? projection.ticketId ?? "not recorded"}`,
    `remaining ${projection.remaining.join(", ") || "none"}`,
    `last successful action ${projection.lastSuccess}`,
    `interruption/failure ${projection.interruption}`,
    `validation/QA ${projection.validation}`,
    `branch ${projection.branch ?? "current"}; worktree ${projection.worktree}`,
    `baseline ${run.repository.baselineComplete ? `${run.repository.git.baseRef ?? "recorded"} @ ${run.repository.git.baselineHead}` : "incomplete; automatic rollback is unavailable"}`,
    `session ${projection.exactSessionId ? "exact Builder session available (validated)" : projection.sessionCandidateRef ? `exact Builder session unavailable (${projection.sessionAvailability?.reason ?? "validation pending"})` : "fresh Builder session required"}`,
    `runtime ${run.builder?.settings.make ?? "unavailable"}; model ${run.builder?.settings.model ?? "unavailable"}`,
    `updated ${run.updatedAt}`,
    `preserved expected in-progress paths ${projection.expectedChanges.join(", ") || "none currently dirty"}`,
  ];
  if (projection.unexpectedChanges.length) {
    lines.push("WARNING: unexpected recovery state (recovery remains available):");
    for (const item of projection.unexpectedChanges) lines.push(`  ${item.path}: ${item.risk}`);
    lines.push("recommended action: preserve or move these changes before recovery if they overlap the interrupted work");
  }
  lines.push(`next action ${projection.nextAction}`);
  return lines;
}

function currentLease(now: Date): NonNullable<BuildRunRecordV2["lease"]> {
  return { hostname: hostname(), pid: process.pid, processStart: processStartIdentity(process.pid), heartbeatAt: now.toISOString() };
}

function processStartIdentity(pid: number): string {
  try {
    return statSync(`/proc/${pid}`).birthtimeMs.toString();
  } catch {
    return pid === process.pid ? `${Date.now() - Math.round(process.uptime() * 1000)}` : "unknown";
  }
}

function validateBuildRun(run: BuildRunRecord): void {
  if (![1, 2, 3].includes(run.version) || !run.runId || !run.repository?.root || !run.repository.worktree || !run.createdAt || !run.updatedAt) {
    throw new Error("invalid build run record");
  }
}

function workflowStatus(status: BuildRunRecordV2["status"]): WorkflowRunStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "superseded") return "superseded";
  if (status === "blocked") return "blocked";
  if (status === "interrupted" || status === "recoverable") return "paused";
  return "running";
}

function remainingTickets(run: BuildRunRecordV2): string[] {
  const current = run.currentTicket ? run.tickets.indexOf(run.currentTicket) : 0;
  return run.status === "completed" ? [] : run.tickets.slice(Math.max(0, current));
}

function captureGitSnapshot(worktree: string, input: CreateBuildRunInput): BuildRunRecordV2["repository"]["git"] {
  const git = (args: string[]): string | undefined => {
    try { return execFileSync("git", args, { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
  };
  const statusPaths = (git(["status", "--porcelain=v1", "-z"]) ?? "").split("\0").filter(Boolean).map((line) => line.slice(3)).sort();
  const head = input.startHead ?? git(["rev-parse", "HEAD"]);
  const branch = input.branch ?? git(["branch", "--show-current"]);
  return {
    baselineHead: input.baseHead ?? head,
    baseRef: input.baseRef ?? branch,
    branch,
    startHead: head,
    worktree,
    worktreeIdentity: worktreeIdentity(worktree),
    statusPaths,
    initialStatusPaths: [...statusPaths],
    runOwnedPaths: [],
    createdBranch: false,
    createdWorktree: worktree !== resolve(input.repositoryRoot),
    upstream: git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  };
}

function worktreeIdentity(worktree: string): string | undefined {
  return captureWorkspaceIdentity(worktree);
}

function gitValue(cwd: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
}

function gitStatusPaths(cwd: string): string[] {
  return (gitValue(cwd, ["status", "--porcelain=v1", "-z"]) ?? "").split("\0").filter(Boolean).map((line) => line.slice(3)).sort();
}

function relativeTime(value: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function upgradeBuildRun(run: BuildRunRecord, projectDir = run.repository.root, now = new Date()): BuildRunRecordV3 {
  if (run.version === 3) return run as BuildRunRecordV3;
  const policy = resolveAutonomyPolicy(loadProjectAutonomyConfig(projectDir), undefined, new Date(run.createdAt || now));
  if (run.version === 2) return {
    ...run, version: 3, frozenPolicy: policy, phase: run.checkpoint, qaEnabled: Boolean(run.qa), recoveryAttempts: [],
    supervisor: { status: policy.supervisorEnabled ? "stopped" : "disabled", generation: 0, workerGeneration: 0, checkpointRestarts: 0, runRestarts: 0 }, pendingDecisions: [], deferredTickets: [], legacy: true,
  };
  const legacy = run as BuildRunRecordV1;
  const remaining = legacy.status === "completed" ? [] : legacy.tickets.slice(Math.max(0, legacy.currentTicket ? legacy.tickets.indexOf(legacy.currentTicket) : 0));
  return {
    ...legacy,
    version: 3,
    legacy: true,
    repository: {
      ...legacy.repository,
      baselineComplete: false,
      git: {
        baselineHead: legacy.repository.baseHead,
        branch: legacy.repository.branch,
        startHead: legacy.repository.startHead,
        worktree: legacy.repository.worktree,
        statusPaths: [], initialStatusPaths: [], runOwnedPaths: [], createdBranch: false, createdWorktree: false,
      },
    },
    progress: {
      completedTickets: legacy.status === "completed" ? [...legacy.tickets] : [],
      completedOperations: Object.keys(legacy.receipts).sort(),
      remainingTickets: remaining,
      lastSuccessfulAction: legacy.checkpoint,
      nextAction: remaining[0] ? `Resume ${remaining[0]}` : "Inspect legacy run",
    },
    frozenPolicy: policy,
    phase: legacy.checkpoint,
    qaEnabled: Boolean(legacy.qa),
    recoveryAttempts: [],
    supervisor: { status: policy.supervisorEnabled ? "stopped" : "disabled", generation: 0, workerGeneration: 0, checkpointRestarts: 0, runRestarts: 0 },
    pendingDecisions: [],
    deferredTickets: [],
  };
}

function releaseWorkflowLease(projectDir: string, runId: string, now = new Date()): void {
  const workflow = new WorkflowDb(projectDir); try { const lease = workflow.currentLease(); if (lease?.runId === runId) workflow.releaseLease(lease, now); } finally { workflow.close(); }
}
