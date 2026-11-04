// S-CLI-13 (SCN 4.2; M10 must-pass after P30, partial in M4): `rafi resume` lists saved interviews; `--discard`
// removes one; old completed records are pruned only by commands that write (P38, C150). `--id` hands the record to
// its command, which comes in M9 (plan, ticket-setup) and M10 (create).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { registry } from "../checks/registry.js";
import { writeInterviews } from "../fixtures/interviews.js";
import { scenario } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const records = (project: string) => {
  const dir = path.join(project, ".rafi", "interviews");
  return Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(path.join(dir, f), "utf8")]));
};

scenario({
  id: "S-CLI-13", covers: covers("S-CLI-13"), modes: ["next"], fixture: "F-ONE",
  async run({ rafi, step, project, computer, pending }) {
    writeInterviews(project);
    await step("rafi resume lists the three unfinished interviews, newest first, never the completed one", async () => {
      const r = await rafi("resume", { tty: true, input: [""] });
      assert.match(r.output, /What should Rafi resume\?/);
      const at = (t: string) => r.output.indexOf(t);
      for (const t of ["Plan the search feature", "Create the fixture app", "Ticket the search plan"]) {
        assert.ok(at(t) > 0, `${t}:\n${r.output}`);
      }
      assert.ok(at("Plan the search feature") < at("Create the fixture app"), "newest first");
      assert.ok(at("Create the fixture app") < at("Ticket the search plan"), "newest first");
      assert.doesNotMatch(r.output, /An old finished plan/);
    });
    await step("--id <prefix> picks the record and hands it to its command, which isn't built yet", async () => {
      const r = await rafi("resume --id plan-c");
      assert.equal(r.code, 1);
      assert.match(r.output, /Plan the search feature/);
      assert.match(r.output, /isn't in the new engine yet \(milestone M9\)/);
      assert.match((await rafi("resume --id create")).output, /milestone M10/);
    });
    await pending("--id resumes the create, plan and ticket-setup interviews", "M10");
    await step("--discard <prefix> removes only that record", async () => {
      const r = await rafi("resume --discard tickets-e");
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(Object.keys(records(project)), ["create-a1b2.json", "plan-c3d4.json", "plan-old9.json"]);
    });
    await step("readers leave every record as it is; the next command that writes prunes the old completed one",
      async () => {
        computer.clock.advance(25 * 3_600_000);
        const before = records(project);
        await rafi("status");
        await rafi("stats show");
        assert.deepEqual(records(project), before, "status and stats show write nothing (P38)");
        writeInterviews(project, [{ id: "plan-stale", workflow: "plan", status: "in_progress",
          title: "Untouched for forty days", updated_at: "2026-09-23T14:00:00.000Z" }]);
        const r = await rafi("resume --discard create-a1");
        assert.equal(r.code, 0, r.output);
        assert.deepEqual(Object.keys(records(project)), ["plan-c3d4.json", "plan-stale.json"],
          "the 31-day-old completed record went; unfinished ones never do");
        assert.equal(existsSync(path.join(project, ".rafi", "interviews", "plan-old9.json")), false);
      });
  },
});
