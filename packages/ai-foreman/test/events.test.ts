import assert from "node:assert/strict";
import { test } from "node:test";
import { printEvents } from "../src/cli/events.js";
import type { BuilderEvent } from "../src/adapters/types.js";

async function* events(items: BuilderEvent[]): AsyncIterable<BuilderEvent> {
  yield* items;
}

test("event feed prints a successful tool lifecycle once", async () => {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((value: string | Uint8Array) => {
    chunks.push(String(value));
    return true;
  }) as typeof process.stdout.write;
  try {
    await printEvents(events([
      { kind: "tool", name: "Bash", input: { command: "pnpm test 1" }, lifecycle: "started", callId: "tool-1" },
      { kind: "tool", name: "Bash", input: {}, lifecycle: "progress", callId: "tool-1", durationMs: 2_000 },
      { kind: "tool", name: "Bash", input: { command: "pnpm test 2" }, lifecycle: "completed", callId: "tool-1", status: "completed", exitCode: 0 },
    ]));
  } finally {
    process.stdout.write = original;
  }
  assert.equal(chunks.join("").match(/-> Bash/g)?.length, 1);
  assert.match(chunks.join(""), /pnpm test 1/);
  assert.doesNotMatch(chunks.join(""), /pnpm test 2/);
});
