// Milestone: M4
// P8 option C in the fake executables (M4 plan Q1, slice 11): a process-mode script's rules match the turn's
// identity from rafi's log, as the in-process engine matches `meta`: first unused fitting rule, else the role's happy
// path; used rules are shared through a file beside the script, so a later process (or a rafi resumed after a kill)
// doesn't fire a rule again (C166). No log, or a v 1 intent: order only. Kill flags and the Claude shape pass through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeShape, pickBehavior } from "../fakes/script/match.mjs";
import { pOn, writeShims } from "../fakes/shims.js";
import { tempRoot } from "../fixtures/common.js";
import { fChain3 } from "../fixtures/f-chain3.js";

type Id = { role: string; ticket: string | null; step: string | null; attempt: number | null };

function project() {
  const root = tempRoot();
  const dir = fChain3(root);
  mkdirSync(path.join(dir, ".rafi"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, ".rafi", "state.sqlite3"));
  db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT, v INTEGER, data TEXT)");
  const intent = (id: Id, v = 2) => db.prepare("INSERT INTO events (type, v, data) VALUES ('turn.intent', ?, ?)")
    .run(v, JSON.stringify({ key: "ignored:never:parsed", ...id }));
  return { root, dir, intent, close: () => db.close() };
}

const RULES = [
  pOn("qa T2#1 @review", { kind: "reject", notes: { 1: "not yet" } }),
  pOn("builder T3#1 @build", { raw: "not json" }),
  pOn("builder T1 @fix", { kind: "happy", kill: "after-reply" }),
];

function script(root: string) {
  const shims = writeShims(root, { rules: RULES });
  const file = path.join(root, "codex.script.json");
  return { shims, file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("a rule fires on the turn whose identity it names, once; other turns get the role's happy path", () => {
  const p = project();
  const s = script(p.root);
  let cursor = 0;
  const pick = (message = "") => pickBehavior(s.read(), s.file, { cwd: p.dir, message }, () => cursor++);
  p.intent({ role: "builder", ticket: "T1", step: "build", attempt: 1 });
  const build = pick();
  assert.deepEqual(build.identity, { role: "builder", ticket: "T1", step: "build", attempt: 1 });
  assert.equal(build.behavior.reply.kind, "done", "the builder's happy path");
  assert.ok(build.behavior.steps.some((x: { edit?: string }) => x.edit === "src/T1.txt"));
  p.intent({ role: "qa", ticket: "T2", step: "review", attempt: 1 });
  const review = pick("Check R1 and R2.\n- run 4: npm test");
  assert.deepEqual(review.behavior.reply.results.map((r: { req: number; status: string }) => [r.req, r.status]),
    [[1, "not-satisfied"], [2, "satisfied"]]);
  const again = pick("Check R1 and R2.");
  assert.ok(again.behavior.reply.results.every((r: { status: string }) => r.status === "satisfied"),
    "the rule was used; the same identity now gets the happy path");
  p.intent({ role: "builder", ticket: "T3", step: "build", attempt: 2 });
  assert.equal(pick().behavior.raw, undefined, "attempt 2 isn't the rule's attempt 1");
  p.intent({ role: "builder", ticket: "T3", step: "build", attempt: 1 });
  assert.equal(pick().behavior.raw, "not json");
  p.intent({ role: "builder", ticket: "T1", step: "fix", attempt: 2 });
  assert.equal(pick().behavior.kill, "after-reply", "the kill flag passes through");
  assert.equal(cursor, 0, "no order-only fallback was used");
  p.close();
});

test("used rules are shared through the file beside the script: a later process doesn't fire them again", () => {
  const p = project();
  const s = script(p.root);
  p.intent({ role: "builder", ticket: "T3", step: "build", attempt: 1 });
  assert.equal(pickBehavior(s.read(), s.file, { cwd: p.dir, message: "" }, () => 0).behavior.raw, "not json");
  const fresh = JSON.parse(readFileSync(s.file, "utf8"));
  assert.equal(pickBehavior(fresh, s.file, { cwd: p.dir, message: "" }, () => 0).behavior.raw, undefined);
  p.close();
});

test("no log, or a v 1 turn.intent, falls back to order; Claude gets its rule shape", () => {
  const p = project();
  const s = script(p.root);
  const outside = tempRoot();
  let cursor = 0;
  const first = pickBehavior(s.read(), s.file, { cwd: outside, message: "" }, () => cursor++);
  assert.equal(first.identity, null);
  assert.equal(cursor, 1, "order only");
  p.intent({ role: "qa", ticket: "T2", step: "review", attempt: 1 }, 1);
  assert.equal(pickBehavior(s.read(), s.file, { cwd: p.dir, message: "" }, () => cursor++).identity, null);
  assert.equal(claudeShape({ hang: true }).behavior, "hang");
  assert.equal(claudeShape({ error: "overloaded" }).message, "overloaded");
  assert.equal(claudeShape({ reply: {} }).behavior, "reply");
  const claude = JSON.parse(readFileSync(path.join(p.root, "claude.script.json"), "utf8"));
  assert.equal(claude.match, "identity", "both fakes get the identity script");
  writeFileSync(path.join(p.root, "noop"), "");
  p.close();
});
