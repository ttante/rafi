// `rafi status`'s delivery-unit lines (C228; M5 part 6, review P2): one line per unit with a recorded state, from
// the fold's unit state (`state/units.ts`) and the recorded results: its branches (`git.branch_created`), its PR
// links (`pr.created`), a merge wait's deadline (`unit.merge_waiting`), how it was delivered, or why it failed.
// Read-only. Every recorded text is redacted and escaped, on one line, as the other status lines are.
import type { Engine } from "../api/engine.js";
import { escapeControl } from "../log/redact.js";
import type { Folded } from "../state/types.js";

type Ev = { type: string; data: unknown };
type Data = Record<string, unknown>;

const HOW: Readonly<Record<string, string>> = { merged: "merged", pushed: "pushed", "pr-opened": "PR opened",
  none: "nothing to deliver" };

function stateText(state: string, last: (type: string) => Data | undefined): string {
  if (state === "merge_waiting") {
    const until = String(last("unit.merge_waiting")?.until ?? "");
    return `waiting for its PR to merge${until ? ` (until ${until.slice(11, 19)} UTC)` : ""}`;
  }
  if (state === "delivered") return `delivered (${HOW[String(last("unit.delivered")?.how)] ?? "done"})`;
  if (state === "failed") {
    const f = last("unit.failed");
    return `failed (${String(f?.category ?? "unknown")}): ${String(f?.message ?? "").replace(/\.$/, "")}`;
  }
  return state === "ready" ? "ready to deliver" : "building";
}

export function unitLines(engine: Engine, view: Folded, all: readonly Ev[]): string[] {
  const shown = (text: string) => escapeControl(engine.redact(text)).replace(/\s*\n\s*/g, " ");
  return Object.entries(view.units).map(([unit, state]) => {
    const mine = all.filter((e) => (e.data as Data | null)?.unit === unit).map((e) => ({ type: e.type,
      data: (e.data ?? {}) as Data }));
    const last = (type: string) => mine.filter((e) => e.type === type).at(-1)?.data;
    const each = (type: string, field: string) => [...new Set(mine.filter((e) => e.type === type)
      .map((e) => e.data[field]).filter((v): v is string => typeof v === "string"))];
    const branches = each("git.branch_created", "branch");
    const prs = each("pr.created", "url");
    return shown([`Unit ${unit}: ${stateText(state, last)}`,
      ...(branches.length ? [`branch${branches.length > 1 ? "es" : ""} ${branches.join(", ")}`] : []),
      ...(prs.length ? [`PR${prs.length > 1 ? "s" : ""} ${prs.join(", ")}`] : [])].join("; ") + ".");
  });
}
