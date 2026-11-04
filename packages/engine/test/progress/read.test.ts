// Item 23 (M4 plan 3.3; ARCH 3.7; S-CRASH-2): the progress file is read and validated. A torn file, a conflicted one
// and a schema-invalid one are each "damaged"; a valid one parses. The database wins: the file is only ever rewritten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readProgress } from "../../src/progress/read.js";

const valid = "# Written by rafi\nversion: 1\ntickets:\n  T1:\n    status: done\n    at: 2026-11-01T14:00:00.000Z\n" +
  "questions: {}\nanswers: {}\n";

test("torn, conflicted and schema-invalid progress files are damaged; a valid one parses; none is missing", () => {
  assert.equal(readProgress(valid).kind, "valid");
  assert.equal(readProgress(valid.slice(0, 40)).kind, "damaged", "torn mid-write");
  assert.equal(readProgress(`<<<<<<< HEAD\n${valid}=======\n${valid}>>>>>>> theirs\n`).kind, "damaged");
  assert.equal(readProgress("version: 2\ntickets: {}\n").kind, "damaged");
  assert.equal(readProgress(null).kind, "missing");
});
