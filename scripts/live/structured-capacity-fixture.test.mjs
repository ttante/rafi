import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { structuredCapacityPages } from "./structured-capacity-fixture.mjs";
test("capacity journey defaults to two genuine native provider pages", () => {
  const { pages, maxTickets } = structuredCapacityPages({});
  assert.equal(maxTickets, 0); assert.equal(pages.length, 2);
  assert.deepEqual(pages.map(page => page.result.payload.terminal), [false, true]);
});
test("capacity fixture rejects terminal ordering, unknown shapes, and unmet ticket counts before launch", () => {
  const root = mkdtempSync(join(tmpdir(), "rafi-capacity-input-"));
  const path = join(root, "pages.json");
  try {
    const { pages } = structuredCapacityPages({});
    pages[0].result.payload.terminal = true; writeFileSync(path, JSON.stringify(pages));
    assert.throws(() => structuredCapacityPages({ RAFI_LIVE_CAPACITY_FIXTURE: path }), /terminal page must be last/);
    writeFileSync(path, JSON.stringify({ invalid: true }));
    assert.throws(() => structuredCapacityPages({ RAFI_LIVE_CAPACITY_FIXTURE: path }));
    assert.throws(() => structuredCapacityPages({ RAFI_LIVE_CAPACITY_MAX_TICKETS: "1" }), /requested total ticket count/);
    assert.throws(() => structuredCapacityPages({ RAFI_LIVE_CAPACITY_PAGES: "61" }), /page count/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
