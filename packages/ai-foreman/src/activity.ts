import { AsyncLocalStorage } from "node:async_hooks";
import type { BuilderEvent } from "./adapters/types.js";
import { AsyncQueue } from "./util/asyncQueue.js";

export interface ActivityOutput {
  write(text: string): void;
  readonly isTTY: boolean;
}

export interface ActivityReporterOptions {
  output?: ActivityOutput;
  now?: () => number;
  displayDelayMs?: number;
  tickMs?: number;
  heartbeatMs?: number;
  quietWarningMs?: number;
}

interface ActivePhase { id: number; label: string; startedAt: number }

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One process-local live view shared by nested RAFI operations. */
export class ActivityReporter {
  private readonly output: ActivityOutput;
  private readonly now: () => number;
  private readonly displayDelayMs: number;
  private readonly tickMs: number;
  private readonly heartbeatMs: number;
  private readonly quietWarningMs: number;
  private readonly commandStartedAt: number;
  private readonly phases = new Map<number, ActivePhase>();
  private nextPhaseId = 1;
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private detail?: string;
  private provider?: string;
  private model?: string;
  private lastSignalAt = 0;
  private quietWarningPrinted = false;
  private lastHeartbeatAt = 0;
  private lineVisible = false;
  private paused = 0;
  private agentStatusLine?: string;

  constructor(readonly command: string, options: ActivityReporterOptions = {}) {
    this.output = options.output ?? {
      isTTY: Boolean(process.stdout.isTTY),
      write: (text) => process.stdout.write(text),
    };
    this.now = options.now ?? Date.now;
    this.displayDelayMs = options.displayDelayMs ?? 250;
    this.tickMs = options.tickMs ?? 1_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.quietWarningMs = options.quietWarningMs ?? 60_000;
    this.commandStartedAt = this.now();
  }

  begin(label: string): () => void {
    const phase: ActivePhase = { id: this.nextPhaseId++, label: clean(label, 100), startedAt: this.now() };
    this.phases.set(phase.id, phase);
    if (this.phases.size === 1) {
      this.lastSignalAt = phase.startedAt;
      this.lastHeartbeatAt = phase.startedAt;
      this.quietWarningPrinted = false;
      this.startTimer();
    }
    this.render(!this.output.isTTY);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.phases.delete(phase.id);
      if (this.phases.size === 0) this.idle();
      else this.render(true);
    };
  }

  update(state: string, detail?: string, metadata: { provider?: string; model?: string; immediate?: boolean } = {}): void {
    const phase = this.currentPhase();
    if (phase && state) phase.label = clean(state, 100);
    this.detail = detail ? clean(detail, 120) : undefined;
    this.provider = metadata.provider ?? this.provider;
    this.model = metadata.model ?? this.model;
    this.lastSignalAt = this.now();
    this.quietWarningPrinted = false;
    this.render(metadata.immediate !== false || this.output.isTTY);
  }

  pulse(detail?: string): void {
    if (detail) this.detail = clean(detail, 120);
    this.lastSignalAt = this.now();
    this.quietWarningPrinted = false;
    this.render(this.output.isTTY);
  }

  note(message: string): void {
    this.clearLine();
    this.output.write(`${clean(message, 500)}\n`);
    this.render(true);
  }

  writePersistent(text: string): void {
    if (!text) return;
    this.clearLine();
    this.output.write(text);
    if (!text.endsWith("\n")) this.output.write("\n");
    this.render(true);
  }

  /** Keep role/provider/context state in the single bottom-most TTY line. */
  setAgentStatus(line: string | undefined): void {
    this.agentStatusLine = line ? clean(line, 500) : undefined;
    if (this.agentStatusLine && !this.timer) {
      this.lastSignalAt = this.now();
      this.lastHeartbeatAt = this.lastSignalAt;
      this.startTimer();
    }
    if (!this.agentStatusLine && this.phases.size === 0) {
      this.idle();
      return;
    }
    this.render(true);
  }

  pause(): () => void {
    this.paused++;
    this.clearLine();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.paused = Math.max(0, this.paused - 1);
      this.render(true);
    };
  }

  dispose(): void {
    this.phases.clear();
    this.agentStatusLine = undefined;
    this.idle();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.render(false), this.tickMs);
    this.timer.unref();
  }

  private idle(): void {
    if (this.agentStatusLine) {
      this.clearLine();
      this.detail = undefined;
      this.provider = undefined;
      this.model = undefined;
      this.render(true);
      return;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearLine();
    this.detail = undefined;
    this.provider = undefined;
    this.model = undefined;
    this.agentStatusLine = undefined;
  }

  private currentPhase(): ActivePhase | undefined {
    return [...this.phases.values()].at(-1);
  }

  private render(force: boolean): void {
    const phase = this.currentPhase();
    if ((!phase && !this.agentStatusLine) || this.paused > 0) return;
    const now = this.now();
    const elapsed = phase ? now - phase.startedAt : now - this.commandStartedAt;
    if (!force && elapsed < this.displayDelayMs) return;
    const quietFor = now - this.lastSignalAt;
    if (phase && quietFor >= this.quietWarningMs && !this.quietWarningPrinted) {
      this.quietWarningPrinted = true;
      this.note(`rafi: ${this.provider ?? "provider"} has been quiet for ${formatDuration(quietFor)}; RAFI is still responsive and will keep waiting`);
      return;
    }
    const provider = [this.provider, this.model].filter(Boolean).join("/");
    const quiet = quietFor >= this.quietWarningMs ? `provider quiet ${formatDuration(quietFor)}; RAFI is responsive` : this.detail;
    const body = [phase?.label, provider || undefined, phase ? quiet : undefined, this.agentStatusLine].filter(Boolean).join(" — ");
    if (this.output.isTTY) {
      const line = `${FRAMES[this.frame++ % FRAMES.length]} RAFI working: ${body} (${formatDuration(now - this.commandStartedAt)})`;
      this.output.write(`\r\x1b[2K${line}`);
      this.lineVisible = true;
      return;
    }
    if (force || now - this.lastHeartbeatAt >= this.heartbeatMs) {
      this.lastHeartbeatAt = now;
      this.output.write(`[${new Date(now).toISOString()}] rafi working: ${body} (${formatDuration(now - this.commandStartedAt)})\n`);
    }
  }

  private clearLine(): void {
    if (!this.lineVisible || !this.output.isTTY) return;
    this.output.write("\r\x1b[2K");
    this.lineVisible = false;
  }
}

const activityContext = new AsyncLocalStorage<ActivityReporter>();

export function currentActivity(): ActivityReporter | undefined { return activityContext.getStore(); }

export async function withActivityContext<T>(command: string, operation: () => Promise<T>, options: ActivityReporterOptions = {}): Promise<T> {
  const existing = currentActivity();
  if (existing) return operation();
  const reporter = new ActivityReporter(command, options);
  return activityContext.run(reporter, async () => {
    try { return await operation(); }
    finally { reporter.dispose(); }
  });
}

export async function withActivityPhase<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const end = currentActivity()?.begin(label);
  try { return await operation(); }
  finally { end?.(); }
}

export async function pauseActivityForInput<T>(operation: () => Promise<T>): Promise<T> {
  const resume = currentActivity()?.pause();
  try { return await operation(); }
  finally { resume?.(); }
}

export function reportBuilderEvent(event: BuilderEvent): void {
  const reporter = currentActivity();
  if (!reporter) return;
  if (event.kind === "activity") reporter.update(event.state, event.detail, { provider: event.provider, model: event.model, immediate: !event.transient });
  else if (event.kind === "retry") {
    const attempt = event.attempt ? ` (${event.attempt}${event.maximum ? `/${event.maximum}` : ""})` : "";
    const delay = event.delayMs ? ` in ${formatDuration(event.delayMs)}` : "";
    reporter.note(`rafi: ${event.provider} ${clean(event.reason, 300)}; retrying${attempt}${delay}`);
    reporter.update(`retrying ${event.provider}`, event.reason, { provider: event.provider });
  } else if (event.kind === "tool") reporter.update(`running ${event.name}`, briefInput(event.input));
  else if (event.kind === "text") reporter.update("processing agent response");
  else if (event.kind === "session-transition") reporter.update(`session ${event.transition}`, event.detail);
  else if (event.kind === "context-usage") reporter.pulse(event.percentage === undefined ? undefined : `context ${event.percentage.toFixed(0)}%`);
  else if (event.kind === "turn-complete") reporter.update(event.result.isError ? "agent turn failed" : "agent turn complete");
  else if (event.kind === "error") reporter.update("provider error", event.message);
}

/** Async event queue that also feeds the active CLI reporter without consuming the stream. */
export class BuilderEventQueue extends AsyncQueue<BuilderEvent> {
  override push(event: BuilderEvent): void {
    reportBuilderEvent(event);
    super.push(event);
  }
}

function briefInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const detail = value.command ?? value.file_path ?? value.path ?? value.pattern ?? value.query;
  return detail === undefined ? undefined : clean(String(detail), 100);
}

function clean(value: string, maximum: number): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}
