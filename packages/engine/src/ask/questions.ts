// Question records (ARCH 7.6; C101): open one with the next short number (per project, never reused); answer it
// with first-answer-wins: the answer and its effects are one append under the key `answer|<question id>`, so a
// second answer, here or from another process, writes nothing and gets back who answered and when.
import type { Engine } from "../api/engine.js";
import type { Folded, Question } from "../state/types.js";

export type QuestionLog = Pick<Engine, "append" | "fold" | "events">;

export interface QuestionDraft {
  readonly kind: string;
  readonly tickets: readonly string[];
  readonly text: string;
  readonly options: readonly { id: string; label: string }[];
  readonly recommended: string | null;
  readonly context: string | null;
  readonly urgency: "low" | "normal" | "high";
  readonly key: string | null;
}

export interface Answered {
  readonly written: boolean;
  /** When the question was answered already: by whom, where and when. */
  readonly by: { actor: string; source: string | null; at: string } | null;
}

export async function openQuestion(log: QuestionLog, run: string | null, q: QuestionDraft):
  Promise<{ id: string; no: number }> {
  const no = Math.max(0, ...Object.values(log.fold().questions).map((x) => x.no)) + 1;
  const id = `question-${no}`;
  await log.append([{ type: "question.opened", run_id: run, actor: "engine", data: { id, no, kind: q.kind,
    tickets: [...q.tickets], text: q.text, options: q.options.map((o) => ({ id: o.id, label: o.label })),
    recommended: q.recommended, context: q.context, urgency: q.urgency, key: q.key } }]);
  return { id, no };
}

async function answeredBy(log: QuestionLog, id: string): Promise<Answered["by"]> {
  for await (const e of log.events()) {
    if (e.type === "question.answered" && (e.data as { id: string }).id === id) {
      return { actor: e.actor, source: e.source, at: e.at };
    }
  }
  return null;
}

export async function answerQuestion(log: QuestionLog, run: string | null, id: string,
  a: { choice: string | null; note: string | null; text?: string | null; save?: "none" | "build" | "project" },
  effects: readonly { type: string; ticket_id?: string | null; data: unknown }[],
  source: "terminal" | "rafi-answer" | "notification" = "terminal"): Promise<Answered> {
  const q = log.fold().questions[id];
  if (q && q.status === "answered") return { written: false, by: await answeredBy(log, id) };
  const result = await log.append([{ type: "question.answered", run_id: run, actor: "user", source,
    data: { id, choice: a.choice, text: a.text ?? null, note: a.note, save: a.save ?? "none" } },
  ...effects.map((e) => ({ ...e, run_id: run, actor: "user", source }))], { idemKey: `answer|${id}` });
  if (!result.replayed) return { written: true, by: null };
  const first = result.events[0]!;
  return { written: false, by: { actor: first.actor, source: first.source, at: first.at } };
}

/** Open questions, oldest first. */
export function openQuestions(view: Folded): Question[] {
  return Object.values(view.questions).filter((q) => q.status === "open").sort((a, b) => a.no - b.no);
}
