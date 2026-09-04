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
    if (state.status === "running" && state.pid && state.pid !== process.pid && processLooksLive(state.pid, state.heartbeatAt)) {
      db.close(); throw new Error(`supervisor already active for run ${this.options.runId} (pid ${state.pid})`);
    }
    state = { ...state, status: "running", pid: process.pid, generation: state.generation + 1, heartbeatAt: this.now().toISOString() };
    db.putSupervisorState(this.options.runId, state);
    let lastCheckpoint = this.options.checkpoint();
    const heartbeat = setInterval(() => {
      state = { ...state, heartbeatAt: this.now().toISOString() };
      try { db.putSupervisorState(this.options.runId, state); } catch { /* next durable boundary reports failure */ }
    }, 10_000); heartbeat.unref();
    try {
      while (!this.stopRequested) {
        const pending = db.pendingHumanDecisions(this.options.runId);
        if (pending.length) {
          state = { ...state, status: "waiting_for_human", workerPid: undefined, heartbeatAt: this.now().toISOString() };
          db.putSupervisorState(this.options.runId, state);
          return { kind: "waiting_for_human" };
        }
        const checkpoint = this.options.checkpoint();
        if (checkpoint !== lastCheckpoint) { lastCheckpoint = checkpoint; state = { ...state, checkpointRestarts: 0 }; }
        state = { ...state, status: "running", workerGeneration: state.workerGeneration + 1, heartbeatAt: this.now().toISOString() };
        this.active = await this.options.spawnWorker(state.workerGeneration);
        state = { ...state, workerPid: this.active.pid }; db.putSupervisorState(this.options.runId, state);
        const outcome = await this.active.result; this.active = undefined;
        state = { ...state, workerPid: undefined, heartbeatAt: this.now().toISOString() };
        if (outcome.kind !== "crashed") {
          const status = outcome.kind === "completed" ? "stopped" : outcome.kind === "waiting_for_human" ? "waiting_for_human" : outcome.kind === "failed" ? "failed" : "stopped";
          state = { ...state, status }; db.putSupervisorState(this.options.runId, state); return outcome;
        }
        const checkpointLimit = this.options.policy.limits.workerRestartsPerCheckpoint;
        const runLimit = this.options.policy.limits.workerRestartsPerRun;
        if (state.checkpointRestarts >= checkpointLimit || state.runRestarts >= runLimit) {
          state = { ...state, status: "failed" }; db.putSupervisorState(this.options.runId, state);
          return { kind: "failed", detail: `worker restart budget exhausted at ${checkpoint}: ${outcome.detail}` };
        }
        state = { ...state, checkpointRestarts: state.checkpointRestarts + 1, runRestarts: state.runRestarts + 1 };
        db.putSupervisorState(this.options.runId, state);
        await this.sleep(Math.min(10_000, 250 * (2 ** Math.min(5, state.checkpointRestarts - 1))));
      }
      state = { ...state, status: "stopped", stopRequestedAt: this.now().toISOString(), workerPid: undefined };
      db.putSupervisorState(this.options.runId, state); return { kind: "stopped" };
    } finally {
      clearInterval(heartbeat); db.close();
    }
  }
}

export function initialSupervisorState(): SupervisorState {
  return { status: "starting", generation: 0, workerGeneration: 0, checkpointRestarts: 0, runRestarts: 0 };
}

function processLooksLive(pid: number, heartbeatAt?: string): boolean {
  if (!heartbeatAt || Date.now() - new Date(heartbeatAt).getTime() > 45_000) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

