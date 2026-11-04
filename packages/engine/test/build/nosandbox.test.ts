// Item 28 and section 4's no-sandbox rows (C60, NEW-SEC-4): the acceptance decision for every combination, and the
// remembered acceptance in ~/.rafi/grants.yaml, keyed by the project's path, read and written through deps.fs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realFs } from "../../src/deps/real/fs.js";
import { forgetNoSandbox, noSandboxDecision, rememberNoSandbox, savedNoSandbox, stopLine,
  WARNING } from "../../src/ask/grants.js";
import { tempDir } from "../helpers.js";

test("the decision, in order: saved, the setting, auto-approve, a terminal prompt, else stop", () => {
  for (const saved of [false, true]) for (const setting of [false, true]) for (const auto of [false, true]) {
    for (const tty of [false, true]) {
      const d = noSandboxDecision({ saved, setting, autoApprove: auto, tty });
      const expected = saved ? "saved" : setting ? "project" : auto ? "auto-approve" : tty ? "ask" : "stop";
      assert.equal(d, expected, JSON.stringify({ saved, setting, auto, tty }));
    }
  }
});

test("the warning and the stop line say what they must", () => {
  const warning = WARNING("bubblewrap isn't installed");
  assert.match(warning, /bubblewrap isn't installed/);
  assert.match(warning, /reach the internet/);
  assert.match(warning, /write outside the project/);
  assert.match(stopLine("bubblewrap isn't installed"), /checks\.run_without_sandbox: true/);
  assert.match(stopLine("bubblewrap isn't installed"), /rafi-config\.yaml/);
});

test("the acceptance is saved per project path, read back, removed; another project isn't covered", async () => {
  const state = path.join(tempDir(), ".rafi");
  const fs = realFs({ id: () => "t", jitter: () => 0 });
  assert.equal(await savedNoSandbox(fs, state, "/p/one"), false);
  await rememberNoSandbox(fs, state, "/p/one", "2026-11-01T14:00:00.000Z");
  assert.equal(await savedNoSandbox(fs, state, "/p/one"), true);
  assert.equal(await savedNoSandbox(fs, state, "/p/two"), false);
  assert.match(readFileSync(path.join(state, "grants.yaml"), "utf8"), /run_without_sandbox/);
  await forgetNoSandbox(fs, state, "/p/one");
  assert.equal(await savedNoSandbox(fs, state, "/p/one"), false);
});

test("an unreadable or malformed grants.yaml counts as not accepted", async () => {
  const state = path.join(tempDir(), ".rafi");
  mkdirSync(state, { recursive: true });
  const fs = realFs({ id: () => "t", jitter: () => 0 });
  for (const text of ["{{ not yaml", "projects: 7", "- a list"]) {
    writeFileSync(path.join(state, "grants.yaml"), text);
    assert.equal(await savedNoSandbox(fs, state, "/p/one"), false, text);
  }
});
