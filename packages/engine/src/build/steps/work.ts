// Builder steps (ARCH 4.2, 6.2, 6.9): build and fix. The reply's run numbers must be rafi's; after the turn rafi
// snapshots the worktree, logs claims that disagree with its record (never a retry), and records the report.
import path from "node:path";
import type { BuilderReply } from "rafi-spec/v1";
import { snapshot } from "../../facts/snapshot.js";
import { mismatches, runsOf } from "../../facts/runs.js";
import { buildMessage, fixMessage, type FailedRun } from "../../instructions/messages.js";
import { agentTurn, allEvents, append, knownRuns, ticketOf, type BuildContext } from "../context.js";
import { failStep, readRequirements } from "./common.js";

/** Run references are checked exactly: unknown or repeated numbers are content errors (NEW-REF-3). */
/** The builder's citations: a repeated number is an error; one rafi never recorded is a mismatch (S-MAL-4). */
function duplicates(runs: readonly number[]): string[] {
  return runs.filter((n, i) => runs.indexOf(n) !== i).map((n) => `run ${n} is cited twice`);
}

export function refErrors(runs: readonly number[], known: ReadonlySet<number>): string[] {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const n of runs) {
    if (seen.has(n)) errors.push(`run ${n} is cited twice`);
    else if (!known.has(n)) errors.push(`run ${n} isn't one of rafi's recorded runs for this ticket`);
    seen.add(n);
  }
  return errors;
}

async function failedRuns(ctx: BuildContext, id: string): Promise<FailedRun[]> {
  const events = await allEvents(ctx.engine);
  const last = events.filter((e) => e.ticket_id === id && e.type === "checks.failed").at(-1);
  const failing = ((last?.data as { failing?: { run: number }[] } | undefined)?.failing ?? []).map((f) => f.run);
  const runs = runsOf(events, id).filter((r) => failing.includes(r.run));
  const out: FailedRun[] = [];
  for (const record of runs) {
    const json = path.join(ctx.project, ".rafi", "cache", `run-${id}-${record.run}.json`);
    let tests: FailedRun["tests"] = [];
    if (await ctx.deps.fs.stat(json)) {
      try {
        const report = JSON.parse(await ctx.deps.fs.read(json)) as { testResults: { name: string;
          assertionResults: { title: string; status: string; failureMessages: string[] }[] }[] };
        tests = report.testResults.flatMap((r) => r.assertionResults.filter((a) => a.status === "failed")
          .map((a) => ({ name: a.title, file: path.relative(ctx.project, r.name),
            error: a.failureMessages[0] ?? null })));
      } catch { /* no per-test results */ }
    }
    const output = record.output ? ctx.engine.readBlob(record.output) ?? "" : "";
    out.push({ record, tests, excerpt: output.split("\n").filter(Boolean).slice(0, 15).join("\n") });
  }
  return out;
}

export async function workStep(ctx: BuildContext, id: string, step: "build" | "fix", attempt: number,
  redo: boolean): Promise<void> {
  const ticket = ticketOf(ctx, id);
  await append(ctx, id, { type: "step.started", data: { step, attempt } });
  const reqs = await readRequirements(ctx, id);
  const message = step === "build" ? buildMessage(ticket, reqs.path, redo)
    : fixMessage(ticket, await failedRuns(ctx, id), (t) => ctx.engine.redact(t));
  const out = await agentTurn(ctx, { ticket: id, step, role: "builder", reply: "builder", attempt, redo, message,
    requirementChecks: reqs.list.flatMap((r) => (r.check ? [r.check] : [])),
    validate: (value) => duplicates((value as BuilderReply).runs) });
  if (!out.ok) return failStep(ctx, id, out);
  const reply = out.value as BuilderReply;
  const snap = await snapshot(ctx.deps, ctx.project, `${id}-${attempt}`);
  const key = `${id}:${step}:${attempt}`;
  const events: { type: string; data: unknown }[] = [];
  if (snap.ok) {
    events.push({ type: "facts.snapshot", data: { key, tree: snap.tree, base: snap.base, files: snap.files } },
      { type: "attempt.summary", data: { attempt, tree: snap.tree, files_read: [], runs: reply.runs } });
  }
  const known = await knownRuns(ctx, id);
  for (const n of reply.runs.filter((r) => !known.has(r))) {
    events.push({ type: "facts.mismatch", data: { key, claim: `run ${n} cited as evidence`,
      record: `rafi recorded no run ${n} for ${id}` } });
  }
  for (const m of mismatches(await allEvents(ctx.engine), id, reply)) {
    events.push({ type: "facts.mismatch", data: { key, ...m } });
  }
  events.push({ type: "builder.reported", data: { kind: reply.kind, summary: reply.summary, runs: reply.runs,
    block: reply.block, question: reply.question } });
  await append(ctx, id, ...events);
}
