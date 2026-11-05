// Milestone: M2
// M2 plan 11.4's attack tests for the secrets floor (ARCH 7.12), review 2's finding 1 (NEW-SEC-8); the rest are in
// the other security-sec-*.test.ts files. Each was run red before its fix (.rafi-build/M2-red/add-*.log).
import { test } from "node:test";
import assert from "node:assert/strict";
import { B, on } from "../fakes/script/behaviors.js";
import { configure, tempRoot } from "../fixtures/common.js";
import { fTestsLocal } from "../fixtures/f-tests.js";
import { canaryProblems } from "../harness/canaries.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { SHELL, toolReplies } from "./security-sec-helpers.js";

const DB_URL = "postgres://db.internal:5432/app_main";
const REGION = "staging-eu-west-7";

test("review 2, finding 1 (NEW-SEC-8): a plain-named checks.env value and an agents.env value are redacted, " +
  "labeled with the name, in agent messages, tool replies, the log and the terminal", async () => {
  const root = tempRoot();
  const project = fTestsLocal(root);
  configure(project, { harness: { targets: ["codex"] }, checks: { env: ["DB_URL"] },
    agents: { env: ["DEPLOY_REGION"] } });
  const computer = newComputer(root, "a", { ...SHELL, DB_URL, DEPLOY_REGION: REGION });
  computer.checks.tests["t1.test"] = { outcomes: ["fail(1)", "fail(1)", "pass"],
    prints: [{ env: "DB_URL", forms: ["raw", "base64"] }] };
  computer.script.rules.push(on("builder T1#1", B.runCheck(`fake-test t1.test -t ${REGION}`)));
  computer.script.rules.push(on("builder T1 @fix", { steps: [{ runCheck: "fake-test t1.test" }, { checkOutput: 2 },
    { edit: "src/T1.txt", content: "fixed\n" }], reply: { kind: "done", summary: `fixed for ${REGION}`,
    runs: "$runs", block: null, question: null } }));
  const replies = toolReplies(computer);
  const rafi = rafiRunner(computer, project);
  const r = await rafi("start . --ticket T1 --steps 1");
  assert.equal(r.code, 0, r.output);
  assert.ok(replies.some((t) => /DB_URL raw: /.test(t)), "the test did print it");
  const exported = (await rafi("stats export")).out;
  const messages = computer.script.transcript.map((t) => ({ where: `the ${t.step} message`, text: t.message }));
  const texts = [{ where: "the terminal", text: r.raw }, { where: "stats export", text: exported },
    ...replies.map((text) => ({ where: "a tool reply", text })), ...messages];
  assert.deepEqual(canaryProblems({ canaries: { DB_URL, DEPLOY_REGION: REGION }, projects: [project], agentEnvs: [],
    texts }), [], "redacted everywhere");
  assert.ok(messages.some((m) => m.text.includes("[REDACTED:DB_URL]")), "the fix message names it");
  assert.ok(messages.some((m) => m.text.includes("[REDACTED:DEPLOY_REGION]")), "the review message names it");
  assert.match(exported, /\[REDACTED:DEPLOY_REGION\]/, "the log names it");
});
