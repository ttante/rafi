import { processStartIdentity } from "./processIdentity.js";
import type { ResolvedAutonomyPolicy, SupervisorState } from "rafi-spec";
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

export interface DurableSupervisorOptions {
  projectDir: string;
  runId: string;
  policy: ResolvedAutonomyPolicy;
  spawnWorker: (generation: number) => Promise<SupervisorWorkerHandle> | SupervisorWorkerHandle;
  checkpoint: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

/** Durable worker restart loop. The supervisor never owns the project's mutation lease. */
export class DurableSupervisor {
  private stopRequested = false;
  private active?: SupervisorWorkerHandle;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: DurableSupervisorOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
  }

  requestStop(): void {
    this.stopRequested = true;
    void this.active?.stop();
  }

  async run(): Promise<WorkerOutcome> {
    const db = new WorkflowDb(this.options.projectDir);
    let state = db.supervisorState(this.options.runId) ?? initialSupervisorState();
    if (!this.options.policy.supervisorEnabled) {
      state = { ...state, status: "disabled" }; db.putSupervisorState(this.options.runId, state); db.close();
      return { kind: "stopped" };
    }
    try { state = db.atomic(() => {
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
    }); } catch (error) { db.close(); throw error; }
    const saveState = () => db.atomic(() => {
      const owner = db.supervisorState(this.options.runId);
      if (owner?.generation !== state.generation || owner.pid !== process.pid) throw new Error("supervisor ownership changed");
      db.putSupervisorState(this.options.runId, state);
    });
    let lastCheckpoint = this.options.checkpoint();
    const heartbeat = setInterval(() => {
      state = { ...state, heartbeatAt: this.now().toISOString() };
      try { saveState(); } catch { this.requestStop(); }
    }, 10_000); heartbeat.unref();
    try {
      while (!this.stopRequested) {
        const pending = db.pendingHumanDecisions(this.options.runId);
        if (pending.some(decision => !this.options.policy.continueIndependentTickets || !decision.interruptionId.startsWith("ticket:"))) {
          state = { ...state, status: "waiting_for_human", workerPid: undefined, heartbeatAt: this.now().toISOString() };
          saveState();
          return { kind: "waiting_for_human" };
        }
        const checkpoint = this.options.checkpoint();
        if (checkpoint !== lastCheckpoint) lastCheckpoint = checkpoint;
        state = { ...state, status: "running", workerGeneration: state.workerGeneration + 1, heartbeatAt: this.now().toISOString() };
        saveState(); // Publish the fence before the child can dispatch.
        this.active = await this.options.spawnWorker(state.workerGeneration);
        state = { ...state, workerPid: this.active.pid }; saveState();
        const outcome = await this.active.result; this.active = undefined;
        state = { ...state, workerPid: undefined, heartbeatAt: this.now().toISOString() };
        if (outcome.kind !== "crashed") {
          const status = outcome.kind === "completed" ? "stopped" : outcome.kind === "waiting_for_human" ? "waiting_for_human" : outcome.kind === "failed" ? "failed" : "stopped";
          state = { ...state, status }; saveState(); return outcome;
        }
        const checkpointLimit = this.options.policy.limits.workerRestartsPerCheckpoint;
        const runLimit = this.options.policy.limits.workerRestartsPerRun;
        if (state.checkpointRestarts >= checkpointLimit || state.runRestarts >= runLimit) {
          state = { ...state, status: "failed" }; saveState();
          return { kind: "failed", detail: `worker restart budget exhausted at ${checkpoint}: ${outcome.detail}` };
        }
        state = { ...state, checkpointRestarts: state.checkpointRestarts + 1, runRestarts: state.runRestarts + 1 };
        saveState();
        await this.sleep(Math.min(10_000, 250 * (2 ** Math.min(5, state.checkpointRestarts - 1))));
      }
      state = { ...state, status: "stopped", stopRequestedAt: this.now().toISOString(), workerPid: undefined };
      saveState(); return { kind: "stopped" };
    } finally {
      clearInterval(heartbeat); db.close();
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

