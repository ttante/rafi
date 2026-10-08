import { randomUUID } from "node:crypto";
import type { RuntimeProbePhase } from "rafi-spec";

/** Intentionally contains no provider IDs, payloads, error strings, or settings. */
export interface QuestionTrace {
  attemptId: string;
  timestamp: string;
  elapsedMs: number;
  durationMs: number;
  runtimePhase: RuntimeProbePhase;
  stage: "sdk-request" | "local-permission-start" | "answer-returned" | "next-stream-message" | "provider-signal" | "terminal";
  outcome: "pending" | "allowed" | "denied" | "callback-error" | "stream-message" | "provider-retry" | "provider-error" | "provider-auth-error" | "result" | "result-error" | "stream-error" | "stream-ended" | "idle-timeout" | "closed";
}

export type QuestionTraceSink = (trace: QuestionTrace) => void | Promise<void>;

/** All diagnostics are best effort and cannot reject the SDK permission callback. */
export function bestEffortDiagnostic(operation: () => unknown): void {
  try { void Promise.resolve(operation()).catch(() => {}); } catch { /* diagnostics must never break a turn */ }
}

export class QuestionRoundTripTrace {
  private readonly attempts = new Map<string, { startedAt: number; lastAt: number; returnedAt?: number; resumed: boolean; spanId?: string }>();

  constructor(
    private readonly phase: RuntimeProbePhase,
    private readonly sink?: QuestionTraceSink,
    private readonly spans?: { start: (attemptId: string) => string; finish: (spanId: string, outcome: string) => void },
    private readonly now: () => number = Date.now,
  ) {}

  begin(): string {
    const id = randomUUID();
    const now = this.now();
    this.attempts.set(id, { startedAt: now, lastAt: now, resumed: false });
    this.emit(id, "sdk-request", "pending");
    this.emit(id, "local-permission-start", "pending");
    return id;
  }

  returned(id: string, outcome: "allowed" | "denied" | "callback-error"): void {
    const attempt = this.attempts.get(id);
    if (!attempt) return; // The turn may have closed while the prompt was open.
    if (outcome === "callback-error") {
      this.emit(id, "terminal", outcome);
      this.attempts.delete(id);
      return;
    }
    attempt.returnedAt = this.now();
    this.emit(id, "answer-returned", outcome);
    if (outcome === "allowed" && this.spans) {
      bestEffortDiagnostic(() => { attempt.spanId = this.spans!.start(id); });
    }
  }

  message(outcome: "stream-message" | "provider-retry" | "provider-error" | "provider-auth-error"): void {
    for (const [id, attempt] of this.attempts) {
      if (attempt.returnedAt === undefined) continue;
      if (attempt.resumed) {
        // Preserve diagnostic categories after resumption, without logging
        // ordinary stream traffic or extending the post-answer wait span.
        if (outcome !== "stream-message") this.emit(id, "provider-signal", outcome);
        continue;
      }
      attempt.resumed = true;
      this.emit(id, "next-stream-message", outcome);
      this.finishSpan(attempt, outcome);
    }
  }

  finish(outcome: QuestionTrace["outcome"]): void {
    for (const [id, attempt] of this.attempts) {
      this.emit(id, "terminal", outcome);
      this.finishSpan(attempt, outcome);
    }
    this.attempts.clear();
  }

  private finishSpan(attempt: { spanId?: string }, outcome: string): void {
    const spanId = attempt.spanId;
    attempt.spanId = undefined;
    if (spanId && this.spans) bestEffortDiagnostic(() => this.spans!.finish(spanId, outcome));
  }

  private emit(id: string, stage: QuestionTrace["stage"], outcome: QuestionTrace["outcome"]): void {
    const attempt = this.attempts.get(id)!;
    const now = this.now();
    const trace: QuestionTrace = {
      attemptId: id, timestamp: new Date(now).toISOString(),
      elapsedMs: now - attempt.startedAt, durationMs: now - attempt.lastAt,
      runtimePhase: this.phase, stage, outcome,
    };
    attempt.lastAt = now;
    if (this.sink) bestEffortDiagnostic(() => this.sink!(trace));
  }
}
