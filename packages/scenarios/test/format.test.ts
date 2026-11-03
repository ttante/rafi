// M1 security: damaged or hostile config and ticket files are validated on read; every refusal exits 1 with
// one line and writes nothing, in the project or in machine.stateDir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snapshot } from "../checks/snapshot.js";
import { git, tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

function project(edit: (dir: string) => void) {
  const root = tempRoot();
  const dir = fOne(root);
  edit(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "hostile edit", "--allow-empty"]);
  const computer = newComputer(root);
  return { dir, computer, rafi: rafiRunner(computer, dir) };
}

const config = (dir: string) => path.join(dir, "rafi-config.yaml");
const CASES: [string, (dir: string) => void, RegExp][] = [
  ["invalid YAML", (d) => writeFileSync(config(d), "format_version: 1\n  bad: [\n"), /isn't valid YAML/],
  ['format_version: "1" (a string)', (d) => writeFileSync(config(d), 'format_version: "1"\n'),
    /format_version must be the number 1/],
  ["format_version: 2", (d) => writeFileSync(config(d), "format_version: 2\n"), /format_version must be the number 1/],
  ["a workflows: key", (d) => writeFileSync(config(d), `${readFileSync(config(d), "utf8")}workflows: {}\n`),
    /^rafi: Custom workflows aren't supported yet\.$/],
  ["a ticket workflow field", (d) => {
    const file = path.join(d, ".tickets", "tickets.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("  - id: T1\n", "  - id: T1\n    workflow: audit-first\n"));
  }, /^rafi: Custom workflows aren't supported yet\. \(ticket T1\)$/],
  ["a config that isn't a mapping", (d) => writeFileSync(config(d), "format_version: 1\n---\n- a\n"),
    /isn't valid YAML|must be/],
];

for (const [name, edit, message] of CASES) {
  test(`hostile config: ${name} exits 1 with one line and writes nothing`, async () => {
    const { dir, computer, rafi } = project(edit);
    const before = snapshot(dir);
    const r = await rafi("start . --steps 1");
    assert.equal(r.code, 1, r.output);
    assert.equal(r.out, "");
    assert.equal(r.err.trim().split("\n").length, 1, r.err);
    assert.match(r.err.trim(), message);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=all"]), "");
    assert.equal(existsSync(computer.stateDir), false, "nothing in machine.stateDir");
  });
}

test("a valid 1.0 project passes the format check and reaches the command", async () => {
  const { rafi } = project(() => undefined);
  // `start` is built in M2, so `resume` (M4) stands in for "a command that isn't built yet".
  const r = await rafi("resume");
  assert.match(r.err, /isn't in the new engine yet/);
});

test("outside any project, a command says so in one line; version and help still work", async () => {
  const dir = tempRoot("rafi-empty-");
  const rafi = rafiRunner(newComputer(dir), dir);
  const r = await rafi("status");
  assert.equal(r.code, 1);
  assert.match(r.err, /^rafi: No rafi project here/);
  assert.equal((await rafi("--version")).code, 0);
  assert.equal((await rafi("help status")).code, 0);
});
