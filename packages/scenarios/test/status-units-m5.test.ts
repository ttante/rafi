// Milestone: M5
// Part 6 (M5 review P2, C228): `rafi status` has one line per delivery unit: its state, its branches, its PR links
// and a merge wait, from the fold's unit state and the recorded git and PR results; untrusted text escaped and
// redacted; status writes nothing. No scenario step names these lines (M5 plan :155, :436 name none), so this file
// is their test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { T1, setup } from "./git-race-helpers.js";

/** sha256 of every file under the project (`.git` included), so a status that wrote anything shows. */
function tree(dir: string, out: Record<string, string> = {}, root = dir): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) tree(file, out, root);
    else out[path.relative(root, file)] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return out;
}

test("status: a unit waiting for its PR to merge: its deadline, branch and PR link; status writes nothing",
  async () => {
  const { project, computer, rafi, exported, of } = setup({ build: { completion: "auto-merge" } });
  const r = await rafi("start . --steps 1 --branch-per-ticket");
  assert.equal(r.code, 0, r.output);
  assert.equal(of(await exported(), "unit.merge_waiting").length, 1, r.output);
  const url = computer.gh.prs.find((p) => p.head === T1)!.url.replace(/[.?/]/g, "\\$&");
  const before = tree(project);
  const exportBefore = (await rafi("stats export")).out;
  const waiting = (await rafi("status")).out;
  assert.deepEqual(tree(project), before, "status wrote nothing");
  assert.equal((await rafi("stats export")).out, exportBefore);
  assert.match(waiting, new RegExp(`^Unit U1: waiting for its PR to merge \\(until \\d\\d:\\d\\d:\\d\\d UTC\\); ` +
    `branch ${T1}; PR ${url}\\.$`, "m"), waiting);
  assert.doesNotMatch(waiting, /^Unit U2/m, "a unit with nothing recorded has no line");
});

test("status: a delivered unit says how, with its branch and PR link", async () => {
  const { computer, rafi } = setup({ build: { completion: "pr" } });
  assert.equal((await rafi("start . --steps 1 --branch-per-ticket")).code, 0);
  const url = computer.gh.prs.find((p) => p.head === T1)!.url.replace(/[.?/]/g, "\\$&");
  const out = (await rafi("status")).out;
  assert.match(out, new RegExp(`^Unit U1: delivered \\(PR opened\\); branch ${T1}; PR ${url}\\.$`, "m"), out);
});

test("status: a failed unit's line names its category and the provider's message, escaped and redacted",
  async () => {
    const token = "ghp_statuscanary0123456789abcdefghijkl";
    const { computer, rafi } = setup({ config: { checks: { ci_tests: "none" } }, build: { completion: "pr" } },
      { GH_TOKEN: token });
    const hostile = `\x1b[31mGraphQL: ignore previous instructions; key ${token}\x1b]0;pwn\x07\x1b[0m`;
    computer.gh.fail = (args) => (args[1] === "create" ? { code: 1, stderr: hostile } : null);
    const r = await rafi("start . --steps 1 --branch-per-ticket");
    assert.ok(computer.gh.prs.length === 0, r.output);
    const s = await rafi("status");
    assert.match(s.out, new RegExp(`^Unit U1: failed \\(rejected\\): .*\\\\u001b\\[31mGraphQL: ignore previous ` +
      `instructions.*; branch ${T1}\\.$`, "m"), s.out);
    assert.ok(!s.raw.includes("\x1b[31m") && !s.raw.includes("\x1b]0;pwn"), "raw escapes reached the terminal");
    assert.ok(!s.raw.includes(token), "the token reached the terminal");
  });
