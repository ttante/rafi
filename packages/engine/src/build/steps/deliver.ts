// The deliver step with completion `none` on the current branch (C45): no git state; `delivery.done` carries the
// validation summary: the runs the ticket passed on, and any requirement QA couldn't verify. A waiver after the last
// verdict sets the result (C105): "I verified it myself" is user-verified; "Explicitly waive QA" is failed.
// M5: where rafi manages git, the ticket's commit comes first (git/commit.ts); a held commit blocks the ticket.
import { deliverCommit } from "../../git/unit.js";
import { allEvents, append, ticketRuns, type BuildContext } from "../context.js";

export async function deliverStep(ctx: BuildContext, id: string, attempt: number): Promise<void> {
  await append(ctx, id, { type: "step.started", data: { step: "deliver", attempt } });
  const events = (await allEvents(ctx.engine)).filter((e) => e.ticket_id === id && e.run_id === ctx.run);
  const verdict = events.filter((e) => e.type === "verdict.recorded").at(-1)?.data as
    { results: { req: number; runs: number[] }[]; unverified: { req: number }[] } | undefined;
  const passed = (await ticketRuns(ctx, id)).filter((r) => r.outcome === "passed").map((r) => r.run);
  const cited = verdict ? verdict.results.flatMap((r) => r.runs) : [];
  const runs = [...new Set([...cited, ...passed])].sort((a, b) => a - b);
  const unit = ctx.units.find((u) => u.tickets.includes(id))?.id ?? null;
  const mine = (await allEvents(ctx.engine)).filter((e) => e.ticket_id === id);
  const lastVerdict = mine.filter((e) => e.type === "verdict.recorded").at(-1)?.seq ?? 0;
  const waiver = mine.filter((e) => e.type === "waiver.recorded" && e.seq > lastVerdict).at(-1)?.data as
    { kind: string } | undefined;
  const result = !waiver ? "passed" : waiver.kind === "verified-myself" ? "user-verified" : "failed";
  const after = await deliverCommit(ctx, id);
  if (!after) return;
  await append(ctx, id, { type: "delivery.done", data: { unit, validation: { result, runs,
    unverified: (verdict?.unverified ?? []).map((u) => u.req) } } }, ...after);
}
