// The role happy paths of SCN 2.2, shared by the in-process fakes and the fake executables (plain ESM).
// They read the ticket from the project the agent runs in (`.tickets/tickets.yaml`), never the prompt's wording,
// except QA's review, which cites the run numbers and requirement numbers rafi's message lists.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export function ticketOf(cwd, id) {
  const file = path.join(cwd, ".tickets", "tickets.yaml");
  if (!id || !existsSync(file)) return null;
  return (parse(readFileSync(file, "utf8"))?.tickets ?? []).find((t) => t.id === id) ?? null;
}

const numbers = (text, re) => [...new Set([...String(text).matchAll(re)].map((m) => Number(m[1])))]
  .sort((a, b) => a - b);

/** `RUNS` in a reply is replaced with the run numbers the turn's run_check calls returned. */
export const RUNS = "$runs";

export function happyPath(meta, ctx) {
  const ticket = ticketOf(ctx.cwd, meta.ticket);
  const tests = ticket?.required_tests ?? [];
  if (meta.role === "qa" && meta.step === "prepare") {
    const acceptance = ticket?.acceptance ?? ["It works."];
    return { steps: [], reply: { requirements: acceptance.map((text, i) => ({ from: i + 1, text,
      check: tests[0] ?? null, expect: tests[0] ? "passes" : null })), in_scope: [ticket?.title ?? "the ticket"],
    out_of_scope: [], risks: [], add_tags: [] } };
  }
  if (meta.role === "qa") {
    const reqs = numbers(ctx.message, /\bR(\d+)\b/g);
    const runs = numbers(ctx.message, /^- run (\d+):/gm);
    const cite = runs.length ? [runs[runs.length - 1]] : [];
    return { steps: [], reply: { results: (reqs.length ? reqs : [1]).map((req) => ({ req, status: "satisfied",
      runs: cite, needs: null, note: null })), summary: "Every requirement is satisfied." } };
  }
  if (meta.role === "builder") {
    const file = ticket?.likely_files?.[0] ?? `src/${meta.ticket ?? "work"}.txt`;
    const steps = [{ edit: file, content: `${meta.ticket ?? "work"} done\n` }];
    if (tests[0]) steps.push({ runCheck: tests[0] });
    return { steps, reply: { kind: "done", summary: `Built ${meta.ticket ?? "the ticket"}.`, runs: RUNS, block: null,
      question: null } };
  }
  if (meta.role === "ticket-maker" && meta.step === "risk-notes") {
    return { steps: [], reply: { rollback: `Revert ${meta.ticket}'s commit; nothing else depends on it.` } };
  }
  return { steps: [], reply: {} };
}

/** The `outside` step (C123): the user edits or removes a file mid-turn, straight on disk; the agent did nothing. */
export function outsideEdit(cwd, o) {
  if (o.remove) rmSync(path.resolve(cwd, o.remove), { force: true });
  if (o.edit) {
    const file = path.resolve(cwd, o.edit);
    mkdirSync(path.dirname(file), { recursive: true });
    const content = o.replace ? readFileSync(file, "utf8").replace(o.replace[0], o.replace[1])
      : o.content ?? "changed by you\n";
    writeFileSync(file, content);
  }
}
