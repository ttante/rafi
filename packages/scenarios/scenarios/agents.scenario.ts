// S-CLI-8 (`rafi agents`, M5 plan item 8, C186): PRM-110's walkthrough in a terminal, then each FLAG-AG flag,
// including settings for an inactive role. Settings are saved per role under agent_defaults.roles with a revision
// bump; defaults are `fresh` for builder, QA and ticket-maker (Q-CFG-5); an inactive role's settings are kept;
// comments elsewhere in rafi-config.yaml are kept.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { registry } from "../checks/registry.js";
import { git } from "../fixtures/common.js";
import { scenario } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
type Defaults = { version?: number; revision?: number; roles?: Record<string, Record<string, unknown>> };

scenario({
  id: "S-CLI-8", covers: covers("S-CLI-8"), modes: ["next"], fixture: "F-ONE",
  async run({ rafi, step, project }) {
    const file = path.join(project, "rafi-config.yaml");
    writeFileSync(file, `# Team settings: keep this comment\n${readFileSync(file, "utf8")}`);
    git(project, ["commit", "-qam", "comment"]);
    const saved = () => (parse(readFileSync(file, "utf8")) as { agent_defaults?: Defaults }).agent_defaults ?? {};
    await step("1: in a terminal, every PRM-110 prompt; the answers are saved for the chosen roles", async () => {
      const r = await rafi("agents", { tty: true, input: ["2,3", "2", "2", "gpt-x", "4", "2", "1", "70", "4", "60",
        "3", "1"] });
      assert.equal(r.code, 0, r.output);
      for (const prompt of ["Which roles should share these settings?", "Runtime:", "Model:", "Runtime default " +
        "(Recommended)", "Validated custom ID", "Custom model ID:", "Reasoning:", "Enable fast mode when supported?",
      "Session continuity:", "Builder automatic compaction threshold (1-99):", "QA automatic compaction threshold",
      "maximum compactions per session", `Apply to builder, qa in ${project}?`]) {
        assert.ok(r.output.includes(prompt), `prompt: ${prompt}\n${r.output}`);
      }
      assert.match(r.output, /Fresh conversation \(Recommended\)/, "fresh is the default (Q-CFG-5)");
      const d = saved();
      assert.equal(d.version, 1);
      assert.equal(d.revision, 1);
      assert.deepEqual(d.roles?.builder, { make: "codex", model: "gpt-x", reasoning: "high", fast: false,
        session_strategy: "fresh", auto_compact_threshold_percent: 70, compact_maximum: 4 });
      assert.deepEqual(d.roles?.qa, { make: "codex", model: "gpt-x", reasoning: "high", fast: false,
        session_strategy: "fresh", auto_compact_threshold_percent: 60, compact_maximum: 3 });
      assert.match(readFileSync(file, "utf8"), /^# Team settings: keep this comment/);
    });
    await step("2: flags for an inactive role (uninstaller) are saved and kept for its next session", async () => {
      const r = await rafi("agents --agent-type uninstaller --agent-make claude --model u-1 --reasoning low --fast " +
        "--session-strategy compact --show-session-cost");
      assert.equal(r.code, 0, r.output);
      const d = saved();
      assert.equal(d.revision, 2);
      assert.deepEqual(d.roles?.uninstaller, { make: "claude", model: "u-1", reasoning: "low", fast: true,
        session_strategy: "compact", display_session_cost: true });
      assert.equal(d.roles?.builder?.model, "gpt-x", "other roles unchanged");
    });
    await step("3: --auto-compact-threshold, --compact-maximum, --no-fast and --no-show-session-cost for builder",
      async () => {
        const r = await rafi("agents --agent-type builder --auto-compact-threshold 50 --compact-maximum 2 --no-fast " +
          "--no-show-session-cost");
        assert.equal(r.code, 0, r.output);
        const d = saved();
        assert.equal(d.revision, 3);
        assert.deepEqual(d.roles?.builder, { make: "codex", model: "gpt-x", reasoning: "high", fast: false,
          session_strategy: "fresh", auto_compact_threshold_percent: 50, compact_maximum: 2,
          display_session_cost: false });
        assert.equal(d.roles?.uninstaller?.model, "u-1", "the inactive role's settings are kept");
      });
    await step("4: a role with no saved strategy shows fresh for builder, QA and ticket-maker (Q-CFG-5)", async () => {
      const r = await rafi("agents --agent-type ticket-maker --model tm-1");
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /ticket-maker: .*session fresh/);
      assert.equal(saved().roles?.["ticket-maker"]?.session_strategy, undefined, "the default isn't written");
    });
    await step("5: --agent-type all applies to every role, discovery and manager included", async () => {
      const r = await rafi("agents --agent-type all --session-strategy fresh");
      assert.equal(r.code, 0, r.output);
      const roles = saved().roles ?? {};
      for (const role of ["planner", "builder", "qa", "ticket-maker", "uninstaller", "manager", "discovery"]) {
        assert.equal(roles[role]?.session_strategy, "fresh", role);
      }
      assert.equal(roles.uninstaller?.model, "u-1");
    });
    await step("6: bad values exit 1 naming the flag and change nothing", async () => {
      const before = readFileSync(file, "utf8");
      for (const [line, message] of [["agents --agent-type painter", /--agent-type .*planner, builder, qa/],
        ["agents --agent-type builder --auto-compact-threshold 0", /--auto-compact-threshold .*1 to 99/],
        ["agents --agent-type planner --compact-maximum 3", /--compact-maximum .*builder and qa/],
        ["agents --agent-type qa --agent-make gemini", /--agent-make .*claude or codex/],
        ["agents", /terminal/]] as const) {
        const r = await rafi(line);
        assert.equal(r.code, 1, `${line}: ${r.output}`);
        assert.match(r.output, message, line);
      }
      assert.equal(readFileSync(file, "utf8"), before);
    });
    await step("7: answering No to the confirmation saves nothing", async () => {
      const before = readFileSync(file, "utf8");
      const r = await rafi("agents", { tty: true, input: ["1", "1", "1", "1", "2", "1", "2"] });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Nothing was saved/);
      assert.equal(readFileSync(file, "utf8"), before);
    });
  },
});
