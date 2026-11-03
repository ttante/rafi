// S-ENG-5 — the engine switch and one process. In-process here: steps 2 and 4 through the launcher's shared
// format.ts and runCli. The process set (harness/process.ts) runs steps 1, 2 and 4 on the built launcher;
// step 3 (one process tree during a build) needs a build (M2).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { findProject, OLD_ENGINE_REFUSAL, readFormat } from "@rafi-ai/cli/next/format";
import { registry } from "../checks/registry.js";
import { snapshot } from "../checks/snapshot.js";
import { LEGACY_DIR } from "../fixtures/legacy.js";
import { scenario } from "../harness/scenario.js";

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
    await pending("3: one rafi process plus provider processes during a build", "M2");
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
