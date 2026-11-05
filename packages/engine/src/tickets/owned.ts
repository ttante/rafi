// Rafi-owned tickets (decision 10; ARCH 6.10, 7.10; M5 C272): defined only by `ticket.added`, never in tickets.yaml,
// so the steps get a definition made from that event. A CI fix ticket: "Fix N failing tests", one acceptance
// criterion per failing test, and as its summary the failing run's tests, the output excerpt about them and the run
// number to read the rest (the summary is ticket text: agents get it quoted and escaped). A conflict fix ticket:
// "Resolve the merge conflict in <unit>", its requirements as its criteria. `unit`: the delivery unit its work goes
// into: the event's (a conflict ticket's), else its hint ticket's, else the unit its CI point tested, else the last.
import type { DeliveryUnit, TicketV1 } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import type { Folded, TicketState } from "../state/types.js";

export interface AddedData {
  readonly ticket: string;
  readonly source: "ci" | "recheck" | "conflict";
  readonly requirements: readonly string[];
  readonly hint: string | null;
  readonly unit?: string | null;
}

export interface Owned {
  readonly ticket: TicketV1;
  readonly unit: string | null;
  readonly added: AddedData;
}

interface FirstRun { run: number; output: string | null; tests: { name: string; file: string | null;
  outcome: string }[] }

/** The output lines about the failing files: each header line naming one, and the indented lines under it. */
function excerpt(output: string, files: readonly string[]): string {
  const lines = output.split("\n").filter(Boolean);
  let keep = false;
  const kept = lines.filter((line) => {
    const names = files.some((f) => line.includes(f));
    keep = /^\s/.test(line) ? keep || names : names;
    return keep;
  });
  return (kept.length ? kept : lines).slice(0, 15).join("\n");
}

/** The next free rafi-owned id, `FIX-<n>` per project, never reused (C212). */
export function nextFixId(view: Pick<Folded, "tickets">): string {
  const used = Object.keys(view.tickets).map((id) => /^FIX-(\d+)$/.exec(id)).filter(Boolean).map((m) => Number(m![1]));
  return `FIX-${Math.max(0, ...used) + 1}`;
}

/** A rafi-owned ticket's definition from the fold alone (its `owned` identity), without the run details. */
export function ownedTicket(t: TicketState | undefined): TicketV1 | undefined {
  if (!t?.rafiOwned || !t.owned) return undefined;
  const { source, unit, requirements, hint } = t.owned;
  return definition(null, { ticket: t.id, source: source as AddedData["source"], requirements, hint, unit },
    undefined);
}

function definition(engine: Engine | null, a: AddedData, first: FirstRun | undefined): TicketV1 {
  const n = a.requirements.length;
  const base = { id: a.ticket, risk: "Low", depends_on: [], tags: [], required_tests: [], likely_files: [],
    open_decisions: [], person_only: [], locked: [], needs: { internet: null, local_servers: null, installs: [],
      services: [], credentials: [] } };
  if (a.source === "conflict") {
    return { ...base, title: `Resolve the merge conflict in ${a.unit ?? "the delivery unit"}`,
      acceptance: a.requirements.length ? [...a.requirements] : ["The merge has no conflict markers"] } as TicketV1;
  }
  const failing = (first?.tests ?? []).filter((t) => t.outcome === "failed" && a.requirements.includes(t.file ?? ""));
  const output = first?.output && engine ? engine.readBlob(first.output) ?? "" : "";
  const summary = first ? [`Rafi's CI run ${first.run} found ${n === 1 ? "this test" : "these tests"} failing` +
    `${a.hint ? ` (${a.hint} probably caused it)` : ""}:`, ...failing.map((t) => `- ${t.name} in ${t.file}`),
  "Output excerpt:", excerpt(output, a.requirements), `Read the rest with check_output(${first.run}).`].join("\n")
    : undefined;
  return { ...base, title: `Fix ${n} failing test${n === 1 ? "" : "s"}`, ...(summary ? { summary } : {}),
    acceptance: a.requirements.map((f) => `${f} passes`) } as TicketV1;
}

/** Every rafi-owned ticket in the log, with its definition and unit. */
export async function ownedTickets(engine: Engine, units: readonly DeliveryUnit[]): Promise<Map<string, Owned>> {
  const added = new Map<string, { data: AddedData; suiteUnit: string | null }>();
  const first = new Map<string, FirstRun>();
  let suiteUnit: string | null = null;
  for await (const e of engine.events()) {
    if (e.type === "suite.run") suiteUnit = String((e.data as { unit: string }).unit);
    if (e.type === "ticket.added") {
      const d = e.data as AddedData;
      added.set(d.ticket, { data: d, suiteUnit });
    } else if (e.type === "check.run" && e.ticket_id && added.has(e.ticket_id) && !first.has(e.ticket_id)) {
      first.set(e.ticket_id, e.data as FirstRun);
    }
  }
  const out = new Map<string, Owned>();
  for (const [id, { data, suiteUnit: tested }] of added) {
    const hinted = units.find((u) => data.hint && u.tickets.includes(data.hint))?.id;
    const unit = data.unit ?? hinted ?? units.find((u) => u.id === tested)?.id ?? units.at(-1)?.id ?? null;
    out.set(id, { ticket: definition(engine, data, first.get(id)), unit, added: data });
  }
  return out;
}
