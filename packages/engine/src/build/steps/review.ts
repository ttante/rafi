// The review step (ARCH 6.4): QA's verdict per requirement, citing rafi's runs. Rafi derives the outcome: any
// not-satisfied is a rejection; unable is recorded as unverified. References are checked exactly (NEW-REF-3).
// A re-review in the same session gets only what changed (C108); a rejection is one terminal line (C110).
import type { VerdictReply } from "rafi-spec/v1";
import { changedBetween, snapshot } from "../../facts/snapshot.js";
import { escapeControl } from "../../log/redact.js";
import { reviewMessage, type ReviewDelta } from "../../instructions/messages/review.js";
import {
  agentTurn, allEvents, append, knownRuns, sessionUsed, setting, ticketOf, ticketRuns, type AgentOutcome,
  type BuildContext,
} from "../context.js";
import { isolated } from "../isolation.js";
import {
  affectedRequirements, digest, failStep, readRequirements, trustedOf, type Requirements,
} from "./common.js";
import { verdictSignature } from "../../turns/circling.js";
import {
  circlingNow, findings, lastOf, runsAfter, treeBefore, type LogEvent, type VerdictData,
} from "./history.js";
import { refErrors } from "./work.js";

/** Every requirement needs a result, except person-only ones (C125) and those a changed file affects (C115). */
function verdictErrors(reply: VerdictReply, count: number, runs: ReadonlySet<number>,
  optional: readonly number[] = []): string[] {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const r of reply.results) {
    if (r.req > count) errors.push(`R${r.req} isn't a requirement of this ticket (it has R1–R${count})`);
    if (seen.has(r.req)) errors.push(`R${r.req} has two results`);
    seen.add(r.req);
    if (r.status === "not-applicable") errors.push(`R${r.req}: not-applicable isn't allowed for this requirement`);
    errors.push(...refErrors(r.runs, runs).map((e) => `R${r.req}: ${e}`));
  }
  for (let n = 1; n <= count; n += 1) if (!seen.has(n) && !optional.includes(n)) errors.push(`R${n} has no result`);
  return errors;
}

/** C108: what changed since the previous review in this session, or null for a full review. */
async function deltaSince(ctx: BuildContext, id: string, events: readonly LogEvent[]):
  Promise<{ delta: ReviewDelta; since: number } | null> {
  const prev = lastOf(events, id, "verdict.recorded");
  if (!prev || !sessionUsed(ctx, id, "qa", "verdict")) return null;
  const before = treeBefore(events, id, prev.seq);
  const now = treeBefore(events, id);
  const files = before && now ? await changedBetween(ctx.deps, ctx.project, before, now) : [];
  return { delta: { files, findings: findings(prev.data as VerdictData) }, since: prev.seq };
}

/** C110: one line per rejection, QA's note escaped and redacted. */
function rejectedLine(ctx: BuildContext, id: string, reply: VerdictReply): string {
  const failing = reply.results.filter((r) => r.status === "not-satisfied").sort((a, b) => a.req - b.req);
  const first = failing[0]!;
  const note = escapeControl(ctx.engine.redact(first.note ?? "no note")).replace(/\s+/g, " ").trim().slice(0, 200);
  const more = failing.length > 1 ? `, and ${failing.length - 1} more` : "";
  return `${id}: QA rejected the work: R${first.req}: ${note}${more}`;
}

/** C115: the warning for a changed or missing file, and the requirements it affects. */
function fileWarning(reqs: Requirements): { warning: string | null; affected: number[] } {
  if (!reqs.written || reqs.status === "delivered" || reqs.status === null) return { warning: null, affected: [] };
  const affected = affectedRequirements(reqs.text, reqs.written.req_fps);
  const what = reqs.status === "changed" ? "changed since rafi wrote it" : `is ${reqs.status}`;
  const list = affected.length ? ` (${affected.map((n) => `R${n}`).join(", ")} affected)` : "";
  return { warning: `${reqs.path} ${what}${list}`, affected };
}

/** NEW-REQ-5: rafi records the affected requirements "unable to verify" whatever QA said (C115). */
function overridden(reply: VerdictReply, affected: readonly number[], count: number): VerdictReply["results"] {
  const results = reply.results.filter((r) => !affected.includes(r.req));
  for (const req of affected) {
    if (req > count) continue;
    results.push({ req, status: "unable", runs: [], needs: "file",
      note: "the requirements file changed or is missing, so this can't be verified against what rafi wrote" });
  }
  return results.sort((a, b) => a.req - b.req);
}

/** The receipt's `read`: a tool event in the turn named the file. */
const readIt = (tools: readonly { command: string | null }[], rel: string) =>
  tools.some((t) => (t.command ?? "").split(/[\s"']+/).some((w) => w === rel || w.endsWith(`/${rel}`)));

interface Review {
  readonly id: string;
  readonly attempt: number;
  readonly redo: boolean;
  readonly reqs: Requirements;
  readonly count: number;
  readonly optional: readonly number[];
  readonly warning: string | null;
  readonly files: readonly string[];
}

/** One QA review turn, in place or in a copy (C128), and its receipt (C115). A copy review gets the full message. */
async function reviewTurn(ctx: BuildContext, r: Review, root: string): Promise<AgentOutcome> {
  const ticket = ticketOf(ctx, r.id);
  const events = await allEvents(ctx.engine) as LogEvent[];
  const since = root === ctx.project ? await deltaSince(ctx, r.id, events) : null;
  const runs = (since ? runsAfter(events, r.id, since.since) : await ticketRuns(ctx, r.id))
    .filter((x) => x.outcome !== "refused");
  const out = await agentTurn(ctx, { ticket: r.id, step: "review", role: "qa", reply: "verdict", attempt: r.attempt,
    redo: r.redo, root, requirementChecks: trustedOf(r.reqs).map((c) => c.command),
    message: reviewMessage({ ticket, path: r.reqs.path, fp: r.reqs.fp, count: r.count, files: r.files, runs,
      warning: r.warning, delta: since?.delta ?? null, redact: (t) => ctx.engine.redact(t) }),
    validate: async (value) => verdictErrors(value as VerdictReply, r.count, await knownRuns(ctx, r.id),
      r.optional) });
  const { reqs } = r;
  if (reqs.written && reqs.path) {
    await append(ctx, r.id, { type: "requirements.receipt", data: { key: `${r.id}:review:${r.attempt}`,
      path: reqs.path, fp_supplied: reqs.written.fp, fp_observed: reqs.text === null ? null : digest(reqs.text),
      status: reqs.status ?? "delivered", read: readIt(out.tools, reqs.path) } });
  }
  return out;
}

export async function reviewStep(ctx: BuildContext, id: string, attempt: number, redo: boolean): Promise<void> {
  const ticket = ticketOf(ctx, id);
  await append(ctx, id, { type: "step.started", data: { step: "review", attempt } });
  const reqs = await readRequirements(ctx, id);
  const count = reqs.written?.count ?? (reqs.list.length || ticket.acceptance.length);
  const { warning, affected } = fileWarning(reqs);
  if (warning) ctx.ui.line(`${id}: ${warning}; QA can't verify those requirements against it. The build goes on.`);
  const snap = await snapshot(ctx.deps, ctx.project, `${id}-review`);
  const review: Review = { id, attempt, redo, reqs, count, warning, files: snap.ok ? snap.files : [],
    optional: [...(reqs.written?.person_only ?? []), ...affected] };
  const out = await isolated(ctx, ticket, review, snap.ok ? snap.tree : null, (root) => reviewTurn(ctx, review, root));
  if (!out.ok) {
    ctx.ui.line(`${id}: QA broke (no verdict): ${out.reason.split("\n")[0]!.slice(0, 200)}`);
    return failStep(ctx, id, out);
  }
  const given = out.value as VerdictReply;
  const reply: VerdictReply = { ...given, results: overridden(given, affected, count) };
  const failing = reply.results.filter((r) => r.status === "not-satisfied").map((r) => r.req).sort((a, b) => a - b);
  const signature = verdictSignature(reply.results, await ticketRuns(ctx, id));
  const circling = failing.length > 0 && circlingNow(await allEvents(ctx.engine) as LogEvent[], id, signature,
    attempt, setting<number>(ctx, "retries.circling_repeats"));
  await append(ctx, id, { type: "verdict.recorded", data: { attempt, results: reply.results,
    rejected: failing.length > 0, unverified: reply.results.filter((r) => r.status === "unable")
      .map((r) => ({ req: r.req, tool: null })), signature, circling } });
  if (failing.length) ctx.ui.line(rejectedLine(ctx, id, reply));
}
