// A CI point as a step (ARCH 6.10; M5 slice 8, C213, C234, C271): the suite in a throwaway worktree of what the point
// tests; failures sorted by reruns at the starting commit (already broken) and at the same commit (flaky), each told
// once; a real failure adds a rafi-owned fix ticket, first in the queue, told once and never asked, with the failing
// run recorded under it. Once the fix is done the point runs again, reusing what passed and nothing since touched.
// `ci.result` closes the point: passed, fixed, or (the fix out of tries, or done and the tests still failing)
// unfixed-merged, or unfixed-pushed with `checks.ci_blocks_merge`.
import { classifySuite } from "../state/ci.js";
import type { Action } from "../state/types.js";
import { ownedTickets, nextFixId } from "../tickets/owned.js";
import { ciResult, combinedOrFailed, hintFor, rerunFailures, startOf, suiteIn, testsFor } from "../git/throwaway.js";
import { planOf } from "../git/worktree.js";
import { allEvents, type BuildContext } from "./context.js";

type Point = Extract<Action, { kind: "ci" }>;
type Suite = { commit: string; failing: string[]; preexisting: string[]; flaky: string[] };
const list = (xs: readonly string[]) => xs.join(", ");

export async function ciPoint(ctx: BuildContext, a: Point): Promise<void> {
  const plan = planOf(ctx);
  const units = plan.units.filter((u) => a.units.includes(u.id) || u.tickets.includes(a.key));
  const view = ctx.engine.fold();
  const fix = view.ci[`${ctx.run}|${a.key}`]?.fix ?? null;
  const events = await allEvents(ctx.engine);
  const last = events.filter((e) => e.run_id === ctx.run && e.type === "suite.run" &&
    (e.data as { unit: string }).unit === a.key).at(-1)?.data as Suite | undefined;
  const lastReal = (last?.failing ?? []).filter((f) => !last!.preexisting.includes(f) && !last!.flaky.includes(f));
  if (fix && view.tickets[fix]?.state !== "done") return void await ciResult(ctx, a.key, fix, lastReal);
  const box = await combinedOrFailed(ctx, plan, units);
  if (!box) return;
  try {
    const id = fix ?? nextFixId(view);
    const prior = fix ? (events.find((e) => e.type === "check.run" && e.ticket_id === fix)?.data as
      { tests: { file: string | null; outcome: string }[] } | undefined)?.tests ?? null : null;
    const start = await startOf(ctx, plan, units);
    const { tip, files, reused } = await testsFor(ctx, box, id, { light: a.tests === "light", start,
      last: last ?? null, prior });
    const run = await suiteIn(ctx, box, id, files);
    const { atStart, onRerun } = await rerunFailures(ctx, box, id, start, run.failing, last?.preexisting ?? []);
    const sorted = classifySuite(run.failing, atStart, onRerun);
    const told = (xs: string[], before: string[] = []) => xs.filter((f) => !before.includes(f));
    const broken = told(sorted.preexisting, last?.preexisting);
    const flaky = told(sorted.flaky, last?.flaky);
    if (broken.length) ctx.ui.line(`CI: already failing on the starting commit, not blocking: ${list(broken)}.`);
    if (flaky.length) ctx.ui.line(`CI: flaky (passed on a rerun), not blocking: ${list(flaky)}.`);
    const suite = { unit: a.key, commit: tip, tests: a.tests, outcome: sorted.real.length ? "failed" : "passed",
      failing: run.failing, preexisting: sorted.preexisting, flaky: sorted.flaky, reused,
      duration_ms: run.record.duration_ms ?? 0 };
    if (!sorted.real.length || fix) return void await ciResult(ctx, a.key, fix, sorted.real, suite);
    const hint = await hintFor(ctx, units.flatMap((u) => u.tickets), sorted.real, id, events);
    await ctx.engine.append([{ type: "suite.run", run_id: ctx.run, ticket_id: null, actor: "engine", data: suite },
      ...[{ type: "ticket.added", data: { ticket: id, source: "ci", requirements: sorted.real, hint, unit: null } },
        { type: "check.run", data: run.record }].map((e) => ({ ...e, run_id: ctx.run, ticket_id: id,
        actor: "engine" }))]);
    for (const [k, v] of await ownedTickets(ctx.engine, ctx.units)) ctx.owned?.set(k, v);
    ctx.ui.line(`Rafi's CI found ${sorted.real.length} failing test${sorted.real.length === 1 ? "" : "s"} ` +
      `(${list(sorted.real)}); rafi added ${id} to fix ${sorted.real.length === 1 ? "it" : "them"} first` +
      `${hint ? ` (${hint} probably caused it)` : ""}. Nothing to answer.`);
  } finally {
    await box.remove();
  }
}
