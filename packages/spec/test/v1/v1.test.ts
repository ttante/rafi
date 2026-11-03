// rafi-spec/v1 schema tests: the event registry against ARCH 3.4, payload checks, the config subset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkConfigV1, checkEventData, checkReservedTicketFields, CUSTOM_WORKFLOWS_MESSAGE, eventRegistry, eventTypes,
} from "../../src/v1/index.js";

const arch = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../REWRITE_ARCHITECTURE.md"),
  "utf8");

/** Every event type named in the first column of ARCH 3.4's tables, groups A–G. */
function archTypes(): Map<string, string> {
  const section = arch.slice(arch.indexOf("### 3.4 Event types"), arch.indexOf("**H. Capture levels**"));
  const types = new Map<string, string>();
  for (const line of section.split("\n")) {
    const row = /^\| (`[^|]+`) \| (state|detail) \|/.exec(line);
    if (!row) continue;
    for (const name of row[1]!.match(/`([a-z_]+\.[a-z_]+)`/g) ?? []) types.set(name.slice(1, -1), row[2]!);
  }
  return types;
}

test("the registry has exactly ARCH 3.4's event types, each with its class, all at v 1", () => {
  const expected = archTypes();
  assert.ok(expected.size > 90, `${expected.size} types read from ARCH 3.4`);
  assert.deepEqual([...eventTypes()].sort(), [...expected.keys()].sort());
  for (const [type, cls] of expected) {
    assert.equal(eventRegistry.get(type)?.class, cls, type);
    assert.equal(eventRegistry.get(type)?.v, 1, type);
  }
});

test("checkEventData: unknown type, unknown v, bad payload, extra field, 64 KB", () => {
  assert.equal(checkEventData("project.created", 1, { app_name: "a", rafi_version: "1" }).ok, true);
  assert.match(String((checkEventData("made.up", 1, {}) as { reason: string }).reason), /unknown event type/);
  assert.match(String((checkEventData("project.created", 2, {}) as { reason: string }).reason), /unknown version/);
  assert.equal(checkEventData("project.created", 1, { app_name: 1, rafi_version: "1" }).ok, false);
  assert.equal(checkEventData("project.created", 1, { app_name: "a", rafi_version: "1", ticket: "T1" }).ok, false,
    "a reply that adds a field fails the schema");
  assert.match(String((checkEventData("plan.failed", 1, { reason: "x".repeat(66_000) }) as { reason: string }).reason),
    /64 KB/);
  assert.equal(checkEventData("checks.failed", 1, { failing: [], signature: "s", circling: true }).ok, true,
    "checks.failed carries circling (P1)");
  assert.equal(checkEventData("project.archived", 1, {}).ok, true, "project.archived exists (P5)");
});

test("delivery.done carries the validation summary; ticket.done is gone (review finding 3)", () => {
  const validation = { result: "passed", runs: [1, 2], unverified: [] };
  assert.equal(checkEventData("delivery.done", 1, { unit: "U1", validation }).ok, true);
  assert.equal(checkEventData("delivery.done", 1, { unit: null, validation }).ok, true);
  assert.equal(checkEventData("delivery.done", 1, { unit: "U1" }).ok, false, "validation is required");
  assert.equal(checkEventData("delivery.done", 1, { sha: null, branch: null, url: null, unit: null, validation }).ok,
    false, "the git fields belong to the git/pr events");
  assert.match(String((checkEventData("ticket.done", 1, { validation }) as { reason: string }).reason),
    /unknown event type/);
});

test("config subset: the integer marker, and workflows: reserved", () => {
  assert.equal(checkConfigV1({ format_version: 1, anything: { else: true } }).ok, true);
  assert.equal(checkConfigV1({ format_version: "1" }).ok, false);
  assert.equal(checkConfigV1({ format_version: 2 }).ok, false);
  assert.deepEqual(checkConfigV1({ format_version: 1, workflows: {} }), { ok: false, message: CUSTOM_WORKFLOWS_MESSAGE });
  assert.equal(CUSTOM_WORKFLOWS_MESSAGE, "Custom workflows aren't supported yet.");
  assert.deepEqual(checkReservedTicketFields([{ id: "T1" }, { id: "T2", workflow: "x" }]),
    { ok: false, ticket: "T2", message: CUSTOM_WORKFLOWS_MESSAGE });
});
