import assert from "node:assert/strict";
import { test } from "node:test";
import { isLiveProcessIdentity, processStartIdentity } from "../src/processIdentity.js";

test("process identity verifies the current process on supported Unix hosts", () => {
  const identity = processStartIdentity(process.pid);
  assert.notEqual(identity, "unavailable");
  assert.equal(isLiveProcessIdentity(process.pid, identity), true);
  assert.equal(isLiveProcessIdentity(process.pid, `${identity}-wrong`), false);
});

test("classification preserves uncertainty and ignores heartbeat age", async () => {
  const { classifyProcess } = await import("../src/processIdentity.js");
  const { hostname } = await import("node:os");
  const probe = { kill: () => {}, identity: () => "incarnation" };
  assert.equal(classifyProcess(123, "incarnation", hostname(), probe).state, "live");
  assert.equal(classifyProcess(123, "old", hostname(), probe).state, "dead");
  assert.equal(classifyProcess(123, "unavailable", hostname(), probe).state, "unknown");
  assert.equal(classifyProcess(123, "incarnation", "foreign-host", probe).state, "unknown");
  for (const code of ["EPERM", "EACCES", "ESRCH"]) {
    assert.equal(classifyProcess(123, "incarnation", hostname(), { ...probe, kill: () => { throw Object.assign(new Error(code), { code }); } }).state, code === "ESRCH" ? "dead" : "unknown");
  }
});

test("Linux identity parser handles spaces and nested parentheses in comm", async () => {
  const { linuxProcessStart } = await import("../src/processIdentity.js");
  const fields = ["S", ...Array.from({ length: 18 }, (_, i) => String(i)), "12345", "0"];
  assert.equal(linuxProcessStart(`123 (a worker (test)) ${fields.join(" ")}`), "12345");
  assert.equal(linuxProcessStart("malformed"), undefined);
});
