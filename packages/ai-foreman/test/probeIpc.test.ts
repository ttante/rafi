import { test } from "node:test";
import assert from "node:assert/strict";
import { ProbeIpcTracker } from "../src/probeIpc.js";

test("probe terminal requires current registered identity; duplicates cannot overwrite it", () => {
  const tracker = new ProbeIpcTracker("probe", 100);
  const registration = { version: 1, kind: "rafi-probe-registered", id: "probe", pid: 100 };
  const result = { ...registration, kind: "rafi-probe-result", exitCode: 0, signal: null };
  assert.equal(tracker.accept(result), undefined);
  for (const stale of [{ ...registration, id: "old" }, { ...registration, pid: 101 }, { ...registration, version: 0 }]) assert.equal(tracker.accept(stale), undefined);
  assert.deepEqual(tracker.accept(registration), registration);
  assert.equal(tracker.accept(registration), undefined);
  assert.deepEqual(tracker.accept(result), result);
  assert.equal(tracker.accept(result), undefined);
  assert.equal(tracker.accept({ ...result, exitCode: 1 }), "conflict");
  assert.equal(tracker.accept({ ...registration, kind: "rafi-probe-spawn-error", code: "ENOENT", message: "missing" }), "conflict");
  assert.deepEqual(tracker.terminal, result);
});
