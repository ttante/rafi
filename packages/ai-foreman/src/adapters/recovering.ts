import { isCancel, log, select } from "@clack/prompts";
import type { AgentRuntime } from "../runtimeAuth.js";
import { AsyncQueue } from "../util/asyncQueue.js";
import { pauseActivityForInput, reportBuilderEvent } from "../activity.js";
import type { BuilderAdapter, BuilderEvent, CompactResult, ContextUsage, TurnResult } from "./types.js";

export type TurnRecoveryChoice = "retry" | "switch" | "cancel";

export interface RecoveringAdapterOptions {
  initial: BuilderAdapter;
  runtime: AgentRuntime;
  enabled: boolean;
  allowSwitch: boolean;
  label: string;
  recreate: (runtime: AgentRuntime, resumeSessionId?: string) => Promise<BuilderAdapter>;
  choose?: (result: TurnResult, runtime: AgentRuntime, otherRuntime: AgentRuntime) => Promise<TurnRecoveryChoice>;
  onRuntimeChange?: (runtime: AgentRuntime) => void;
}

/** Adds interactive recovery around structured runtime turn failures. */
export class RecoveringAdapter implements BuilderAdapter {
  private adapter: BuilderAdapter;
  private runtime: AgentRuntime;
  private readonly eventQueue = new AsyncQueue<BuilderEvent>();
  private eventPump: Promise<void>;
  private closed = false;

  constructor(private readonly opts: RecoveringAdapterOptions) {
    this.adapter = opts.initial;
    this.runtime = opts.runtime;
    this.eventPump = this.forwardEvents(this.adapter);
  }

  get agent(): "claude" | "codex" {
    return this.adapter.agent;
  }

  async sendTurn(text: string): Promise<TurnResult> {
    while (true) {
      const result = await this.adapter.sendTurn(text);
      if (!this.opts.enabled || !result.isError || !result.failure) return result;

      const otherRuntime = this.runtime === "claude" ? "codex" : "claude";
      const choice = this.opts.choose
        ? await this.opts.choose(result, this.runtime, otherRuntime)
        : await pauseActivityForInput(() => promptTurnRecovery(result, this.opts.label, this.runtime, otherRuntime, this.opts.allowSwitch));
      if (choice === "cancel") return result;
      if (choice === "switch" && !this.opts.allowSwitch) return result;

      const recoveryEvent: BuilderEvent = choice === "retry"
        ? { kind: "retry", provider: this.runtime, reason: `${this.opts.label} failed`, managedBy: "rafi" }
        : { kind: "activity", provider: otherRuntime, state: `switching to ${otherRuntime}`, detail: "starting a fresh provider session" };
      this.eventQueue.push(recoveryEvent);
      reportBuilderEvent(recoveryEvent);

      const nextRuntime = choice === "switch" ? otherRuntime : this.runtime;
      const resumeSessionId = choice === "retry" ? this.adapter.sessionId() : undefined;
      await this.replaceAdapter(nextRuntime, resumeSessionId);
      if (choice === "switch") {
        log.info(`Using ${nextRuntime} for the rest of this run. This is a fresh provider session; conversational continuity was not transferred.`);
      }
    }
  }

  sessionId(): string | undefined {
    return this.adapter.sessionId();
  }

  compact(): Promise<CompactResult> { return this.adapter.compact?.() ?? Promise.resolve({ ok: false, error: "native compaction unavailable" }); }
  contextUsage(): Promise<ContextUsage | undefined> { return this.adapter.contextUsage?.() ?? Promise.resolve(undefined); }

  events(): AsyncIterable<BuilderEvent> {
    return this.eventQueue;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.adapter.close().catch(() => {});
    await this.eventPump.catch(() => {});
    this.eventQueue.close();
  }

  private async replaceAdapter(runtime: AgentRuntime, resumeSessionId?: string): Promise<void> {
    await this.adapter.close().catch(() => {});
    await this.eventPump.catch(() => {});
    this.adapter = await this.opts.recreate(runtime, resumeSessionId);
    this.runtime = runtime;
    this.opts.onRuntimeChange?.(runtime);
    this.eventPump = this.forwardEvents(this.adapter);
  }

  private async forwardEvents(adapter: BuilderAdapter): Promise<void> {
    for await (const event of adapter.events()) this.eventQueue.push(event);
  }
}

async function promptTurnRecovery(
  result: TurnResult,
  label: string,
  runtime: AgentRuntime,
  otherRuntime: AgentRuntime,
  allowSwitch: boolean,
): Promise<TurnRecoveryChoice> {
  log.error(result.text);
  const choice = await select({
    message: `${runtime} failed during ${label}. What should Rafi do?`,
    options: [
      { value: "retry", label: "Fix the runtime manually, then retry this turn" },
      ...(allowSwitch
        ? [{ value: "switch", label: `Switch to ${otherRuntime} for this run (fresh session)` }]
        : []),
      { value: "cancel", label: "Cancel this command and keep project state" },
    ],
  });
  if (isCancel(choice)) return "cancel";
  return choice as TurnRecoveryChoice;
}
