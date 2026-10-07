import assert from "node:assert/strict";
import { test } from "node:test";
import { isLiveProcessIdentity, processStartIdentity } from "../src/processIdentity.js";

test("process identity verifies the current process on supported Unix hosts", () => {
  const identity = processStartIdentity(process.pid);
  assert.notEqual(identity, "unavailable");
  assert.equal(isLiveProcessIdentity(process.pid, identity), true);
  assert.equal(isLiveProcessIdentity(process.pid, `${identity}-wrong`), false);
});
