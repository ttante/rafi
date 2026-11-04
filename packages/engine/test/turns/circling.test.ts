// Item 10 (M3 plan): failure signatures, "no progress" and circling (ARCH 5.5; C111, C112).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockSignature, checksSignature, isCircling, noProgress, replySignature, turnCircling, verdictSignature,
  type AttemptRecord,
} from "../../src/turns/circling.js";

test("a QA rejection's signature: sorted not-satisfied numbers with their cited runs' outcomes (no run numbers)", () => {
  const runs = [{ run: 3, outcome: "passed" }, { run: 4, outcome: "failed" }, { run: 7, outcome: "passed" }];
  const a = verdictSignature([{ req: 3, status: "not-satisfied", runs: [4] }, { req: 1, status: "satisfied", runs: [3] },
    { req: 2, status: "not-satisfied", runs: [3] }], runs);
  assert.equal(a, "R2[passed] R3[failed]");
  const b = verdictSignature([{ req: 2, status: "not-satisfied", runs: [7] }, { req: 3, status: "not-satisfied",
    runs: [4] }], runs);
  assert.equal(b, a, "a new run with the same outcome is the same failure");
  assert.equal(verdictSignature([{ req: 1, status: "unable", runs: [] }], runs), "");
});

test("a check failure's signature: requirement numbers and test names; a block: kind and reason", () => {
  assert.equal(checksSignature([{ req: 2, run: 5, tests: ["b fails", "a fails"] }, { req: 1, run: 4, tests: [] }]),
    "R1 R2[a fails|b fails]");
  assert.equal(blockSignature("install", "needs PostgreSQL"), "install: needs PostgreSQL");
});

test("a format or content failure's signature: the class and the field, or the repair's rejected field", () => {
  assert.equal(replySignature("content", ["summary: Expected string, received null"]), "content: summary");
  assert.equal(replySignature("content", ["Unexpected non-whitespace character after JSON; the repair was " +
    "rejected: the resend changed summary"]), "repair rejected: summary");
  assert.equal(replySignature("format", ["the reply was cut off"]), "format: the reply was cut off");
  assert.equal(replySignature("provider", ["overloaded"]), null, "only format and content failures circle");
});

const rec = (signature: string, tree: string | null, read: string[] = []): AttemptRecord => ({ signature, tree, read });

test("no progress needs all three: the same signature, a tree already seen, and no new file read", () => {
  assert.equal(noProgress([rec("R2", "t1"), rec("R2", "t1")], 1), true);
  assert.equal(noProgress([rec("R2", "t1"), rec("R3", "t1")], 1), false, "a different failure");
  assert.equal(noProgress([rec("R2", "t1"), rec("R2", "t2")], 1), false, "a new tree");
  assert.equal(noProgress([rec("R2", "t1", ["a"]), rec("R2", "t1", ["b"])], 1), false, "a new file read");
  assert.equal(noProgress([rec("R2", "t1", ["a", "b"]), rec("R2", "t1", ["b"])], 1), true, "an old read");
  assert.equal(noProgress([rec("R2", "t1"), rec("R2", "t2"), rec("R2", "t1")], 2), true, "t1 was seen earlier");
  assert.equal(noProgress([rec("R2", "t1")], 0), false, "the first attempt is never circling");
  assert.equal(noProgress([rec("R2", null), rec("R2", null)], 1), false, "no snapshot: no claim");
});

test("circling is `repeats` no-progress attempts in a row; a new tree or a new read resets it", () => {
  const same = [rec("R2", "t1"), rec("R2", "t1"), rec("R2", "t1")];
  assert.equal(isCircling(same.slice(0, 2), 2), false);
  assert.equal(isCircling(same, 2), true);
  assert.equal(isCircling(same.slice(0, 2), 1), true);
  assert.equal(isCircling([rec("R2", "t1"), rec("R2", "t1"), rec("R2", "t2"), rec("R2", "t2")], 2), false);
  assert.equal(isCircling([rec("R2", "t1"), rec("R2", "t1", ["x"]), rec("R2", "t1", ["x"])], 2), false);
  assert.equal(isCircling([rec("R2", "t1", ["x"]), rec("R2", "t1", ["x"]), rec("R2", "t1", ["x"])], 2), true);
});

test("turn-level circling (C112): the same failure, touching nothing new, `repeats` times in a row", () => {
  const t = (signature: string | null, touched: string[] = ["Write src/T1.txt"]) => ({ signature, touched });
  assert.equal(turnCircling([t("repair rejected: summary"), t("repair rejected: summary")], 2), false);
  assert.equal(turnCircling([t("repair rejected: summary"), t("repair rejected: summary"),
    t("repair rejected: summary")], 2), true);
  assert.equal(turnCircling([t("content: summary"), t("content: summary", ["Read README.md"]),
    t("content: summary", ["Read README.md"])], 2), false, "a new read is progress");
  assert.equal(turnCircling([t(null), t(null), t(null)], 2), false, "provider errors never circle");
  assert.equal(turnCircling([t("content: a"), t("content: b"), t("content: b")], 2), false);
});
