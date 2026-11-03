// The review step (ARCH 6.4): QA's verdict per requirement, citing rafi's runs. Rafi derives the outcome: any
// not-satisfied is a rejection; unable is recorded as unverified. References are checked exactly (NEW-REF-3).
import type { VerdictReply } from "rafi-spec/v1";
import { snapshot } from "../../facts/snapshot.js";
import { reviewMessage } from "../../instructions/messages.js";
import { agentTurn, append, knownRuns, ticketOf, ticketRuns, type BuildContext } from "../context.js";
import { failStep, readRequirements } from "./common.js";
import { refErrors } from "./work.js";

function verdictErrors(reply: VerdictReply, count: number, runs: ReadonlySet<number>): string[] {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const r of reply.results) {
    if (r.req > count) errors.push(`R${r.req} isn't a requirement of this ticket (it has R1–R${count})`);
    if (seen.has(r.req)) errors.push(`R${r.req} has two results`);
    seen.add(r.req);
    if (r.status === "not-applicable") errors.push(`R${r.req}: not-applicable isn't allowed for this requirement`);
    errors.push(...refErrors(r.runs, runs).map((e) => `R${r.req}: ${e}`));
  }
  for (let n = 1; n <= count; n += 1) if (!seen.has(n)) errors.push(`R${n} has no result`);
  return errors;
}

export async function reviewStep(ctx: BuildContext, id: string, attempt: number, redo: boolean): Promise<void> {
  const ticket = ticketOf(ctx, id);
  await append(ctx, id, { type: "step.started", data: { step: "review", attempt } });
  const reqs = await readRequirements(ctx, id);
  const count = reqs.list.length || ticket.acceptance.length;
  const snap = await snapshot(ctx.deps, ctx.project, `${id}-review`);
  const runs = (await ticketRuns(ctx, id)).filter((r) => r.outcome !== "refused");
  const out = await agentTurn(ctx, { ticket: id, step: "review", role: "qa", reply: "verdict", attempt, redo,
    requirementChecks: reqs.list.flatMap((r) => (r.check ? [r.check] : [])),
    message: reviewMessage({ ticket, path: reqs.path, fp: reqs.fp, count, files: snap.ok ? snap.files : [], runs }),
    validate: async (value) => verdictErrors(value as VerdictReply, count, await knownRuns(ctx, id)) });
  if (!out.ok) return failStep(ctx, id, out);
  const reply = out.value as VerdictReply;
  const failing = reply.results.filter((r) => r.status === "not-satisfied").map((r) => r.req).sort((a, b) => a - b);
  await append(ctx, id, { type: "verdict.recorded", data: { attempt, results: reply.results,
    rejected: failing.length > 0, unverified: reply.results.filter((r) => r.status === "unable")
      .map((r) => ({ req: r.req, tool: null })), signature: failing.map((n) => `R${n}`).join(","), circling: false } });
}
