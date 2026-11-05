// S-CLI-3 (flags are one-off overrides) and S-CLI-19 (settings in rafi-config.yaml), their M5 parts (plan item 9):
// `--completion none` and `--set` win for one build and leave the file unchanged; `--set` by dot path reaches only
// its role; an unknown key exits 1 naming it; the org policy's locked keys refuse flags and `--set` and override the
// project's value (C184); `-y`, `--yes` and `--auto-approve` alike. S-CLI-19: the full 1.0 config validates, a
// build records each setting with its source, an unknown key is an error, the old RAFI_* tuning variables change
// nothing, and `workflows:` or a ticket `workflow` field exit 1.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { registry } from "../checks/registry.js";
import { configure, git, setTickets } from "../fixtures/common.js";
import { newComputer, rafiRunner, type RafiResult } from "../harness/rafi.js";
import { scenario } from "../harness/scenario.js";
import { exported, of } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
type Setting = { value: unknown; source: string };
const startedSettings = (e: Awaited<ReturnType<typeof exported>>) =>
  (of(e, "build.started") as { settings: Record<string, Setting> }[]).at(-1)!.settings;

scenario({
  id: "S-CLI-3", covers: covers("S-CLI-3"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    const { rafi, step, project, pending, root } = ctx;
    configure(project, { tickets: { build: { branch_strategy: "current", completion: "pr" } } });
    const file = path.join(project, "rafi-config.yaml");
    const saved = readFileSync(file, "utf8");
    await step("1: --completion none wins for the build; rafi-config.yaml is unchanged", async () => {
      const r = await rafi("start . --steps 1 --completion none");
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(startedSettings(await exported(ctx))["tickets.build.completion"],
        { value: "none", source: "flag" });
      assert.equal(readFileSync(file, "utf8"), saved);
    });
    await step("2: --set agent_defaults.roles.qa.model=m-qa reaches QA's turns only; the file is unchanged",
      async () => {
        const r = await rafi("start . --steps 1 --completion none --set agent_defaults.roles.qa.model=m-qa");
        assert.equal(r.code, 0, r.output);
        const e = await exported(ctx);
        const run = (of(e, "build.started") as unknown[]).length;
        assert.equal(run, 2);
        const last = e.events.filter((x) => x.type === "build.started").at(-1)!.seq;
        const intents = e.events.filter((x) => x.type === "turn.intent" && x.seq > last)
          .map((x) => x.data as { role: string; model: string | null });
        assert.ok(intents.some((i) => i.role === "qa"), JSON.stringify(intents));
        assert.ok(intents.filter((i) => i.role === "qa").every((i) => i.model === "m-qa"), JSON.stringify(intents));
        assert.ok(intents.filter((i) => i.role === "builder").every((i) => i.model !== "m-qa"));
        const s = startedSettings(e);
        assert.deepEqual(s["agent_defaults.roles.qa.model"], { value: "m-qa", source: "flag" });
        assert.deepEqual(s["agent.qa.model"], { value: "m-qa", source: "flag" });
        assert.equal(readFileSync(file, "utf8"), saved);
      });
    await step("3: --set nosuch.key=1 exits 1 naming it, before any build", async () => {
      const before = of(await exported(ctx), "build.started").length;
      const r = await rafi("start . --steps 1 --completion none --set nosuch.key=1");
      assert.equal(r.code, 1, r.output);
      assert.match(r.output, /nosuch\.key: unknown key/);
      assert.equal(of(await exported(ctx), "build.started").length, before);
    });
    await step("4: a key locked by the org policy is refused by flag and --set, naming the policy; a different "
      + "project value is overridden with one line (Q-FLAG-1)", async () => {
      const other = ctx.fixture("F-CHAIN");
      configure(other, { retries: { fixes: 1 } });
      const computer = newComputer(path.join(root, "policy"), "b");
      mkdirSync(computer.stateDir, { recursive: true });
      writeFileSync(path.join(computer.stateDir, "policy.yaml"), stringify({ version: 1, locked: {
        "tickets.build.completion": "none", "retries.fixes": 2 } }));
      const run = rafiRunner(computer, other, ctx.results as RafiResult[]);
      for (const line of ["start . --steps 1 --set retries.fixes=5", "start . --steps 1 --completion none"]) {
        const r = await run(line);
        assert.equal(r.code, 1, `${line}: ${r.output}`);
        assert.match(r.output, /is locked by your organization's policy \(~\/\.rafi\/policy\.yaml\)/, line);
      }
      const r = await run("start . --steps 1");
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /rafi-config\.yaml sets retries\.fixes to 1; your organization's policy locks it to 2/);
      const s = startedSettings(await exported({ rafi: run }));
      assert.deepEqual(s["retries.fixes"], { value: 2, source: "policy" });
      assert.deepEqual(s["tickets.build.completion"], { value: "none", source: "policy" });
    });
    await step("5: rafi resume -y, --yes and --auto-approve do the same thing (FLAG-ST-17, FLAG-RS-8)", async () => {
      const outs = [];
      for (const flag of ["-y", "--yes", "--auto-approve"]) {
        const r = await rafi(`resume ${flag}`);
        outs.push({ code: r.code, out: r.output.replace(/\d{2}:\d{2}:\d{2}/g, "") });
      }
      assert.deepEqual(outs[1], outs[0]);
      assert.deepEqual(outs[2], outs[0]);
    });
    await pending("single-action confirmations such as uninstall:cleanup keep --yes (Q-FLAG-3)", "M10");
  },
});

/** S-CLI-19's setup: a 1.0 config using every new key family SCN names. */
const FULL = {
  retries: { fixes: 2, turn: 2 }, plan_updates: "change-then-tell", manual_checks: "wait",
  notifications: { enabled: true }, logs: { location: "machine", capture: "normal" },
  recordings: { save: "failures", keep: { builds: 5 } }, approvals: { mode: "manual" },
  tools: { lint: { kind: "command", start: { command: "npx", args: ["eslint"] }, description: "Lint", roles: ["qa"],
    tags: ["nosuchtag"] } },
  tags: { payments: { patterns: ["src/pay/**"], description: "Payment code" } },
  locked_requirements: ["Always use PostgreSQL"],
  tickets: { build: { branch_strategy: "current", completion: "none", max_branch_depth: 4, keep_worktrees: true,
    branch_prefix: "work" } },
  agent_defaults: { version: 1, revision: 1, roles: { builder: { display_session_cost: true } } },
};

scenario({
  id: "S-CLI-19", covers: covers("S-CLI-19"), modes: ["next"], fixture: "F-ONE",
  async run(ctx) {
    const { rafi, step, project, pending } = ctx;
    const file = path.join(project, "rafi-config.yaml");
    writeFileSync(file, stringify({ ...parse(readFileSync(file, "utf8")), ...FULL }));
    git(project, ["commit", "-qam", "full config"]);
    await pending("rafi doctor shows each setting's value and source", "M10");
    await step("a short build validates the full config and records each setting with its source", async () => {
      const r = await rafi("start . --steps 1 --no-qa", { env: { RAFI_PROVIDER_IDLE_TIMEOUT_MS: "1",
        RAFI_AUTO_MERGE_POLL_MS: "1", RAFI_QA_COMMAND_OUTPUT_EXCERPTS: "0" } });
      assert.equal(r.code, 0, r.output);
      const s = startedSettings(await exported(ctx));
      assert.deepEqual(s["retries.fixes"], { value: 2, source: "project" });
      assert.deepEqual(s["tickets.build.max_branch_depth"], { value: 4, source: "project" });
      assert.deepEqual(s["tickets.build.keep_worktrees"], { value: true, source: "project" });
      assert.deepEqual(s["recordings.keep"], { value: { builds: 5 }, source: "project" });
      assert.deepEqual(s["retries.circling_repeats"], { value: 2, source: "default" });
      assert.deepEqual(s["timeouts.idle_minutes"], { value: 30, source: "default" },
        "RAFI_PROVIDER_IDLE_TIMEOUT_MS changes nothing (ENV-4 → config, Q-CFG-1)");
      assert.deepEqual(s["harness.qa"], { value: false, source: "flag" });
      assert.equal(existsSync(path.join(project, "foreman.yaml")), false, "no foreman.yaml in a 1.0 project");
    });
    await step("an unknown key is an error naming it", async () => {
      writeFileSync(file, `${readFileSync(file, "utf8")}surprise_key: 1\n`);
      const r = await rafi("start . --steps 1");
      assert.equal(r.code, 1, r.output);
      assert.match(r.output, /unknown key surprise_key/);
      git(project, ["checkout", "--", "rafi-config.yaml"]);
    });
    await step("workflows: and a ticket workflow field exit 1: Custom workflows aren't supported yet.", async () => {
      writeFileSync(file, `${readFileSync(file, "utf8")}workflows: {}\n`);
      const a = await rafi("start . --steps 1");
      assert.equal(a.code, 1, a.output);
      assert.match(a.output, /Custom workflows aren't supported yet\./);
      git(project, ["checkout", "--", "rafi-config.yaml"]);
      setTickets(project, { T1: { workflow: "maker-checker" } });
      const b = await rafi("start . --steps 1");
      assert.equal(b.code, 1, b.output);
      assert.match(b.output, /Custom workflows aren't supported yet\./);
    });
  },
});
