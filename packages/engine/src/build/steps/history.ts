// What a ticket's earlier events say, for the review and fix steps (C108, C109): the last verdict and its findings,
// the builder snapshot each review saw, and the runs recorded since.
import type { RunRecord } from "../../facts/runs.js";
import type { Finding } from "../../instructions/messages/review.js";
import { isCircling, type AttemptRecord } from "../../turns/circling.js";

export interface LogEvent {
  readonly type: string;
  readonly ticket_id: string | null;
  readonly run_id: string | null;
  readonly data: unknown;
  readonly seq: number;
  readonly id?: string;
}

export interface VerdictData {
  readonly attempt: number;
  readonly results: readonly { req: number; status: string; runs: number[]; needs: string | null;
    note: string | null }[];
  readonly rejected: boolean;
  readonly signature: string;
  readonly circling: boolean;
}

export const ofTicket = (events: readonly LogEvent[], id: string, type: string) =>
  events.filter((e) => e.ticket_id === id && e.type === type);

export function lastOf(events: readonly LogEvent[], id: string, type: string): LogEvent | undefined {
  return ofTicket(events, id, type).at(-1);
}

export function findings(verdict: VerdictData): Finding[] {
  return verdict.results.filter((r) => r.status === "not-satisfied").map((r) => ({ req: r.req, note: r.note,
    runs: r.runs }));
}

/** The latest builder snapshot tree recorded before `seq` (or at all). */
export function treeBefore(events: readonly LogEvent[], id: string, seq = Infinity): string | null {
  const snap = ofTicket(events, id, "facts.snapshot").filter((e) => e.seq < seq).at(-1);
  return snap ? (snap.data as { tree: string }).tree : null;
}

/** Runs of this ticket recorded after `seq`. */
export function runsAfter(events: readonly LogEvent[], id: string, seq: number): RunRecord[] {
  return events.filter((e) => e.type === "check.run" && e.seq > seq && (e.data as RunRecord).ticket === id)
    .map((e) => e.data as RunRecord);
}

/** The ticket's latest failure in its fix loop: a QA rejection, or a failed check. */
export function lastFailure(events: readonly LogEvent[], id: string): LogEvent | undefined {
  return events.filter((e) => e.ticket_id === id && ((e.type === "verdict.recorded" &&
    (e.data as VerdictData).rejected) || e.type === "checks.failed")).at(-1);
}

/** The ticket's failed attempts in order (ARCH 5.5): each one's signature, and the tree and reads of the builder
 * turn before it, from `attempt.summary` (a state event, so this works at every capture level). */
export function attemptHistory(events: readonly LogEvent[], id: string): AttemptRecord[] {
  const summaries = new Map<number, { tree: string; files_read: string[] }>();
  for (const e of ofTicket(events, id, "attempt.summary")) {
    const d = e.data as { attempt: number; tree: string; files_read: string[] };
    summaries.set(d.attempt, d);
  }
  const out: AttemptRecord[] = [];
  for (const e of events) {
    if (e.ticket_id !== id) continue;
    const failed = e.type === "checks.failed" || (e.type === "verdict.recorded" && (e.data as VerdictData).rejected);
    if (!failed) continue;
    const attempt = e.type === "verdict.recorded" ? (e.data as VerdictData).attempt : attemptAt(events, id, e.seq);
    const s = summaries.get(attempt);
    out.push({ signature: (e.data as { signature: string }).signature, tree: s?.tree ?? null,
      read: s?.files_read ?? [] });
  }
  return out;
}

/** The attempt of the last step.started before `seq`. */
export function attemptAt(events: readonly LogEvent[], id: string, seq: number): number {
  const started = ofTicket(events, id, "step.started").filter((e) => e.seq < seq).at(-1);
  return (started?.data as { attempt?: number } | undefined)?.attempt ?? 1;
}

/** The current failure, added to the history, is circling (`retries.circling_repeats` in a row). */
export function circlingNow(events: readonly LogEvent[], id: string, signature: string, attempt: number,
  repeats: number): boolean {
  const summary = ofTicket(events, id, "attempt.summary").filter((e) =>
    (e.data as { attempt: number }).attempt === attempt).at(-1)?.data as { tree: string; files_read: string[] } |
    undefined;
  return isCircling([...attemptHistory(events, id), { signature, tree: summary?.tree ?? null,
    read: summary?.files_read ?? [] }], repeats);
}
