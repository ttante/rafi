import { createHash } from "node:crypto";
import { Command } from "commander";
import { resolve } from "node:path";
import {
  formatBuildRecoveryProjection,
  projectBuildRecovery,
  readBuildRuns,
  recoverableBuildRuns,
  resolveBuildRecoveryProjection,
  saveBuildRun,
} from "ai-foreman/build-runs.js";
import { HandoffService } from "ai-foreman/handoffs.js";
import { createRoleBuilder, readOnlyPermissionConfig } from "ai-foreman/agent-run.js";
import { continuityInstruction, parseContinuityDelta } from "ai-foreman/continuity.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { loadQaRecoveryPacket, recoverPendingQaRecoveryPublications, type QaRecoveryPacket } from "ai-foreman/qa-recovery.js";
import type { BuildRecoveryDecisionReceipt, BuildRecoveryMode, BuildRunRecordV2, ContinuityDelta, ResolvedAgentSettings } from "rafi-spec";
import { assertLifecycleForCommand } from "./lifecycle.js";

type RecoverableRun = BuildRunRecordV2 & { active: boolean };

export interface BuildResumeCommandOptions {
  executeStart: (args: string[]) => Promise<number> | number;
  /** Deterministic provider probe injection for unit tests. */
  resolveProjection?: typeof resolveBuildRecoveryProjection;
  /** Deterministic plan-approval prompt injection for unit tests. */
  resolvePlanUpdateApproval?: () => Promise<"auto" | "review" | undefined>;
}

export function buildBuildResumeCommand(commandOpts: BuildResumeCommandOptions): Command {
  return new Command("build:resume")
    .description("Inspect and resume one interrupted implementation run using an exact recovery mode.")
    .argument("[project]", "project directory", ".")
    .option("--run <id>", "run ID or unique prefix")
    .option("--ticket <id>", "narrow mutation scope to one ticket while retaining run-wide context")
    .option("--qa-revision <number>", "exact durable QA protocol revision to resume")
    .option("--inspect", "show recovery state and planned actions without mutation")
    .option("--yes", "auto-approve the implementation plan and later plan updates for this resumed process")
    .option("--no", "review the implementation plan and later plan updates for this resumed process")
    .option("--fresh-with-handoff", "start a genuinely fresh session from validated cumulative context")
    .option("--fresh-session", "compatibility mode: ordinary fresh recovery without cumulative handoff")
    .option("--guided-recovery", "repair a degraded role checkpoint interactively, then start a validated successor")
    .option("--agent <runtime>", "fresh-mode provider (claude | codex)")
    .option("--model <model>", "fresh-mode model override")
    .action(async (project: string, opts: Record<string, unknown>) => {
      const root = resolve(project);
      assertLifecycleForCommand(root, "build-resume");
      validateModeFlags(opts);
      validateApprovalFlags(opts);
      if (opts.agent && !["claude", "codex"].includes(String(opts.agent))) throw new Error("--agent must be claude or codex");
      if (opts.qaRevision !== undefined && (!/^\d+$/.test(String(opts.qaRevision)) || Number(opts.qaRevision) < 0)) throw new Error("--qa-revision must be a non-negative integer");
      const runs = recoverableBuildRuns(root);
      if (runs.length === 0) { console.log("rafi build:resume: no unfinished or recoverable runs found"); return; }
      let selected = selectByFlags(runs, opts);
      if (!selected && opts.run) throw new Error(`no recoverable build run found for run ID or prefix ${String(opts.run)}`);
      if (!selected && opts.ticket) {
        const knownTickets = [...new Set(runs.flatMap((run) => run.tickets))].sort();
        throw new Error(`no recoverable build run found for ticket ${String(opts.ticket)}${knownTickets.length ? `; recoverable tickets: ${knownTickets.join(", ")}` : ""}`);
      }
      if (!selected) selected = await promptRun(runs);
      if (!selected) return;
      // Inspection and active-run diagnostics are strictly read-only. In
      // particular, do not reconcile filesystem projections while another
      // supervisor may still be publishing them.
      if (selected.active || opts.inspect) {
        const previewDb = new WorkflowDb(root);
        let previewTicket = opts.ticket ? String(opts.ticket) : undefined;
        try {
          if (!previewTicket) previewTicket = previewDb.pendingQaRecoveryHeads(selected.runId).at(0)?.ticketId
            ?? previewDb.pendingQaTicketHeads(selected.runId).at(0)?.ticketId;
        } finally { previewDb.close(); }
        const preview = await (commandOpts.resolveProjection ?? resolveBuildRecoveryProjection)(root, selected, new Date(), previewTicket);
        console.log("rafi build:resume preview:");
        for (const line of formatBuildRecoveryProjection(preview)) console.log(`  ${line}`);
        if (selected.active) console.log("rafi build:resume: the original process is verified live; return to it or stop it before recovery. No mutation was performed.");
        return;
      }
      let preloadedQaRecoveryPacket: QaRecoveryPacket | undefined;
      let pendingQaProtocolTicket: string | undefined;
      let pendingQaProtocolRevision: number | undefined;
      const reconciliationDb = new WorkflowDb(root);
      const reconciliationLease = reconciliationDb.acquireLease(selected.runId);
      try { recoverPendingQaRecoveryPublications(root, selected.runId); }
      finally { reconciliationDb.releaseLease(reconciliationLease); reconciliationDb.close(); }
      const recoveryDb = new WorkflowDb(root);
      let recoveryVersion: string;
      try {
        recoveryVersion = recoveryStateVersion(recoveryDb, selected.runId);
        const legacyQaState = recoveryDb.getRun(selected.runId)?.state.qaReportRecovery as { packetPath?: unknown } | undefined;
        if (typeof legacyQaState?.packetPath === "string" && recoveryDb.pendingQaRecoveryHeads(selected.runId).length === 0) {
          // Loading performs the version/integrity check only; V1 is rejected
          // and is never converted into authoritative V2 state.
          loadQaRecoveryPacket(legacyQaState.packetPath);
        }
        const pendingRecoveryHeads = recoveryDb.pendingQaRecoveryHeads(selected.runId);
        if (pendingRecoveryHeads.length > 1 && !opts.ticket) throw new Error(`run ${selected.runId} has multiple pending QA recovery packets; resume one with --ticket`);
        const selectedHead = opts.ticket
          ? pendingRecoveryHeads.find((item) => item.ticketId === String(opts.ticket))
          : pendingRecoveryHeads[0];
        if (pendingRecoveryHeads.length > 0 && opts.ticket && !selectedHead) {
          throw new Error(`--ticket ${String(opts.ticket)} conflicts with pending QA recovery ticket${pendingRecoveryHeads.length === 1 ? ` ${pendingRecoveryHeads[0].ticketId}` : "s"}`);
        }
        if (selectedHead && selectedHead.pendingAction !== "resolved") {
          const packet = loadQaRecoveryPacket(selectedHead.packetPath);
          const pending = recoveryDb.qaRecoveryHead(selected.runId, packet.manifest.ticketId);
          if (!pending || packet.manifest.runId !== selected.runId || packet.manifest.ticketId !== pending.ticketId
            || packet.manifest.packetId !== pending.packetId || packet.manifest.packetDigest !== pending.packetDigest
            || packet.manifest.revision !== pending.revision || packet.manifest.reviewedStateDigest !== pending.reviewedStateDigest
            || packet.manifest.correctionTurns !== pending.correctionTurns || packet.manifest.pendingAction !== pending.pendingAction) {
            throw new Error("saved QA recovery packet does not match its durable recovery head");
          }
          if (!selected.tickets.includes(packet.manifest.ticketId)) throw new Error(`QA recovery packet ticket ${packet.manifest.ticketId} is not part of run ${selected.runId}`);
          if (opts.ticket && String(opts.ticket) !== packet.manifest.ticketId) throw new Error(`--ticket ${String(opts.ticket)} conflicts with pending QA recovery ticket ${packet.manifest.ticketId}`);
          if (!opts.ticket) throw new Error(`pending QA recovery must be resumed with --ticket ${packet.manifest.ticketId}`);
          const qaHead = recoveryDb.qaTicketHead(selected.runId, packet.manifest.ticketId);
          const attempts = recoveryDb.qaReviewAttempts(selected.runId, packet.manifest.ticketId);
          const attempt = attempts.find((item) => item.attemptId === packet.manifest.reviewAttemptId);
          const packetMayLeadSource = qaHead.sourceStateDigest !== packet.manifest.reviewedStateDigest
            && ["automatic-recovery", "successor-acknowledgement", "qa-correction", "qa-full-review", "operator-menu"].includes(packet.manifest.pendingAction);
          const exactBinding = qaHead.reviewNumber === packet.manifest.reviewAttempt && attempt?.reviewNumber === packet.manifest.reviewAttempt
            && attempt.sourceDigest === qaHead.sourceStateDigest && (qaHead.sourceStateDigest === packet.manifest.reviewedStateDigest || packetMayLeadSource);
          const undispatchedSuccessor = attempts.find((item) => item.reviewNumber === qaHead.reviewNumber);
          const packetMayLagOneUndispatchedReview = qaHead.state === "review-ready" && qaHead.reviewNumber === packet.manifest.reviewAttempt + 1
            && attempt?.reviewNumber === packet.manifest.reviewAttempt && attempt.status === "interrupted" && undispatchedSuccessor?.status === "started"
            && undispatchedSuccessor.sourceDigest === qaHead.sourceStateDigest && qaHead.sourceStateDigest === packet.manifest.reviewedStateDigest;
          if (!exactBinding && !packetMayLagOneUndispatchedReview) {
            throw new Error("saved QA recovery packet does not match its durable review/source binding");
          }
          if (opts.qaRevision === undefined) throw new Error(`pending QA recovery must be resumed with --qa-revision ${qaHead.revision}`);
          if (Number(opts.qaRevision) !== qaHead.revision) throw new Error(`stale QA recovery revision: requested ${String(opts.qaRevision)}, current revision is ${qaHead.revision}`);
          preloadedQaRecoveryPacket = packet;
          pendingQaProtocolTicket = packet.manifest.ticketId;
          pendingQaProtocolRevision = qaHead.revision;
        } else {
          const pendingHeads = recoveryDb.pendingQaTicketHeads(selected.runId);
          if (pendingHeads.length > 1) throw new Error(`run ${selected.runId} has multiple pending QA tickets; resume one explicitly after inspecting durable state`);
          const qaHead = pendingHeads[0];
          if (qaHead) {
            if (!selected.tickets.includes(qaHead.ticketId)) throw new Error(`pending QA protocol ticket ${qaHead.ticketId} is not part of run ${selected.runId}`);
            if (!opts.ticket) throw new Error(`pending QA protocol must be resumed with --ticket ${qaHead.ticketId}`);
            if (String(opts.ticket) !== qaHead.ticketId) throw new Error(`--ticket ${String(opts.ticket)} conflicts with pending QA protocol ticket ${qaHead.ticketId}`);
            if (opts.qaRevision === undefined) throw new Error(`pending QA protocol must be resumed with --qa-revision ${qaHead.revision}`);
            if (Number(opts.qaRevision) !== qaHead.revision) throw new Error(`stale QA protocol revision: requested ${String(opts.qaRevision)}, current revision is ${qaHead.revision}`);
            pendingQaProtocolTicket = qaHead.ticketId;
            pendingQaProtocolRevision = qaHead.revision;
          }
        }
      } finally { recoveryDb.close(); }
      const effectiveTicket = pendingQaProtocolTicket ?? (opts.ticket ? String(opts.ticket) : undefined);
      let projection = await (commandOpts.resolveProjection ?? resolveBuildRecoveryProjection)(root, selected, new Date(), effectiveTicket);
      console.log("rafi build:resume preview:");
      for (const line of formatBuildRecoveryProjection(projection)) console.log(`  ${line}`);
      const db = new WorkflowDb(root);
      let qaRecoveryPacket: QaRecoveryPacket | undefined = preloadedQaRecoveryPacket;
      let role: "builder" | "qa" = "builder";
      let head = db.continuityHead(selected.runId, "builder");
      const qaHead = db.continuityHead(selected.runId, "qa");
      if (qaHead && ["degraded", "invalid"].includes(qaHead.state) && (!head || head.state === "current")) { role = "qa"; head = qaHead; }
      if (qaRecoveryPacket) { role = "qa"; head = qaHead; }
      let reconstructable = Boolean(head && head.state === "current" && db.latestContinuityCheckpoint(selected.runId, role));
      const guidedAvailable = Boolean(head && ["degraded", "invalid"].includes(head.state));
      let mode = explicitMode(opts);
      if (!mode && process.stdin.isTTY && process.stdout.isTTY) mode = await promptMode(!qaRecoveryPacket && Boolean(projection.exactSessionId), reconstructable, guidedAvailable);
      if (!mode && !qaRecoveryPacket) mode = projection.exactSessionId ? "exact-session" : undefined;
      if (!mode) { db.close(); throw new Error(`this run has no compatible exact session; choose ${reconstructable ? "--fresh-with-handoff or " : ""}--fresh-session`); }
      if (qaRecoveryPacket && mode !== "fresh-with-handoff" && mode !== "guided-recovery") {
        db.close();
        throw new Error("a pending QA report recovery requires --fresh-with-handoff so the packet can be materialized and acknowledged in a new disposable QA snapshot");
      }
      if (mode === "exact-session" && !projection.exactSessionId) { db.close(); throw new Error("exact-session was selected, but the frozen projection has no compatible provider session"); }
      if ((opts.agent || opts.model) && mode === "exact-session") { db.close(); throw new Error("--agent and --model are accepted only for fresh recovery modes"); }
      let planUpdateApproval: "auto" | "review";
      try {
        planUpdateApproval = await resolvePlanUpdateApproval(opts, commandOpts.resolvePlanUpdateApproval);
      } catch (error) {
        db.close();
        throw error;
      }
      let settings: ResolvedAgentSettings;
      try { settings = requestedSettings(selected, role, opts); }
      catch (error) { db.close(); throw error; }
      // From this point onward recovery may publish checkpoints, stage handoffs,
      // or update decisions. Hold the supervisor lease before any such mutation.
      const mutationLease = db.acquireLease(selected.runId);
      let handoffGeneration: number | undefined;
      let receipt!: BuildRecoveryDecisionReceipt;
      try {
      if (recoveryStateVersion(db, selected.runId) !== recoveryVersion) throw new Error("Recovery state changed while the resume decision was being prepared; inspect and retry the current revision");
      const currentRun = readBuildRuns(root).find((run) => run.runId === selected!.runId);
      if (!currentRun) throw new Error("Selected recovery run disappeared before its decision could be committed");
      selected = { ...currentRun, active: false };
      const currentProjection = projectBuildRecovery(root, selected, new Date(), effectiveTicket, projection.sessionAvailability);
      const projectionState = (value: typeof projection) => ({ ticketId: value.ticketId, worktree: value.worktree, branch: value.branch,
        expectedChanges: value.expectedChanges, unexpectedChanges: value.unexpectedChanges });
      if (JSON.stringify(projectionState(currentProjection)) !== JSON.stringify(projectionState(projection))) {
        throw new Error("Repository recovery state changed while the resume decision was being prepared; inspect and retry");
      }
      projection = currentProjection;
      settings = requestedSettings(selected, role, opts);
      if (mode === "guided-recovery") {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("--guided-recovery requires an interactive TTY");
        if (!guidedAvailable) throw new Error("guided recovery is available only for a degraded or double-failure role checkpoint");
        const checkpoint = db.latestContinuityCheckpoint(selected.runId, role);
        const laterEvents = db.continuityEvents(selected.runId, checkpoint?.sequence ?? 0);
        const delta = await collectGuidedCheckpoint({ projectDir: root, role, run: selected, settings, projection, checkpoint, laterEvents });
        db.appendContinuityEvent({ runId: selected.runId, role: "host", kind: "guided_recovery", payload: { role, delta }, authoritativeStateRevision: head?.authoritativeStateRevision ?? 0 });
        db.publishContinuityCheckpoint({ runId: selected.runId, role, delta, state: "current", authoritativeStateRevision: head?.authoritativeStateRevision ?? 0 });
        head = db.continuityHead(selected.runId, role);
        reconstructable = true;
      }
      if ((mode === "fresh-with-handoff" || mode === "guided-recovery") && !reconstructable) throw new Error("fresh-with-handoff was selected, but no current validated cumulative checkpoint is reconstructable");

      const runHead = db.continuityHead(selected.runId, "run") ?? head;
      const authoritativeStateDigest = runHead?.digest ?? digest(projection);
      let handoffDigest: string | undefined;
      if (mode === "fresh-with-handoff" || mode === "guided-recovery") {
        const sessionId = role === "builder" ? selected.builder?.sessionId : selected.qa?.sessionId;
        const staged = new HandoffService(root).stage({
          runId: selected.runId,
          role,
          reason: mode === "guided-recovery" ? "guided recovery produced a repaired cumulative checkpoint" : "explicit fresh-with-handoff recovery decision",
          predecessorSessionId: sessionId,
          predecessorSessionRef: role === "builder" ? projection.sessionCandidateRef : selected.sessionBindings?.filter((ref) => ref.role === "qa").at(-1),
          roleState: { projection, mutationScope: effectiveTicket ? [effectiveTicket] : selected.tickets, runWideTickets: selected.tickets,
            ...(qaRecoveryPacket ? { recoveryPacketDigest: qaRecoveryPacket.manifest.packetDigest, reviewedStateDigest: qaRecoveryPacket.manifest.reviewedStateDigest } : {}) },
          compactionCount: sessionId ? db.successfulCompactionCount(selected.runId, role, role === "builder" ? projection.sessionCandidateRef ?? sessionId : selected.sessionBindings?.filter((ref) => ref.role === "qa" && ref.sessionId === sessionId).at(-1) ?? sessionId) : 0,
          compactMaximum: settings.compact_maximum ?? 10,
          resources: [{ label: "frozen-recovery-projection", content: JSON.stringify(projection), authoritative: true, purpose: "Frozen build recovery projection" }, ...(qaRecoveryPacket ? qaRecoveryPacket.manifest.resources.map((resource) => ({
            label: resource.path, digest: resource.digest, authoritative: true, requiredForRecovery: resource.requiredForRecovery,
            mediaType: resource.mediaType, path: resource.path, purpose: resource.purpose, bytes: resource.bytes,
          })) : [])],
        });
        handoffGeneration = staged.manifest.generation;
        handoffDigest = staged.lineage.manifestDigest;
      }
      receipt = {
        version: 1,
        mode,
        runId: selected.runId,
        tickets: [...selected.tickets],
        role,
        ...(head ? { checkpointDigest: head.digest } : {}),
        ...(handoffDigest ? { handoffDigest } : {}),
        authoritativeStateDigest,
        settings,
        worktree: projection.worktree,
        ...(selected.repository.branch ? { branch: selected.repository.branch } : {}),
        ...(projection.exactSessionId ? { predecessorSessionId: projection.exactSessionId } : {}),
        ...(projection.exactSessionRef ? { predecessorSessionRef: projection.exactSessionRef } : {}),
        ...(projection.sessionAvailability ? { sessionAvailability: projection.sessionAvailability } : {}),
        ...((opts.agent || opts.model) ? { requestedSuccessor: { ...(opts.agent ? { agent: String(opts.agent) as "claude" | "codex" } : {}), ...(opts.model ? { model: String(opts.model) } : {}) } } : {}),
        planUpdateApproval,
        decidedAt: new Date().toISOString(),
      };
      db.recordRecoveryDecision(receipt);
      selected = { ...saveBuildRun(root, { ...selected, checkpoint: "recovery-decision-frozen", recoveryDecision: receipt }), active: false };
      } finally {
        // executeStart launches a new supervisor process. Transfer ownership by
        // releasing the CLI's lease before spawning it; the child acquires and
        // revalidates the durable recovery decision itself.
        db.releaseLease(mutationLease);
        db.close();
      }
      const args = ["start", root, "--steps", String(effectiveTicket ? 1 : Math.max(1, selected.tickets.length)), "--recover-run", selected.runId, "--recovery-mode", mode];
      args.push("--recovery-decision-digest", digest(receipt));
      if (effectiveTicket) args.push("--ticket", effectiveTicket);
      if (pendingQaProtocolRevision !== undefined) args.push("--qa-revision", String(pendingQaProtocolRevision));
      if (selected.branchMode !== "current") { args.push("--branch-per-ticket"); if (mode !== "exact-session") args.push("--continue"); }
      if (mode === "exact-session") args.push("--resume", projection.exactSessionId!);
      if (handoffGeneration !== undefined) args.push("--accept-handoff", String(handoffGeneration), "--accept-handoff-role", role);
      if (opts.agent) args.push("--agent", String(opts.agent));
      else if (settings.make) args.push("--agent", settings.make);
      if (opts.model) args.push("--model", String(opts.model));
      else if (settings.model !== "default") args.push("--model", settings.model);
      if (settings.reasoning !== "default") args.push("--effort", settings.reasoning);
      if (settings.fast) args.push("--fast");
      const code = await commandOpts.executeStart(args);
      if (code !== 0) process.exitCode = code;
    });
}

function recoveryStateVersion(db: WorkflowDb, runId: string): string {
  const run = db.getRun(runId);
  return digest({ run: run ? { status: run.status, checkpoint: run.checkpoint, remainingWork: run.remainingWork, state: run.state, updatedAt: run.updatedAt } : null,
    packets: db.pendingQaRecoveryHeads(runId), qa: db.pendingQaTicketHeads(runId),
    continuity: ["run", "builder", "qa"].map((role) => db.continuityHead(runId, role as "run" | "builder" | "qa")) });
}

function validateModeFlags(opts: Record<string, unknown>): void {
  const selected = [opts.freshWithHandoff, opts.freshSession, opts.guidedRecovery].filter(Boolean).length;
  if (selected > 1) throw new Error("--fresh-with-handoff, --fresh-session, and --guided-recovery are mutually exclusive");
}
function validateApprovalFlags(opts: Record<string, unknown>): void {
  if (opts.yes && opts.no) throw new Error("--yes and --no are mutually exclusive");
}

async function resolvePlanUpdateApproval(
  opts: Record<string, unknown>,
  injected?: () => Promise<"auto" | "review" | undefined>,
): Promise<"auto" | "review"> {
  if (opts.yes) return "auto";
  if (opts.no) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("--no requires an interactive TTY to review plan updates; use --yes to auto-approve this resumed process");
    }
    return "review";
  }
  if (injected) {
    const answer = await injected();
    if (!answer) throw new Error("build recovery cancelled before mutation");
    return answer;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("choose --yes to auto-approve plan updates in this non-interactive resumed process; no recovery mutation was performed");
  }
  const answer = await promptPlanUpdateApproval();
  if (!answer) throw new Error("build recovery cancelled before mutation");
  return answer;
}

async function promptPlanUpdateApproval(): Promise<"auto" | "review" | undefined> {
  const { select, isCancel } = await import("@clack/prompts");
  const answer = await select<"review" | "auto">({
    message: "How should Rafi handle implementation-plan updates during this resumed process?",
    options: [
      { value: "review", label: "Ask me to review each plan update (Recommended)" },
      { value: "auto", label: "Auto-approve plan updates for this resumed process" },
    ],
  });
  return isCancel(answer) ? undefined : answer;
}
function explicitMode(opts: Record<string, unknown>): BuildRecoveryMode | undefined {
  if (opts.freshWithHandoff) return "fresh-with-handoff";
  if (opts.freshSession) return "fresh-recovery-only";
  if (opts.guidedRecovery) return "guided-recovery";
  return undefined;
}

async function promptRun(runs: RecoverableRun[]): Promise<RecoverableRun | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("provide --run <id> or --ticket <id> when not running in a TTY");
  const { select, isCancel } = await import("@clack/prompts");
  const projections = new Map(runs.map((run) => [run.runId, projectBuildRecovery(run.repository.root, run)]));
  const answer = await select({ message: "Which interrupted build should Rafi recover?", options: runs.map((run) => ({ value: run.runId, label: `${run.runId.slice(0, 8)} — ${projections.get(run.runId)!.compactLabel}`, hint: `${run.active ? "verified process active; " : ""}${projections.get(run.runId)!.compactHint}` })) });
  return isCancel(answer) ? undefined : runs.find((run) => run.runId === answer);
}

async function promptMode(exact: boolean, reconstructable: boolean, guided: boolean): Promise<BuildRecoveryMode | undefined> {
  const { select, isCancel } = await import("@clack/prompts");
  const answer = await select<BuildRecoveryMode | "cancel">({ message: "How should Rafi continue?", options: [
    ...(exact ? [{ value: "exact-session" as const, label: "Resume exact compatible session (Recommended)" }] : []),
    ...(reconstructable ? [{ value: "fresh-with-handoff" as const, label: "Fresh session with validated cumulative handoff" }] : []),
    { value: "fresh-recovery-only", label: "Ordinary fresh recovery (compatibility; conversation continuity is not transferred)" },
    ...(guided ? [{ value: "guided-recovery" as const, label: "Guided recovery for degraded role checkpoint" }] : []),
    { value: "cancel", label: "Cancel" },
  ] });
  return isCancel(answer) || answer === "cancel" ? undefined : answer;
}

interface GuidedCheckpointInput {
  projectDir: string;
  role: "builder" | "qa";
  run: BuildRunRecordV2;
  settings: ResolvedAgentSettings;
  projection: unknown;
  checkpoint?: { sequence: number; digest: string; delta: ContinuityDelta };
  laterEvents: Array<{ sequence: number; kind: string; digest: string; payload: unknown }>;
}

async function collectGuidedCheckpoint(input: GuidedCheckpointInput): Promise<ContinuityDelta> {
  const { text, confirm, isCancel } = await import("@clack/prompts");
  const effort = ["low", "medium", "high", "xhigh"].includes(input.settings.reasoning)
    ? input.settings.reasoning as "low" | "medium" | "high" | "xhigh"
    : undefined;
  const recovery = await createRoleBuilder({
    projectDir: input.projectDir,
    role: input.role,
    agent: input.settings.make,
    model: input.settings.model === "default" ? undefined : input.settings.model,
    effort,
    fast: input.settings.fast,
    label: `${input.role} guided recovery`,
    allowSwitch: false,
    ...(input.role === "qa" ? { permissionConfig: readOnlyPermissionConfig(), sandboxMode: "read-only" as const } : {}),
  });
  let first = true;
  try {
    while (true) {
      const guidance = await text({
        message: first
          ? `Guide the ${input.role} recovery agent. State verified facts, unknown in-flight work, blockers, and the next safe action:`
          : `Add guidance or corrections for the ${input.role} recovery checkpoint:`,
        validate: (value) => String(value ?? "").trim() ? undefined : "Guidance is required",
      });
      if (isCancel(guidance)) throw new Error("guided recovery cancelled");
      const roleBoundary = input.role === "qa"
        ? "You are a QA recovery agent. Remain read-only/review-only. Do not edit project files or reset state."
        : "You are a Builder recovery agent. You retain edit/test permissions only within the frozen run scope; reconcile durable receipts before retrying any side effect.";
      const prompt = first ? [
        `Repair the durable cumulative checkpoint for interrupted run ${input.run.runId}, role ${input.role}.`,
        roleBoundary,
        `Frozen recovery projection: ${JSON.stringify(input.projection)}`,
        `Last valid checkpoint: ${JSON.stringify(input.checkpoint ?? { state: "missing" })}`,
        `Later host-observed facts: ${JSON.stringify(input.laterEvents.map((event) => ({ sequence: event.sequence, kind: event.kind, digest: event.digest, payload: event.payload })))}`,
        "Treat an in-flight operation as unknown unless a durable receipt or host fact proves its result.",
        `Human guidance: ${String(guidance)}`,
        "Return a repaired cumulative state. Do not claim work or evidence that is not supported by the checkpoint, host facts, repository inspection, or human guidance.",
        continuityInstruction(),
      ].join("\n\n") : [
        roleBoundary,
        `Human correction: ${String(guidance)}`,
        "Revise the proposed cumulative checkpoint and return it again.",
        continuityInstruction(),
      ].join("\n\n");
      first = false;
      const result = await recovery.builder.sendTurn(prompt);
      if (result.isError) {
        console.warn(`rafi build:resume: ${input.role} recovery turn failed; provide correction or cancel: ${result.text.slice(0, 240)}`);
        continue;
      }
      const parsed = parseContinuityDelta(result.text);
      if (!parsed.delta) {
        console.warn(`rafi build:resume: recovery agent returned an invalid checkpoint (${parsed.error?.problems.join("; ")}); provide guidance to repair it`);
        continue;
      }
      console.log("rafi build:resume guided checkpoint candidate:");
      console.log(`  decisions: ${parsed.delta.decisions.length}; completed actions: ${parsed.delta.completedActions.length}; evidence: ${parsed.delta.evidence.length}`);
      console.log(`  blockers: ${parsed.delta.blockers.length}; open work: ${parsed.delta.openWork.length}`);
      console.log(`  next action: ${parsed.delta.nextAction}`);
      const approved = await confirm({ message: `Publish this as the repaired ${input.role} checkpoint for run ${input.run.runId.slice(0, 8)}?`, initialValue: false });
      if (isCancel(approved)) throw new Error("guided recovery cancelled before checkpoint publication");
      if (approved) return parsed.delta;
    }
  } finally {
    await recovery.builder.close().catch(() => {});
  }
}

function requestedSettings(run: BuildRunRecordV2, role: "builder" | "qa", opts: Record<string, unknown>): ResolvedAgentSettings {
  const captured = run[role]?.settings ?? run.builder?.settings;
  if (!captured) throw new Error(`run ${run.runId} has no captured ${role} settings`);
  return { ...captured, ...(opts.agent ? { make: String(opts.agent) as "claude" | "codex", source: "cli" as const } : {}), ...(opts.model ? { model: String(opts.model), source: "cli" as const } : {}) };
}

function selectByFlags(runs: RecoverableRun[], opts: Record<string, unknown>): RecoverableRun | undefined {
  if ((opts.yes || opts.no) && !opts.run && !opts.ticket) throw new Error("--yes and --no require --run or --ticket");
  const matches = opts.run ? runs.filter((run) => run.runId === opts.run || run.runId.startsWith(String(opts.run)))
    : opts.ticket ? runs.filter((run) => run.currentTicket === opts.ticket || run.tickets.includes(String(opts.ticket))) : [];
  if (matches.length > 1) throw new Error(opts.ticket ? `multiple recoverable build runs found for ticket ${String(opts.ticket)}; choose one with --run (${matches.map((run) => run.runId.slice(0, 8)).join(", ")})` : "selection is ambiguous; provide a longer run ID");
  const selected = matches[0];
  if (selected && opts.run && opts.ticket && selected.currentTicket !== opts.ticket && !selected.tickets.includes(String(opts.ticket))) {
    throw new Error(`ticket ${String(opts.ticket)} is not part of run ${selected.runId}`);
  }
  return selected;
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
