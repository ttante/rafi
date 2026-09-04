import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";

import { Foreman } from "../src/foreman.js";
import { Log } from "../src/log.js";
import { cmdBlock, cmdInit, cmdUpdate } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

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

class FakeBuilder implements BuilderAdapter {
  readonly agent = "claude" as const;
  readonly instructions: string[] = [];
  private index = 0;

  constructor(
    private readonly turns: string[],
    private readonly beforeTurn?: (index: number) => void,
  ) {}

  async sendTurn(instruction: string): Promise<TurnResult> {
    this.instructions.push(instruction);
    this.beforeTurn?.(this.index);
    const text = this.turns[this.index++] ?? "";
    return { text, isError: false, numTurns: 1, costUsd: 0 };
  }

  sessionId(): string | undefined {
    return "fake-session";
  }

  async *events(): AsyncIterable<BuilderEvent> {}

  async close(): Promise<void> {}
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
    assert.match(resolved.status.reason ?? "", /input required in an interactive terminal/);
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
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 3, dir, undefined, async () => new FakeBuilder([qaPass]));
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

    const builder = new FakeBuilder([
      'implemented\nSTEP_STATUS: done | ticket="T001" summary="implemented"',
      'fixed\nSTEP_STATUS: done | ticket="T001" summary="fixed"',
    ]);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 1, dir, undefined, async () => new FakeBuilder([qaFail]));

    const result = await foreman.runBatch(1);
    assert.equal(result.outcome, "needs-human");
    assert.match(result.detail ?? "", /could not converge/);

    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try {
      const state = db.getState("T001");
      assert.equal(state?.status, "in_progress");
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
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 3, dir, undefined, async () => new FakeBuilder([qaPass]));

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
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 3, dir, undefined, async () => new FakeBuilder([qaPass]));

    const result = await foreman.runBatch(1, undefined, undefined, "T001");

    assert.equal(result.outcome, "all-done");
    const db = new StateDb(join(dir, ".tickets/ticket-state.sqlite"));
    try { assert.equal(db.getState("T001")?.status, "done"); }
    finally { db.close(); }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("independent QA may write Foreman's own .foreman runtime files", async () => {
  const dir = makeTmpDir();
  try {
    const builder = new FakeBuilder([
      'implemented\nSTEP_STATUS: done | summary="implemented"',
    ]);
    const foreman = new Foreman(
      builder,
      new Log(join(dir, ".foreman/test.jsonl")),
      false,
      true,
      3,
      dir,
      undefined,
      async (cwd) => new FakeBuilder([qaPass], () => {
        mkdirSync(join(cwd, ".foreman"), { recursive: true });
        writeFileSync(join(cwd, ".foreman/qa-runtime.jsonl"), "runtime output\n", "utf8");
        mkdirSync(join(cwd, ".rafi/cache"), { recursive: true });
        writeFileSync(join(cwd, ".rafi/cache/qa-runtime.json"), "{}\n", "utf8");
      }),
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
      'implemented\nSTEP_STATUS: done | summary="implemented"',
    ]);
    const foreman = new Foreman(
      builder,
      new Log(join(dir, ".foreman/test.jsonl")),
      false,
      true,
      3,
      dir,
      undefined,
      async (cwd) => new FakeBuilder([qaPass], () => writeFileSync(join(cwd, "source.ts"), "after\n", "utf8")),
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
