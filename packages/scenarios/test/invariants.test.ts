// Milestone: M1
// The invariant checker on synthetic exports (plan choice C20), and the script grammar and engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCrashRun, type EventsExport, type ExportedEvent } from "../checks/invariants.js";
import { appendTranscript, countPerSession, readTranscript, turnOrder } from "../checks/transcript.js";
import { parseRule } from "../fakes/script/parse.js";
import { rule, scriptEngine } from "../fakes/script/engine.js";
import { tempRoot } from "../fixtures/common.js";
import path from "node:path";

let seq = 0;
const ev = (type: string, ticket: string | null, data: Record<string, unknown> = {}): ExportedEvent =>
  ({ seq: ++seq, id: `e${seq}`, run_id: "r1", ticket_id: ticket, type, data });
const exp = (events: ExportedEvent[]): EventsExport => ({ format: "rafi-events", schema: 1, events });

function crashRun() {
  seq = 0;
  const before = [ev("ticket.started", "T1"), ev("turn.sent", "T1", { key: "T1:build:1" }),
    ev("question.opened", null, { id: "q1" })];
  const after = [ev("turn.sent", "T1", { key: "T1:build:1" }), ev("delivery.done", "T1"), ev("delivery.done", "T2")];
  seq = 100;
  const clean = [ev("delivery.done", "T1"), ev("delivery.done", "T2")];
  return { beforeResume: exp(before), final: exp([...before, ...after]), clean: exp(clean), resumeOutput: ["ok"] };
}

test("a consistent crash run passes", () => {
  assert.deepEqual(checkCrashRun(crashRun()), []);
});

test("each broken invariant is reported", () => {
  const base = crashRun();
  const twice = { ...base, final: exp([...base.final.events, { ...base.final.events.at(-1)!, seq: 99 }]) };
  assert.match(checkCrashRun(twice).join("\n"), /T2 was done twice/);
  const lost = { ...base, final: exp(base.final.events.filter((e) => e.ticket_id !== "T2")) };
  assert.match(checkCrashRun(lost).join("\n"), /T2 was lost|differ/);
  const rewritten = { ...base, final: exp([{ ...base.final.events[0]!, type: "ticket.dropped" },
    ...base.final.events.slice(1)]) };
  assert.match(checkCrashRun(rewritten).join("\n"), /before the crash changed/);
  const extra = { ...base, final: exp([...base.final.events, ev("turn.sent", "T1", { key: "T1:build:1" })]) };
  assert.match(checkCrashRun(extra).join("\n"), /ran 1 times before and 2 after/);
  const asked = { ...base, resumeOutput: ["How should Rafi recover the interrupted build?"] };
  assert.match(checkCrashRun(asked).join("\n"), /recovery mode/);
  const noQuestion = { ...base, final: exp(base.final.events.filter((e) => e.type !== "question.opened")) };
  assert.match(checkCrashRun(noQuestion).join("\n"), /question q1 was lost/);
});

test("the script grammar reads SCN 2.2's rules", () => {
  assert.deepEqual(parseRule('builder T2#1: blocked(permission: internet, "Internet needed")'), {
    selector: { role: "builder", ticket: "T2", attempt: 1 }, name: "blocked",
    args: 'permission: internet, "Internet needed"' });
  assert.deepEqual(parseRule("qa      T1#2: pass").selector, { role: "qa", ticket: "T1", attempt: 2 });
  assert.deepEqual(parseRule("builder @fix: hang").selector, { role: "builder", step: "fix" });
  assert.throws(() => parseRule("nonsense"), /can't read rule/);
  assert.throws(() => rule("builder T1#1: reject(R2: x)"), /isn't in M1/);
});

test("the script engine matches by role, ticket and attempt, then falls back to the happy path", () => {
  const engine = scriptEngine([rule("builder T2#1: hang"), rule("builder T2: malformed(not-json)")],
    () => ({ reply: { happy: true } }));
  assert.deepEqual(engine.next({ role: "builder", ticket: "T1", attempt: 1 }), { reply: { happy: true } });
  assert.deepEqual(engine.next({ role: "builder", ticket: "T2", attempt: 1 }), { hang: true });
  assert.deepEqual(engine.next({ role: "builder", ticket: "T2", attempt: 2 }), { raw: "I finished the work." });
  assert.deepEqual(engine.next({ role: "builder", ticket: "T2", attempt: 3 }), { reply: { happy: true } });
});

test("transcript helpers", () => {
  const file = path.join(tempRoot(), "t.jsonl");
  const entry = { role: "builder", ticket: "T1", step: "build", attempt: 1, session: "new" as const,
    instructions: "RULES", message: "go", sandbox: null };
  appendTranscript(file, entry);
  appendTranscript(file, { ...entry, session: "reused", instructions: "", attempt: 2 });
  const entries = readTranscript(file);
  assert.deepEqual(countPerSession(entries, "RULES"), [1]);
  assert.deepEqual(turnOrder(entries), ["builder T1#1", "builder T1#2"]);
});
