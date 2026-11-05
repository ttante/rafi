// Process set, M4 follow-up 2 (user decision): a provider that ignores SIGTERM and stdin's end, with a helper child in
// its process group that ignores SIGTERM too (fakes/script/deaf.mjs), is SIGKILLed with its whole group about 5 s
// after rafi's SIGTERM: after Ctrl+C in the build's PTY and after a normal finish, on both fake executables. Before
// the change the Codex fake outlived its rafi (rafi waited on its pipes) and the Claude fake's helper outlived both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pOn, writeShims } from "../fakes/shims.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { alive, launch, ops, waitFor } from "../harness/process-run.js";

type Runtime = "codex" | "claude";
const CTRL_C = "\u0003";

function setup(runtime: Runtime, slow: boolean) {
  const root = tempRoot("rafi-term-");
  const project = fOne(root);
  configure(project, { harness: { targets: [runtime] } });
  const make = slow ? { kind: "slow" as const, ms: 60_000, every: 250, ignoreTerm: true }
    : { kind: "happy" as const, ignoreTerm: true };
  const shims = writeShims(root, { rules: [pOn("builder T1#1 @build", make)] });
  return { log: shims.logs[runtime], o: { cwd: project, pathFirst: shims.bin } };
}

/** The deaf provider ignored rafi's SIGTERM; rafi ended 4–10 s later; it and its helper are gone after. */
async function killedAfterGrace(log: string, exitedAt: number): Promise<void> {
  const deaf = ops(log).find((o) => o.op === "deaf");
  assert.ok(deaf, "the builder's provider went deaf");
  const ignored = ops(log).find((o) => o.op === "sigterm-ignored");
  assert.ok(ignored, "rafi sent the provider SIGTERM first");
  const waited = exitedAt - (ignored.at as number);
  assert.ok(waited >= 4_000 && waited <= 10_000, `rafi ended ${waited} ms after its SIGTERM (5 s grace)`);
  await waitFor("the provider and its helper gone", () => !alive(deaf.pid as number) && !alive(deaf.helper as number),
    3_000);
}

for (const runtime of ["codex", "claude"] as const) {
  const skip = process.platform === "win32" ? "POSIX process groups and a PTY" : false;
  test(`provider kill (process, ${runtime}): Ctrl+C, then SIGKILL to a provider group that ignores SIGTERM`,
    { skip, timeout: 120_000 }, async () => {
      const s = setup(runtime, true);
      const live = launch(["start", ".", "--steps", "1"], { ...s.o, pty: true });
      await waitFor("the deaf build turn", () => ops(s.log).some((o) => o.op === "deaf"), 60_000);
      await new Promise((r) => setTimeout(r, 600));
      live.type(CTRL_C);
      const r = await live.done;
      const exitedAt = Date.now();
      assert.equal(r.code, 130, r.output.slice(-1500));
      await killedAfterGrace(s.log, exitedAt);
    });

  test(`provider kill (process, ${runtime}): a normal finish, then SIGKILL to a provider group that ignores SIGTERM`,
    { skip, timeout: 120_000 }, async () => {
      const s = setup(runtime, false);
      const live = launch(["start", ".", "--steps", "1"], s.o);
      const r = await live.done;
      const exitedAt = Date.now();
      assert.equal(r.code, 0, r.output.slice(-1500));
      await killedAfterGrace(s.log, exitedAt);
    });
}
