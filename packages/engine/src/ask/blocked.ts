// "What next?" (ARCH 7.7, 5.5, 5.6; REQ PRM-81..83; C99, C100, C102, C103): the question a blocked(what-next)
// ticket asks, its five options, and applying the answer. Its text says what failed (QA's findings, the failing
// checks, or the failure that repeated), escaped and redacted: QA's notes are data, never instructions.
import type { Engine } from "../api/engine.js";
import { escapeControl } from "../log/redact.js";
import { whatNextEffects, WHAT_NEXT_LATER } from "../state/answers.js";
import type { Question } from "../state/types.js";
import type { Fs } from "../deps/types.js";
import { snapshot } from "../facts/snapshot.js";
import { changedCovered, coveredDigest, whatNextKey, type KeyDeps } from "./keys.js";
import { answerQuestion, openQuestion, type QuestionDraft } from "./questions.js";

/** One option as the terminal shows it: a note it needs, a confirmation it asks, or the milestone it waits for. */
export interface UiOption {
  readonly id: string;
  readonly label: string;
  readonly note?: { prompt: string; required: boolean };
  readonly confirm?: { text: string; options: readonly string[]; yes: number };
  readonly later?: string;
}

export interface UiQuestion {
  readonly no: number;
  readonly kind: string;
  readonly text: string;
  readonly options: readonly UiOption[];
  readonly recommended: string | null;
}

export type UiAnswer = { choice: string; note: string | null; confirmed: boolean } | null;

export const WHAT_NEXT_OPTIONS: readonly UiOption[] = Object.freeze([
  { id: "retry", label: "Retry another Builder fix" },
  { id: "verified", label: "I verified it myself (a note is required)",
    note: { prompt: "What did you check? (one line)", required: true } },
  { id: "waive", label: "Explicitly waive QA", confirm: { text: "Record validation_result=failed and retain " +
    "unresolved issues?", options: ["No", "Waive and continue"], yes: 1 } },
  { id: "planner", label: "Discuss with read-only Planner", later: WHAT_NEXT_LATER.planner! },
  { id: "pause", label: "Pause at this checkpoint", later: WHAT_NEXT_LATER.pause! },
]);

interface Ev { readonly type: string; readonly ticket_id: string | null; readonly data: unknown; readonly id: string;
  readonly seq: number }

type Failure = { req: number; status?: string; note?: string | null };

/** The ticket's latest failure in its fix loop and the findings still open. */
function failure(events: readonly Ev[], id: string) {
  const last = events.filter((e) => e.ticket_id === id && (e.type === "checks.failed" ||
    (e.type === "verdict.recorded" && (e.data as { rejected: boolean }).rejected))).at(-1);
  if (!last) return null;
  const d = last.data as { results?: Failure[]; failing?: { req: number; run: number }[]; circling: boolean };
  const open = d.results ? d.results.filter((r) => r.status === "not-satisfied") : (d.failing ?? []);
  return { event: last, qa: Boolean(d.results), circling: d.circling, open: open as Failure[] };
}

/** The ticket's changed files and tree in its latest builder snapshot (C106), less the requirements file rafi
 * wrote (threat 2, 10.8: exactly that path, so your own files under a docs folder still count). */
export function coveredFiles(events: readonly Pick<Ev, "type" | "ticket_id" | "data">[], id: string):
  { tree: string | null; files: string[] } {
  const mine = events.filter((e) => e.ticket_id === id);
  const snap = mine.filter((e) => e.type === "facts.snapshot").at(-1);
  const written = mine.filter((e) => e.type === "requirements.written").at(-1)?.data as { path: string } | undefined;
  const d = snap?.data as { tree: string; files: string[] } | undefined;
  return { tree: d?.tree ?? null, files: (d?.files ?? []).filter((f) => f !== written?.path) };
}

function clean(engine: Engine, text: string): string {
  return escapeControl(engine.redact(text)).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The what-next question for a blocked ticket (C99): its text, options and key. */
export async function whatNextDraft(engine: Engine, deps: KeyDeps, id: string, fixes: number):
  Promise<{ draft: QuestionDraft; findings: string[]; fp: string } | null> {
  const events: Ev[] = [];
  for await (const e of engine.events()) events.push(e);
  const f = failure(events, id);
  if (!f) return null;
  const covered = coveredFiles(events, id);
  const fp = covered.tree ? await coveredDigest(deps, engine.projectDir, covered.tree, covered.files)
    : "sha256:none";
  const findings = f.open.map((r) => `R${r.req}`);
  const detail = f.open.map((r) => (r.note ? `R${r.req}: ${clean(engine, r.note)}` : `R${r.req}`)).join("; ");
  const what = f.qa ? `QA still finds ${detail || "a problem"}` : `the checks still fail (${detail})`;
  const text = f.circling
    ? `${id}: the same failure repeated with no progress, so rafi stopped early: ${what}. What next?`
    : `${id}: ${what} after ${fixes} ${fixes === 1 ? "fix" : "fixes"}. What next?`;
  return { findings, fp, draft: { kind: "what-next", tickets: [id], text, recommended: "retry", context: null,
    urgency: "high", key: whatNextKey(id, f.event.id, fp),
    options: WHAT_NEXT_OPTIONS.map((o) => ({ id: o.id, label: o.label })) } };
}

export async function openWhatNext(engine: Engine, deps: KeyDeps, run: string, id: string, fixes: number) {
  const made = await whatNextDraft(engine, deps, id, fixes);
  return made ? openQuestion(engine, run, made.draft) : null;
}

/** Asks one open what-next question in the terminal and applies the answer. Null: no answer (the input ended). */
export async function askWhatNext(engine: Engine, deps: KeyDeps, run: string, q: Question,
  ask: (q: UiQuestion) => Promise<UiAnswer>, fixes: number): Promise<boolean> {
  const id = q.tickets[0]!;
  const made = await whatNextDraft(engine, deps, id, fixes);
  for (;;) {
    const answer = await ask({ no: q.no, kind: q.kind, text: q.text, options: WHAT_NEXT_OPTIONS,
      recommended: "retry" });
    if (!answer) return false;
    const effects = whatNextEffects({ ticket: id, choice: answer.choice, note: answer.note,
      confirmed: answer.confirmed, findings: made?.findings ?? [], fp: made?.fp ?? "sha256:none" });
    if (!effects.ok) continue;
    await answerQuestion(engine, run, q.id, { choice: answer.choice, note: answer.note, save: "project" },
      effects.events.map((e) => ({ ...e, ticket_id: id })));
    return true;
  }
}

/**
 * C107: a done ticket put back in scope by name keeps its waiver only while the files it covered are unchanged. A
 * stale one reopens the ticket for QA (`ticket.reopened`) with one line naming a changed file; a README-only edit
 * doesn't count. Returns whether it reopened.
 */
export async function staleWaiver(engine: Engine, deps: KeyDeps & { fs: Fs; git: KeyDeps["git"] }, run: string,
  id: string, say: (text: string) => void): Promise<boolean> {
  if (engine.fold().tickets[id]?.state !== "done") return false;
  const events: Ev[] = [];
  for await (const e of engine.events()) events.push(e);
  const waiver = events.filter((e) => e.ticket_id === id && e.type === "waiver.recorded").at(-1);
  const covered = coveredFiles(events, id);
  if (!waiver || !covered.tree) return false;
  const snap = await snapshot(deps, engine.projectDir, `${id}-waiver`);
  if (!snap.ok) return false;
  const fp = await coveredDigest(deps, engine.projectDir, snap.tree, covered.files);
  if (fp === (waiver.data as { fp: string }).fp) return false;
  const changed = await changedCovered(deps, engine.projectDir, covered.tree, snap.tree, covered.files);
  const named = changed.map((f) => escapeControl(f)).join(", ") || "the files it covered";
  await engine.append([{ type: "ticket.reopened", run_id: run, ticket_id: id, actor: "engine",
    data: { why: `the waiver is stale: ${named} changed` } }]);
  say(`${id}: ${named} changed since the waiver, so QA reviews ${id} again.`);
  return true;
}
