// rafi's command records (ARCH 6.9, NEW-FACT-1..3): run numbers count up per ticket; an agent's claim that
// disagrees with the record is a mismatch, logged, never a retry — rafi's record wins.
interface RunEvent {
  readonly type: string;
  readonly ticket_id?: string | null;
  readonly data: unknown;
}

export interface RunRecord {
  readonly run: number;
  readonly ticket: string;
  readonly command: string;
  readonly outcome: string;
  readonly exit_code: number | null;
  readonly tree?: string;
  readonly asked_by?: string;
  readonly output?: string | null;
  readonly tests?: readonly { name: string; file: string | null; outcome: string }[];
  readonly duration_ms?: number;
  /** Why rafi refused it (`outcome: refused`). */
  readonly refused?: string | null;
}

export function runsOf(events: readonly RunEvent[], ticket: string): RunRecord[] {
  return events.filter((e) => e.type === "check.run" && (e.data as RunRecord).ticket === ticket)
    .map((e) => e.data as RunRecord);
}

export function nextRun(events: readonly RunEvent[], ticket: string): number {
  return runsOf(events, ticket).reduce((max, r) => Math.max(max, r.run), 0) + 1;
}

/** A done reply citing a run that rafi recorded as not passing. */
export function mismatches(events: readonly RunEvent[], ticket: string,
  reply: { kind?: string; runs?: readonly number[] }): { claim: string; record: string }[] {
  if (reply.kind !== "done") return [];
  const runs = runsOf(events, ticket);
  const out: { claim: string; record: string }[] = [];
  for (const n of reply.runs ?? []) {
    const run = runs.find((r) => r.run === n);
    if (run && run.outcome !== "passed") {
      out.push({ claim: `run ${n} cited as evidence the work is done`,
        record: `run ${n} \`${run.command}\` ${run.outcome} (exit ${run.exit_code ?? "none"})` });
    }
  }
  return out;
}
