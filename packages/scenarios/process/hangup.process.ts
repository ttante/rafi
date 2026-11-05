// Process set, M4 follow-up 3 item 3 (C183): each provider leads its own session and process group, so a closed
// terminal's SIGHUP reaches only rafi. Rafi then stops the build (graceful, then now 5 s later) and ends its providers
// through endProvider. Here the terminal really closes (the PTY's master end), during a deaf provider's long turn whose
// helper child ignores SIGTERM too; afterwards no provider or helper is left, and the build is recorded as stopped.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pOn, writeShims } from "../fakes/shims.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { alive, launch, ops, providerPids, waitFor } from "../harness/process-run.js";

for (const runtime of ["codex", "claude"] as const) {
  const skip = process.platform === "win32" ? "POSIX sessions and a PTY" : false;
  test(`hangup (process, ${runtime}): the terminal closes; rafi stops the build and no provider or helper is left`,
    { skip, timeout: 120_000 }, async () => {
      const root = tempRoot("rafi-hup-");
      const project = fOne(root);
      configure(project, { harness: { targets: [runtime] } });
      const shims = writeShims(root, { rules: [pOn("builder T1#1 @build",
        { kind: "slow", ms: 60_000, every: 250, ignoreTerm: true })] });
      const log = shims.logs[runtime];
      const live = launch(["start", ".", "--steps", "1"], { cwd: project, pathFirst: shims.bin, pty: true });
      await waitFor("the deaf build turn", () => ops(log).some((o) => o.op === "deaf"), 60_000);
      await new Promise((r) => setTimeout(r, 600));
      live.hangup();
      const r = await live.done;
      const deaf = ops(log).find((o) => o.op === "deaf")!;
      const pids = [...providerPids(log), deaf.helper as number];
      await waitFor("every provider and the helper gone", () => pids.every((pid) => !alive(pid)), 3_000);
      assert.ok(ops(log).some((o) => o.op === "sigterm-ignored"), "rafi sent the provider SIGTERM");
      assert.equal(r.code, 0, r.output.slice(-1500));
      const db = new DatabaseSync(path.join(project, ".rafi", "state.sqlite3"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT type, data FROM events WHERE type IN ('build.stop_requested', " +
          "'build.stopped') ORDER BY seq").all() as { type: string; data: string }[];
        assert.deepEqual(rows.map((x) => `${x.type} ${(JSON.parse(x.data) as { mode?: string; cause?: string })
          .mode ?? (JSON.parse(x.data) as { cause: string }).cause}`),
        ["build.stop_requested graceful", "build.stop_requested now", "build.stopped cancel"]);
      } finally {
        db.close();
      }
    });
}
