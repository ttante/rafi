import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertStructuredCommunicationInventory, collectStructuredCommunicationCallsites } from "./structured-communication-inventory.mts";

test("compiler inventory retains the known structured authority boundaries", () => {
  const callsites = collectStructuredCommunicationCallsites();
  assert.ok(callsites.some(site => site.kind === "structured-dispatch" && site.file === "packages/ai-foreman/src/adapters/claude.ts"));
  assert.ok(callsites.some(site => site.kind === "candidate-validation" && site.file === "packages/ai-foreman/src/structuredOperation.ts"));
  assert.ok(callsites.some(site => site.kind === "response-consumer" && site.file === "packages/rafi/src/ticketPlan.ts"));
  assert.ok(callsites.every(site => site.line > 0 && site.column > 0));
  assert.ok(callsites.some(site => site.file === "packages/ai-foreman/test/providerSmoke.test.ts" && site.kind === "live-supervision"), "package-declared live tests cannot bypass the inventory");
  assertStructuredCommunicationInventory(callsites);
});

test("inventory fails closed for unresolved or dynamic authority paths", () => {
  assert.throws(() => assertStructuredCommunicationInventory([{ kind: "structured-dispatch", callee: "sendTurn", file: "fixture.ts", line: 1, column: 1, resolution: "unresolved" }]));
  assert.throws(() => assertStructuredCommunicationInventory([{ kind: "dynamic-authority-call", callee: "[dynamic]", file: "fixture.ts", line: 1, column: 1, resolution: "dynamic" }]));
});


test("compiler follows renamed, literal, destructured, bound and transitive wrapper calls", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-inventory-aliases-"));
  try {
    writeFileSync(join(root, "boundary.ts"), `
      export function sendTurn(value: string) { return value; }
      export const adapter = { sendTurn };
    `);
    writeFileSync(join(root, "consumer.ts"), `
      import { sendTurn as renamed, adapter } from "./boundary.js";
      const alias = renamed;
      const { sendTurn: destructured } = adapter;
      const bound = adapter.sendTurn.bind(adapter);
      function first(value: string) { return alias(value); }
      function second(value: string) { return first(value); }
      renamed("import"); alias("alias"); destructured("destructured");
      adapter["sendTurn"]("literal"); bound("bound"); second("transitive");
    `);
    const sites = collectStructuredCommunicationCallsites([root]).filter(site => site.file.endsWith("consumer.ts"));
    assert.equal(sites.filter(site => site.kind === "structured-dispatch").length, 6);
    assert.ok(sites.some(site => site.callee === "second" && site.reaches?.includes("structured-dispatch")));
    assertStructuredCommunicationInventory(sites);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compiler rejects computed dispatch, missing declarations, and tuple writes", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-inventory-negative-"));
  try {
    writeFileSync(join(root, "unsafe.ts"), `
      declare const adapter: { sendTurn(): void };
      declare const key: "sendTurn";
      adapter[key]();
      sendTurn();
      declare const tuple: { descriptorDigest: string; instructionDigest: string; dispatchId: string };
      tuple.dispatchId = "changed";
    `);
    const sites = collectStructuredCommunicationCallsites([root]);
    assert.ok(sites.some(site => site.resolution === "dynamic"));
    assert.ok(sites.some(site => site.resolution === "unresolved"));
    assert.ok(sites.some(site => site.kind === "tuple-mutation"));
    for (const site of sites) assert.throws(() => assertStructuredCommunicationInventory([site]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("parser authority cannot return through a new production caller", () => {
  const site = { kind: "legacy-parser", callee: "parseQaResponseContract", file: "packages/ai-foreman/src/newWorkflow.ts", line: 1, column: 1, resolution: "resolved" as const };
  assert.throws(() => assertStructuredCommunicationInventory([site]), /newWorkflow/);
  assert.doesNotThrow(() => assertStructuredCommunicationInventory([{ ...site, file: "packages/spec/src/legacyQaDisplay.ts" }]));
});


test("compiler rejects reflective and deleted tuple identity writes, including builtin aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-inventory-reflection-"));
  try {
    writeFileSync(join(root, "unsafe.ts"), `
      declare const tuple: { descriptorDigest: string; instructionDigest: string; dispatchId: string };
      Object.assign(tuple, { dispatchId: "foreign" });
      const overwrite = Object.assign;
      overwrite(tuple, { dispatchId: "foreign" });
      Object.defineProperty(tuple, "dispatchId", { value: "foreign" });
      Object.defineProperties(tuple, { dispatchId: { value: "foreign" } });
      Reflect.set(tuple, "dispatchId", "foreign");
      Reflect.deleteProperty(tuple, "dispatchId");
      Object.assign.call(Object, tuple, { dispatchId: "foreign" });
      Object.assign.apply(Object, [tuple, { dispatchId: "foreign" }]);
      const later = Object.assign.bind(Object, tuple);
      delete tuple.dispatchId;
    `);
    const sites = collectStructuredCommunicationCallsites([root]).filter(site => site.kind === "tuple-mutation");
    assert.equal(sites.length, 10);
    for (const site of sites) assert.throws(() => assertStructuredCommunicationInventory([site]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
