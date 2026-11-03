// M2 plan 11.4's attack tests for the secrets floor (ARCH 7.12), A3/A4; the rest are in the other
// security-sec-*.test.ts files. Each was run red before its fix (.rafi-build/M2-red/add-*.log).
import { test } from "node:test";
import assert from "node:assert/strict";
import { configure, tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { canary } from "../harness/canaries.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { type Data, SHELL } from "./security-sec-helpers.js";

for (const runtime of ["claude", "codex"] as const) {
  test(`A3/A4 (${runtime}): no canary in the agent's environment; only its own login; Codex's shells drop its key`,
    async () => {
      const root = tempRoot();
      const project = fTestsLocal(root);
      configure(project, { harness: { targets: [runtime] }, agents: { env: ["PROJECT_FLAG"] } });
      const token = canary(`${root}/RAFI_CANARY_TOKEN`);
      const computer = newComputer(root, "a", { ...SHELL, RAFI_CANARY_TOKEN: token, ANTHROPIC_API_KEY: "sk-ant-fake",
        OPENAI_API_KEY: "sk-openai-fake", PROJECT_FLAG: "1" });
      const rafi = rafiRunner(computer, project);
      const r = await rafi("start . --ticket T1 --steps 1");
      assert.equal(r.code, 0, r.output);
      const envs = computer.agentEnvs.filter((e) => e.kind === runtime);
      assert.ok(envs.length > 0, "an agent ran");
      for (const { env } of envs) {
        assert.equal(env.RAFI_CANARY_TOKEN, undefined, "the canary stays out of the agent's environment");
        assert.equal(env.PROJECT_FLAG, "1", "agents.env reaches the agent");
        assert.equal(env.PATH, SHELL.PATH);
        assert.equal(runtime === "claude" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY, undefined, "not the other's");
        assert.ok(runtime === "claude" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY, "its own login");
      }
      if (runtime === "codex") {
        const start = computer.sentToAgents.map((m) => JSON.parse(m) as Data).find((m) => m.method === "thread/start");
        const config = (start!.params as Data).config as Data;
        assert.deepEqual(config.shell_environment_policy, { inherit: "all", exclude: ["OPENAI_*"] }, "A4");
      }
    });
}
