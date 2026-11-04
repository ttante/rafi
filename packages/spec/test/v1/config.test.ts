// M2 plan slice 1: the M2 config keys with their defaults, the 1.0 ticket and delivery files, the progress file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConfigV1, SETTING_DEFAULTS, settingsOf } from "../../src/v1/config.js";
import { checkDeliveryFile } from "../../src/v1/delivery.js";
import { checkProgressFile } from "../../src/v1/progress.js";
import { checkTicketsFile } from "../../src/v1/tickets.js";

test("M2 settings have ARCH 5.6's defaults", () => {
  assert.equal(SETTING_DEFAULTS["retries.fixes"], 3);
  assert.equal(SETTING_DEFAULTS["retries.turn"], 3);
  assert.equal(SETTING_DEFAULTS["retries.circling_repeats"], 2);
  assert.equal(SETTING_DEFAULTS["retries.quota_wait_hours"], 6);
  assert.equal(SETTING_DEFAULTS["timeouts.idle_minutes"], 30);
  assert.equal(SETTING_DEFAULTS["timeouts.check_quiet_minutes"], 2);
  assert.equal(SETTING_DEFAULTS["timeouts.check_minutes"], 5);
  assert.deepEqual(SETTING_DEFAULTS["checks.output_paths"], ["coverage/", "test-results/"]);
  assert.equal(SETTING_DEFAULTS["checks.run_without_sandbox"], false);
  assert.equal(SETTING_DEFAULTS["docs.root"], "docs");
  assert.equal(SETTING_DEFAULTS["harness.qa"], true);
  assert.equal(SETTING_DEFAULTS["logs.capture"], "normal");
  assert.equal(SETTING_DEFAULTS["git.managed_by"], "rafi");
});

test("settingsOf gives each M2 key its value and source: project when set, else default", () => {
  const s = settingsOf({ format_version: 1, retries: { turn: 5 }, harness: { targets: ["codex"] } });
  assert.deepEqual(s["retries.turn"], { value: 5, source: "project" });
  assert.deepEqual(s["retries.fixes"], { value: 3, source: "default" });
  assert.deepEqual(s["harness.targets"], { value: ["codex"], source: "project" });
});

test("a wrong type for an M2 key exits 1 naming the key; unknown keys still pass (M5)", () => {
  const bad = checkConfigV1({ format_version: 1, checks: { run_without_sandbox: "yes" } });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.message, /checks\.run_without_sandbox/);
  const bad2 = checkConfigV1({ format_version: 1, retries: { turn: -1 } });
  assert.match(bad2.ok ? "" : bad2.message, /retries\.turn/);
  assert.equal(checkConfigV1({ format_version: 1, some_later_key: { x: 1 } }).ok, true);
  assert.equal(checkConfigV1({ format_version: 1, workflows: [] }).ok, false);
});

const TICKET = {
  id: "T1", order: 1, title: "Add it", area: "app", summary: "Add it", priority: "P1", size: "S", risk: "Low",
  depends_on: [], tags: ["backend"], acceptance: ["It works."], required_tests: ["npm test"],
  likely_files: ["src/T1.txt"], rollback: null,
  needs: { internet: null, local_servers: null, installs: [], services: [], credentials: [] },
  open_decisions: [], person_only: [], locked: [],
};

test("the 1.0 tickets file: a valid ticket reads; a bad field is named with its ticket", () => {
  const ok = checkTicketsFile({ tickets: [TICKET] });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.tickets[0]!.id, "T1");
  const bad = checkTicketsFile({ tickets: [{ ...TICKET, acceptance: "one" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.message, /T1.*acceptance|acceptance.*T1/);
  const dup = checkTicketsFile({ tickets: [TICKET, TICKET] });
  assert.match(dup.ok ? "" : dup.message, /T1/);
  const minimal = checkTicketsFile({ tickets: [{ id: "T2", title: "x", risk: "Low", acceptance: ["a"] }] });
  assert.equal(minimal.ok && minimal.tickets[0]!.likely_files.length, 0);
});

test("the delivery file: units with tickets; a missing tickets list is named", () => {
  assert.equal(checkDeliveryFile({ delivery_units: [{ id: "U-T1", tickets: ["T1"], completion: "none" }] }).ok, true);
  const bad = checkDeliveryFile({ delivery_units: [{ id: "U-T1" }] });
  assert.match(bad.ok ? "" : bad.message, /U-T1/);
});

test("the progress file shape of ARCH 3.7", () => {
  const file = { version: 1, tickets: { T1: { status: "done", at: "2026-11-01T14:10:02Z" },
    T3: { status: "in_progress", at: "2026-11-01T14:31:40Z", step: "review", fixes: 1 } }, questions: {}, answers: {} };
  assert.equal(checkProgressFile(file).ok, true);
  assert.equal(checkProgressFile({ ...file, version: 2 }).ok, false);
  assert.equal(checkProgressFile({ ...file, tickets: { T1: { status: "nope", at: "x" } } }).ok, false);
});

test("checks.env and agents.env: exact variable names, default []; an invalid one is named (C92, FMT-C28, FMT-C30)", () => {
  assert.deepEqual(SETTING_DEFAULTS["checks.env"], []);
  assert.deepEqual(SETTING_DEFAULTS["agents.env"], []);
  const ok = checkConfigV1({ format_version: 1, checks: { env: ["DATABASE_URL", "_X1"] }, agents: { env: ["A"] } });
  assert.equal(ok.ok, true);
  for (const [key, bad] of [["checks", "API_*"], ["agents", "1BAD"], ["checks", "has space"]] as const) {
    const r = checkConfigV1({ format_version: 1, [key]: { env: ["OK", bad] } });
    assert.equal(r.ok, false, `${key}.env ${bad}`);
    assert.match(r.ok ? "" : r.message, new RegExp(`${key}\\.env.*${bad.replace("*", "\\*")}`));
  }
  assert.equal(checkConfigV1({ format_version: 1, checks: { env: "DATABASE_URL" } }).ok, false);
});
