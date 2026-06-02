import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";

import { Foreman } from "../src/foreman.js";
import { Log } from "../src/log.js";
import { cmdInit } from "../src/tickets/commands.js";
import { StateDb } from "../src/tickets/stateDb.js";
import type { BuilderAdapter, BuilderEvent, TurnResult } from "../src/adapters/types.js";
import type { TicketDef } from "../src/tickets/ticketSchema.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "foreman-runner-test-"));
}

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
  private index = 0;

  constructor(private readonly turns: string[]) {}

  async sendTurn(_text: string): Promise<TurnResult> {
    const text = this.turns[this.index++] ?? "";
    return { text, isError: false, numTurns: 1, costUsd: 0 };
  }

  sessionId(): string | undefined {
    return "fake-session";
  }

  async *events(): AsyncIterable<BuilderEvent> {}

  async close(): Promise<void> {}
}

test("runBatch completes ticket only after QA passes", async () => {
  const dir = makeTmpDir();
  try {
    cmdInit(dir, { appName: "Test", timezone: "UTC" });
    writeFileSync(join(dir, ".tickets/tickets.yaml"), stringify({ tickets: [makeDef("T001")] }));

    const builder = new FakeBuilder([
      'implemented\nSTEP_STATUS: done | ticket="T001" summary="implemented"',
      'checked\nSTEP_STATUS: qa_pass | summary="tests passed"',
    ]);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 3, dir);

    const result = await foreman.runBatch(1);
    assert.equal(result.outcome, "all-done");
    assert.equal(result.completed, 1);

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
      'bad\nSTEP_STATUS: qa_fail | issues="missing test"',
      'fixed\nSTEP_STATUS: done | ticket="T001" summary="fixed"',
    ]);
    const foreman = new Foreman(builder, new Log(join(dir, ".foreman/test.jsonl")), false, true, 1, dir);

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
