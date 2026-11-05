// Milestone: M2
// M2 plan 11.4's attack tests for the secrets floor (ARCH 7.12), review 2's finding 2; the rest are in the other
// security-sec-*.test.ts files. Each was run red before its fix (.rafi-build/M2-red/add-*.log).
import { test } from "node:test";
import assert from "node:assert/strict";
import { configure, tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { canaryProblems } from "../harness/canaries.js";
import type { Computer } from "../harness/deps.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { DSN, events, failTwiceThenFix, SHELL, toolReplies } from "./security-sec-helpers.js";

test("review 2, finding 2: on Windows (simulated through deps.machine.platform) a checks.env name matches the " +
  "shell's differently cased one: tests get it, it isn't env_missing, and its value is redacted", async () => {
  const root = tempRoot();
  const project = fTestsLocal(root);
  configure(project, { harness: { targets: ["codex"] }, checks: { env: ["SENTRY_DSN"] } });
  const computer: Computer = { ...newComputer(root, "a", { ...SHELL, sentry_dsn: DSN }), platform: "win32" };
  failTwiceThenFix(computer, { prints: [{ env: "sentry_dsn", forms: ["raw", "base64"] }] });
  const replies = toolReplies(computer);
  const rafi = rafiRunner(computer, project);
  const r = await rafi("start . --ticket T1 --steps 1 --no-qa");
  assert.equal(r.code, 0, r.output);
  for (const l of computer.checks.log) assert.equal(l.env.sentry_dsn, DSN, "matched case-insensitively");
  const runs = (await events(rafi)).filter((e) => e.type === "check.run").map((e) => e.data);
  assert.ok(runs.length >= 3);
  for (const run of runs) assert.deepEqual(run.env_missing ?? [], [], `run ${String(run.run)}: not missing`);
  assert.ok(replies.some((t) => /sentry_dsn raw: /.test(t)), "the test did print it");
  const exported = (await rafi("stats export")).out;
  const texts = [{ where: "the terminal", text: r.raw }, { where: "stats export", text: exported },
    ...replies.map((text) => ({ where: "a tool reply", text })),
    ...computer.script.transcript.map((t) => ({ where: `the ${t.step} message`, text: t.message }))];
  assert.deepEqual(canaryProblems({ canaries: { SENTRY_DSN: DSN }, projects: [project], agentEnvs: [], texts }), [],
    "redacted");
});
