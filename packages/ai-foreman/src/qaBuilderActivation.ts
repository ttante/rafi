import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { BuildRunRecordV2, ResolvedAgentSettings } from "rafi-spec";
import type { BuilderAdapter } from "./adapters/types.js";
import { assertBuildAssignmentReconciled, captureBuildSource } from "./buildAssignment.js";
import { HandoffService, HandoffRecoveryPausedError, type HandoffRecoveryOptions, type StagedHandoff } from "./handoffs.js";
import { qaDigest } from "./qaProtocolV2.js";
import { providerSessionKey } from "./sessionIdentity.js";
import { loadTicketsConfig, resolveTicketPaths } from "./tickets/config.js";
import { loadTickets } from "./tickets/ticketLoader.js";
import { WorkflowDb } from "./workflowDb.js";

export interface QaRecoveryBuilderActivation {
  projectDir: string;
  runId: string;
  ticketId: string;
  worktree: string;
  adapter: BuilderAdapter;
  settings: ResolvedAgentSettings;
  expectedCapabilities?: BuildRunRecordV2["builderCapabilities"];
  frozenAction: string;
  createSuccessor: (handoff: StagedHandoff, requestedRuntime?: "claude" | "codex") => Promise<BuilderAdapter>;
  wrap: (adapter: BuilderAdapter) => BuilderAdapter | Promise<BuilderAdapter>;
  recovery?: HandoffRecoveryOptions;
}

/** QA-only startup must not replace Builder ownership. Activate a Builder only
 * at an authorized work boundary, through the ordinary validated handoff. */
export async function activateQaRecoveryBuilder(input: QaRecoveryBuilderActivation): Promise<BuilderAdapter> {
  const inspect = () => {
    const db = new WorkflowDb(input.projectDir);
    try {
      const lease = db.currentLease();
      if (lease?.runId !== input.runId || lease.pid !== process.pid) throw new Error("Builder activation requires the current build execution lease");
      const run = db.getRun(input.runId)?.state as unknown as BuildRunRecordV2 | undefined;
      if (!run?.tickets.includes(input.ticketId) || run.progress.completedTickets.includes(input.ticketId)) throw new Error("QA recovery cannot activate Builder work outside unfinished approved scope");
      const admission = db.assertAdmittedWork(input.runId, input.ticketId);
      const definition = loadTickets(resolveTicketPaths(loadTicketsConfig(input.projectDir), input.projectDir).tickets).find(ticket => ticket.id === input.ticketId);
      if (!definition || qaDigest("admitted-requirements", definition) !== admission.requirementsDigest) throw new Error("Builder recovery requirements changed; renew scope approval before implementation");
      if (!run.builder || qaDigest("builder-settings", run.builder.settings) !== qaDigest("builder-settings", input.settings)) throw new Error("QA recovery cannot replace the saved Builder settings");
      if (input.expectedCapabilities && qaDigest("builder-capabilities", run.builderCapabilities) !== qaDigest("builder-capabilities", input.expectedCapabilities)) throw new Error("Builder capability approval changed before recovery activation");
      if (db.unresolvedRoleDispatches(input.runId, "builder").length) throw new Error("Reconcile unknown Builder dispatch before activating another session");
      assertBuildAssignmentReconciled(input.projectDir, input.runId, input.worktree);
      const owner = db.roleMutationLease(input.runId, "builder");
      const ref = owner?.sessionRef;
      if (!owner || !Number.isSafeInteger(owner.generation) || owner.generation < 0 || !ref || ref.version !== 1 || ref.role !== "builder" || ref.stream !== "builder"
        || !Number.isSafeInteger(ref.generation) || ref.generation < 0 || ref.sessionId !== owner.providerSessionId
        || ref.source !== "observed" || !ref.validatedAt || Number.isNaN(Date.parse(ref.validatedAt)) || providerSessionKey(ref) !== owner.sessionKey
        || realpathSync(ref.cwd) !== realpathSync(input.worktree) || realpathSync(ref.configRoot) !== realpathSync(input.projectDir)) throw new Error("QA recovery has no validated Builder owner for this worktree");
      const branchSession = db.branchResumeSessions(false).find(session => session.ticket === input.ticketId && realpathSync(session.worktreePath) === realpathSync(input.worktree));
      const branch = branchSession?.branch ?? (realpathSync(run.repository.worktree) === realpathSync(input.worktree) ? run.repository.branch : undefined);
      if (!branch || execFileSync("git", ["branch", "--show-current"], { cwd: input.worktree, encoding: "utf8" }).trim() !== branch) throw new Error("Return to the approved Builder worktree branch before recovery activation");
      const head = db.continuityHead(input.runId, "builder");
      if (!head || head.state !== "current" || !db.latestContinuityCheckpoint(input.runId, "builder")) throw new Error("Builder continuity needs reconstruction before QA can request implementation");
      return { owner, ref, head, source: captureBuildSource(input.worktree), requirementsDigest: admission.requirementsDigest,
        capabilitiesDigest: qaDigest("builder-capabilities", run.builderCapabilities), compactionCount: db.successfulCompactionCount(input.runId, "builder", ref) };
    } finally { db.close(); }
  };
  const before = inspect();
  const currentRef = input.adapter.sessionRef?.();
  if (currentRef && providerSessionKey(currentRef) === before.owner.sessionKey && currentRef.generation === before.ref.generation
    && currentRef.role === "builder" && currentRef.stream === "builder" && realpathSync(currentRef.configRoot) === realpathSync(input.projectDir)
    && currentRef.source === "observed" && currentRef.validatedAt) return input.adapter;
  const assertPreparedState = (current: ReturnType<typeof inspect>) => {
    if (current.owner.generation !== before.owner.generation || current.owner.sessionKey !== before.owner.sessionKey
      || current.head.digest !== before.head.digest || current.source.digest !== before.source.digest || current.capabilitiesDigest !== before.capabilitiesDigest) throw new Error("Builder recovery state changed while preparing its handoff; inspect and retry");
  };

  const transfer = await new HandoffService(input.projectDir).transfer({
    runId: input.runId, role: "builder", reason: "Authorized Builder work after QA-only recovery requires a validated Builder owner",
    predecessorSessionId: before.ref.sessionId, predecessorSessionRef: before.ref,
    compactionCount: before.compactionCount, compactMaximum: input.settings.compact_maximum ?? 10,
    roleState: { ticketId: input.ticketId, requirementsDigest: before.requirementsDigest, sourceDigest: before.source.digest,
      capabilitiesDigest: before.capabilitiesDigest, recovery: "qa-builder-activation", providerReplayAuthorized: false },
    resources: [{ label: "frozen-action", content: input.frozenAction, authoritative: true, purpose: "Approved QA remediation or guidance action; no replay of historical work" }],
  }, async (handoff, runtime) => {
    assertPreparedState(inspect());
    const successor = await input.createSuccessor(handoff, runtime);
    try { assertPreparedState(inspect()); }
    catch (error) { await successor.close().catch(() => {}); throw error; }
    return successor;
  }, input.recovery);
  let owned: BuilderAdapter;
  try { owned = await input.wrap(transfer.successor); }
  catch (error) {
    let drainError: unknown;
    try { await transfer.successor.close(); } catch (failure) { drainError = failure; }
    throw new HandoffRecoveryPausedError(input.runId, transfer.manifest.generation,
      `Builder handoff was accepted but could not install its execution wrapper: ${String(error)}.${drainError ? ` The accepted session also needs cleanup: ${String(drainError)}.` : " The accepted session was closed without implementation."} The recorded accepted owner is preserved; inspect this build with rafi resume before continuing.`);
  }
  try { await input.adapter.close(); }
  catch (error) {
    let drainError: unknown;
    try { await owned.close(); } catch (failure) { drainError = failure; }
    throw new HandoffRecoveryPausedError(input.runId, transfer.manifest.generation,
      `Builder handoff was accepted, but the unused startup session could not close: ${String(error)}.${drainError ? ` The accepted session also needs cleanup: ${String(drainError)}.` : " The accepted session was closed without implementation."} Ownership remains with the recorded accepted session; reconcile cleanup with rafi resume before continuing.`);
  }
  return owned;
}
