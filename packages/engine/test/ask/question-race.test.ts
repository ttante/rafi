// Threat 9 (M4 plan 10.5): the question number shared by two processes. Two connections to one log stand in for two
// rafi processes; the second writer takes the next number between the first one's read and its append. The first
// must notice inside its transaction and take the number after, so no two questions share a short number. Checked
// for what-next questions (openQuestion) and for the runtime question a turn asks (C46).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openRealDb } from "../../src/deps/real/db.js";
import { append } from "../../src/log/append.js";
import { openLog } from "../../src/log/db.js";
import { readEvents } from "../../src/log/read.js";
import { redactor } from "../../src/log/redact.js";
import { fold } from "../../src/state/fold.js";
import { builtInWorkflows } from "../../src/workflow/load.js";
import { openQuestion, type QuestionLog } from "../../src/ask/questions.js";
import { runtimeQuestion } from "../../src/turns/agent.js";
import type { Clock } from "../../src/deps/types.js";
import { testLog } from "../helpers.js";

type Racer = QuestionLog & { beforeAppend: (() => Promise<void>) | null };

async function writer(file: string, clock: Clock, prefix: string): Promise<Racer> {
  const log = await openLog({ db: { open: (f) => openRealDb(f) }, clock }, file);
  let n = 0;
  const ctx = { log, redact: redactor({}), now: () => clock.now(), newId: () => `${prefix}-${++n}` };
  const racer: Racer = {
    beforeAppend: null,
    append: async (events, o) => {
      const hook = racer.beforeAppend;
      racer.beforeAppend = null;
      await hook?.();
      return append(ctx, events, o);
    },
    fold: () => fold(readEvents(log.db).events, { workflows: builtInWorkflows }),
    async *events() { for (const e of readEvents(log.db).events) yield e; },
  };
  return racer;
}

const q = (text: string) => ({ kind: "what-next", tickets: ["T1"], text, options: [{ id: "retry", label: "Retry" }],
  recommended: "retry", context: null, urgency: "high" as const, key: `what-next|T1|${text}` });

const numbers = (log: QuestionLog) => Object.values(log.fold().questions).map((x) => x.no).sort();

async function pair() {
  const { file, clock } = await testLog();
  return { a: await writer(file, clock, "a"), b: await writer(file, clock, "b") };
}

test("threat 9: a what-next question opened while another process takes its number gets the next one", async () => {
  const { a, b } = await pair();
  // A reads "the next number is 1"; before its append, B opens a question and commits number 1.
  a.beforeAppend = async () => { await openQuestion(b, "run-1", q("from b")); };
  const mine = await openQuestion(a, "run-1", q("from a"));
  assert.equal(mine.no, 2);
  assert.deepEqual(numbers(a), [1, 2], "two questions, two numbers");
});

test("threat 9: the runtime question (C46) gets a number no other process has taken", async () => {
  const { a, b } = await pair();
  a.beforeAppend = async () => { await openQuestion(b, "run-1", q("from b")); };
  const ask = runtimeQuestion(a, "run-1", "T1", async () => "retry" as const);
  assert.equal(await ask("auth", "Claude isn't logged in"), "retry");
  assert.deepEqual(numbers(a), [1, 2], "two questions, two numbers");
  const runtime = Object.values(a.fold().questions).find((x) => x.kind === "runtime");
  assert.equal(runtime?.no, 2);
});
