import { createHash } from "node:crypto";
import { Command } from "commander";
import { resolve } from "node:path";
import {
  formatBuildRecoveryProjection,
  projectBuildRecovery,
  recoverableBuildRuns,
  resolveBuildRecoveryProjection,
  saveBuildRun,
} from "ai-foreman/build-runs.js";
import { HandoffService } from "ai-foreman/handoffs.js";
import { createRoleBuilder, readOnlyPermissionConfig } from "ai-foreman/agent-run.js";
import { continuityInstruction, parseContinuityDelta } from "ai-foreman/continuity.js";
import { WorkflowDb } from "ai-foreman/workflow-db.js";
import type { BuildRecoveryDecisionReceipt, BuildRecoveryMode, BuildRunRecordV2, ContinuityDelta, ResolvedAgentSettings } from "rafi-spec";
import { assertLifecycleForCommand } from "./lifecycle.js";

type RecoverableRun = BuildRunRecordV2 & { active: boolean };

export interface BuildResumeCommandOptions {
  executeStart: (args: string[]) => Promise<number> | number;
  /** Deterministic provider probe injection for unit tests. */
  resolveProjection?: typeof resolveBuildRecoveryProjection;
}

export function buildBuildResumeCommand(commandOpts: BuildResumeCommandOptions): Command {
  return new Command("build:resume")
    .description("Inspect and resume one interrupted implementation run using an exact recovery mode.")
    .argument("[project]", "project directory", ".")
    .option("--run <id>", "run ID or unique prefix")
    .option("--ticket <id>", "narrow mutation scope to one ticket while retaining run-wide context")
    .option("--inspect", "show recovery state and planned actions without mutation")
    .option("--yes", "accept the recovery preview (requires --run or --ticket)")
    .option("--fresh-with-handoff", "start a genuinely fresh session from validated cumulative context")
    .option("--fresh-session", "compatibility mode: ordinary fresh recovery without cumulative handoff")
    .option("--guided-recovery", "repair a degraded role checkpoint interactively, then start a validated successor")
    .option("--agent <runtime>", "fresh-mode provider (claude | codex)")
    .option("--model <model>", "fresh-mode model override")
    .action(async (project: string, opts: Record<string, unknown>) => {
      const root = resolve(project);
      assertLifecycleForCommand(root, "build-resume");
      validateModeFlags(opts);
      if (opts.agent && !["claude", "codex"].includes(String(opts.agent))) throw new Error("--agent must be claude or codex");
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
      const projection = await (commandOpts.resolveProjection ?? resolveBuildRecoveryProjection)(root, selected, new Date(), opts.ticket ? String(opts.ticket) : undefined);
      console.log("rafi build:resume preview:");
      for (const line of formatBuildRecoveryProjection(projection)) console.log(`  ${line}`);
      if (selected.active) { console.log("rafi build:resume: the original process is verified live; return to it or stop it before recovery. No mutation was performed."); return; }
      if (opts.inspect) return;

      const db = new WorkflowDb(root);
      let role: "builder" | "qa" = "builder";
      let head = db.continuityHead(selected.runId, "builder");
      const qaHead = db.continuityHead(selected.runId, "qa");
      if (qaHead && ["degraded", "invalid"].includes(qaHead.state) && (!head || head.state === "current")) { role = "qa"; head = qaHead; }
      let reconstructable = Boolean(head && head.state === "current" && db.latestContinuityCheckpoint(selected.runId, role));
      const guidedAvailable = Boolean(head && ["degraded", "invalid"].includes(head.state));
      let mode = explicitMode(opts);
      if (!mode && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) mode = await promptMode(Boolean(projection.exactSessionId), reconstructable, guidedAvailable);
      if (!mode) mode = projection.exactSessionId ? "exact-session" : undefined;
      if (!mode) { db.close(); throw new Error(`this run has no compatible exact session; choose ${reconstructable ? "--fresh-with-handoff or " : ""}--fresh-session`); }
      if (mode === "exact-session" && !projection.exactSessionId) { db.close(); throw new Error("exact-session was selected, but the frozen projection has no compatible provider session"); }
      if ((opts.agent || opts.model) && mode === "exact-session") { db.close(); throw new Error("--agent and --model are accepted only for fresh recovery modes"); }
      const settings = requestedSettings(selected, role, opts);
      if (mode === "guided-recovery") {
        if (!process.stdin.isTTY || !process.stdout.isTTY) { db.close(); throw new Error("--guided-recovery requires an interactive TTY"); }
        if (!guidedAvailable) { db.close(); throw new Error("guided recovery is available only for a degraded or double-failure role checkpoint"); }
        const checkpoint = db.latestContinuityCheckpoint(selected.runId, role);
        const laterEvents = db.continuityEvents(selected.runId, checkpoint?.sequence ?? 0);
        const delta = await collectGuidedCheckpoint({ projectDir: root, role, run: selected, settings, projection, checkpoint, laterEvents });
        db.appendContinuityEvent({ runId: selected.runId, role: "host", kind: "guided_recovery", payload: { role, delta }, authoritativeStateRevision: head?.authoritativeStateRevision ?? 0 });
        db.publishContinuityCheckpoint({ runId: selected.runId, role, delta, state: "current", authoritativeStateRevision: head?.authoritativeStateRevision ?? 0 });
        head = db.continuityHead(selected.runId, role);
        reconstructable = true;
      }
      if ((mode === "fresh-with-handoff" || mode === "guided-recovery") && !reconstructable) { db.close(); throw new Error("fresh-with-handoff was selected, but no current validated cumulative checkpoint is reconstructable"); }

      const runHead = db.continuityHead(selected.runId, "run") ?? head;
      const authoritativeStateDigest = runHead?.digest ?? digest(projection);
      let handoffGeneration: number | undefined;
      let handoffDigest: string | undefined;
      if (mode === "fresh-with-handoff" || mode === "guided-recovery") {
        const sessionId = role === "builder" ? selected.builder?.sessionId : selected.qa?.sessionId;
        const staged = new HandoffService(root).stage({
          runId: selected.runId,
          role,
          reason: mode === "guided-recovery" ? "guided recovery produced a repaired cumulative checkpoint" : "explicit fresh-with-handoff recovery decision",
          predecessorSessionId: sessionId,
          predecessorSessionRef: role === "builder" ? projection.sessionCandidateRef : selected.sessionBindings?.filter((ref) => ref.role === "qa").at(-1),
          roleState: { projection, mutationScope: opts.ticket ? [String(opts.ticket)] : selected.tickets, runWideTickets: selected.tickets },
          compactionCount: sessionId ? db.successfulCompactionCount(selected.runId, role, role === "builder" ? projection.sessionCandidateRef ?? sessionId : selected.sessionBindings?.filter((ref) => ref.role === "qa" && ref.sessionId === sessionId).at(-1) ?? sessionId) : 0,
          compactMaximum: settings.compact_maximum ?? 10,
          resources: [{ label: "frozen-recovery-projection", content: JSON.stringify(projection), authoritative: true }],
        });
        handoffGeneration = staged.manifest.generation;
        handoffDigest = staged.lineage.manifestDigest;
      }
      const receipt: BuildRecoveryDecisionReceipt = {
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
        decidedAt: new Date().toISOString(),
      };
      db.recordRecoveryDecision(receipt);
      db.close();
      selected = { ...saveBuildRun(root, { ...selected, checkpoint: "recovery-decision-frozen", recoveryDecision: receipt }), active: false };

      const args = ["start", root, "--steps", String(opts.ticket ? 1 : Math.max(1, selected.tickets.length)), "--yes", "--recover-run", selected.runId, "--recovery-mode", mode];
      if (opts.ticket) args.push("--ticket", String(opts.ticket));
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
      if (code !== 0) throw new Error(`build recovery mode ${mode} exited with status ${code}; Rafi did not substitute another recovery path`);
    });
}

function validateModeFlags(opts: Record<string, unknown>): void {
  const selected = [opts.freshWithHandoff, opts.freshSession, opts.guidedRecovery].filter(Boolean).length;
  if (selected > 1) throw new Error("--fresh-with-handoff, --fresh-session, and --guided-recovery are mutually exclusive");
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
  if (opts.run && opts.ticket) throw new Error("choose either --run or --ticket");
  if (opts.yes && !opts.run && !opts.ticket) throw new Error("--yes requires --run or --ticket");
  const matches = opts.run ? runs.filter((run) => run.runId === opts.run || run.runId.startsWith(String(opts.run)))
    : opts.ticket ? runs.filter((run) => run.currentTicket === opts.ticket || run.tickets.includes(String(opts.ticket))) : [];
  if (matches.length > 1) throw new Error(opts.ticket ? `multiple recoverable build runs found for ticket ${String(opts.ticket)}; choose one with --run (${matches.map((run) => run.runId.slice(0, 8)).join(", ")})` : "selection is ambiguous; provide a longer run ID");
  return matches[0];
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
