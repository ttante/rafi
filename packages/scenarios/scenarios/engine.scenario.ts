// S-ENG-5 — the engine switch and one process. In-process here: steps 2 and 4 through the launcher's shared
// format.ts and runCli. The process set runs steps 1, 2 and 4 on the built launcher (engine-switch.process.ts)
// and step 3, one process tree during a build (start.process.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { findProject, OLD_ENGINE_REFUSAL, readFormat } from "@rafi-ai/cli/next/format";
import { registry } from "../checks/registry.js";
import { snapshot } from "../checks/snapshot.js";
import { LEGACY_DIR } from "../fixtures/legacy.js";
import { scenario } from "../harness/scenario.js";
import type { EventsExport } from "../checks/invariants.js";

const nodeFs = {
  readText: async (file: string) => { try { return readFileSync(file, "utf8"); } catch { return null; } },
  isDir: async () => true,
};

scenario({
  id: "S-ENG-5", covers: registry.find((r) => r.id === "S-ENG-5")!.covers, modes: ["next", "next-process"],
  fixture: "F-ONE",
  async run({ rafi, step, pending, project, fixture }) {
    await pending("1: the old engine builds T1 on a 0.10.x project (process set)", "M1 process set");
    await step("2: a 1.0 project is what the launcher refuses for the old engine", async () => {
      const found = await findProject(["start", "."], project, nodeFs, ".");
      assert.equal(found, project);
      assert.equal((await readFormat(project, nodeFs)).format, "1.0");
      assert.equal(OLD_ENGINE_REFUSAL, "This project uses 1.0 formats; set RAFI_ENGINE=next.");
    });
    await pending("3: one rafi process plus provider processes during a build (process set)", "M2 process set");
    await step("4: `rafi resume` on F-LEGACY-RUNNING names the run and the 0.10.x commands", async () => {
      const legacy = fixture("F-LEGACY-RUNNING");
      const manifest = JSON.parse(readFileSync(path.join(LEGACY_DIR, "F-LEGACY-RUNNING", "manifest.json"), "utf8"));
      const before = snapshot(legacy);
      const r = await rafi("resume", { cwd: legacy });
      assert.equal(r.code, 1, r.output);
      assert.equal(r.err.trim().split("\n").length, 1);
      assert.match(r.err, new RegExp(`run ${manifest.unfinishedRun}`));
      assert.match(r.err, /`rafi resume`/);
      assert.match(r.err, /`rafi build:reset`/);
      assert.match(r.err, /without RAFI_ENGINE/);
      assert.deepEqual(snapshot(legacy), before, "the 0.10.x database was opened read-only");
    });
  },
});

scenario({
  id: "S-ENG-4", covers: registry.find((r) => r.id === "S-ENG-4")!.covers, modes: ["next"], fixture: "F-ONE",
  async run({ rafi, step, pending, computer }) {
    let r = { code: 0, out: "", err: "", output: "" };
    await step("a builder model the provider doesn't list is flagged before the first turn", async () => {
      r = await rafi("start . --steps 1 --model claude-unlisted-9");
      assert.equal(r.code, 0, r.output);
      const flag = r.output.indexOf("isn't in Claude's model list");
      assert.ok(flag >= 0, r.output);
      assert.ok(flag < r.output.indexOf("started"), "flagged before the first turn");
    });
    await step("the structured-reply fallback is used and recorded; replies still validate", async () => {
      const e = JSON.parse((await rafi("stats export")).out) as EventsExport;
      const schemas = e.events.filter((x) => x.type === "turn.intent").map((x) => String(x.data.schema));
      assert.ok(schemas.length >= 3 && schemas.every((s) => s.endsWith("+text")), schemas.join(","));
      assert.ok(computer.script.transcript.filter((t) => t.role === "builder")
        .every((t) => /Reply with only the JSON/.test(t.instructions) || t.session === "reused"));
      assert.ok(e.events.some((x) => x.type === "delivery.done"));
    });
    await step("no instruction asks Claude for an exit code; runs record completed, no exit code", async () => {
      for (const t of computer.script.transcript) {
        assert.doesNotMatch(t.instructions + t.message, /report .*exit code/i);
      }
      const e = JSON.parse((await rafi("stats export")).out) as EventsExport;
      const tools = e.events.filter((x) => x.type === "turn.tool").map((x) => x.data);
      assert.ok(tools.length > 0);
      assert.ok(tools.every((t) => t.exit_code === null && t.outcome === "completed"));
    });
    await pending("the live set: the absolute claude path that passed readiness, a logging shim's log empty", "live");
  },
});
