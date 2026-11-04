// Copy and fingerprint only when needed (SCN 3.2): S-QA-7 (M3; Q-COPY-1, C118, C119, C128).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { git, setTickets } from "../fixtures/common.js";
import { scenario } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

type Isolation = { mode: string; why: string; files: number; bytes: number; ms: Record<string, number> };

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

scenario({
  id: "S-QA-7", covers: covers("S-QA-7"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, computer, fixture, project } = ctx;
    setTickets(project, { T2: { risk: "High" } });
    await step("1: T1 (Low) in place on the light fingerprint, why recorded; T2 (High) on the full one", async () => {
      const r = await rafi("start . --steps 2");
      assert.equal(r.code, 0, r.output);
      const e = await exported(ctx);
      const [t1] = of(e, "qa.isolation", "T1") as Isolation[];
      assert.equal(t1?.mode, "in-place");
      assert.match(t1!.why, /light fingerprint/);
      assert.match(t1!.why, /no copy/);
      const [t2] = of(e, "qa.isolation", "T2") as Isolation[];
      assert.equal(t2?.mode, "in-place");
      assert.match(t2!.why, /full fingerprint/);
      assert.ok(t2!.files > 0 && t2!.bytes > 0, JSON.stringify(t2));
      for (const k of ["copy", "hash", "verify", "cleanup"]) assert.equal(typeof t2!.ms[k], "number", k);
    });
    await step("2: drift during T1's review: reported, redone in full on a copy; your files and git untouched",
      async () => {
        const dir = fixture("F-CHAIN");
        computer.script.rules.length = 0;
        computer.script.transcript.length = 0;
        computer.script.rules.push(on("qa T1#1 @review", B.outside({ edit: "src/T1.txt", content: "yours\n" })));
        const head = git(dir, ["rev-parse", "HEAD"]);
        const refs = git(dir, ["for-each-ref"]);
        const r = await rafi("start . --steps 1", { cwd: dir });
        assert.equal(r.code, 0, r.output);
        const drift = r.output.split("\n").filter((l) => /drift/i.test(l) && l.startsWith("rafi: "));
        assert.equal(drift.length, 1, r.output);
        assert.match(drift[0]!, /src\/T1\.txt/);
        const e = await exported(ctx, dir);
        const iso = of(e, "qa.isolation", "T1") as Isolation[];
        assert.deepEqual(iso.map((x) => x.mode), ["copy"]);
        assert.match(iso[0]!.why, /^source drift: src\/T1\.txt/);
        const reviews = computer.script.transcript.filter((t) => t.ticket === "T1" && t.step === "review");
        assert.equal(reviews.length, 2);
        assert.equal(reviews[1]!.session, "new");
        assert.ok(reviews[1]!.cwd?.startsWith(path.join(dir, ".rafi", "cache", "qa-copy") + path.sep),
          String(reviews[1]!.cwd));
        assert.doesNotMatch(reviews[1]!.message, /again, after the builder's fix/, "a full review message");
        assert.ok(computer.script.transcript.slice(computer.script.transcript.indexOf(reviews[1]!) + 1)
          .every((t) => t.cwd !== dir || t.ticket !== "T1" || t.role !== "qa"), "no later turn in place");
        assert.equal(of(e, "verdict.recorded", "T1").length, 1);
        assert.equal(git(dir, ["worktree", "list"]).trim().split("\n").length, 1);
        const copies = path.join(dir, ".rafi", "cache", "qa-copy");
        assert.ok(!existsSync(copies) || readdirSync(copies).length === 0, "no copy folder left");
        assert.equal(readFileSync(path.join(dir, "src", "T1.txt"), "utf8"), "yours\n");
        const written = (of(e, "requirements.written", "T1") as { path: string; fp: string }[])[0]!;
        assert.equal(sha(readFileSync(path.join(dir, written.path), "utf8")), written.fp);
        const snap = (of(e, "facts.snapshot", "T1") as { tree: string; files: string[] }[]).at(-1)!;
        for (const f of snap.files.filter((x) => x !== "src/T1.txt")) {
          assert.equal(git(dir, ["hash-object", f]).trim(), git(dir, ["rev-parse", `${snap.tree}:${f}`]).trim(), f);
        }
        assert.equal(git(dir, ["rev-parse", "HEAD"]), head);
        assert.equal(git(dir, ["for-each-ref"]), refs);
      });
  },
});
