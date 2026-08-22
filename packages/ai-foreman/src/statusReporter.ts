import type { BuilderAdapter } from "./adapters/types.js";

export interface AgentStatusSnapshot {
  role: string; provider: string; model: string; reasoning: string; fast: boolean;
  ticket?: string; stack?: string; step: number; total: number; phase: string; qaCycle?: number;
  context?: { used: number; maximum?: number; percentage?: number };
  sessionTransition: string; at: string;
}

export interface StatusClock {
  now(): Date;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: StatusClock = {
  now: () => new Date(),
  setInterval: (callback, milliseconds) => { const handle = setInterval(callback, milliseconds); handle.unref(); return handle; },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** Non-blocking five-minute status with provider-truthful context occupancy. */
export class AgentStatusReporter {
  private handle?: unknown;
  constructor(private readonly input: Omit<AgentStatusSnapshot, "context" | "at"> & { adapter: BuilderAdapter | (() => BuilderAdapter) }, private readonly emit: (line: string, snapshot: AgentStatusSnapshot) => void, private readonly clock: StatusClock = systemClock, private readonly intervalMs = 300_000) {}
  start(): void { if (this.handle !== undefined) return; this.handle = this.clock.setInterval(() => void this.tick(), this.intervalMs); }
  async tick(): Promise<void> {
    const adapter = typeof this.input.adapter === "function" ? this.input.adapter() : this.input.adapter;
    const context = await adapter.contextUsage?.();
    const { adapter: _adapter, ...base } = this.input;
    const snapshot: AgentStatusSnapshot = { ...base, ...(context ? { context } : {}), at: this.clock.now().toISOString() };
    const occupancy = context ? `context: ${context.used}/${context.maximum ?? "unknown"}${context.percentage === undefined ? "" : ` (${context.percentage.toFixed(1)}%)`}` : "context: unavailable";
    this.emit(`[${snapshot.at}] ${snapshot.role} ${snapshot.provider}/${snapshot.model} reasoning=${snapshot.reasoning} fast=${snapshot.fast}; ${snapshot.ticket ? `ticket=${snapshot.ticket}; ` : ""}${snapshot.stack ? `stack=${snapshot.stack}; ` : ""}step=${snapshot.step}/${snapshot.total}; phase=${snapshot.phase}${snapshot.qaCycle ? `; qa_cycle=${snapshot.qaCycle}` : ""}; ${occupancy}; session=${snapshot.sessionTransition}`, snapshot);
  }
  stop(): void { if (this.handle !== undefined) this.clock.clearInterval(this.handle); this.handle = undefined; }
}
