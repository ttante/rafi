// M2 plan 11.4's attack tests for the secrets floor (ARCH 7.12), A1/A2; the rest are in the other
// security-sec-*.test.ts files (threat 30's A7–A10 are in security-t30.test.ts). Each was run red before its fix
// (.rafi-build/M2-red/add-*.log).
import { test } from "node:test";
import assert from "node:assert/strict";
import { configure, tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { canary } from "../harness/canaries.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { events, failTwiceThenFix, SHELL } from "./security-sec-helpers.js";

test("A1/A2: tests get no canary outside the allowlist (run_check, the check step, the related-tests query); " +
  "a checks.env name reaches them; a declared name that isn't set is env_missing", async () => {
  const root = tempRoot();
  const project = fTestsLocal(root);
  configure(project, { checks: { env: ["DATABASE_URL", "UNSET_NAME"] } });
  const token = canary(`${root}/RAFI_CANARY_TOKEN`);
  const computer = newComputer(root, "a", { ...SHELL, RAFI_CANARY_TOKEN: token,
    DATABASE_URL: "postgres://localhost/test" });
  failTwiceThenFix(computer);
  const rafi = rafiRunner(computer, project);
  const r = await rafi("start . --ticket T1 --steps 1 --no-qa");
  assert.equal(r.code, 0, r.output);
  const runs = (await events(rafi)).filter((e) => e.type === "check.run").map((e) => e.data);
  assert.ok(runs.some((x) => x.asked_by === "builder") && runs.some((x) => x.asked_by === "rafi"), "both kinds ran");
  assert.ok(computer.checks.log.some((l) => l.args.includes("--listTests")), "the related-tests query ran");
  for (const l of computer.checks.log) {
    assert.equal(l.env.RAFI_CANARY_TOKEN, undefined, `${l.cmd} ${l.args.join(" ")} got the canary`);
    assert.equal(l.env.PATH, SHELL.PATH, "the base set still reaches tests");
    assert.equal(l.env.DATABASE_URL, "postgres://localhost/test", "A2: the declared name");
  }
  assert.ok(runs.length >= 3);
  for (const run of runs) assert.deepEqual(run.env_missing, ["UNSET_NAME"], `A2: run ${String(run.run)}`);
});
