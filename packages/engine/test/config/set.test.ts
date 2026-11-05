// M5 plan item 24 (C183, C184, C187): `--set key=value` by dot path, YAML scalar and flow values, repeated; a wrong
// type names the key; the layers default → policy → project → flag → --set with each source; a locked key refused
// by every layer above it; the one writer of rafi-config.yaml keeps comments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realFs } from "../../src/deps/real/fs.js";
import { layered } from "../../src/config/load.js";
import { parseSets, editConfig } from "../../src/config/set.js";
import { tempDir } from "../helpers.js";

const fs = realFs({ id: () => "x", jitter: () => 0 });
const config = (extra: Record<string, unknown> = {}) => ({ format_version: 1 as const, ...extra });

test("--set parses dot paths with YAML scalar and flow values; an unknown key or a section is named", () => {
  const ok = parseSets(["retries.fixes=5", "checks.env=[A, B]", "agent_defaults.roles.qa.model=m-qa",
    "harness.qa=false"]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.sets, [{ path: "retries.fixes", value: 5 }, { path: "checks.env", value: ["A", "B"] },
    { path: "agent_defaults.roles.qa.model", value: "m-qa" }, { path: "harness.qa", value: false }]);
  for (const [entry, message] of [["nosuch.key=1", /--set nosuch\.key: unknown key/], ["retries=1",
    /--set retries: .*a section/], ["retries.fixes", /key=value/], ["=1", /key=value/]] as const) {
    const r = parseSets([entry]);
    assert.equal(r.ok, false, entry);
    assert.match(r.ok ? "" : r.message, message, entry);
  }
});

test("layers: default, project, flag, --set, each with its source; a wrong --set type names the key", () => {
  const sets = parseSets(["retries.fixes=5", "agent_defaults.roles.qa.model=m-qa"]);
  assert.ok(sets.ok);
  const r = layered(config({ retries: { turn: 4 }, agent_defaults: { roles: { builder: { model: "b" } } },
    tickets: { build: { completion: "pr" } } }), { completion: "none" }, { sets: sets.ok ? sets.sets : [] });
  assert.ok(r.ok, r.ok ? "" : r.message);
  const s = r.ok ? r.settings : {};
  assert.deepEqual(s["retries.turn"], { value: 4, source: "project" });
  assert.deepEqual(s["retries.fixes"], { value: 5, source: "flag" });
  assert.deepEqual(s["retries.circling_repeats"], { value: 2, source: "default" });
  assert.deepEqual(s["tickets.build.completion"], { value: "none", source: "flag" });
  assert.deepEqual(s["agent_defaults.roles.qa.model"], { value: "m-qa", source: "flag" });
  assert.deepEqual((s["agent_defaults.roles"]?.value as Record<string, unknown>).builder, { model: "b" });
  const bad = parseSets(["retries.fixes=lots"]);
  const r2 = layered(config(), {}, { sets: bad.ok ? bad.sets : [] });
  assert.equal(r2.ok, false);
  assert.match(r2.ok ? "" : r2.message, /--set retries\.fixes/);
});

test("a locked key wins with source policy; a flag or --set naming it exits 1; a project value is overridden "
  + "with one line (C184)", () => {
  const locked = { "tickets.build.completion": "none", "agent_defaults.roles.qa.model": "org-qa" };
  const ok = layered(config({ tickets: { build: { completion: "pr" } } }), {}, { locked });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.settings["tickets.build.completion"], { value: "none", source: "policy" });
  assert.deepEqual(ok.ok && ok.settings["agent_defaults.roles.qa.model"], { value: "org-qa", source: "policy" });
  assert.deepEqual(ok.ok && ok.lines, ["rafi-config.yaml sets tickets.build.completion to pr; your organization's " +
    "policy locks it to none (~/.rafi/policy.yaml)."]);
  const flag = layered(config(), { completion: "pr" }, { locked });
  assert.match(flag.ok ? "" : flag.message, /^tickets\.build\.completion is locked by your organization's policy/);
  for (const entry of ["tickets.build.completion=pr", "agent_defaults.roles.qa.model=x", "agent_defaults.roles={}"]) {
    const sets = parseSets([entry]);
    const r = layered(config(), {}, { locked, sets: sets.ok ? sets.sets : [] });
    assert.equal(r.ok, false, entry);
    assert.match(r.ok ? "" : r.message, /is locked by your organization's policy \(~\/\.rafi\/policy\.yaml\)/, entry);
  }
});

test("editConfig: the one writer keeps comments and other keys, and refuses an edit that wouldn't validate", async () => {
  const dir = tempDir();
  const file = path.join(dir, "rafi-config.yaml");
  writeFileSync(file, "# my project\nformat_version: 1\nretries:\n  fixes: 2 # keep two\n");
  const r = await editConfig({ fs, machine: { stateDir: dir } }, dir, [{ path: "agent_defaults.roles.qa.model", value: "m" },
    { path: "agent_defaults.revision", value: 1 }]);
  assert.ok(r.ok, r.ok ? "" : r.message);
  const text = readFileSync(file, "utf8");
  assert.match(text, /^# my project/);
  assert.match(text, /fixes: 2 # keep two/);
  assert.match(text, /qa:\n\s+model: m/);
  const bad = await editConfig({ fs, machine: { stateDir: dir } }, dir, [{ path: "retries.fixes", value: "x" }]);
  assert.equal(bad.ok, false);
  assert.equal(readFileSync(file, "utf8"), text, "unchanged");
});
