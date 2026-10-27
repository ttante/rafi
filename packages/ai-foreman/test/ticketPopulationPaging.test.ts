import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ticketPopulationPageOutput } from "rafi-spec";
import { streamTicketPopulation } from "../src/ticketPopulationPaging.js";
import { journalStructuredDispatch, nativePolicy } from "../src/structuredOperation.js";
import { assertActiveProviderDispatch } from "../src/structuredDispatchAuthority.js";
import { WorkflowDb } from "../src/workflowDb.js";
import type { BuilderAdapter } from "../src/adapters/types.js";
import { canonicalFixtureTurn } from "./helpers/nativeOutput.js";

function fixture(root: string, failSecond = false, correction = 0) {
  let sends = 0, checkpoints = 0;
  const ref = { version: 1 as const, provider: "claude" as const, sessionId: "session", role: "builder" as const,
    stream: "builder", generation: 0, cwd: root, configRoot: root, source: "observed" as const, createdAt: new Date(0).toISOString() };
  const adapter: BuilderAdapter = { agent: "claude", sessionId: () => ref.sessionId, sessionRef: () => ref,
    async prepareSession() { assert.ok(checkpoints > 0); return ref; },
    async sendTurn(instruction, policy) {
      assertActiveProviderDispatch(policy!, instruction, "claude", ref);
      const db = new WorkflowDb(root);
      // A restarted population uses a fresh lineage (":restart-N") for the same correction.
      const base = `ticket-population:interview:artifact:${correction}`;
      try { assert.ok([base, `${base}:restart-1`, `${base}:restart-2`].some(id => db.populationPageLedger(id))); }
      finally { db.close(); }
      sends++;
      if (failSecond && sends === 2) throw new Error("uncertain send");
      // Each lineage is two pages long.
      const page = Number(/Return page (\d+)/.exec(instruction)?.[1] ?? 1);
      return canonicalFixtureTurn(policy, ref.sessionId, { plan_id: "plan", revision: 1, tickets: [], retirements: [], terminal: page === 2 });
    }, async *events() {}, async close() {} };
  return { adapter, sends: () => sends,
    input: { projectDir: root, interviewId: "interview", correction, instruction: "Populate approved plan",
      checkpoint() { checkpoints++; },
      async dispatch(instruction: string, policy: Parameters<BuilderAdapter["sendTurn"]>[1] & { output: typeof ticketPopulationPageOutput }) {
        const result = await journalStructuredDispatch(root, adapter, instruction, nativePolicy(policy.output, policy),
          (text, sealed) => adapter.sendTurn(text, sealed));
        return { result, status: { kind: "done" } };
      } } };
}

test("population seals before page one, appends each native page, and replays terminal without a send", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-stream-pages-"));
  try {
    const f = fixture(root);
    const result = await streamTicketPopulation(f.input);
    assert.equal(result.proposal.plan_id, "plan"); assert.equal(f.sends(), 2);
    const db = new WorkflowDb(root);
    try { assert.equal(db.populationPageLedger("ticket-population:interview:artifact:0")?.pageCount, 2); }
    finally { db.close(); }
    const replay = await streamTicketPopulation(f.input);
    assert.deepEqual(replay.proposal, result.proposal); assert.equal(f.sends(), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unfinished lineage is retired and population restarts from page one", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-uncertain-pages-"));
  try {
    const f = fixture(root, true);
    await assert.rejects(streamTicketPopulation(f.input), /uncertain send/);
    const result = await streamTicketPopulation(f.input);
    assert.equal(result.proposal.plan_id, "plan");
    assert.equal(f.sends(), 4, "two sends in the retired lineage, two in the restarted one");
    const db = new WorkflowDb(root);
    try {
      assert.equal(db.operation("ticket-population:interview:artifact:0")?.status, "failed");
      assert.equal(db.operation("ticket-population:interview:artifact:0:restart-1")?.status, "confirmed");
      assert.equal(db.operations("ticket-population:interview").filter(op => op.kind === "provider-dispatch" && ["in_progress", "uncertain"].includes(op.status)).length, 0);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a generic owner cannot select the subordinate ticket page", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-foreign-pages-"));
  try {
    const f = fixture(root);
    // Prepare only a session; the missing population artifact must still prevent send.
    f.adapter.prepareSession = async () => f.adapter.sessionRef!()!;
    await assert.rejects(journalStructuredDispatch(root, f.adapter, "foreign", nativePolicy(ticketPopulationPageOutput),
      (text, policy) => f.adapter.sendTurn(text, policy)), /active persisted artifact/);
    assert.equal(f.sends(), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("cancellation before page one never sends and a later attempt restarts the population", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-cancel-pages-"));
  try {
    const f = fixture(root);
    await assert.rejects(streamTicketPopulation({ ...f.input, checkpoint() { throw new Error("cancelled before page one"); } }), /cancelled/);
    assert.equal(f.sends(), 0);
    const result = await streamTicketPopulation(f.input);
    assert.equal(result.proposal.plan_id, "plan");
    assert.equal(f.sends(), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal page survives confirmation crash and a correction uses a fresh lineage", async () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-terminal-pages-"));
  const original = WorkflowDb.prototype.updateOperation;
  let crash = true;
  try {
    WorkflowDb.prototype.updateOperation = function (...args: Parameters<typeof original>) {
      if (crash && args[0] === "ticket-population:interview:artifact:0" && args[1] === "confirmed") {
        crash = false; throw new Error("crash after terminal append");
      }
      return original.apply(this, args);
    };
    const f = fixture(root);
    await assert.rejects(streamTicketPopulation(f.input), /crash after terminal/);
    WorkflowDb.prototype.updateOperation = original;
    const recovered = await streamTicketPopulation(f.input);
    assert.equal(f.sends(), 2); assert.equal(recovered.proposal.plan_id, "plan");
    const correction = fixture(root, false, 1);
    await streamTicketPopulation(correction.input);
    assert.equal(correction.sends(), 2);
    const db = new WorkflowDb(root);
    try {
      const first = db.populationPageLedger("ticket-population:interview:artifact:0")!;
      const next = db.populationPageLedger("ticket-population:interview:artifact:1")!;
      const firstOwner = db.operation("ticket-population:interview:artifact:0")!.intent as { lineageId: string };
      const nextOwner = db.operation("ticket-population:interview:artifact:1")!.intent as { lineageId: string };
      assert.notEqual(firstOwner.lineageId, nextOwner.lineageId);
      assert.equal(first.state, "terminal"); assert.equal(next.state, "terminal");
    } finally { db.close(); }
  } finally { WorkflowDb.prototype.updateOperation = original; rmSync(root, { recursive: true, force: true }); }
});
