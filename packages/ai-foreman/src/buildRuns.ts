import { loadQaPreparationPolicy } from "./qaEffectiveConfig.js";
export { withBuildInvocation as withBuildRecoveryInvocation, launchDigest as launchArgumentDigest } from "./buildAdmission.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import type { AutonomyProfile, BuildRunRecord, BuildRunRecordV1, BuildRunRecordV2, BuildRunRecordV3, ProviderSessionRefV1, ResolvedAgentSettings, ResolvedAutonomyPolicy, SessionAvailabilityV1 } from "rafi-spec";
import { WorkflowDb, heartbeatCurrentWorkflowLease, readCurrentWorkflowLease, type WorkflowRunStatus, type ProjectLease } from "./workflowDb.js";
import { WorkflowReader } from "./workflowReader.js";
import { canonicalSessionPath, captureWorkspaceIdentity, createProviderSessionRef, latestSessionBinding, upsertSessionBinding } from "./sessionIdentity.js";
import { resolveProviderSessionAvailability, type ResolveSessionAvailabilityOptions } from "./sessionAvailability.js";
import { captureCurrentWorkflowSessionIdentity, currentWorkflowIdentityKey } from "./branch/currentGuard.js";
import { isTicketsInitialized, loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import { loadProjectAutonomyConfig, resolveAutonomyPolicy } from "./recoveryPolicy.js";
import { classifyProcess, isLiveProcessIdentity, processStartIdentity } from "./processIdentity.js";
import { assertBuildAssignmentReconciled } from "./buildAssignment.js";

export const BUILD_RUN_VERSION = 3;
export const BUILD_RUN_DIRECTORY = ".foreman/runs";
export const BUILD_HEARTBEAT_MS = 10_000;
export const BUILD_LEASE_STALE_MS = 45_000;

const buildAuthority = Symbol("buildAuthority");
type AuthorizedBuild = BuildRunRecordV2 & { [buildAuthority]?: ProjectLease };
export function bindBuildAuthority(run: BuildRunRecordV2, lease: ProjectLease): BuildRunRecordV2 {
  return { ...run, [buildAuthority]: lease } as AuthorizedBuild;
}
function assertBuildAuthority(workflow: WorkflowDb, run: BuildRunRecordV2): void {
  const token = (run as AuthorizedBuild)[buildAuthority];
  if (!token) throw new Error("build mutation requires the caller's original workflow authority");
  const held = workflow.currentLease();
  const authorizedSupersession = run.status === "superseded" && run.supersededBy === held?.runId;
  if (token && (!held || held.owner !== token.owner || held.generation !== token.generation || held.runId !== token.runId)) throw new Error("workflow lease ownership changed");
  if (held && (!token || (held.runId !== run.runId && !authorizedSupersession))) throw new Error("build mutation requires the caller's original workflow authority");
}

export interface CreateBuildRunInput {
  runId?: string;
  tickets: string[];
  authorizedBatch?: BuildRunRecordV2["authorizedBatch"];
  builderCapabilities?: BuildRunRecordV2["builderCapabilities"];
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
    authorizedBatch: input.authorizedBatch ?? (input.tickets.length && (input.branchMode ?? "current") === "current" ? { tickets: [...input.tickets], requestedSteps: input.tickets.length, scopeRevision: "explicit-create-selection", startedTickets: [] } : undefined),
    builderCapabilities: input.builderCapabilities,
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
    supervisor: { status: frozenPolicy.supervisorEnabled ? "stopped" : "disabled", generation: 0, workerGeneration: 0, checkpointRestarts: 0, runRestarts: 0 },
    pendingDecisions: [],
    deferredTickets: [],
    runDecisions: input.runDecisions,
    receipts: {},
    lease: currentLease(now),
    createdAt: stamp,
    updatedAt: stamp,
  };
  const workflow = new WorkflowDb(input.repositoryRoot);
  try {
    workflow.ensureRun(run.runId, "build", now);
    const authority = workflow.acquireLease(run.runId, undefined, now, BUILD_LEASE_STALE_MS);
    workflow.qaPreparationStore().freezePolicy(run.runId, loadQaPreparationPolicy(input.repositoryRoot));
    return saveBuildRun(input.repositoryRoot, bindBuildAuthority(run, authority), now);
  } finally { workflow.close(); }
}

export function resumeBuildRun(projectDir: string, runId: string, patch: { builder?: LegacyResolvedAgentSettings; qa?: LegacyResolvedAgentSettings; builderSessionId?: string | null; builderSessionRef?: ProviderSessionRefV1 | null; expectedRecoveryDecisionDigest?: string }, now = new Date()): BuildRunRecordV2 {
  let existing = readBuildRuns(projectDir).find((run) => run.runId === runId);
  if (!existing) throw new Error(`recoverable build run not found: ${runId}`);
  if (["completed", "cancelled", "superseded"].includes(existing.status)) throw new Error(`build run ${runId} is ${existing.status} and cannot resume`);
  const workflow = new WorkflowDb(projectDir);
  let authority: ProjectLease;
  try {
    authority = workflow.acquireLease(runId, undefined, now, BUILD_LEASE_STALE_MS);
    if (patch.expectedRecoveryDecisionDigest) {
      const decision = workflow.getRun(runId)?.state.recoveryDecision;
      if (createHash("sha256").update(JSON.stringify(decision ?? null)).digest("hex") !== patch.expectedRecoveryDecisionDigest) {
        workflow.releaseLease(authority, now);
        throw new Error("Recovery decision changed before the child supervisor acquired its lease; inspect and retry");
      }
    }
    existing = readBuildRuns(projectDir).find((run) => run.runId === runId)!;
    if (!existing || ["completed", "cancelled", "superseded"].includes(existing.status)) {
      workflow.releaseLease(authority, now);
      throw new Error("Recovery run completed or disappeared before lease acquisition");
    }
  } finally { workflow.close(); }
  const clearBuilderSession = patch.builderSessionId === null && patch.builderSessionRef === null;
  const builderSessionId = clearBuilderSession
    ? undefined
    : patch.builderSessionRef?.sessionId ?? patch.builderSessionId ?? existing.builder?.sessionId;
  return saveBuildRun(projectDir, {
    ...bindBuildAuthority(existing, authority!), status: "running", checkpoint: "recovery-resumed", completedAt: undefined,
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
    auto_compact_threshold_percent: settings.auto_compact_threshold_percent ?? 65,
    compact_maximum: settings.compact_maximum ?? 10,
    settings_revision: settings.settings_revision ?? 0,
  };
}

export function saveBuildRun(projectDir: string, run: BuildRunRecordV2, now = new Date()): BuildRunRecordV2 {
  if (!(run as AuthorizedBuild)[buildAuthority]) throw new Error("build mutation requires the caller's original workflow authority");
  if (canonicalSessionPath(projectDir) !== canonicalSessionPath(run.repository.root)) throw new Error("Build authority belongs to another project");
  const original = (run as AuthorizedBuild)[buildAuthority]!;
  const current = readCurrentWorkflowLease(projectDir);
  if (!current || current.owner !== original.owner || current.generation !== original.generation || current.runId !== original.runId) throw new Error("workflow lease ownership changed");
  validateBuildRun(run);
  const directory = join(resolve(projectDir), BUILD_RUN_DIRECTORY);
  const progress = ["recoverable", "interrupted", "blocked", "failed"].includes(run.status) ? currentBranchTicketProgress(projectDir, run) : undefined;
  if (progress) run = { ...run,
    currentTicket: progress.pendingQa.find(ticket => run.tickets.includes(ticket)) ?? (run.currentTicket && progress.remaining.includes(run.currentTicket) ? run.currentTicket : progress.remaining[0]),
    progress: { ...run.progress, completedTickets: progress.completed, remainingTickets: progress.remaining },
  };
  const upgraded = upgradeBuildRun(run, projectDir, now);
  const completedOperations = Object.keys(upgraded.receipts).sort();
  let next: BuildRunRecordV3 = {
    ...upgraded,
    progress: { ...run.progress, completedOperations, remainingTickets: remainingTickets(run) },
    updatedAt: now.toISOString(),
  };
  const workflow = new WorkflowDb(projectDir);
  const target = join(directory, `${run.runId}.json`);
  let publicationId: string | undefined;
  let temporary: string | undefined;
  try {
    workflow.atomic(() => {
    assertBuildAuthority(workflow, run);
    const frozenPolicy = workflow.freezeAutonomyPolicy(next.runId, next.frozenPolicy, now);
    next = { ...next, frozenPolicy, recoveryAttempts: workflow.recoveryAttempts(next.runId), pendingDecisions: workflow.pendingHumanDecisions(next.runId), supervisor: workflow.supervisorState(next.runId) ?? next.supervisor };
    const existing = workflow.getRun(next.runId);
    const priorProgress = existing?.state.progress as {completedTickets?: string[]}|undefined;
    next = {...next,progress:{...next.progress,completedTickets:[...new Set([...next.progress.completedTickets,...(priorProgress?.completedTickets??[])])]}};
    if (existing && ["completed", "cancelled", "superseded"].includes(existing.status) && workflowStatus(next.status) !== existing.status) throw new Error(`cannot rewrite a ${existing.status} build run`);
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
    publicationId = workflow.beginPublication(next.runId, { operation: "build-run-projection", target,
      revision: createHash("sha256").update(JSON.stringify(next)).digest("hex"), updatedAt: next.updatedAt }, {}, now).transactionId;
    });
    mkdirSync(directory, { recursive: true });
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    temporary = temp;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    workflow.atomic(() => {
      assertBuildAuthority(workflow, run);
      if (JSON.stringify(workflow.getRun(run.runId)?.state) !== JSON.stringify(next)) throw new Error("Build projection changed before publication");
      renameSync(temp, target);
      temporary = undefined;
    });
    workflow.atomic(() => {
      workflow.updatePublication(publicationId!, "committed", now);
      // Publishing the latest authoritative revision also reconciles any older
      // interrupted publication of this same projection; never write old bytes.
      for (const pending of workflow.incompletePublications()) {
        const intent = pending.intent as { operation?: string; target?: string };
        if (pending.runId === next.runId && intent.operation === "build-run-projection" && intent.target === target) workflow.updatePublication(pending.transactionId, "committed", now);
      }
    });
  } finally { if (temporary) rmSync(temporary, { force: true }); workflow.close(); }
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
    workflow.updateOperation(operationId, "in_progress");
    workflow.updateOperation(operationId, "confirmed", { externalId: detail?.externalId, result: { detail: detail?.detail } });
  } finally { workflow.close(); }
  return next;
}

export function heartbeatBuildRun(projectDir: string, run: BuildRunRecordV2, now = new Date()): BuildRunRecordV2 {
  const lease = (run as AuthorizedBuild)[buildAuthority];
  if (!lease || lease.runId !== run.runId) throw new Error("workflow lease ownership changed");
  const next = heartbeatCurrentWorkflowLease(projectDir, lease, now);
  return { ...run, lease: { hostname: next.host, pid: next.pid, processStart: next.processStart, heartbeatAt: next.heartbeatAt } };
}

export function releaseBuildLease(projectDir: string, run: BuildRunRecordV2, status: BuildRunRecordV2["status"] = "interrupted"): BuildRunRecordV2 {
  const saved = saveBuildRun(projectDir, { ...run, status, lease: undefined }); releaseWorkflowLease(projectDir, run); return saved;
}

export function completeBuildRun(projectDir: string, run: BuildRunRecordV2, now = new Date()): BuildRunRecordV2 {
  assertBuildAssignmentReconciled(projectDir, run.runId);
  if (run.status === "completed") {
    const committed = readBuildRuns(projectDir).find(item => item.runId === run.runId);
    if (committed?.status === "completed" && JSON.stringify(committed) === JSON.stringify(run)) return committed;
  }
  const workflow = new WorkflowDb(projectDir);
  try {
    workflow.assertQaRunFinalizable(run.runId);
    if (workflow.pendingHumanDecisions(run.runId).length) throw new Error("build run has unanswered decisions");
    if (["builder", "qa"].some(role => workflow.unresolvedRoleDispatches(run.runId, role).length)) throw new Error("build run has unresolved provider dispatches");
  }
  finally { workflow.close(); }
  const saved = saveBuildRun(projectDir, { ...run, status: "completed", checkpoint: "complete", lease: undefined, completedAt: now.toISOString(), progress: { ...run.progress, completedTickets: [...run.tickets], remainingTickets: [], nextAction: "None; build complete" } }, now); releaseWorkflowLease(projectDir, run, now); return saved;
}

/** A recovered ticket boundary is complete only when the saved run scope is done. */
export function finishRecoveredTicketScope(projectDir: string, run: BuildRunRecordV2, checkpoint: string): BuildRunRecordV2 {
  if (run.branchMode !== "current" || !run.tickets.length || !isTicketsInitialized(projectDir)) throw new Error("Ticket recovery completion requires an initialized current-branch run scope");
  const { completed, remaining } = currentBranchTicketProgress(projectDir, run)!;
  if (!remaining.length && !run.authorizedBatch) return releaseBuildLease(projectDir, checkpointBuildRun(projectDir, run, "legacy-scope-reconciliation-required", { progress: { ...run.progress, completedTickets: completed, remainingTickets: [], nextAction: "Confirm the original authorized batch scope before declaring the build complete" } }), "recoverable");
  if (!remaining.length) return completeBuildRun(projectDir, run);
  return releaseBuildLease(projectDir, checkpointBuildRun(projectDir, run, checkpoint, {
    currentTicket: remaining[0],
    progress: { ...run.progress, completedTickets: completed, remainingTickets: remaining, nextAction: `Resume ${remaining[0]}` },
  }), "recoverable");
}

export function readBuildRuns(projectDir: string): BuildRunRecordV2[] {
  const directory = join(resolve(projectDir), BUILD_RUN_DIRECTORY);
  const workflow = new WorkflowReader(projectDir);
  const candidates = new Map<string, BuildRunRecord>();
  if (existsSync(directory)) for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) {
    try { const value = JSON.parse(readFileSync(join(directory, name), "utf8")) as BuildRunRecord; candidates.set(value.runId, value); } catch { /* authoritative DB state can repair an absent or partial projection */ }
  }
  for (const stored of workflow.buildRuns()) {
    const value = stored.state as unknown as BuildRunRecord;
    if (value?.runId) candidates.set(value.runId, value);
    else if (!["completed", "superseded", "cancelled"].includes(stored.status) && !candidates.has(stored.runId)) {
      // Supervision/readiness can stop before the first full build snapshot.
      // Keep that attempt visible without inventing a provider session or baseline.
      candidates.set(stored.runId, {
        version: 1, runId: stored.runId, status: stored.status === "running" ? "running" : "recoverable",
        tickets: [], branchMode: "current", checkpoint: stored.checkpoint,
        repository: { root: resolve(projectDir), worktree: resolve(projectDir) }, receipts: {},
        createdAt: stored.createdAt, updatedAt: stored.updatedAt,
        failure: { category: "preparation-incomplete", summary: "Build preparation stopped before a complete build checkpoint", at: stored.updatedAt },
      });
    }
  }
  const runs = [...candidates.values()].flatMap((projection) => {
    try {
      validateBuildRun(projection);
      const authoritative = workflow?.getRun(projection.runId)?.state as unknown as BuildRunRecord | undefined;
      const run = authoritative?.runId ? authoritative : projection;
      let upgraded = upgradeBuildRun(run, projectDir);
      const dbStatus = workflow.getRun(run.runId)?.status;
      if (dbStatus === "superseded" || dbStatus === "completed" || dbStatus === "cancelled") upgraded = { ...upgraded, status: dbStatus };

      if (!["completed", "superseded", "cancelled"].includes(workflow?.getRun(run.runId)?.status ?? "")) {
        for (const role of ["builder", "qa"] as const) {
          const lease = workflow?.roleMutationLease(run.runId, role);
          const ref = lease?.sessionRef;
          if (ref && lease!.generation > 0 && upgraded[role]) upgraded = { ...upgraded, [role]: { ...upgraded[role]!, sessionId: ref.sessionId }, sessionBindings: upsertSessionBinding(upgraded.sessionBindings, ref) };
        }
      }
      return [{ ...upgraded, frozenPolicy: workflow?.autonomyPolicy(run.runId) ?? upgraded.frozenPolicy, recoveryAttempts: workflow?.recoveryAttempts(run.runId) ?? upgraded.recoveryAttempts, pendingDecisions: workflow?.pendingHumanDecisions(run.runId) ?? upgraded.pendingDecisions, supervisor: workflow?.supervisorState(run.runId) ?? upgraded.supervisor }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId));
  workflow?.close();
  return runs;
}

export function recoverableBuildRuns(projectDir: string, now = new Date()): Array<BuildRunRecordV2 & { active: boolean; ownership: "live" | "dead" | "unknown"; ownershipReason: string; cleanupOnly?: boolean }> {
  const reader = new WorkflowReader(projectDir);
  const databaseLease = reader.currentLease();
  const admission = reader.buildAdmission();
  const unfinished = (readBuildRuns(projectDir) as BuildRunRecordV3[]).filter(run => !["completed", "cancelled", "superseded"].includes(run.status));
  const cleanupRuns = [...new Set(reader.readinessProcesses().map(row => row.run_id))].filter(id => !unfinished.some(run => run.runId === id)).map(runId => {
    const run = reader.getRun(runId);
    const at = run?.updatedAt ?? new Date(0).toISOString();
    return { ...upgradeBuildRun({ version: 1, runId, status: "recoverable", tickets: [], branchMode: "current", checkpoint: "readiness-cleanup", repository: { root: resolve(projectDir), worktree: resolve(projectDir) }, receipts: {}, createdAt: run?.createdAt ?? at, updatedAt: at }, projectDir), cleanupOnly: true };
  });
  try { return [...unfinished, ...cleanupRuns]
    .map(run => {
      const owners = [];
      if (admission?.runId === run.runId) owners.push(classifyProcess(admission.pid, admission.processStart, admission.host));
      if (databaseLease?.runId === run.runId) owners.push(classifyProcess(databaseLease.pid, databaseLease.processStart, databaseLease.host));
      if (run.supervisor?.pid && ["running", "stopping"].includes(run.supervisor.status)) owners.push(classifyProcess(run.supervisor.pid, run.supervisor.processStart));
      if (!owners.length && run.lease) owners.push(classifyProcess(run.lease.pid, run.lease.processStart, run.lease.hostname));
      let owner = owners.find(item => item.state === "live") ?? owners.find(item => item.state === "unknown") ?? { state: "dead" as const, reason: "No live owner recorded" };
      if (owner.state !== "live" && reader.pendingBuildLaunches(run.runId).some(launch => launch.state === "dispatching")) owner = { state: "unknown", reason: "launch dispatch began but no child claim was confirmed; reconcile the launcher and child process evidence before retrying" };
      return { ...run, active: owner.state === "live", ownership: owner.state, ownershipReason: owner.reason };
    }); } finally { reader.close(); }
}

/**
 * Timestamp correlations are diagnostic hints, never executable membership.
 */
export function legacyTrackerWorkHints(projectDir: string, run: BuildRunRecordV2): string[] {
  if (!isTicketsInitialized(projectDir)) return [];
  let db: Database.Database | undefined;
  try {
    const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
    if (!existsSync(paths.stateDb)) return [];
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
    return tickets;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function isLeaseActive(run: BuildRunRecordV2, now = new Date()): boolean {
  void now;
  return Boolean(run.lease && classifyProcess(run.lease.pid, run.lease.processStart, run.lease.hostname).state !== "dead");
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

/** Saved context may be broader than the work authorized for this invocation. */
export function recoveryExecutionTickets(run: BuildRunRecordV2, requested: readonly string[], frozen: boolean): string[] {
  const scope = frozen && run.recoveryDecision?.executionTickets !== undefined
    ? run.recoveryDecision.executionTickets
    : requested.length ? requested : run.tickets;
  if (scope.some(ticket => !run.tickets.includes(ticket)) || requested.some(ticket => !scope.includes(ticket)) || (run.tickets.length && !scope.length)) {
    throw new Error("Recovery execution scope conflicts with the saved run or requested ticket");
  }
  return [...new Set(scope)];
}

/** Read-only reconciliation also handles crashes before the last progress checkpoint. */
export function currentBranchTicketProgress(projectDir: string, run: BuildRunRecordV2): { completed: string[]; remaining: string[]; pendingQa: string[] } | undefined {
  if (run.branchMode !== "current" || !run.tickets.length || !isTicketsInitialized(projectDir)) return undefined;
  if (run.status === "completed") return { completed: [...run.tickets], remaining: [], pendingQa: [] };
  const workflow = new WorkflowReader(projectDir);
  let pendingQa: string[];
  let questions: string[];
  try {
    pendingQa = workflow.pendingQaTicketIds(run.runId);
    questions = workflow.pendingHumanDecisions(run.runId).filter(item => item.interruptionId.startsWith("ticket:")).map(item => item.interruptionId.slice(7));
  } finally { workflow.close(); }
  let state: Database.Database | undefined;
  let completed: string[] = [];
  try {
    const paths = resolveTicketPaths(loadTicketsConfig(projectDir), projectDir);
    state = new Database(paths.stateDb, { readonly: true, fileMustExist: true });
    const read = state.prepare("SELECT status FROM ticket_state WHERE ticket_id=?");
    completed = run.tickets.filter(ticket => (read.get(ticket) as { status: string } | undefined)?.status === "done" && !pendingQa.includes(ticket) && !questions.includes(ticket));
  } catch {
    // Legacy, missing or unreadable tracker evidence cannot authorize completion.
    // Keep recovery inspectable; actual dispatch still requires a usable tracker.
    completed = [];
  } finally { state?.close(); }
  return { completed, remaining: run.tickets.filter(ticket => !completed.includes(ticket)), pendingQa };
}

/** Match the frozen preview at both the resume wrapper and direct start boundary. */
export function currentBranchRecoveryTicket(projectDir: string, run: BuildRunRecordV2): string | undefined {
  if (run.currentTicket && !run.tickets.includes(run.currentTicket)) throw new Error(`Recovery ticket ${run.currentTicket} is outside the saved run scope`);
  const ticket = projectBuildRecovery(projectDir, run).ticketId;
  if (ticket && !run.tickets.includes(ticket)) throw new Error(`Recovery ticket ${ticket} is outside the saved run scope`);
  return ticket;
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
  const progress = currentBranchTicketProgress(projectDir, run);
  if (progress && stateTicket && !run.tickets.includes(stateTicket)) throw new Error(`Recovery ticket ${stateTicket} is outside the saved run scope`);
  const savedTicket = stateTicket ?? run.currentTicket;
  const ticketId = ticketOverride ?? (progress
    ? progress.pendingQa.find(ticket => run.tickets.includes(ticket)) ?? (savedTicket && progress.remaining.includes(savedTicket) ? savedTicket : progress.remaining[0])
    : savedTicket ?? run.progress.remainingTickets[0] ?? run.tickets[0]);
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
  const completed = [...new Set([...(progress?.completed ?? run.progress.completedTickets), ...run.progress.completedOperations, ...operationNames])];
  const remaining = progress?.remaining ?? (run.progress.remainingTickets.length ? run.progress.remainingTickets : remainingTickets(run));
  const interruption = run.interruption?.lastError ?? run.interruption?.summary ?? run.failure?.summary ?? issues.at(-1) ?? run.status;
  const validation = run.progress.validation
    ? `${run.progress.validation.status}${run.progress.validation.qa ? `; QA ${run.progress.validation.qa}` : ""}`
    : run.qa?.sessionId ? "QA session checkpointed" : "no completed QA/validation checkpoint recorded";
  const nextAction = ticketOverride
    ? `Resume ${ticketOverride} from ${run.checkpoint}`
    : (progress ? undefined : run.progress.nextAction) ?? (ticketId ? `Resume ${ticketId} from ${run.checkpoint}` : `Resume from ${run.checkpoint}`);
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


function validateBuildRun(run: BuildRunRecord): void {
  if (![1, 2, 3].includes(run.version) || !run.runId || !run.repository?.root || !run.repository.worktree || !run.createdAt || !run.updatedAt) {
    throw new Error("invalid build run record");
  }
}

function workflowStatus(status: BuildRunRecordV2["status"]): WorkflowRunStatus {
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "superseded") return "superseded";
  if (status === "blocked") return "blocked";
  if (status === "interrupted" || status === "recoverable") return "paused";
  return "running";
}

function remainingTickets(run: BuildRunRecordV2): string[] {
  const current = run.currentTicket ? run.tickets.indexOf(run.currentTicket) : 0;
  return run.status === "completed" ? [] : (run.branchMode === "current" ? run.tickets : run.tickets.slice(Math.max(0, current))).filter(ticket => run.branchMode !== "current" || !run.progress.completedTickets.includes(ticket));
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

function releaseWorkflowLease(projectDir: string, run: BuildRunRecordV2, now = new Date()): void {
  const workflow = new WorkflowDb(projectDir);
  try {
    assertBuildAuthority(workflow, run);
    const lease = (run as AuthorizedBuild)[buildAuthority];
    if (lease) workflow.releaseLease(lease, now);
  } finally { workflow.close(); }
}
