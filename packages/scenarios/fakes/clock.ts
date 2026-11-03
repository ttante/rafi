// The fake clock (SCN 7.4, plan choice C18). Starts 2026-11-01T14:00:00Z. Jumps to the next timeout, backoff
// or agent timer only when the engine is idle: no deps call in flight and two setImmediate turns with no new
// work. Never jumps to a reminder (or a heartbeat or poll) on its own; a step calls advance(d) for those.
import type { Cancel, Clock, TimerKind } from "@rafi-ai/engine";

export const CLOCK_START = Date.parse("2026-11-01T14:00:00Z");
const AUTO: ReadonlySet<TimerKind> = new Set(["timeout", "backoff", "agent"]);

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly kind: TimerKind;
  readonly owner: string;
  readonly fn: () => void;
}

export class FakeClock {
  private nowMs = CLOCK_START;
  private timers: Timer[] = [];
  private nextId = 0;
  private inflight = 0;
  private work = 0;
  private checking = false;
  private readonly dead = new Set<string>();

  now(): Date {
    return new Date(this.nowMs);
  }

  /** The Clock one engine instance sees; its timers belong to it and are dropped if it crashes. */
  forInstance(owner: string): Clock {
    return {
      now: () => this.now(),
      timer: (ms, fn, kind) => this.add(ms, fn, kind, owner),
      sleep: (ms, kind, signal) => new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const cancel = this.add(ms, () => { signal?.removeEventListener("abort", onAbort); resolve(); }, kind, owner);
        const onAbort = () => { cancel(); reject(signal?.reason); };
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    };
  }

  private add(ms: number, fn: () => void, kind: TimerKind, owner: string): Cancel {
    if (this.dead.has(owner)) return () => undefined;
    const timer: Timer = { id: ++this.nextId, at: this.nowMs + Math.max(0, ms), kind, owner, fn };
    this.timers.push(timer);
    this.work += 1;
    this.scheduleCheck();
    return () => { this.timers = this.timers.filter((t) => t.id !== timer.id); };
  }

  /** Wraps a deps call so the clock knows the engine isn't idle while it runs. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.inflight += 1;
    this.work += 1;
    try {
      return await fn();
    } finally {
      this.inflight -= 1;
      this.scheduleCheck();
    }
  }

  /** Moves time forward by ms, firing every timer that comes due, reminders included, in order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const next = this.sorted().find((t) => t.at <= target);
      if (!next) break;
      this.fire(next);
    }
    this.nowMs = target;
  }

  /** Drops a crashed instance's timers; it never sets new ones. */
  drop(owner: string): void {
    this.dead.add(owner);
    this.timers = this.timers.filter((t) => t.owner !== owner);
  }

  pending(): readonly { kind: TimerKind; at: string }[] {
    return this.sorted().map((t) => ({ kind: t.kind, at: new Date(t.at).toISOString() }));
  }

  private sorted(): Timer[] {
    return [...this.timers].sort((a, b) => a.at - b.at || a.id - b.id);
  }

  private fire(timer: Timer): void {
    this.timers = this.timers.filter((t) => t.id !== timer.id);
    this.nowMs = Math.max(this.nowMs, timer.at);
    timer.fn();
  }

  private scheduleCheck(): void {
    if (this.checking) return;
    this.checking = true;
    const seen = this.work;
    setImmediate(() => setImmediate(() => {
      this.checking = false;
      if (this.inflight > 0) return;
      if (this.work !== seen) return this.scheduleCheck();
      const next = this.sorted().find((t) => AUTO.has(t.kind));
      if (next) {
        this.fire(next);
        this.scheduleCheck();
      }
    }));
  }
}
