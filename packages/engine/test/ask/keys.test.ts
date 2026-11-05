// Item 15 (M3 plan): saved-answer keys (ARCH 7.6; C106): the what-next and waiver keys, and the covered-files digest:
// a covered file's edit changes it, a README edit doesn't (real git in a temp repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { changedCovered, coveredDigest, waiverKey, whatNextKey } from "../../src/ask/keys.js";
import { tempDir, testGit } from "../helpers.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function repo(): string {
  const dir = tempDir();
  sh(dir, "init", "-q", "-b", "main");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "T1.txt"), "work\n");
  writeFileSync(path.join(dir, "README.md"), "# r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "c");
  return dir;
}

const treeOf = (dir: string) => { sh(dir, "add", "-A"); return sh(dir, "write-tree"); };

test("keys name exactly what was answered", () => {
  assert.equal(whatNextKey("T1", "ev-9", "sha256:d"), "what-next|T1|ev-9|sha256:d");
  assert.equal(waiverKey("T1", ["R4", "R2"], "sha256:d"), "waiver|T1|R2,R4|sha256:d");
});

test("the covered-files digest changes with a covered file, not with a README edit", async () => {
  const dir = repo();
  const deps = { git: testGit, env: {} };
  const t0 = treeOf(dir);
  const d0 = await coveredDigest(deps, dir, t0, ["src/T1.txt"]);
  assert.match(d0, /^sha256:[0-9a-f]{64}$/);
  writeFileSync(path.join(dir, "README.md"), "# r, edited\n");
  const t1 = treeOf(dir);
  assert.notEqual(t1, t0);
  assert.equal(await coveredDigest(deps, dir, t1, ["src/T1.txt"]), d0);
  assert.deepEqual(await changedCovered(deps, dir, t0, t1, ["src/T1.txt"]), []);
  writeFileSync(path.join(dir, "src", "T1.txt"), "changed\n");
  const t2 = treeOf(dir);
  assert.notEqual(await coveredDigest(deps, dir, t2, ["src/T1.txt"]), d0);
  assert.deepEqual(await changedCovered(deps, dir, t0, t2, ["src/T1.txt"]), ["src/T1.txt"]);
  assert.equal(await coveredDigest(deps, dir, t2, []), await coveredDigest(deps, dir, t0, []), "no files: one value");
});

test("threat 2: the covered files leave out exactly the requirements file rafi wrote, not your docs", async () => {
  const { coveredFiles } = await import("../../src/ask/blocked.js");
  const events = [
    { type: "requirements.written", ticket_id: "T1", data: { path: "notes/requirements/T1.md" }, id: "a", seq: 1 },
    { type: "facts.snapshot", ticket_id: "T1", data: { tree: "t", files: ["docs/requirements/T1.md",
      "notes/requirements/T1.md", "src/a.ts"] }, id: "b", seq: 2 },
  ];
  assert.deepEqual(coveredFiles(events, "T1").files, ["docs/requirements/T1.md", "src/a.ts"]);
});

test("part 6: changedCovered names a non-ASCII (or control-character) covered file by its real name", async () => {
  const dir = repo();
  const deps = { git: testGit, env: process.env };
  const names = ["src/Café.txt", ...(process.platform === "win32" ? [] : ["src/\u0001ctl.txt"])];
  for (const f of names) writeFileSync(path.join(dir, f), "a\n");
  const t0 = treeOf(dir);
  for (const f of names) writeFileSync(path.join(dir, f), "b\n");
  const t1 = treeOf(dir);
  assert.deepEqual(await changedCovered(deps, dir, t0, t1, names), [...names].sort());
  assert.deepEqual(await changedCovered(deps, dir, t0, t0, names), []);
});
