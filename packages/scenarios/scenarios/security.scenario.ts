// Secrets and presets (SCN 5.7, M2 part): S-SEC-2 in full; S-SEC-1's step 1 (both runtimes' agent environments
// and Codex's shell policy), the rest pending M7; S-SEC-3 and S-SEC-4 pending M7. Canaries are on the computer, so
// the after-each check greps every project file, the terminal, the transcript and agent environments (C89).
import assert from "node:assert/strict";
import path from "node:path";
import type { EventsExport } from "../checks/invariants.js";
import { registry } from "../checks/registry.js";
import { B, on } from "../fakes/script/behaviors.js";
import { configure } from "../fixtures/common.js";
import { canary, canaryForms } from "../harness/canaries.js";
import type { Computer } from "../harness/deps.js";
import { scenario } from "../harness/scenario.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
type Data = Record<string, unknown>;
const BASE = { PATH: "/usr/bin:/bin", HOME: "/home/u", LANG: "en_US.UTF-8" };


/** The shell environment for rafi's commands; `canaries` are also registered for the after-each grep (C89). */
function shell(computer: Computer, vars: Record<string, string>, canaries: Record<string, string>) {
  Object.assign(computer.canaries, canaries);
  return { env: { ...vars, ...canaries } };
}

for (const runtime of ["claude", "codex"] as const) {
  scenario({
    id: "S-SEC-2", covers: covers("S-SEC-2"), modes: ["next"], fixture: "F-TESTS-LOCAL",
    async run(ctx) {
      const { rafi, step, computer, project } = ctx;
      configure(project, { harness: { targets: [runtime] },
        checks: { env: ["DATABASE_URL", "API_SECRET", "UNSET_NAME"] } });
      const secret = canary(`${ctx.root}/API_SECRET`);
      const token = canary(`${ctx.root}/RAFI_CANARY_TOKEN`);
      const env = shell(computer, { ...BASE, DATABASE_URL: "postgres://localhost/test" },
        { API_SECRET: secret, RAFI_CANARY_TOKEN: token });
      computer.checks.tests["t1.test"] = { outcomes: ["fail(1)", "fail(1)", "pass"],
        prints: [{ env: "API_SECRET", forms: ["raw", "base64", "hex"] }] };
      computer.checks.tests["t2.test"] = { outcomes: ["pass"], related: ["src/T1.txt"] };
      computer.script.rules.push(on("builder T1#1", B.runCheck("fake-test t1.test")));
      computer.script.rules.push(on("builder T1 @fix", { steps: [{ runCheck: "fake-test t1.test" },
        { checkOutput: 2 }, { edit: "src/T1.txt", content: "fixed\n" }], reply: { kind: "done", summary: "fixed",
        runs: "$runs", block: null, question: null } }));
      let exported: EventsExport = { events: [] } as unknown as EventsExport;
      let exportText = "";
      await step("rafi start . --ticket T1 --steps 1; rafi stats export", async () => {
        const r = await rafi("start . --ticket T1 --steps 1", env);
        assert.equal(r.code, 0, r.output);
        exportText = (await rafi("stats export", env)).out;
        exported = JSON.parse(exportText) as EventsExport;
      });
      await step("every test run gets the base set, the cache variables and the declared names; no canary",
        () => {
          const log = computer.checks.log;
          assert.ok(log.some((l) => l.args.includes("--listTests")), "the related-tests query ran");
          const runs = exported.events.filter((e) => e.type === "check.run").map((e) => e.data);
          assert.ok(runs.some((r) => r.asked_by === "builder") && runs.some((r) => r.asked_by === "rafi"));
          for (const l of log) {
            assert.equal(l.env.PATH, BASE.PATH);
            assert.ok(String(l.env.npm_config_cache).startsWith(path.join(project, ".rafi", "cache")));
            assert.equal(l.env.DATABASE_URL, "postgres://localhost/test");
            assert.equal(l.env.API_SECRET, secret, "a declared secret reaches tests");
            assert.equal(l.env.RAFI_CANARY_TOKEN, undefined, "an undeclared one doesn't");
          }
        });
      await step("each check.run records env_missing: [UNSET_NAME]", () => {
        const runs = exported.events.filter((e) => e.type === "check.run").map((e) => e.data);
        assert.ok(runs.length >= 3);
        for (const r of runs) assert.deepEqual(r.env_missing, ["UNSET_NAME"], `run ${String(r.run)}`);
      });
      await step("API_SECRET, raw, base64 and hex, is redacted in what the builder gets and in stored output",
        () => {
          const fix = computer.script.transcript.find((t) => t.step === "fix");
          assert.ok(fix, "the builder got a fix message");
          assert.match(fix.message, /API_SECRET (raw|base64|hex): \[REDACTED:API_SECRET\]/);
          const forms = canaryForms(secret);
          for (const text of [fix.message, exportText, ...computer.sentToAgents]) {
            for (const form of [forms.raw, forms.base64, forms.hex]) assert.ok(!text.includes(form!));
          }
        });
      await step("no canary, raw or encoded, in any event, blob, terminal output, transcript or export", () => {
        for (const value of [secret, token]) {
          for (const form of Object.values(canaryForms(value))) assert.ok(!exportText.includes(form));
        }
      });
    },
  });
}

for (const runtime of ["claude", "codex"] as const) {
  scenario({
    id: "S-SEC-1", covers: covers("S-SEC-1"), modes: ["next"], fixture: "F-TESTS-LOCAL",
    async run(ctx) {
      const { rafi, step, computer, project } = ctx;
      configure(project, { harness: { targets: [runtime] }, agents: { env: ["PROJECT_FLAG"] } });
      const env = shell(computer, { ...BASE, ANTHROPIC_API_KEY: "sk-ant-fake-login-1234567890", OPENAI_API_KEY:
        "sk-openai-fake-login-1234567890", PROJECT_FLAG: "1" }, { RAFI_CANARY_TOKEN:
        canary(`${ctx.root}/RAFI_CANARY_TOKEN`), STRIPE_KEY: canary(`${ctx.root}/STRIPE_KEY`) });
      computer.script.rules.push(on("builder T1#1", B.runCheck("fake-test t1.test")));
      await step("1: the runtime's environment holds the base set, its own login and PROJECT_FLAG; no canary",
        async () => {
          const r = await rafi("start . --ticket T1 --steps 1", env);
          assert.equal(r.code, 0, r.output);
          const envs = computer.agentEnvs.filter((e) => e.kind === runtime);
          assert.ok(envs.length > 0);
          for (const { env } of envs) {
            assert.deepEqual([env.PATH, env.HOME, env.LANG, env.PROJECT_FLAG], [BASE.PATH, BASE.HOME, BASE.LANG, "1"]);
            assert.ok(runtime === "claude" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY, "its own login");
            assert.equal(runtime === "claude" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY, undefined);
            assert.equal(env.RAFI_CANARY_TOKEN, undefined);
            assert.equal(env.STRIPE_KEY, undefined);
          }
        });
      if (runtime === "codex") {
        await step("1: Codex's shells get the same set minus its API key (shell_environment_policy)", () => {
          const starts = computer.sentToAgents.map((m) => JSON.parse(m) as Data)
            .filter((m) => m.method === "thread/start" || m.method === "thread/resume");
          assert.ok(starts.length > 0);
          for (const s of starts) {
            assert.deepEqual(((s.params as Data).config as Data).shell_environment_policy,
              { inherit: "all", exclude: ["OPENAI_*"] });
          }
        });
      } else {
        await ctx.pending("1: Claude's shells drop its API key (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, needs a paid " +
          "turn to confirm)", "M7");
      }
      await ctx.pending("1: the test run gets the store secret DB_URL", "M7");
      await ctx.pending("2: isolation.home: guarded denies the agent's and the test's read of ~/.aws/credentials",
        "M7");
      await ctx.pending("3: isolation.home: empty gives tests and agents HOME=.rafi/home/", "M7");
      await ctx.pending("4: isolation.workspace is rejected the way workflows: is", "M7");
    },
  });
}

scenario({
  id: "S-SEC-3", covers: covers("S-SEC-3"), modes: ["next"], fixture: "F-TESTS-LOCAL",
  async run(ctx) {
    for (const s of ["1: rafi secrets set (hidden input, argv refused, provider key refused)", "2: list and check",
      "3: the credential item resolves from the store", "4: rafi secrets use acme"]) await ctx.pending(s, "M7");
  },
});

scenario({
  id: "S-SEC-4", covers: covers("S-SEC-4"), modes: ["next"], fixture: "F-TESTS-LOCAL",
  async run(ctx) {
    for (const s of ["1: the preset item", "2: auto-approve fills standard", "3: doctor and a looser --set",
      "4: sensitive refuses --auto-approve", "5: sensitive refuses a missing sandbox",
      "6: sensitive: Allow once only, a secret plus internet asked", "7: an org-locked preset"]) {
      await ctx.pending(s, "M7");
    }
  },
});
