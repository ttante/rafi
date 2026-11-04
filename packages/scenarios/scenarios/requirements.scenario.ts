// One requirements file per ticket (SCN 3.2): S-QA-5, all but the F-BRANCH commit, which needs M5's delivery (P21).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import type { TranscriptEntry } from "../checks/transcript.js";
import { B, on } from "../fakes/script/behaviors.js";
import { happyPath } from "../fakes/script/roles.mjs";
import type { Behavior, MetaLike, TurnContext } from "../fakes/script/engine.js";
import { setTickets } from "../fixtures/common.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported, of, ticketJson } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const REQ = (t: string) => `docs/requirements/${t}.md`;

/** F-CHAIN with T1 High risk, planner depth focused, two criteria; QA's reviews read the file. */
function prepare(ctx: ScenarioContext, dir: string): void {
  setTickets(dir, { T1: { risk: "High", qa_preparation: { depth: "focused" },
    acceptance: ["Ticket 1 works.", "Ticket 1 explains itself."] } });
  ctx.computer.script.rules.length = 0;
  ctx.computer.script.transcript.length = 0;
  for (const t of ["T1", "T2"]) ctx.computer.script.rules.push(on(`qa ${t} @review`, B.also({ read: REQ(t) })));
}

const lines = (dir: string, t: string) => readFileSync(path.join(dir, REQ(t)), "utf8").split("\n")
  .filter((l) => l.startsWith("- **R"));

function warnings(output: string): string[] {
  return output.split("\n").filter((l) => /^rafi: .*docs\/requirements\/T\d\.md.*(changed|missing)/.test(l));
}

type Verdict = { results: { req: number; status: string; needs: string | null }[] };

/** Steps 2–4: a changed file, a missing file, a misspelt path; none stops the build (NEW-CAU-3). */
async function changedFiles(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, computer, fixture } = ctx;
    await step("2: R1's line edited while the builder works: one warning, R1 unable, the rest normal", async () => {
      const dir = fixture("F-CHAIN");
      prepare(ctx, dir);
      computer.script.rules.unshift(on("builder T1#1", B.outside({ edit: REQ("T1"),
        replace: ["Ticket 1 works.", "Ticket 1 works, and nothing else matters."] })));
      const r = await rafi("start . --steps 2", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const w = warnings(r.output);
      assert.equal(w.length, 1, r.output);
      assert.match(w[0]!, /T1: docs\/requirements\/T1\.md changed/);
      const review = computer.script.transcript.find((x) => x.ticket === "T1" && x.step === "review")!;
      assert.match(review.message, /docs\/requirements\/T1\.md/);
      assert.match(review.message, /Warning: .*changed/);
      const e = await exported(ctx, dir);
      const verdict = (of(e, "verdict.recorded", "T1") as Verdict[])[0]!;
      assert.deepEqual(verdict.results.map((x) => [x.req, x.status, x.needs]), [[1, "unable", "file"],
        [2, "satisfied", null]]);
      assert.deepEqual((of(e, "requirements.receipt") as { status: string }[]).map((x) => x.status),
        ["changed", "delivered"]);
      assert.equal(of(e, "question.opened").length, 0, "T2 starts with no question about T1");
      assert.ok(computer.script.transcript.some((x) => x.ticket === "T2" && x.role === "builder"));
    });
    await step("3: T2's file deleted while the builder works: missing, every T2 requirement unable", async () => {
      const dir = fixture("F-CHAIN");
      prepare(ctx, dir);
      computer.script.rules.unshift(on("builder T2#1", B.outside({ remove: REQ("T2") })));
      const r = await rafi("start . --steps 2", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      const w = warnings(r.output);
      assert.equal(w.length, 1, r.output);
      assert.match(w[0]!, /T2: docs\/requirements\/T2\.md is missing/);
      const e = await exported(ctx, dir);
      assert.ok((of(e, "verdict.recorded", "T2") as Verdict[])[0]!.results.every((x) => x.status === "unable"));
      assert.deepEqual((of(e, "requirements.receipt") as { status: string }[]).map((x) => x.status),
        ["delivered", "missing"]);
    });
    await step("4: a misspelt path in the builder's reply changes nothing: delivered, no warning, exit 0", async () => {
      const dir = fixture("F-CHAIN");
      prepare(ctx, dir);
      const misspelt = (meta: MetaLike, c: TurnContext): Behavior => {
        const base = happyPath(meta, c) as Behavior;
        return { ...base, reply: { ...(base.reply as object), summary: "Done; see docs/requirement/T1.md." } };
      };
      computer.script.rules.unshift(on("builder T1#1", misspelt));
      const r = await rafi("start . --steps 2", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.equal(warnings(r.output).length, 0);
      const e = await exported(ctx, dir);
      assert.deepEqual((of(e, "requirements.receipt") as { status: string }[]).map((x) => x.status),
        ["delivered", "delivered"]);
      assert.ok((of(e, "verdict.recorded") as Verdict[]).every((v) => v.results.every((x) => x.status !== "unable")));
      assert.deepEqual(of(e, "delivery.done").length, 2);
    });
}

scenario({
  id: "S-QA-5", covers: covers("S-QA-5"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, computer, fixture, pending, project } = ctx;
    prepare(ctx, project);
    let output = "";
    let transcript: TranscriptEntry[] = [];
    let file: Record<string, string[]> = {};
    await step("1: a new QA prepare session writes each file before the ticket's first builder turn", async () => {
      const r = await rafi("start . --steps 2");
      output = r.output;
      assert.equal(r.code, 0, r.output);
      transcript = [...computer.script.transcript];
      for (const t of ["T1", "T2"]) {
        const prep = transcript.findIndex((x) => x.role === "qa" && x.step === "prepare" && x.ticket === t);
        const build = transcript.findIndex((x) => x.role === "builder" && x.ticket === t);
        assert.ok(prep >= 0 && prep < build, `${t}: prepare before build`);
        assert.equal(transcript[prep]!.session, "new");
        const text = readFileSync(path.join(project, REQ(t)), "utf8");
        assert.match(text, /^- \*\*R1\*\* /m);
        for (const section of ["Requirements", "Acceptance criteria", "In scope", "Out of scope", "Risks"]) {
          assert.match(text, new RegExp(`^## ${section}$`, "m"), `${t}: ${section}`);
        }
        assert.match(text, /Check: `[^`]+`, expect it to pass\./);
      }
      file = { T1: lines(project, "T1"), T2: lines(project, "T2") };
    });
    await step("1: T1's depth is rafi's High minimum, in the file and tickets show; the raise is recorded once",
      async () => {
        assert.match(readFileSync(path.join(project, REQ("T1")), "utf8"),
          /^<!-- rafi requirements v1 ticket=T1 depth=extensive -->$/m);
        assert.equal((await ticketJson(ctx, "T1")).depth, "extensive");
        const written = of(await exported(ctx), "requirements.written") as { depth: string;
          depth_raised_from: string | null }[];
        assert.deepEqual(written.filter((w) => w.depth_raised_from).map((w) => [w.depth, w.depth_raised_from]),
          [["extensive", "focused"]]);
      });
    await step("1: every instruction has the path, QA's review the fingerprint; no requirement line", async () => {
      const e = await exported(ctx);
      const fps = new Map((of(e, "requirements.written") as { path: string; fp: string }[])
        .map((w) => [w.path, w.fp]));
      for (const t of transcript.filter((x) => x.ticket === "T1" || x.ticket === "T2")) {
        assert.ok(t.message.includes(REQ(t.ticket!)), `${t.role}@${t.step} ${t.ticket} has the path`);
        if (t.step === "review") assert.ok(t.message.includes(fps.get(REQ(t.ticket!))!), "the fingerprint");
        for (const line of [...file.T1!, ...file.T2!]) assert.ok(!t.message.includes(line), `no line: ${line}`);
      }
    });
    await step("1: stats show lists one receipt per review turn: delivered, read yes", async () => {
      const run = (await exported(ctx)).events.find((x) => x.type === "build.started")!.run_id!;
      const r = await rafi(`stats show --run ${run}`);
      assert.equal(r.code, 0, r.output);
      const receipts = r.out.split("\n").filter((l) => l.startsWith("- receipt "));
      assert.equal(receipts.length, 2, r.out);
      for (const [t, line] of [["T1", receipts[0]!], ["T2", receipts[1]!]] as const) {
        assert.match(line, new RegExp(`${t} review attempt 1 .*${REQ(t)}.*supplied sha256:[0-9a-f]{64}.*observed ` +
          "sha256:[0-9a-f]{64}.*delivered.*read: yes"));
        assert.match(line, /at \d{4}-\d\d-\d\dT/);
      }
      assert.equal(warnings(output).length, 0);
    });
    await changedFiles(ctx);
    await pending("on F-BRANCH the file is in the same commit as the ticket's work (P21)", "M5");
  },
});
