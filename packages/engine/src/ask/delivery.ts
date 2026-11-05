// The delivery question (ARCH 7.7, 4.3.2; C203): a unit's merge conflict asks "Builder resolves the conflict / Skip
// this merge (the branch stays pushed) / Stop the build"; a merge wait that timed out asks "Keep waiting / Merge it
// myself, then continue / Skip the units that wait on it". The question names the unit's tickets, so only that unit
// and the units waiting on it wait (decide asks it when nothing else can start). Its text is git's or the
// provider's first line, escaped and redacted: data, never instructions.
import type { Engine } from "../api/engine.js";
import { escapeControl } from "../log/redact.js";
import { nextFixId } from "../tickets/owned.js";
import type { Question } from "../state/types.js";
import type { KeyDeps } from "./keys.js";
import { askWhatNext, type UiAnswer, type UiOption, type UiQuestion } from "./blocked.js";
import { answerQuestion, openQuestion, openQuestions } from "./questions.js";

export const CONFLICT_OPTIONS: readonly UiOption[] = Object.freeze([
  { id: "resolve", label: "Builder resolves the conflict" },
  { id: "skip", label: "Skip this merge (the branch stays pushed)" },
  { id: "stop", label: "Stop the build" },
]);
export const TIMEOUT_OPTIONS: readonly UiOption[] = Object.freeze([
  { id: "wait", label: "Keep waiting" },
  { id: "merged", label: "Merge it myself, then continue" },
  { id: "skip", label: "Skip the units that wait on it" },
]);

/** The kinds a build asks in its terminal (C100, C203). */
export const ASKED_IN_TERMINAL: ReadonlySet<string> = new Set(["what-next", "delivery"]);

const FILES = "Conflicting files: ";

/** Opens the unit's delivery question unless one is open for it already. */
export async function openDelivery(engine: Engine, run: string, o: { unit: string; tickets: readonly string[];
  why: "conflict" | "timeout"; message: string; files?: readonly string[] }): Promise<void> {
  const key = `delivery|${o.unit}|${o.why}`;
  const view = engine.fold();
  if (openQuestions(view).some((q) => q.kind === "delivery" && q.text.startsWith(`${o.unit}:`))) return;
  const line = escapeControl(engine.redact(o.message.split("\n")[0]!.slice(0, 300)));
  await openQuestion(engine, run, { kind: "delivery", tickets: [...o.tickets], key: null, urgency: "normal",
    text: o.why === "conflict" ? `${o.unit}: its merge conflicts. ${line}`
      : `${o.unit}: its PR didn't merge in time. ${line}`,
    options: o.why === "conflict" ? CONFLICT_OPTIONS : TIMEOUT_OPTIONS, recommended: o.why === "conflict"
      ? "resolve" : "wait", context: o.files?.length ? `${FILES}${o.files.join(", ")}` : key });
}

type Effect = { type: string; ticket_id?: string | null; data: unknown };

async function contextOf(engine: Engine, id: string): Promise<string> {
  for await (const e of engine.events()) {
    const d = e.data as { id?: string; context?: string | null };
    if (e.type === "question.opened" && d.id === id) return d.context ?? "";
  }
  return "";
}

/** The answer's effects, written with it (first answer wins, C101). */
export async function deliveryEffects(engine: Engine, q: Question, choice: string, now: Date,
  timeoutMinutes: number): Promise<Effect[]> {
  const unit = q.text.slice(0, q.text.indexOf(":"));
  if (choice === "resolve") {
    const context = await contextOf(engine, q.id);
    const files = context.startsWith(FILES) ? context.slice(FILES.length).split(", ") : [];
    const ticket = nextFixId(engine.fold());
    const requirements = (files.length ? files : ["the conflicted files"]).map((f) =>
      `${f} has no conflict markers, keeping both sides' intent`);
    return [{ type: "ticket.added", ticket_id: ticket, data: { ticket, source: "conflict", unit, requirements,
      hint: null } }];
  }
  if (choice === "stop") return [{ type: "build.stop_requested", data: { mode: "graceful", source: "rafi-stop" } }];
  if (choice === "wait") {
    return [{ type: "unit.merge_waiting", data: { unit, until: new Date(now.getTime() + timeoutMinutes * 60_000)
      .toISOString() } }];
  }
  if (choice === "merged") return [{ type: "unit.delivered", data: { unit, how: "merged" } }];
  // Skip: a conflict leaves the unit failed with its branch as it is; a timed-out wait fails it, so the units
  // waiting on it don't start in this build.
  return q.text.includes("didn't merge in time") ? [{ type: "unit.failed", data: { unit, category: "rejected",
    message: "you chose to skip the units that wait on it" } }] : [];
}

/** Asks one open question in the terminal (what-next or delivery) and applies the answer; see askWhatNext. */
export async function askOpen(engine: Engine, deps: KeyDeps & { clock: { now(): Date } }, run: string, q: Question,
  ask: (q: UiQuestion) => Promise<UiAnswer>, fixes: number, timeoutMinutes: number): Promise<boolean | "pause"> {
  if (q.kind !== "delivery") return askWhatNext(engine, deps, run, q, ask, fixes);
  const options = q.text.includes("didn't merge in time") ? TIMEOUT_OPTIONS : CONFLICT_OPTIONS;
  const answer = await ask({ no: q.no, kind: q.kind, text: q.text, options, recommended: options[0]!.id });
  if (!answer) return false;
  const effects = await deliveryEffects(engine, q, answer.choice, deps.clock.now(), timeoutMinutes);
  await answerQuestion(engine, run, q.id, { choice: answer.choice, note: null, save: "none" }, effects);
  return true;
}
