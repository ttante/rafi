// S-START-1 (one-ticket build) and S-START-4 (agent choice and a fresh agent per ticket), mode next.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { checkCrashRun, type EventsExport } from "../checks/invariants.js";
import { registry } from "../checks/registry.js";
import { steps } from "../checks/transcript.js";
import { git } from "../fixtures/common.js";
import { scenario } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;

scenario({
  id: "S-START-1", covers: covers("S-START-1"), modes: ["next", "next-process"], fixture: "F-ONE",
  async run({ rafi, step, project, computer }) {
    let out = "";
    await step("1: rafi start . --steps 1 exits 0", async () => {
      const r = await rafi("start . --steps 1");
      out = r.out;
      assert.equal(r.code, 0, r.output);
    });
    await step("the transcript has one requirements turn (QA), one builder turn, one review turn (QA), in order",
      () => assert.deepEqual(steps(computer.script.transcript), ["qa@prepare", "builder@build", "qa@review"]));
    await step("2: T1 is done, with validation evidence citing rafi's recorded test command", async () => {
      const r = await rafi("tickets show --all --json");
      assert.equal(r.code, 0, r.output);
      const t1 = (JSON.parse(r.out) as { tickets: Record<string, unknown>[] }).tickets.find((t) => t.id === "T1")!;
      assert.equal(t1.status, "done");
      const validation = t1.validation as { result: string; runs: { run: number; command: string; outcome: string }[] };
      assert.equal(validation.result, "passed");
      assert.ok(validation.runs.some((run) => run.command === "npm test" && run.outcome === "passed"));
    });
    await step("progress rows with timestamps appear while the builder works", () => {
      assert.match(out, /^\d\d:\d\d:\d\d +builder +T1 /m);
    });
    await step("build.started pins standard with version and digest; every step.started names a workflow step",
      async () => {
        const r = await rafi("stats export");
        assert.equal(r.code, 0, r.output);
        const exported = JSON.parse(r.out) as EventsExport;
        assert.equal(exported.format, "rafi-events");
        const started = exported.events.find((e) => e.type === "build.started")!;
        const workflow = started.data.workflow as { id: string; version: number; digest: string };
        assert.deepEqual([workflow.id, workflow.version], ["standard", 1]);
        assert.match(workflow.digest, /^sha256:[0-9a-f]{64}$/);
        const names = new Set(["prepare", "build", "check", "review", "fix", "deliver"]);
        const stepEvents = exported.events.filter((e) => e.type === "step.started");
        assert.ok(stepEvents.length >= 5);
        for (const e of stepEvents) assert.ok(names.has(String(e.data.step)), String(e.data.step));
        assert.deepEqual(checkCrashRun({ beforeResume: exported, final: exported, clean: exported, resumeOutput: [] }),
          []);
        assert.equal((await rafi("stats export")).out, r.out, "stable JSON");
      });
    await step(".rafi/progress.yaml lists T1 done; git shows only the work, requirements and progress files",
      () => {
        const progress = parse(readFileSync(path.join(project, ".rafi", "progress.yaml"), "utf8"));
        assert.equal(progress.tickets.T1.status, "done");
        const status = git(project, ["status", "--porcelain", "--untracked-files=all"]).trim().split("\n").sort();
        assert.deepEqual(status, ["?? .rafi/progress.yaml", "?? docs/requirements/T1.md", "?? src/T1.txt"]);
      });
  },
});

function retarget(dir: string, targets: string[] | null): void {
  const file = path.join(dir, "rafi-config.yaml");
  const config = parse(readFileSync(file, "utf8"));
  if (targets) config.harness = { targets };
  writeFileSync(file, stringify(config));
  git(dir, ["commit", "-qam", "targets"]);
}

scenario({
  id: "S-START-4", covers: covers("S-START-4"), modes: ["next"], fixture: "F-CHAIN",
  async run({ rafi, step, project, computer, fixture }) {
    const t = computer.script.transcript;
    const settingsOf = async (cwd: string) => {
      const e = JSON.parse((await rafi("stats export", { cwd })).out) as EventsExport;
      return e.events.filter((x) => x.type === "build.started").at(-1)!.data.settings as
        Record<string, { value: unknown; source: string }>;
    };
    await step("1: a codex-only project uses Codex; T2's builder and QA are new sessions, not T1's", async () => {
      retarget(project, ["codex"]);
      const r = await rafi("start . --steps 2");
      assert.equal(r.code, 0, r.output);
      assert.ok(t.length >= 6 && t.every((x) => x.runtime === "codex"), JSON.stringify(t.map((x) => x.runtime)));
      for (const role of ["builder", "qa"]) {
        const first = t.find((x) => x.ticket === "T2" && x.role === role)!;
        assert.equal(first.session, "new", `${role} for T2 starts a new session`);
      }
      const s = await settingsOf(project);
      assert.deepEqual(s["agent.builder.runtime"], { value: "codex", source: "project" });
      assert.deepEqual(s["retries.fixes"], { value: 3, source: "default" });
    });
    await step("each turn's role comes from the registry: builder sessions write, QA's are read-only", () => {
      assert.ok(t.filter((x) => x.role === "builder").every((x) => x.writable === true));
      assert.ok(t.filter((x) => x.role === "qa").every((x) => x.writable === false));
    });
    await step("2: a project with both targets uses Claude", async () => {
      const dir = fixture("F-CHAIN");
      t.length = 0;
      const r = await rafi("start . --steps 1", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.ok(t.length >= 3 && t.every((x) => x.runtime === "claude"));
      assert.deepEqual((await settingsOf(dir))["agent.builder.runtime"], { value: "claude", source: "default" });
    });
    await step("3: --agent codex --model m-test --effort high --fast, for this build only", async () => {
      const dir = fixture("F-CHAIN");
      const before = readFileSync(path.join(dir, "rafi-config.yaml"), "utf8");
      t.length = 0;
      const r = await rafi("start . --steps 1 --agent codex --model m-test --effort high --fast", { cwd: dir });
      assert.equal(r.code, 0, r.output);
      assert.ok(t.every((x) => x.runtime === "codex" && x.model === "m-test" && x.effort === "high" && x.fast));
      assert.equal(readFileSync(path.join(dir, "rafi-config.yaml"), "utf8"), before, "rafi-config.yaml unchanged");
      const s = await settingsOf(dir);
      assert.deepEqual(s["agent.builder.model"], { value: "m-test", source: "flag" });
      assert.deepEqual(s["agent.qa.effort"], { value: "high", source: "flag" });
      assert.deepEqual(s["agent.builder.fast"], { value: true, source: "flag" });
    });
  },
});
