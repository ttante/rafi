// CI points (ARCH 6.10; M5 slice 8, C213, C234, C270): where `checks.ci_when` puts the suite and what a ready unit
// waits for. Pure. A point is keyed by what it tests: a unit (`each-pr`, light points), a ticket (`each-ticket`) or
// `build` (the end-of-build point, and light-each-pr-full-end's full one). A failing `suite.run` opens it, the CI fix
// ticket joins it, `ci.result` closes it; while a fix ticket is open, nothing is delivered (the fix goes first).
import type { Action, BuildState, Folded } from "./types.js";

type Tests = "full" | "light";
type Point = Extract<Action, { kind: "ci" }>;
const CLOSED: ReadonlySet<string> = new Set(["done", "dropped", "blocked"]);

function settingsOf(build: BuildState) {
  const s = (k: string) => build.settings[k]?.value;
  return { when: String(s("checks.ci_when") ?? "end-of-build"), tests: (s("checks.ci_tests") ?? "full") as Tests,
    blocks: s("checks.ci_blocks_merge") === true,
    // No test runner (none configured or found, C42): there's nothing to run, so no CI point.
    on: s("git.managed_by") !== "me" && s("checks.ci_tests") !== "none" && Boolean(s("checks.test_runner")) };
}

/** due: no record, or its fix ticket finished (done, or blocked once its fixes ran out); fixing; closed. */
function stateOf(view: Folded, run: string, key: string): "due" | "fixing" | "closed" {
  const p = view.ci[`${run}|${key}`];
  if (!p) return "due";
  if (p.closed) return "closed";
  return !p.fix || CLOSED.has(view.tickets[p.fix]?.state ?? "") ? "due" : "fixing";
}

const ci = (key: string, units: string[], tests: Tests): Point => ({ kind: "ci", key, units, tests });

/** `ended`: the scope is done (rule 5) or every ticket in it is closed. Null: nothing to deliver or test now. */
export function ciAction(view: Folded, build: BuildState, ended: boolean): Action | null {
  const ready = Object.entries(view.units).filter(([, s]) => s === "ready").map(([u]) => u);
  const c = settingsOf(build);
  const run = build.run;
  if (!c.on) return ready[0] ? { kind: "deliver-unit", unit: ready[0] } : null;
  const mine = Object.keys(view.ci).filter((k) => k.startsWith(`${run}|`)).map((k) => k.slice(run.length + 1));
  if (mine.some((k) => stateOf(view, run, k) === "fixing")) return null;
  if (c.when === "each-ticket") {
    const t = (view.doneInRun[run] ?? []).find((id) => !view.tickets[id]?.rafiOwned &&
      stateOf(view, run, id) === "due");
    if (t) return ci(t, [], c.tests);
  }
  const end = c.when === "end-of-build" || c.when === "light-each-pr-full-end";
  if (end && ended && ready.length && stateOf(view, run, "build") === "due") {
    return ci("build", ready, c.when === "light-each-pr-full-end" ? "full" : c.tests);
  }
  for (const u of ready) {
    const light = c.when === "light-each-pr-full-end" && !ended;
    if ((c.when === "each-pr" || light) && stateOf(view, run, u) === "due") {
      return ci(u, [u], light ? "light" : c.tests);
    }
    if (c.when === "end-of-build" && !ended && c.blocks) continue;
    return { kind: "deliver-unit", unit: u };
  }
  return null;
}

/** A suite's failing tests sorted (6.10 step 1): failing at the starting commit, or passing on the rerun. */
export function classifySuite(failing: readonly string[], atStart: ReadonlySet<string>, onRerun: ReadonlySet<string>) {
  const preexisting = failing.filter((f) => atStart.has(f));
  const flaky = failing.filter((f) => !atStart.has(f) && !onRerun.has(f));
  return { real: failing.filter((f) => !atStart.has(f) && onRerun.has(f)), preexisting, flaky };
}
