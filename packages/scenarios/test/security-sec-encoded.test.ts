// Milestone: M2
// M2 plan 11.4's attack tests for the secrets floor (ARCH 7.12), A5/A6; the rest are in the other
// security-sec-*.test.ts files. Each was run red before its fix (.rafi-build/M2-red/add-*.log).
import { test } from "node:test";
import assert from "node:assert/strict";
import { configure, tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { canaryProblems } from "../harness/canaries.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { DSN, failTwiceThenFix, SHELL, toolReplies } from "./security-sec-helpers.js";

const ENCODED = "s3cr3t value/with+chars&x=1";

test("A5/A6: a secret-named value, and a secret-looking checks.env one, printed raw or encoded by a test, are " +
  "redacted in blobs, the terminal, the agent's replies and messages, and the export", async () => {
  const root = tempRoot();
  const project = fTestsLocal(root);
  configure(project, { harness: { targets: ["codex"] }, checks: { env: ["MY_API_TOKEN", "SENTRY_DSN"] } });
  const computer = newComputer(root, "a", { ...SHELL, MY_API_TOKEN: ENCODED, SENTRY_DSN: DSN });
  failTwiceThenFix(computer, { prints: [{ env: "MY_API_TOKEN", forms: ["raw", "base64", "base64url", "hex", "url"] },
    { env: "SENTRY_DSN", forms: ["raw"] }] });
  const replies = toolReplies(computer);
  const rafi = rafiRunner(computer, project);
  const r = await rafi("start . --ticket T1 --steps 1 --no-qa");
  assert.equal(r.code, 0, r.output);
  assert.ok(replies.some((t) => /MY_API_TOKEN base64: /.test(t)), "the test did print it");
  assert.ok(replies.some((t) => /SENTRY_DSN raw: /.test(t)), "the test did print it");
  const exported = (await rafi("stats export")).out;
  const texts = [{ where: "the terminal", text: r.raw }, { where: "stats export", text: exported },
    ...replies.map((text) => ({ where: "a tool reply", text })),
    ...computer.script.transcript.map((t) => ({ where: `the ${t.step} message`, text: t.message }))];
  assert.deepEqual(canaryProblems({ canaries: { MY_API_TOKEN: ENCODED }, projects: [project], agentEnvs: [], texts }),
    [], "A5");
  for (const { text } of texts) assert.doesNotMatch(text, /abc123def456@o1/, "A6");
  assert.deepEqual(canaryProblems({ canaries: { SENTRY_DSN: DSN }, projects: [project], agentEnvs: [], texts: [] }),
    [], "A6");
});
