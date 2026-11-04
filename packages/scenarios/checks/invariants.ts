// S-CRASH-1's invariants over `rafi-events` exports (ARCH 3.5; plan choice C20). It never reads the database;
// from M2, `rafi stats export` feeds it. In M1 it's tested on synthetic exports.

export interface ExportedEvent {
  readonly seq: number;
  readonly id: string;
  readonly run_id: string | null;
  readonly ticket_id: string | null;
  readonly type: string;
  readonly actor?: string;
  readonly source?: string | null;
  readonly at?: string;
  readonly data: Record<string, unknown>;
}

export interface EventsExport {
  readonly format: "rafi-events";
  readonly schema: number;
  readonly events: readonly ExportedEvent[];
}

export interface CrashRun {
  /** The export taken right after the crash, before any resume. */
  readonly beforeResume: EventsExport;
  /** The export after resume finished the build. */
  readonly final: EventsExport;
  /** The clean run's final export, with no crash. */
  readonly clean: EventsExport;
  /** Terminal output of every `rafi resume`. */
  readonly resumeOutput: readonly string[];
}

function finalStates(e: EventsExport): Record<string, string> {
  const states: Record<string, string> = {};
  for (const event of e.events) {
    if (!event.ticket_id) continue;
    if (event.type === "delivery.done") states[event.ticket_id] = "done";
    else if (event.type === "ticket.dropped") states[event.ticket_id] = "dropped";
    else if (event.type === "ticket.blocked") states[event.ticket_id] = "blocked";
    else if (event.type === "ticket.started" && !states[event.ticket_id]) states[event.ticket_id] = "started";
  }
  return states;
}

function turnKey(event: ExportedEvent): string {
  return `${event.run_id}|${event.ticket_id}|${String(event.data.key ?? "")}`;
}

function openOrSaved(e: EventsExport): Set<string> {
  const ids = new Set<string>();
  for (const event of e.events) {
    if (event.type === "question.opened" || event.type === "question.answered") ids.add(String(event.data.id));
  }
  return ids;
}

/** Returns the broken invariants; empty when the crash run is consistent. */
export function checkCrashRun(run: CrashRun): string[] {
  const problems: string[] = [];
  const clean = finalStates(run.clean);
  const final = finalStates(run.final);
  if (JSON.stringify(final) !== JSON.stringify(clean)) {
    problems.push(`final ticket states ${JSON.stringify(final)} differ from the clean run's ${JSON.stringify(clean)}`);
  }
  const done = run.final.events.filter((e) => e.type === "delivery.done").map((e) => e.ticket_id);
  for (const id of new Set(done)) {
    if (done.filter((d) => d === id).length > 1) problems.push(`${id} was done twice`);
  }
  for (const id of Object.keys(clean)) if (!(id in final)) problems.push(`${id} was lost from the batch`);
  const crashSeq = run.beforeResume.events.at(-1)?.seq ?? 0;
  const prefix = run.final.events.filter((e) => e.seq <= crashSeq);
  if (JSON.stringify(prefix) !== JSON.stringify(run.beforeResume.events)) {
    problems.push("the event log before the crash changed after resume");
  }
  const sent = run.final.events.filter((e) => e.type === "turn.sent");
  const counts = new Map<string, { before: number; after: number }>();
  for (const event of sent) {
    const entry = counts.get(turnKey(event)) ?? { before: 0, after: 0 };
    if (event.seq <= crashSeq) entry.before += 1; else entry.after += 1;
    counts.set(turnKey(event), entry);
  }
  for (const [key, c] of counts) {
    if (c.before > 1 || c.after > 1) problems.push(`turn ${key} ran ${c.before} times before and ${c.after} after`);
  }
  const before = openOrSaved(run.beforeResume);
  const after = openOrSaved(run.final);
  for (const id of before) if (!after.has(id)) problems.push(`question ${id} was lost`);
  for (const output of run.resumeOutput) {
    if (/recovery mode|How should Rafi recover/i.test(output)) problems.push("rafi resume asked for a recovery mode");
  }
  return problems;
}
