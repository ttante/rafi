// Manager's thin host commands (ARCH 8.3, 8.5, 5.6; C153): `/pause <run> <ticket>`, `/request-attempt <run>
// <ticket> "<reason>"`, `/answer-question <question> <choice>`. Each parses, calls one engine action and says one
// line; no model turn. Everything is recorded with actor and source `manager`; first answer wins (C101). Like every
// command that writes, they prune old completed interviews (C150).
import { answerQuestion, openQuestions } from "../ask/questions.js";
import { whatNextDraft } from "../ask/blocked.js";
import { whatNextEffects } from "../state/answers.js";
import type { Engine } from "../api/engine.js";
import { definitions, findRun } from "../build/runs.js";
import { pauseBuild, type Said } from "../api/stop.js";
import { pruneInterviews } from "../setup/interviews.js";

export type HostCommand =
  | { cmd: "pause"; run: string; ticket: string }
  | { cmd: "request-attempt"; run: string; ticket: string; reason: string }
  | { cmd: "answer-question"; question: number; choice: string };

const MANAGER = Object.freeze({ actor: "manager", source: "manager" as const });

/** Splits like a shell for simple quoting ("…", '…'). */
function words(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)]
    .map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]!));
}

export function parseHost(text: string): HostCommand | { error: string } {
  const [name, ...args] = words(text.trim());
  const usage = (form: string) => ({ error: `Usage: ${form}` });
  if (name === "/pause") return args.length === 2 ? { cmd: "pause", run: args[0]!, ticket: args[1]! }
    : usage("/pause <run> <ticket>");
  if (name === "/request-attempt") {
    return args.length === 3 && args[2]!.trim() ? { cmd: "request-attempt", run: args[0]!, ticket: args[1]!,
      reason: args[2]! } : usage('/request-attempt <run> <ticket> "<reason>"');
  }
  if (name === "/answer-question") {
    const n = Number(args[0]);
    return args.length === 2 && Number.isInteger(n) && n > 0 ? { cmd: "answer-question", question: n,
      choice: args[1]! } : usage("/answer-question <question number> <choice>");
  }
  return { error: `${name ?? "That"} isn't one of Manager's host commands in this version (/pause, ` +
    "/request-attempt, /answer-question); the rest comes with Manager (milestone M9)." };
}

async function answerWhatNext(engine: Engine, run: string | null, question: { id: string; tickets: readonly string[] },
  choice: string, reason: string): Promise<Said> {
  const ticket = question.tickets[0]!;
  const fixes = engine.fold(await definitions(engine)).tickets[ticket]?.fixesUsed ?? 0;
  const made = await whatNextDraft(engine, engine.deps, ticket, fixes);
  const effects = whatNextEffects({ ticket, choice, note: null, confirmed: true, findings: made?.findings ?? [],
    fp: made?.fp ?? "sha256:none" });
  if (!effects.ok) return { code: 1, line: effects.reason };
  const events = effects.events.map((e) => (e.type === "fix.granted" ? { ...e, data: { by: "manager", reason } }
    : e.type === "ticket.unblocked" ? { ...e, data: { ...(e.data as object), by: "manager" } } : e))
    .map((e) => ({ ...e, ticket_id: ticket }));
  const out = await answerQuestion(engine, run, question.id, { choice, note: null }, events, "manager", "manager");
  if (!out.written) return { code: 0, line: `That question was already answered by ${out.by?.actor ?? "someone"}.` };
  return { code: 0, line: `Answered for ${ticket}: ${choice}.` };
}

export async function runHost(engine: Engine, c: HostCommand): Promise<Said> {
  // C150 (P38): a command that writes prunes completed interviews first.
  await pruneInterviews(engine.deps.fs, engine.projectDir, engine.deps.clock.now());
  const view = engine.fold(await definitions(engine));
  if (c.cmd === "answer-question") {
    const q = Object.values(view.questions).find((x) => x.no === c.question);
    if (!q) return { code: 1, line: `There's no question ${c.question}.` };
    if (q.status === "answered") {
      const out = await answerQuestion(engine, null, q.id, { choice: c.choice, note: null }, [], "manager", "manager");
      return { code: 0, line: `Question ${c.question} was already answered by ${out.by?.actor ?? "someone"}.` };
    }
    if (q.status !== "open") return { code: 1, line: `Question ${c.question} is ${q.status}.` };
    if (q.kind !== "what-next") return { code: 1, line: `Question ${c.question} is answered in its terminal.` };
    return answerWhatNext(engine, view.run, q, c.choice, "Answered by Manager");
  }
  const found = findRun(view, c.run);
  if ("message" in found) return { code: 1, line: found.message };
  if (c.cmd === "pause") return pauseBuild(engine, found.run, MANAGER);
  const open = openQuestions(view).find((q) => q.kind === "what-next" && q.tickets.includes(c.ticket));
  if (open) return answerWhatNext(engine, found.run, open, "retry", c.reason);
  await engine.append([{ type: "fix.granted", run_id: found.run, ticket_id: c.ticket, ...MANAGER,
    data: { by: "manager", reason: c.reason } }]);
  return { code: 0, line: `Granted ${c.ticket} one more fix attempt.` };
}
