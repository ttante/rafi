// S-ENG-5 steps 1, 2 and 4 in the process set, on the built launcher. Step 3 needs a build (M2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshot } from "../checks/snapshot.js";
import { git, tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { copyLegacy, LEGACY_DIR } from "../fixtures/legacy.js";
import { project as legacyProject } from "../fixtures/legacy/generate.mjs";
import { launcher } from "../harness/process.js";

test("S-ENG-5 step 1: without RAFI_ENGINE, the old engine builds T1 on a 0.10.x project", { timeout: 300_000 },
  () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "rafi-eng5-"));
    const { root, extra } = legacyProject(path.join(scratch, "faults"), path.join(scratch, "ops"));
    const r = launcher(["start", root, "--steps", "1", "--no-qa", "--yes", "--agent", "codex", "--dirty-work",
      "include"], { cwd: root, pathFirst: path.join(root, "bin"), env: extra });
    const output = `${r.stdout}${r.stderr}`;
    assert.equal(r.code, 0, output.slice(-3000));
    assert.match(output, /T001\s+\S+\s+\S+\s+done/, "the old engine finished T001");
  });

test("S-ENG-5 step 2: without RAFI_ENGINE, a 1.0 project is refused and nothing is written", () => {
  const dir = fOne(tempRoot());
  const before = snapshot(dir);
  const r = launcher(["start", ".", "--steps", "1"], { cwd: dir });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(r.stderr, "This project uses 1.0 formats; set RAFI_ENGINE=next.\n");
  assert.equal(r.stdout, "");
  assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=all"]), "");
  assert.ok(!existsSync(path.join(dir, ".tickets", "ticket-state.sqlite")));
  assert.ok(!existsSync(path.join(dir, ".foreman")));
  assert.deepEqual(snapshot(dir), before);
  for (const form of [["--version"], ["--help"], ["help", "start"]]) {
    assert.equal(launcher(form, { cwd: dir }).code, 0, `${form.join(" ")} works on a 1.0 project`);
  }
});

test("S-ENG-5 step 4: RAFI_ENGINE=next rafi resume on F-LEGACY-RUNNING names the run and the 0.10.x commands",
  () => {
    const dir = copyLegacy("F-LEGACY-RUNNING", tempRoot());
    const manifest = JSON.parse(readFileSync(path.join(LEGACY_DIR, "F-LEGACY-RUNNING", "manifest.json"), "utf8"));
    const before = snapshot(dir);
    const r = launcher(["resume"], { cwd: dir, engine: "next" });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`run ${manifest.unfinishedRun}`));
    assert.match(r.stderr, /`rafi resume`.*`rafi build:reset`.*without RAFI_ENGINE/);
    assert.deepEqual(snapshot(dir), before);
  });

test("S-MIG-2 step 1 (process): RAFI_ENGINE=next rafi start on F-LEGACY exits 1 in one line", () => {
  const dir = copyLegacy("F-LEGACY", tempRoot());
  const before = snapshot(dir);
  const r = launcher(["start", ".", "--steps", "1"], { cwd: dir, engine: "next" });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "rafi: This project uses 0.10.x formats. Run `rafi migrate` first.\n");
  assert.deepEqual(snapshot(dir), before);
});
