// Item 27 (M4 plan 3.3, C139): the real `deps.logChanged` polls `PRAGMA data_version` on its own read-only
// connection, so a commit by another connection (another rafi process, or this one's log) fires it; with no commit
// it never fires, and once cancelled it stops. Real time, so it's in the process set.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openRealDb } from "../../src/deps/real/db.js";
import { realLogChanged, WATCH_MS } from "../../src/deps/real/watch.js";
import { tempDir } from "../helpers.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("logChanged fires after another connection's commit, never without one, and stops when cancelled", async () => {
  const file = path.join(tempDir(), "s.sqlite3");
  const writer = openRealDb(file);
  writer.pragma("journal_mode = WAL");
  writer.exec("CREATE TABLE t (x)");
  let fired = 0;
  const stop = realLogChanged(file, () => { fired += 1; });
  await wait(WATCH_MS * 3);
  assert.equal(fired, 0, "no commit, no call");
  writer.exec("INSERT INTO t VALUES (1)");
  await wait(WATCH_MS * 3);
  assert.equal(fired, 1);
  writer.exec("INSERT INTO t VALUES (2)");
  writer.exec("INSERT INTO t VALUES (3)");
  await wait(WATCH_MS * 3);
  assert.ok(fired >= 2 && fired <= 3, `${fired}`);
  stop();
  const after = fired;
  writer.exec("INSERT INTO t VALUES (4)");
  await wait(WATCH_MS * 3);
  assert.equal(fired, after, "cancelled");
  writer.close();
});
