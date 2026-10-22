import type { BuildAdmission } from "./buildAdmission.js";
import { processStartIdentity } from "./processIdentity.js";
import { stopCause, type ResolvedAutonomyPolicy, type StopCause, type StopCauseName, type SupervisorState } from "rafi-spec";
import { WorkflowDb } from "./workflowDb.js";

export type WorkerOutcome =
  | { kind: "completed" }
  | { kind: "waiting_for_human" }
  | { kind: "stopped" }
  | { kind: "failed"; detail: string }
  | { kind: "crashed"; detail: string };

export interface SupervisorWorkerHandle {
  pid?: number;
  result: Promise<WorkerOutcome>;
  stop: () => Promise<void> | void;
}

/**
 * Retry only the short synchronous persistence operation. The caller owns
 * the retry budget and remains responsible for deciding whether ownership is
 * safe after the budget is exhausted.
 */
export async function persistWithBoundedRetry(
  persist: () => void,
  sleep: (milliseconds: number) => Promise<void>,
  attempts = 3,
): Promise<{ ok: true; attempts: number } | { ok: false; attempts: number; error: unknown }> {
  let error: unknown;
  let completedAttempts = 0;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    completedAttempts = attempt;
    try { persist(); return { ok: true, attempts: attempt }; }
    catch (failure) {
      error = failure;
      if (attempt < attempts && retryablePersistenceError(failure)) await sleep(100 * attempt);
      else break;
    }
  }
  return { ok: false, attempts: completedAttempts, error };
}

function retryablePersistenceError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is (?:busy|locked)/i.test(message);
}

export interface DurableSupervisorOptions {
  projectDir: string;
  runId: string;
  policy: ResolvedAutonomyPolicy;
  admission?: BuildAdmission;
  spawnWorker: (generation: number) => Promise<SupervisorWorkerHandle> | SupervisorWorkerHandle;
  checkpoint: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  onStopRequested?: (cause: StopCause) => void;
  heartbeatIntervalMs?: number;
}

/** Durable worker restart loop. The supervisor never owns the project's mutation lease. */
export class DurableSupervisor {
  private stopRequested = false;
  private requestedStopCause?: StopCause;
  private active?: SupervisorWorkerHandle;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: DurableSupervisorOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
  }

  requestStop(cause: StopCauseName = "unknown"): void {
    this.stopRequested = true;
    const source: StopCause["source"] = cause === "user-sigint" || cause === "parent-sigterm" ? "signal" : cause === "heartbeat-timeout" ? "heartbeat" : cause === "heartbeat-persistence-failure" ? "persistence" : cause === "human-decision" ? "human-decision" : "host";
    const actor: StopCause["actor"] = cause === "user-sigint" ? "user" : cause === "parent-sigterm" ? "parent" : cause === "heartbeat-persistence-failure" ? "database" : cause === "unknown" ? "unknown" : "supervisor";
    this.requestedStopCause = stopCause({ cause, source, actor, runId: this.options.runId, checkpoint: this.options.checkpoint(), at: this.now().toISOString(), requested: true });
    this.options.onStopRequested?.(this.requestedStopCause);
    void this.active?.stop();
  }

  async run(): Promise<WorkerOutcome> {
    const db = new WorkflowDb(this.options.projectDir);
    let state = db.supervisorState(this.options.runId) ?? initialSupervisorState();
    if (!this.options.policy.supervisorEnabled) {
      state = { ...state, status: "disabled" }; db.putSupervisorState(this.options.runId, state); db.close();
      return { kind: "stopped" };
    }
    let ownedAdmission: BuildAdmission | undefined;
    try {
      if (this.options.admission) db.assertBuildAdmission(this.options.admission);
      else ownedAdmission = db.acquireBuildAdmission(this.options.runId, "coordinator");
      state = db.atomic(() => {
    for (const other of db.runningSupervisors()) {
      if (other.runId !== this.options.runId && other.state.pid && processLooksLive(other.state.pid, other.state.processStart)) throw new Error(`supervisor already active for project (run ${other.runId})`);
    }
    const latest = db.supervisorState(this.options.runId);
    if (latest) state = latest;
    if (state.status === "running" && state.pid && processLooksLive(state.pid, state.processStart)) {
      throw new Error(`supervisor already active for run ${this.options.runId} (pid ${state.pid})`);
    }
    state = { ...state, status: "running", pid: process.pid, processStart: processStartIdentity(), generation: state.generation + 1, heartbeatAt: this.now().toISOString() };
    db.putSupervisorState(this.options.runId, state);
    return state;
    }); } catch (error) {
      try { if (ownedAdmission) db.releaseBuildAdmission(ownedAdmission); } finally { db.close(); }
      throw error;
    }
    const saveState = () => db.atomic(() => {
      const owner = db.supervisorState(this.options.runId);
      if (owner?.generation !== state.generation || owner.pid !== process.pid) throw new Error("supervisor ownership changed");
      db.putSupervisorState(this.options.runId, state);
    });
    let lastCheckpoint = this.options.checkpoint();
    let heartbeatInFlight = false;
    const persistHeartbeat = async (): Promise<void> => {
      if (heartbeatInFlight || this.stopRequested) return;
      heartbeatInFlight = true;
      try {
        state = { ...state, heartbeatAt: this.now().toISOString() };
        const persisted = await persistWithBoundedRetry(saveState, this.sleep);
        if (persisted.ok) return;
        this.requestStop("heartbeat-persistence-failure");
        // Ownership failure remains fail-closed; the explicit cause is
        // delivered to the worker-exit evidence by supervisedStart.
      } finally { heartbeatInFlight = false; }
    };
    let heartbeatTask: Promise<void> | undefined;
    const heartbeat = setInterval(() => { heartbeatTask = persistHeartbeat(); }, this.options.heartbeatIntervalMs ?? 10_000); heartbeat.unref();
    try {
      while (!this.stopRequested) {
        const pending = db.pendingHumanDecisions(this.options.runId);
        if (pending.some(decision => !this.options.policy.continueIndependentTickets || !decision.interruptionId.startsWith("ticket:"))) {
          state = { ...state, status: "waiting_for_human", workerPid: undefined, heartbeatAt: this.now().toISOString(), stopCause: stopCause({ cause: "human-decision", source: "human-decision", actor: "supervisor", runId: this.options.runId, supervisorGeneration: state.generation, workerGeneration: state.workerGeneration, checkpoint: "waiting-for-human", at: this.now().toISOString(), requested: true }) };
          saveState();
          if (db.getRun(this.options.runId)?.status === "running") db.transitionSupervisor(this.options.runId, state.workerGeneration, { status: "paused", checkpoint: "waiting-for-human", event: "worker_waiting_for_human", payload: { cause: state.stopCause } });
          return { kind: "waiting_for_human" };
        }
        const checkpoint = this.options.checkpoint();
        if (checkpoint !== lastCheckpoint) lastCheckpoint = checkpoint;
        state = { ...state, status: "running", workerGeneration: state.workerGeneration + 1, heartbeatAt: this.now().toISOString() };
        saveState(); // Publish the fence before the child can dispatch.
        this.active = await this.options.spawnWorker(state.workerGeneration);
        state = { ...state, workerPid: this.active.pid }; saveState();
        const workerPid = state.workerPid;
        const outcome = await this.active.result; this.active = undefined;
        state = { ...state, workerPid: undefined, heartbeatAt: this.now().toISOString() };
        const cause = this.requestedStopCause
          ? stopCause({ ...this.requestedStopCause, supervisorGeneration: state.generation, workerGeneration: state.workerGeneration, pid: workerPid, processStart: workerPid ? processStartIdentity(workerPid) : undefined, checkpoint: this.options.checkpoint(), at: this.now().toISOString() })
          : stopCause({ cause: "worker-exit", source: "worker", actor: "worker", runId: this.options.runId, supervisorGeneration: state.generation, workerGeneration: state.workerGeneration, pid: workerPid, checkpoint: this.options.checkpoint(), at: this.now().toISOString(), requested: false, detail: outcome.kind === "failed" ? outcome.detail : `worker outcome: ${outcome.kind}` });
        state = { ...state, stopCause: cause };
        if (outcome.kind !== "crashed") {
          if (outcome.kind === "failed" && db.getRun(this.options.runId)?.status === "running") {
            const eligibility = db.preparationEligibility(this.options.runId);
            db.transitionSupervisor(this.options.runId, state.workerGeneration, {
              status: eligibility.eligible ? "failed" : "paused",
              checkpoint: eligibility.eligible ? "worker-failed" : "worker-reconciliation-required",
              event: "worker_exit_recorded", payload: { detail: outcome.detail, reasons: eligibility.reasons, cause },
            });
          }
          else if (db.getRun(this.options.runId)?.status === "running") db.transitionSupervisor(this.options.runId, state.workerGeneration, {
            status: "paused", checkpoint: outcome.kind === "waiting_for_human" && db.pendingHumanDecisions(this.options.runId).length ? "waiting-for-human" : "worker-exited-before-checkpoint",
            event: "worker_exit_recorded", payload: { outcome: outcome.kind, cause },
          });
          const status = outcome.kind === "completed" ? "stopped" : outcome.kind === "waiting_for_human" ? "waiting_for_human" : outcome.kind === "failed" ? "failed" : "stopped";
          state = { ...state, status }; saveState(); return outcome;
        }
        const eligibility = db.preparationEligibility(this.options.runId);
        if (!eligibility.eligible) {
          state = { ...state, status: "waiting_for_human" }; saveState();
          const cause = stopCause({ ...state.stopCause!, cause: "worker-reconciliation-required", source: "reconciliation", actor: "supervisor", checkpoint: "worker-reconciliation-required", at: this.now().toISOString(), requested: false, detail: eligibility.reasons.join("; ") });
          state = { ...state, stopCause: cause };
          saveState();
          db.transitionSupervisor(this.options.runId, state.workerGeneration, { status: "paused", checkpoint: "worker-reconciliation-required", event: "worker_restart_withheld", payload: { reasons: eligibility.reasons, cause } });
          return { kind: "waiting_for_human" };
        }
        const checkpointLimit = this.options.policy.limits.workerRestartsPerCheckpoint;
        const runLimit = this.options.policy.limits.workerRestartsPerRun;
        if (state.checkpointRestarts >= checkpointLimit || state.runRestarts >= runLimit) {
          state = { ...state, status: "failed" }; saveState();
          if (db.getRun(this.options.runId)?.status === "running") db.transitionSupervisor(this.options.runId, state.workerGeneration, {
            status: "failed", checkpoint: "worker-restart-budget-exhausted", event: "worker_restart_budget_exhausted", payload: { checkpoint, detail: outcome.detail, cause: state.stopCause },
          });
          return { kind: "failed", detail: `worker restart budget exhausted at ${checkpoint}: ${outcome.detail}` };
        }
        state = { ...state, checkpointRestarts: state.checkpointRestarts + 1, runRestarts: state.runRestarts + 1 };
        saveState();
        await this.sleep(Math.min(10_000, 250 * (2 ** Math.min(5, state.checkpointRestarts - 1))));
      }
      state = { ...state, status: "stopped", stopRequestedAt: this.now().toISOString(), workerPid: undefined, stopCause: state.stopCause ?? this.requestedStopCause ?? stopCause({ cause: "unknown", source: "host", actor: "unknown", runId: this.options.runId, supervisorGeneration: state.generation, workerGeneration: state.workerGeneration, checkpoint: "worker-stopped", at: this.now().toISOString(), requested: true, detail: "Supervisor stopped without a more specific durable cause" }) };
      if (db.getRun(this.options.runId)?.status === "running") db.transitionSupervisor(this.options.runId, state.workerGeneration, { status: "paused", checkpoint: "worker-stopped", event: "supervisor_stop_recorded", payload: { cause: state.stopCause } });
      saveState(); return { kind: "stopped" };
    } catch (error) {
      state = { ...state, status: "failed", workerPid: undefined, heartbeatAt: this.now().toISOString(), stopCause: stopCause({ cause: "launch-failure", source: "launch", actor: "supervisor", runId: this.options.runId, supervisorGeneration: state.generation, workerGeneration: state.workerGeneration, checkpoint: "worker-launch-failed", at: this.now().toISOString(), requested: false, detail: String(error) }) };
      saveState();
      if (db.getRun(this.options.runId)?.status === "running") {
        const eligibility = db.preparationEligibility(this.options.runId);
        const cause = stopCause({ cause: "launch-failure", source: "launch", actor: "supervisor", runId: this.options.runId, supervisorGeneration: state.generation, workerGeneration: state.workerGeneration, checkpoint: eligibility.eligible ? "worker-launch-failed" : "worker-reconciliation-required", at: new Date().toISOString(), requested: false, detail: String(error) });
        db.transitionSupervisor(this.options.runId, state.workerGeneration, { status: eligibility.eligible ? "failed" : "paused",
          checkpoint: eligibility.eligible ? "worker-launch-failed" : "worker-reconciliation-required", event: "worker_launch_failed",
          payload: { detail: String(error), reasons: eligibility.reasons, cause },
        });
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (heartbeatTask) await heartbeatTask;
      try { if (ownedAdmission && db.buildAdmission()?.token === ownedAdmission.token) db.releaseBuildAdmission(ownedAdmission); }
      finally { db.close(); }
    }
  }
}

export function initialSupervisorState(): SupervisorState {
  return { status: "starting", generation: 0, workerGeneration: 0, checkpointRestarts: 0, runRestarts: 0 };
}

function processLooksLive(pid: number, expectedStart?: string): boolean {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  const actual = processStartIdentity(pid);
  return !expectedStart || expectedStart === "unavailable" || actual === "unavailable" || actual === expectedStart;
}

