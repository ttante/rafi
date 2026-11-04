// Process set, M4 item 12: real Ctrl+C in a PTY, on both fake executables. (a) S-CRASH-3 run 3: SIGINT while T2's
// slow build turn runs: exit 130, the fake took rafi's cancel, build.owner_released after turn.cancelled. (b) A
// second SIGINT: rafi exits at once and no provider process is left. (c) Ctrl+C in an attached `rafi resume` (Q2,
// C169): one press stops watching and the build goes on; a second press within 3 s stops it gracefully, with the
// "stopping" and "stopped" lines, and the view exits 130.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventsExport } from "../checks/invariants.js";
import { pOn, writeShims } from "../fakes/shims.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fChain3 } from "../fixtures/f-chain3.js";
import { alive, launch, ops, providerPids, run, waitFor, type Op } from "../harness/process-run.js";

type Runtime = "codex" | "claude";
const CTRL_C = "\u0003";

function setup(runtime: Runtime, ms: number, o: { ignoreCancel?: boolean } = {}) {
  const root = tempRoot("rafi-ctrlc-");
  const project = fChain3(root);
  configure(project, { harness: { targets: [runtime] } });
  const shims = writeShims(root, { rules: [pOn("builder T2#1 @build", { kind: "slow", ms, every: 250, ...o })] });
  return { project, log: shims.logs[runtime], o: { cwd: project, pathFirst: shims.bin } };
}

const T2_BUILD = (o: Op) => o.op === "pick" && (o.identity as { ticket?: string; step?: string } | null)?.ticket ===
  "T2" && (o.identity as { step?: string }).step === "build";
const exported = async (o: { cwd: string; pathFirst: string }) =>
  JSON.parse((await run(["stats", "export"], o)).output) as EventsExport;
const seqOf = (e: EventsExport, type: string) => e.events.find((x) => x.type === type)?.seq ?? -1;
const cancelSeen = (log: string, runtime: Runtime) => ops(log).some((o) => (runtime === "claude"
  ? o.op === "interrupt" : o.op === "recv" && o.method === "turn/interrupt"));

for (const runtime of ["codex", "claude"] as const) {
  const skip = process.platform === "win32" ? "a PTY needs POSIX" : false;
  test(`S-CRASH-3 run 3 (process, ${runtime}): Ctrl+C in the build's PTY cancels T2's turn, exit 130`,
    { skip, timeout: 120_000 }, async () => {
      const s = setup(runtime, 60_000);
      const live = launch(["start", ".", "--steps", "2"], { ...s.o, pty: true });
      await waitFor("T2's slow build turn", () => ops(s.log).some(T2_BUILD), 60_000);
      await new Promise((r) => setTimeout(r, 600));
      live.type(CTRL_C);
      const r = await live.done;
      assert.equal(r.code, 130, r.output.slice(-1500));
      assert.ok(cancelSeen(s.log, runtime), "the fake took rafi's cancel");
      assert.ok(ops(s.log).some((o) => o.op === "sigint"), "the real SIGINT reached the provider's process group");
      const e = await exported(s.o);
      assert.deepEqual(e.events.filter((x) => x.type === "build.stopped").map((x) => x.data), [{ cause: "ctrl-c" }]);
      assert.ok(e.events.some((x) => x.type === "turn.cancelled" && (x.data as { confirmed: boolean }).confirmed));
      assert.ok(seqOf(e, "turn.cancelled") < seqOf(e, "build.owner_released"), "released after the confirmed cancel");
    });

  test(`S-CRASH-3 run 3 (process, ${runtime}): a second Ctrl+C exits at once and leaves no provider`,
    { skip, timeout: 120_000 }, async () => {
      // The provider doesn't take the first press's cancel, so only the second press's kill ends it at once.
      const s = setup(runtime, 60_000, { ignoreCancel: true });
      const live = launch(["start", ".", "--steps", "2"], { ...s.o, pty: true });
      await waitFor("T2's slow build turn", () => ops(s.log).some(T2_BUILD), 60_000);
      await new Promise((r) => setTimeout(r, 600));
      live.type(CTRL_C);
      await new Promise((r) => setTimeout(r, 150));
      const second = Date.now();
      live.type(CTRL_C);
      const r = await live.done;
      assert.equal(r.code, 130, r.output.slice(-1500));
      assert.ok(ops(s.log).some((o) => o.op === "cancel-ignored"), "the first press's cancel wasn't taken");
      assert.ok(Date.now() - second < 5_000, "rafi exited within 5 s of the second Ctrl+C");
      await waitFor("no provider process left", () => providerPids(s.log).every((p) => !alive(p)), 3_000);
    });

  test(`Ctrl+C in an attached rafi resume (process, ${runtime}): detach on one press, a graceful stop on two`,
    { skip, timeout: 180_000 }, async () => {
      const s = setup(runtime, 14_000);
      const owner = launch(["start", ".", "--steps", "2"], s.o);
      await waitFor("T2's slow build turn", () => ops(s.log).some(T2_BUILD), 60_000);
      const b = launch(["resume"], { ...s.o, pty: true });
      await waitFor("the attached view", () => /Following build/.test(b.output()), 20_000);
      b.type(CTRL_C);
      const one = await b.done;
      assert.equal(one.code, 0, one.output.slice(-1500));
      assert.match(one.output, /Stopped watching build \S+; it keeps running\. Press Ctrl\+C again within 3 seconds/);
      assert.match(one.output, /Build \S+ keeps running/);
      assert.ok(alive(owner.pid), "the build goes on after a single press");
      const c = launch(["resume"], { ...s.o, pty: true });
      await waitFor("the attached view", () => /Following build/.test(c.output()), 20_000);
      c.type(CTRL_C);
      await waitFor("the first press's line", () => /Press Ctrl\+C again/.test(c.output()), 10_000);
      c.type(CTRL_C);
      const two = await c.done;
      assert.equal(two.code, 130, two.output.slice(-1500));
      assert.match(two.output, /Stopping build \S+ after its current step/);
      const first = await owner.done;
      assert.equal(first.code, 0, `the owner after a stop: ${first.output.slice(-1500)}`);
      const e = await exported(s.o);
      assert.deepEqual(e.events.filter((x) => x.type === "build.stop_requested").map((x) => x.data),
        [{ mode: "graceful", source: "ctrl-c" }]);
      assert.equal(e.events.filter((x) => x.type === "build.stopped").length, 1);
    });
}
