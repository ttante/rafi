import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHostIpc } from "../src/hostIpc.js";

test("IPC accepts explicit versioned identities and rejects old or malformed shapes", () => {
  const valid = { version: 1, kind: "rafi-launch-ack", token: "current-launch", pid: 100 };
  assert.deepEqual(parseHostIpc(valid), valid);
  for (const value of ["rafi-launch-ack", { ...valid, version: 2 }, { ...valid, token: "" }, { ...valid, pid: 1 }, { ...valid, unexpected: true }, { kind: valid.kind }]) assert.equal(parseHostIpc(value), undefined);
});
test("worker heartbeat requires generation, process, run and positive monotonic sequence fields", () => {
  const valid = { version: 1, kind: "rafi-worker-heartbeat", runId: "run", generation: 3, pid: 100, sequence: 1 };
  assert.deepEqual(parseHostIpc(valid), valid);
  for (const field of ["version", "runId", "generation", "pid", "sequence"]) {
    const missing = { ...valid } as Record<string, unknown>; delete missing[field];
    assert.equal(parseHostIpc(missing), undefined);
  }
  assert.equal(parseHostIpc({ ...valid, sequence: 0 }), undefined);
});
