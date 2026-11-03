// S-MIG-2 — unmigrated and unsupported projects. Step 1 now; steps 2–3 with `rafi migrate` (M9).
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { snapshot } from "../checks/snapshot.js";
import { scenario } from "../harness/scenario.js";

scenario({
  id: "S-MIG-2", covers: registry.find((r) => r.id === "S-MIG-2")!.covers, modes: ["next"], fixture: "F-LEGACY",
  async run({ rafi, step, pending, project }) {
    await step("1: the new engine refuses a 0.10.x project in one line and writes nothing", async () => {
      const before = snapshot(project);
      const r = await rafi("start . --steps 1");
      assert.equal(r.code, 1);
      assert.equal(r.err, "rafi: This project uses 0.10.x formats. Run `rafi migrate` first.\n");
      assert.equal(r.out, "");
      assert.deepEqual(snapshot(project), before);
    });
    await pending("2: migrate names project.yaml and the legacy qa_preparation object as unsupported", "M9");
    await pending("3: migrate refuses while a 0.10.2 build is unfinished, naming the run", "M9");
  },
});
