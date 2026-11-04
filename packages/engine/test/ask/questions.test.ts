// Item 15 (M3 plan): question records (ARCH 7.6; C101): short numbers per project, never reused; first answer wins
// (a second answer writes nothing and says who answered and when); open questions oldest first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { append } from "../../src/log/append.js";
import { readEvents } from "../../src/log/read.js";
import { fold } from "../../src/state/fold.js";
import { builtInWorkflows } from "../../src/workflow/load.js";
import { answerQuestion, openQuestion, openQuestions, type QuestionLog } from "../../src/ask/questions.js";
import { testLog } from "../helpers.js";

async function questionLog(): Promise<QuestionLog & { types(): string[] }> {
  const { ctx, log } = await testLog();
  return {
    append: (events, o) => append(ctx, events, o),
    fold: () => fold(readEvents(log.db).events, { workflows: builtInWorkflows }),
    async *events() { for (const e of readEvents(log.db).events) yield e; },
    types: () => readEvents(log.db).events.map((e) => e.type),
  };
}

const q = (text: string) => ({ kind: "what-next", tickets: ["T1"], text, options: [{ id: "retry", label: "Retry" }],
  recommended: "retry", context: null, urgency: "high" as const, key: `what-next|T1|${text}` });

test("short numbers count up per project and are never reused, even after an answer", async () => {
  const log = await questionLog();
  const a = await openQuestion(log, "run-1", q("a"));
  const b = await openQuestion(log, "run-1", q("b"));
  assert.deepEqual([a.no, b.no], [1, 2]);
  await answerQuestion(log, "run-1", a.id, { choice: "retry", note: null }, []);
  const c = await openQuestion(log, "run-2", q("c"));
  assert.equal(c.no, 3);
  assert.deepEqual(openQuestions(log.fold()).map((x) => x.no), [2, 3], "open ones, oldest first");
});

test("first answer wins: the second writes nothing and returns who answered and when", async () => {
  const log = await questionLog();
  const { id } = await openQuestion(log, "run-1", q("a"));
  const first = await answerQuestion(log, "run-1", id, { choice: "retry", note: null },
    [{ type: "fix.granted", ticket_id: "T1", data: { by: "user", reason: "Retry another Builder fix" } }]);
  assert.equal(first.written, true);
  const count = log.types().length;
  const second = await answerQuestion(log, "run-1", id, { choice: "waive", note: null },
    [{ type: "fix.granted", ticket_id: "T1", data: { by: "user", reason: "again" } }], "rafi-answer");
  assert.equal(second.written, false);
  assert.equal(log.types().length, count, "nothing written");
  assert.deepEqual([second.by?.actor, second.by?.source], ["user", "terminal"]);
  assert.match(String(second.by?.at), /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(log.types().filter((t) => t === "fix.granted").length, 1);
});

test("an answer and its effects are one append with the key answer|<id>", async () => {
  const log = await questionLog();
  const { id } = await openQuestion(log, "run-1", q("a"));
  await answerQuestion(log, "run-1", id, { choice: "retry", note: null },
    [{ type: "fix.granted", ticket_id: "T1", data: { by: "user", reason: "r" } }]);
  const answered = [] as { idem_key: string | null; type: string; actor: string; source: string | null }[];
  for await (const e of log.events()) if (e.idem_key) answered.push(e);
  assert.deepEqual(answered.map((e) => [e.type, e.idem_key, e.actor]), [["question.answered", `answer|${id}`, "user"],
    ["fix.granted", `answer|${id}`, "user"]]);
});
