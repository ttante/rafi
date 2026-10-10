import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";

import { AuthorizedForeman as Foreman } from "./helpers/workAdmission.js";
import { Log } from "../src/log.js";
import { cmdBlock, cmdInit, cmdUpdate } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";
import type { QaSessionHandle } from "../src/qaReview.js";
import { qaDigest } from "../src/qaProtocolV2.js";
import { WorkflowReader } from "../src/workflowReader.js";
import { createBuildRun, releaseBuildLease } from "../src/buildRuns.js";
import { readQaEvidenceSnapshot } from "../src/qaEvidenceReader.js";
import { BUILDER_QA_REMEDIATION_END, BUILDER_QA_REMEDIATION_START, type ProviderSessionRefV1 } from "rafi-spec";

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-runner-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "qa@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "QA Test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "base"], { cwd: dir });
  return dir;
}

const qaPass = 'checked\nSTEP_STATUS: qa_pass | summary="tests passed"';
const qaFail = `RAFI_QA_FAILURE_REPORT_START\n${JSON.stringify({ version: 1, summary: "missing test", checks_run: [{ check: "unit test", outcome: "failed", evidence: "not found" }], findings: [{ id: "QA-1", requirement: "Unit test", locations: ["repository-wide"], problem: "missing test", evidence: "no matching test", expected: "test exists", fix_direction: "add the test", verification: ["run the test"] }], observations: [] })}\nRAFI_QA_FAILURE_REPORT_END\nSTEP_STATUS: qa_fail | issues="missing test"`;

function makeDef(id: string): TicketDef {
  return {
    id,
    order: 1000,
    title: `Ticket ${id}`,
    area: "Platform",
    priority: "P1",
    size: "S",
    risk: "Low",
    depends_on: [],
    summary: `Summary for ${id}`,
    acceptance: ["It works"],
    required_tests: ["Unit test"],
    likely_files: ["src/*"],
    rollback: null,
    notes: null,
  };
}

for (const qaEnabled of [false, true]) {
  for (const kind of ["done", "plan_complete", "blocked", "needs_input"] as const) {
    for (const returned of ["T001", "UNKNOWN", undefined]) {
      test(`assignment rejects ${kind}/${returned ?? "missing"} with QA ${qaEnabled}`, async () => {
        const dir = makeTmpDir();
        try {
          cmdInit(dir, { appName: "Test", timezone: "UTC" });
          writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001"), { ...makeDef("T002"), order: 2000 }] }));
          let qaCalls = 0;
          const run = createBuildRun({ tickets: ["T002"], repositoryRoot: dir, qaEnabled });
          const response = `STEP_STATUS: ${kind} | ${returned ? `ticket="${returned}" ` : ""}summary="returned" reason="blocked" question="choose" choices="A|B"`;
          const builder = new FakeBuilder([response], () => writeFileSync(join(dir, "unexpected.txt"), "preserve these edits"));
          const parameters: ConstructorParameters<typeof Foreman> = [builder, new Log(join(dir, ".foreman/test.jsonl")), false, qaEnabled, 3, dir, undefined, async (cwd) => { qaCalls++; return qaHandle(new FakeBuilder([qaPass]), cwd); }];
          parameters[22] = run.runId;
          const foreman = new Foreman(...parameters);
          const result = await foreman.runBatch(1, undefined, undefined, "T002");
          assert.equal(result.outcome, "needs-human", result.detail);
          assert.equal(result.completed, 0);
          assert.equal(qaCalls, 0);
          assert.equal(builder.instructions.length, 1);
          const tracker = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
          try { assert.equal(tracker.getState("T001"), undefined); assert.equal(tracker.getState("T002")?.status, "in_progress"); } finally { tracker.close(); }
          const reader = new WorkflowReader(dir);
          try {
            assert.ok(reader.events(run.runId).some(event => event.type === "build_assignment_rejected"), "identity rejection must retain a durable scoped response");
            const operation = reader.operations(run.runId).find(operation => operation.kind === "build-assignment")!;
            const evidence = readQaEvidenceSnapshot(dir, run.runId);
            assert.equal(evidence.blobs.get((operation.result as { responseDigest: string }).responseDigest)?.toString(), response);
          } finally { reader.close(); }
          assert.equal(readFileSync(join(dir, "unexpected.txt"), "utf8"), "preserve these edits");
          const resumed = await foreman.runBatch(1, undefined, undefined, "T002");
          assert.equal(resumed.outcome, "needs-human"); assert.equal(builder.instructions.length, 1);
          const directQa = await foreman.runPendingQaRecovery("T002", "Inspect rejected work");
          assert.equal(directQa.outcome, "needs-human"); assert.match(directQa.detail ?? "", /requires assignment reconciliation/);
          assert.equal(qaCalls, 0, "direct QA recovery must not bypass assignment conflict");
          releaseBuildLease(dir, run, "recoverable");
        } finally { rmSync(dir, { recursive: true }); }
      });
    }
  }
}

test("an empty automatic ticket queue does not dispatch generic work", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [] }));
    const builder = new FakeBuilder(['STEP_STATUS: done | summary="generic work"']);
    const result = await new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 1, dir).runBatch(1);
    assert.equal(builder.instructions.length, 0);
    assert.equal(result.completed, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test("an unavailable explicit ticket never substitutes an independent ticket", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));
    const builder = new FakeBuilder(['STEP_STATUS: done | ticket="T001"']);
    const result = await new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 1, dir).runBatch(1, undefined, undefined, "REMOVED");
    assert.equal(result.outcome, "needs-human");
    assert.equal(builder.instructions.length, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test("removed definitions during approval dispatch no substitute or synthetic work", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));
    const builder = new FakeBuilder(['STEP_STATUS: done | ticket="T001"']);
    const result = await new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 1, dir).runBatch(1, undefined, () => {
      writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [] }));
    }, "T001");
    assert.equal(result.outcome, "needs-human"); assert.equal(builder.instructions.length, 0);
  } finally { rmSync(dir, { recursive: true }); }
});

test("uncertain Builder exception preserves work and prevents blind redispatch", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));
    const builder = new FakeBuilder([], () => { writeFileSync(join(dir, "partial.txt"), "uncertain work"); throw new Error("transport disconnected"); });
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 1, dir);
    await assert.rejects(foreman.runBatch(1), /transport disconnected/);
    const resumed = await foreman.runBatch(1);
    assert.equal(resumed.outcome, "needs-human"); assert.equal(builder.instructions.length, 1);
    assert.equal(readFileSync(join(dir, "partial.txt"), "utf8"), "uncertain work");
  } finally { rmSync(dir, { recursive: true }); }
});

test("an unscoped plain question persists an identity stop before any decision or follow-up turn", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));
    const builder = new FakeBuilder(['Would you like me to change the requirements?']);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 1, dir);
    assert.equal((await foreman.runBatch(1)).outcome, "needs-human");
    assert.equal((await foreman.runBatch(1)).outcome, "needs-human");
    assert.equal(builder.instructions.length, 1);
    const reader = new WorkflowReader(dir);
    try { assert.ok(reader.buildRuns().some(run => reader.events(run.runId).some(event => event.type === "build_assignment_rejected"))); assert.ok(reader.buildRuns().every(run => !reader.pendingHumanDecisions(run.runId).length)); }
    finally { reader.close(); }
  } finally { rmSync(dir, { recursive: true }); }
});

class FakeBuilder implements BuilderAdapter {
  readonly agent = "claude" as const;
  readonly instructions: string[] = [];
  private index = 0;
  private eventQueue: BuilderEvent[] = [];
  private observers = new Set<(event: BuilderEvent) => void>();
  observeEvents(listener: (event: BuilderEvent) => void): () => void { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
  private eventWaiters: Array<() => void> = [];
  private closed = false;
  private ref?: ProviderSessionRefV1;

  constructor(
    private readonly turns: Array<string | ((instruction:string)=>string)>,
    private readonly beforeTurn?: (index: number) => void,
  ) {}

  async sendTurn(instruction: string): Promise<TurnResult> {
    this.instructions.push(instruction);
    this.beforeTurn?.(this.index);
    const response = this.turns[this.index++] ?? "";
    let text = typeof response === "function" ? response(instruction) : response;
    if (instruction.includes(BUILDER_QA_REMEDIATION_START) && !text.includes(BUILDER_QA_REMEDIATION_START)) {
      const handoffId = /QA failure handoff ID: ([a-f0-9]{64})/.exec(instruction)?.[1] ?? "missing";
      const findingKey = /QA-1 -> ([a-f0-9]{64})/.exec(instruction)?.[1] ?? "missing";
      text = [
        BUILDER_QA_REMEDIATION_START,
        JSON.stringify({
          version: 2,
          handoff_id: handoffId,
          summary: "Applied QA remediation.",
          findings: [{
            finding_key: findingKey,
            raw_id: "QA-1",
            disposition: "fixed",
            changes: ["Addressed the QA finding."],
            evidence: "fake builder fixture",
            verification: [{ check: "fixture", outcome: "passed", evidence: "fake builder fixture" }],
          }],
          observations: [],
        }),
        BUILDER_QA_REMEDIATION_END,
        'STEP_STATUS: done | summary="fixed"',
      ].join("\n");
    }
    const result = { text, isError: false, numTurns: 1, costUsd: 0, turnId: `fake-${this.index}`, hostInstruction: instruction, providerInstruction: instruction, rawResponse: text, cleanedResponse: text,
      providerMetadata: { provider: this.agent, sessionId: this.sessionId(), sessionRef: this.ref } };
    for (const observer of this.observers) observer({ kind: "turn-complete", result, turnId: result.turnId });
    this.eventQueue.push({ kind: "turn-complete", result, turnId: result.turnId }); this.eventWaiters.splice(0).forEach((wake) => wake());
    return result;
  }

  sessionId(): string | undefined {
    return "fake-session";
  }
  sessionRef(): ProviderSessionRefV1 | undefined { return this.ref; }
  adoptSessionRef(ref: ProviderSessionRefV1): void { this.ref = ref; }

  async *events(): AsyncIterable<BuilderEvent> { while (!this.closed || this.eventQueue.length) { if (!this.eventQueue.length) await new Promise<void>((resolve) => this.eventWaiters.push(resolve)); const event = this.eventQueue.shift(); if (event) yield event; } }

  async close(): Promise<void> { this.closed = true; this.eventWaiters.splice(0).forEach((wake) => wake()); }
}

function qaHandle(adapter: FakeBuilder, cwd: string): QaSessionHandle {
  const fields = { version: 2 as const, sourceMode: "read-only" as const, scratchMode: "isolated" as const, settingsSources: "none" as const, networkMode: "disabled" as const, environmentDigest: "1".repeat(64), policyDigest: "2".repeat(64) };
  const ref: ProviderSessionRefV1 = { version: 1, provider: adapter.agent, sessionId: adapter.sessionId()!, role: "qa", stream: "qa", generation: 0, cwd, configRoot: cwd, source: "observed", createdAt: new Date(0).toISOString(), validatedAt: new Date(0).toISOString() };
  adapter.adoptSessionRef(ref);
  return { adapter, sessionIdentity: () => ref, effectiveRoleInstructions: "test QA", runtimeContext: { test: true }, skills: [], confinement: { ...fields, digest: qaDigest("qa-confinement", fields) }, handoffReceipt: { kind: "initial" } };
}

function attachBuilderRef(adapter: FakeBuilder, cwd: string, ticketId?: string): FakeBuilder {
  adapter.adoptSessionRef({
    version: 1,
    provider: adapter.agent,
    sessionId: adapter.sessionId()!,
    role: "builder",
    stream: "builder",
    generation: 0,
    cwd,
    configRoot: cwd,
    ...(ticketId ? { ticketId } : {}),
    source: "observed",
    createdAt: new Date(0).toISOString(),
    validatedAt: new Date(0).toISOString(),
  });
  return adapter;
}

test("reported blockers are converted into multiple approaches before a non-interactive safe pause", async () => {
  const dir = makeTmpDir();
  try {
    const builder = new FakeBuilder([
      'STEP_STATUS: needs_input | question="How should Rafi unblock this work?" choices="Safe retry (Recommended)|Use fallback|Wait for access"',
    ]);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 1, dir);

    const resolved = await foreman.resolveBlocker(builder, "missing deployment credential");

    assert.equal(resolved.status.kind, "blocked");
    assert.match(resolved.status.reason ?? "", /waiting for input/);
    assert.ok((resolved.status.reason ?? "").includes(`Resume with rafi resume ${dir}`));
    assert.match(builder.instructions[0] ?? "", /two or three safe, materially different approaches/);
    assert.match(builder.instructions[0] ?? "", /recommended approach and consequence \(Recommended\)/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("runBatch completes ticket only after QA passes", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));

    const builder = new FakeBuilder(['implemented\nSTEP_STATUS: done | ticket="T001" summary="implemented"']);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 3, dir, undefined, async (cwd) => qaHandle(new FakeBuilder([qaPass]), cwd));
    const startedTickets: string[] = [];

    const result = await foreman.runBatch(1, undefined, (ticketId) => {
      startedTickets.push(ticketId);
    });
    assert.equal(result.outcome, "all-done");
    assert.equal(result.completed, 1);
    assert.deepEqual(startedTickets, ["T001"]);

    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      const state = db.getState("T001");
      assert.equal(state?.status, "done");
      assert.equal(state?.validation_result, "passed");
      assert.equal(state?.evidence, "tests passed");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("runBatch does not complete ticket when QA fails to converge", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));

    const builder = attachBuilderRef(new FakeBuilder([
      'implemented\nSTEP_STATUS: done | ticket="T001" summary="implemented"',
      'fixed\nSTEP_STATUS: done | ticket="T001" summary="fixed"',
    ]), dir, "T001");
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 1, dir, undefined, async (cwd) => qaHandle(new FakeBuilder([qaFail]), cwd));

    const result = await foreman.runBatch(1);
    assert.equal(result.outcome, "blocked", result.detail);
    assert.equal(result.completed, 0);
    assert.match(result.detail ?? "", /Deferred tickets: T001/);
    assert.match(result.detail ?? "", /invalid QA response contract|complete fresh QA review|required/);

    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      const state = db.getState("T001");
      assert.equal(state?.status, "blocked");
      assert.equal(state?.validation_result, null);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("runBatch pins recovery to the requested in-progress ticket", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [
      { ...makeDef("T001"), order: 1000 },
      { ...makeDef("T002"), order: 2000 },
    ] }));
    cmdUpdate(dir, "T001", { status: "next", actor: "test" });
    cmdUpdate(dir, "T002", { status: "in_progress", actor: "test" });

    const builder = new FakeBuilder(['continued T002\nSTEP_STATUS: done | ticket="T002" summary="finished recovery"']);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 3, dir, undefined, async (cwd) => qaHandle(new FakeBuilder([qaPass]), cwd));

    const result = await foreman.runBatch(1, undefined, undefined, "T002");

    assert.equal(result.outcome, "all-done");
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      assert.equal(db.getState("T001")?.status, "next");
      assert.equal(db.getState("T002")?.status, "done");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("explicit recovery reopens a safely paused blocked ticket", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));
    cmdBlock(dir, "T001", { summary: "user chose safe pause", actor: "test" });
    const builder = new FakeBuilder(['resumed\nSTEP_STATUS: done | ticket="T001" summary="finished after guidance"']);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 3, dir, undefined, async (cwd) => qaHandle(new FakeBuilder([qaPass]), cwd));

    const result = await foreman.runBatch(1, undefined, undefined, "T001");

    assert.equal(result.outcome, "all-done");
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { assert.equal(db.getState("T001")?.status, "done"); }
    finally { db.close(); }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

for (const blocked of [false, true]) test(`scoped recovery ${blocked ? "stops at blocked work" : "continues eligible work"} without selecting unrelated or generic work`, async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: ["OTHER", "T001", "T002"].map((id, index) => ({ ...makeDef(id), order: index })) }));
    cmdUpdate(dir, "OTHER", { status: "next", actor: "test" });
    cmdUpdate(dir, "T001", { status: "in_progress", actor: "test" });
    if (blocked) cmdBlock(dir, "T002", { summary: "independent unresolved blocker", actor: "test" });
    else cmdUpdate(dir, "T002", { status: "next", actor: "test" });
    const builder = new FakeBuilder(['STEP_STATUS: done | ticket="T001"', 'STEP_STATUS: done | ticket="T002"']);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 3, dir);
    const result = await foreman.runBatch(10, undefined, undefined, "T001", ["T001", "T002"]);
    assert.equal(result.completed, blocked ? 1 : 2);
    assert.equal(builder.instructions.length, blocked ? 1 : 2);
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      assert.equal(db.getState("OTHER")?.status, "next");
      assert.equal(db.getState("T001")?.status, "done");
      assert.equal(db.getState("T002")?.status, blocked ? "blocked" : "done");
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scoped recovery cannot complete a different ticket named by the provider", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001"), makeDef("OTHER")] }));
    cmdUpdate(dir, "T001", { status: "in_progress", actor: "test" });
    cmdUpdate(dir, "OTHER", { status: "next", actor: "test" });
    const builder = new FakeBuilder(['STEP_STATUS: done | ticket="OTHER"']);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 3, dir);
    const result = await foreman.runBatch(1, undefined, undefined, "T001", ["T001"]);
    assert.equal(result.outcome, "needs-human"); assert.equal(result.completed, 0);
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { assert.equal(db.getState("OTHER")?.status, "next"); assert.equal(db.getState("T001")?.status, "in_progress"); }
    finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("independent QA may write Foreman's own .foreman runtime files", async () => {
  const dir = makeTmpDir();
  try {
    const builder = new FakeBuilder([
      (instruction:string) => `implemented\nSTEP_STATUS: done | ticket="${/Ticket scope: ([^ ]+)\./.exec(instruction)?.[1]}" summary="implemented"`,
    ]);
    const foreman = new Foreman(
      builder,
      new Log(join(dir, ".foreman/test.jsonl")),
      false,
      true,
      3,
      dir,
      undefined,
      async (cwd) => qaHandle(new FakeBuilder([qaPass], () => {
        mkdirSync(join(cwd, ".foreman"), { recursive: true });
        writeFileSync(join(cwd, ".foreman/qa-runtime.jsonl"), "runtime output\n", "utf8");
        mkdirSync(join(cwd, ".rafi/cache"), { recursive: true });
        writeFileSync(join(cwd, ".rafi/cache/qa-runtime.json"), "{}\n", "utf8");
      }), cwd),
    );

    const result = await foreman.runBatch(1);

    assert.equal(result.outcome, "all-done", result.detail);
    assert.equal(result.completed, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("independent QA source changes still require human review", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "source.ts"), "before\n", "utf8");
    const builder = new FakeBuilder([
      (instruction:string) => `implemented\nSTEP_STATUS: done | ticket="${/Ticket scope: ([^ ]+)\./.exec(instruction)?.[1]}" summary="implemented"`,
    ]);
    const foreman = new Foreman(
      builder,
      new Log(join(dir, ".foreman/test.jsonl")),
      false,
      true,
      3,
      dir,
      undefined,
      async (cwd) => qaHandle(new FakeBuilder([qaPass], () => writeFileSync(join(cwd, "source.ts"), "after\n", "utf8")), cwd),
    );

    const result = await foreman.runBatch(1);

    assert.equal(result.outcome, "needs-human");
    assert.match(result.detail ?? "", /QA modified files twice|source\.ts/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("preflight rejects an adapter error instead of treating it as a plan", async () => {
  const dir = makeTmpDir();
  try {
    const builder = new FakeBuilder(["API Error"]);
    builder.sendTurn = async () => ({
      text: "Claude failed during builder (authentication).\nExecutable: /opt/company/bin/claude",
      isError: true,
      numTurns: 1,
      costUsd: 0,
    });
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 1, dir);

    await assert.rejects(
      foreman.runPreflight(3),
      /Claude failed during builder \(authentication\).*\/opt\/company\/bin\/claude/s,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("every follow-up Builder dispatch re-enters the safe boundary", async () => {
  const dir = makeTmpDir();
  try {
    const builder = new FakeBuilder(["missing final marker", "STEP_STATUS: done | summary=\"corrected\""]);
    const boundaries: string[] = [];
    const foreman = new Foreman(
      builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 1, dir,
      undefined, undefined, undefined, undefined, undefined, undefined,
      async (adapter, frozenAction) => { boundaries.push(frozenAction); return adapter; },
    );
    const result = await foreman.runInstruction("perform one action");
    assert.equal(result.status.kind, "done");
    assert.equal(boundaries.length, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

for (const mode of ["pending", "answered", "stale", "outside", "run-wide"] as const) test(`recovery decision eligibility: ${mode}`, async () => {
  const { WorkflowDb } = await import("../src/workflowDb.js");
  const { buildScopeRevision } = await import("../src/buildApproval.js");
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001"), { ...makeDef("T002"), order: 2000 }] }));
    cmdUpdate(dir, "T001", { status: "blocked", actor: "test" });
    cmdUpdate(dir, "T002", { status: "next", actor: "test" });
    const db = new WorkflowDb(dir);
    const decision = db.ensureHumanDecision({ decisionKey: `ticket-question:${buildScopeRevision(dir)}:1`, runId: "questions", interruptionId: mode === "run-wide" ? "build-plan" : "ticket:T001", prompt: "Which approach?", choices: [{ id: "a", label: "A" }] });
    if (["answered", "stale", "outside"].includes(mode)) db.answerHumanDecision("questions", decision.decisionId, "a");
    if (mode === "stale") writeFileSync(join(dir, "rafi-config.yaml"), "changed: true\n");
    const selected = mode === "answered" ? "T001" : "T002";
    const builder = new FakeBuilder([`STEP_STATUS: done | ticket="${selected}"`]);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 3, dir, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "questions", true);
    const result = await foreman.runBatch(1, undefined, undefined, mode === "outside" ? "T002" : "T001", mode === "outside" ? ["T002"] : ["T001", "T002"]);
    assert.equal(result.completed, mode === "run-wide" ? 0 : 1, result.detail);
    const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      assert.equal(state.getState("T001")?.status, mode === "answered" ? "done" : "blocked");
      assert.equal(state.getState("T002")?.status, ["answered", "run-wide"].includes(mode) ? "next" : "done");
    } finally { state.close(); }
    assert.equal(Boolean(db.operation(`decision-continuation:${decision.decisionId}`)), mode === "answered");
    if (mode === "pending" || mode === "run-wide") assert.equal(db.pendingHumanDecisions("questions").length, 1);
    if (mode !== "run-wide") assert.match(builder.instructions[0]!, new RegExp(`Assigned ticket: ${selected}`));
    if (mode === "stale") {
      const replacement = db.pendingHumanDecisions("questions")[0]!;
      assert.ok(replacement); assert.notEqual(replacement.decisionId, decision.decisionId);
      db.answerHumanDecision("questions", replacement.decisionId, "a");
      builder.sendTurn = async instruction => ({ text: 'STEP_STATUS: done | ticket="T001"', isError: false, numTurns: 1, costUsd: 0 });
      const resumed = await foreman.runBatch(1, undefined, undefined, "T001", ["T001"]);
      assert.equal(resumed.completed, 1, resumed.detail);
      assert.equal(db.pendingHumanDecisions("questions").length, 0);
    }
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit recovery cannot substitute an independent ticket after a blocker", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001"), makeDef("T002")] }));
    cmdUpdate(dir, "T001", { status: "in_progress", actor: "test" });
    cmdUpdate(dir, "T002", { status: "next", actor: "test" });
    const builder = new FakeBuilder(['STEP_STATUS: blocked | ticket="T001" reason="Rafi is waiting for input"']);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 3, dir);
    const result = await foreman.runBatch(1, undefined, undefined, "T001", ["T001"]);
    assert.equal(result.completed, 0); assert.equal(builder.instructions.length, 1);
    const state = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { assert.equal(state.getState("T002")?.status, "next"); } finally { state.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scoped completion without ticket identity cannot pass QA or update tracker", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));
    cmdUpdate(dir, "T001", { status: "in_progress", actor: "test" });
    const builder = new FakeBuilder(['STEP_STATUS: done | summary="ambiguous"']);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 3, dir, undefined, async () => { throw new Error("QA must not run"); });
    const result = await foreman.runBatch(1, undefined, undefined, "T001", ["T001"]);
    assert.equal(result.completed, 0); assert.match(result.detail ?? "", /no ticket/);
    assert.equal(builder.instructions.length, 1, "do not repeat implementation to recover marker identity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("approval covers later work, revalidates edits between turns and binds every prompt", async () => {
  const { createBuildApprovalGate } = await import("../src/buildApproval.js");
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    const tickets = [makeDef("T001"), { ...makeDef("T002"), order: 2000 }];
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets }));
    for (const ticket of tickets) cmdUpdate(dir, ticket.id, { status: "next", actor: "test" });
    let approvals = 0;
    const gate = createBuildApprovalGate(dir, ["T001", "T002"], false, undefined, async () => { approvals++; });
    const builder = new FakeBuilder(['STEP_STATUS: done | ticket="T001"', 'STEP_STATUS: done | ticket="T002"'], index => {
      if (index === 0) writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [tickets[0], { ...tickets[1], acceptance: ["new requirement"] }] }));
      if (index === 1) assert.equal(approvals, 2, "must approve changed T002 before dispatch");
    });
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 3, dir);
    const result = await foreman.runBatch(2, undefined, gate, "T001", ["T001", "T002"]);
    assert.equal(result.completed, 2, result.detail);
    assert.match(builder.instructions[0]!, /Assigned ticket: T001/);
    assert.match(builder.instructions[1]!, /Assigned ticket: T002/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit recovery never reopens a ticket whose dependency remains unfinished", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001"), { ...makeDef("T002"), depends_on: ["T001"] }] }));
    cmdUpdate(dir, "T001", { status: "next", actor: "test" });
    cmdUpdate(dir, "T002", { status: "blocked", actor: "test" });
    const builder = new FakeBuilder([]);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 3, dir);
    const result = await foreman.runBatch(1, undefined, undefined, "T002", ["T002"]);
    assert.equal(result.completed, 0); assert.equal(result.outcome, "blocked"); assert.equal(builder.instructions.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("response-only protocol correction retains the assigned ticket across safe boundaries", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));
    cmdUpdate(dir, "T001", { status: "next", actor: "test" });
    const builder = new FakeBuilder(['work finished without marker', 'STEP_STATUS: done | ticket="T001"']);
    const boundaries: string[] = [];
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, false, 3, dir, undefined, undefined, undefined, undefined, undefined, undefined,
      async (adapter, action) => { boundaries.push(action); return adapter; });
    const result = await foreman.runBatch(1, undefined, undefined, "T001", ["T001"]);
    assert.equal(result.completed, 1, result.detail);
    assert.equal(builder.instructions.length, 2);
    assert.match(builder.instructions[1]!, /Protocol correction only/);
    assert.match(builder.instructions[1]!, /Do not repeat implementation/);
    assert.ok(builder.instructions.every(instruction => instruction.includes('Ticket scope: T001.') && instruction.includes('ticket="T001"')));
    assert.ok(boundaries.every(instruction => instruction.includes('Ticket scope: T001.')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
