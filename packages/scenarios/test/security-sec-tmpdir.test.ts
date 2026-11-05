// Milestone: M2
// M2 plan 11.4's attack tests for the secrets floor (ARCH 7.12), review 2's finding 3; the rest are in the other
// security-sec-*.test.ts files. Each was run red before its fix (.rafi-build/M2-red/add-*.log).
import { test } from "node:test";
import assert from "node:assert/strict";
import { configure, tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { SHELL } from "./security-sec-helpers.js";

test("review 2, finding 3 (P20, ARCH 7.11): Claude QA gets no TMPDIR from rafi; Claude's builder and Codex keep " +
  "the shell's (C77)", async () => {
  const TMP = "/var/folders/xy/T/";
  for (const runtime of ["claude", "codex"] as const) {
    const root = tempRoot();
    const project = fTestsLocal(root);
    configure(project, { harness: { targets: [runtime] } });
    const computer = newComputer(root, "a", { ...SHELL, TMPDIR: TMP });
    const rafi = rafiRunner(computer, project);
    const r = await rafi("start . --ticket T1 --steps 1");
    assert.equal(r.code, 0, r.output);
    const envs = computer.agentEnvs.filter((e) => e.kind === runtime);
    if (runtime === "claude") {
      const qa = envs.filter((e) => e.readOnly);
      assert.ok(qa.length > 0 && qa.length < envs.length, "both roles ran on Claude");
      for (const e of qa) assert.equal("TMPDIR" in e.env, false, "Claude QA: no TMPDIR from rafi");
      for (const e of envs.filter((x) => !x.readOnly)) assert.equal(e.env.TMPDIR, TMP, "Claude's builder");
    } else {
      assert.ok(envs.length >= 2, "both roles ran on Codex");
      for (const e of envs) assert.equal(e.env.TMPDIR, TMP, "Codex keeps it (ARCH 7.11 sets nothing for Codex QA)");
    }
  }
});
