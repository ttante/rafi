// Process set, M4 item 11 (D9): a sample of S-CRASH-1 with a real SIGKILL of the built rafi, on both fake
// executables. F-CHAIN trimmed to T1–T3 with S-CRASH-1's script (QA rejects T2's first review; T3's first build reply
// is malformed), matched by the turn's identity from the log (P8 option C). Three kills per fake: `killhost` during
// T2's first review (sent, no reply), `killhost-after-reply` on T2's fix, and the harness's SIGKILL once the fake
// shows T3's prepare turn. Each is resumed until done (at most 3); exit codes, checkCrashRun on `stats export`, no
// provider outliving the killed rafi, and no project file changing between the kill and the resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCrashRun, type EventsExport } from "../checks/invariants.js";
import { workFiles } from "../checks/crash.js";
import { pOn, writeShims, type ProcessRule } from "../fakes/shims.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fChain3 } from "../fixtures/f-chain3.js";
import { alive, hashes, launch, ops, providerPids, run, waitFor, type Op } from "../harness/process-run.js";

type Runtime = "codex" | "claude";
const SCRIPT: ProcessRule[] = [pOn("qa T2#1 @review", { kind: "reject", notes: { 1: "not yet" } }),
  pOn("builder T3#1 @build", { raw: `{"kind":"done","summary":"s"}${" ".repeat(300)}trailing text` })];

function setup(runtime: Runtime, extra: ProcessRule[] = []) {
  const root = tempRoot("rafi-kill-");
  const project = fChain3(root);
  configure(project, { harness: { targets: [runtime] } });
  const shims = writeShims(root, { rules: [...extra, ...SCRIPT] });
  return { project, shims, log: shims.logs[runtime], o: { cwd: project, pathFirst: shims.bin } };
}

const exported = async (o: { cwd: string; pathFirst: string }) =>
  JSON.parse((await run(["stats", "export"], o)).output) as EventsExport;
const finished = (e: EventsExport) => e.events.some((x) => x.type === "build.finished") &&
  e.events.filter((x) => x.type.startsWith("build.")).at(-1)?.type === "build.owner_released";

async function clean(runtime: Runtime) {
  const s = setup(runtime);
  const r = await run(["start", ".", "--steps", "3"], s.o);
  assert.equal(r.code, 0, r.output.slice(-2000));
  // The fake matched S-CRASH-1's rules by the turn's identity (option C), not by order.
  const fired = ops(s.log).filter((o) => o.op === "pick" && o.rule !== null)
    .map((o) => [o.rule, (o.identity as { role: string }).role, (o.identity as { ticket: string }).ticket]);
  assert.deepEqual(fired, [[0, "qa", "T2"], [1, "builder", "T3"]]);
  const e = await exported(s.o);
  assert.ok(e.events.some((x) => x.type === "verdict.recorded" && x.ticket_id === "T2" &&
    JSON.stringify(x.data).includes("not-satisfied")), "QA rejected T2 once");
  return { e, files: workFiles(s.project) };
}

/** After the kill: providers gone, the files unchanged until the resume, then resumes until the build is done. */
async function afterKill(s: ReturnType<typeof setup>, cleanRun: Awaited<ReturnType<typeof clean>>) {
  // Right after the kill: the files as rafi left them; a provider that outlived it and kept editing would change them.
  const atKill = hashes(s.project, { withRafi: false });
  await waitFor("every provider of the killed rafi to exit", () => providerPids(s.log).every((p) => !alive(p)), 10_000);
  await new Promise((r) => setTimeout(r, 500));
  const beforeResume = await exported(s.o);
  assert.deepEqual(hashes(s.project, { withRafi: false }), atKill, "no project file changed after the kill");
  const outputs: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await run(["resume"], s.o);
    outputs.push(r.output);
    assert.ok(r.code === 0, `resume ${i + 1} exited ${r.code}: ${r.output.slice(-1500)}`);
    if (finished(await exported(s.o))) break;
  }
  const final = await exported(s.o);
  assert.ok(finished(final), "the build finished within 3 resumes");
  assert.deepEqual(checkCrashRun({ beforeResume, final, clean: cleanRun.e, resumeOutput: outputs }), []);
  assert.deepEqual(workFiles(s.project), cleanRun.files, "the same files as the clean run");
}

const isT3Prepare = (o: Op) => o.op === "pick" && (o.identity as { ticket?: string; step?: string } | null)?.ticket ===
  "T3" && (o.identity as { step?: string }).step === "prepare";

for (const runtime of ["codex", "claude"] as const) {
  test(`S-CRASH-1 SIGKILL sample (process, ${runtime}): killhost, killhost-after-reply and a harness kill`,
    { skip: process.platform === "win32" ? "SIGKILL and PATH shims need POSIX" : false, timeout: 300_000 },
    async (t) => {
      const cleanRun = await clean(runtime);
      await t.test("killhost during T2's first review (sent, before any reply)", async () => {
        const s = setup(runtime, [pOn("qa T2#1 @review", { kind: "happy", kill: "before-reply" })]);
        const r = await launch(["start", ".", "--steps", "3"], s.o).done;
        assert.equal(r.signal, "SIGKILL", `rafi wasn't killed: exit ${r.code}\n${r.output.slice(-1500)}`);
        assert.ok(ops(s.log).some((o) => o.op === "killhost"));
        await afterKill(s, cleanRun);
      });
      await t.test("killhost-after-reply on T2's fix (the reply written)", async () => {
        const s = setup(runtime, [pOn("builder T2 @fix", { kind: "happy", kill: "after-reply" })]);
        const r = await launch(["start", ".", "--steps", "3"], s.o).done;
        assert.equal(r.signal, "SIGKILL", `rafi wasn't killed: exit ${r.code}\n${r.output.slice(-1500)}`);
        await afterKill(s, cleanRun);
      });
      await t.test("the harness SIGKILLs rafi once the fake shows T3's prepare turn", async () => {
        const s = setup(runtime);
        const live = launch(["start", ".", "--steps", "3"], s.o);
        await waitFor("T3's prepare turn", () => ops(s.log).some(isT3Prepare), 120_000);
        live.child.kill("SIGKILL");
        const r = await live.done;
        assert.equal(r.signal, "SIGKILL");
        await afterKill(s, cleanRun);
      });
    });
}
