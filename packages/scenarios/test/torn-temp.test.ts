// Milestone: M4
// M4 follow-up 3, item 1: a crash between writeAtomic's temp write and its rename (deps/real/fs.ts) leaves
// `.<name>.<id>.tmp` beside the file. The build that takes over removes rafi's own leftovers, and only those: names
// in writeAtomic's pattern, for the files rafi writes, in the folders it writes them in (`.rafi/`, `.rafi/cache/`,
// `<docs>/requirements/`). Look-alikes elsewhere, and other names in those folders, stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

const TEMP = /^\..+\.[0-9A-Za-z-]+\.tmp$/;
const temps = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []).filter((n) => TEMP.test(n)).sort();

/** Files that must survive: none is a leftover of rafi's own writes. */
const KEEP = ["docs/requirements/notes.tmp", "docs/requirements/.draft.tmp", "docs/requirements/.T1.md.txt",
  "docs/.T1.md.id-999999.tmp", "src/.T1.md.id-999998.tmp", ".rafi/.mine.json.id-999997.tmp",
  ".rafi/cache/keep.tmp"];

for (const [what, file, at] of [["a requirements file", /docs\/requirements\/T1\.md$/, 1],
  ["the progress file", /\.rafi\/progress\.yaml$/, 2]] as const) {
  test(`a write of ${what} torn at its rename: the takeover removes the temp file, and nothing else`, async () => {
    const root = tempRoot();
    const project = fOne(root);
    const rafi = rafiRunner(newComputer(root), project);
    // M5 (S-START-2 step 4): a start without a terminal names its stopping point; F-ONE's one ticket is all of it.
    const crashed = await rafi("start . --steps 1", { faults: { tornWrite: file, at, atRename: true } });
    assert.ok(crashed.crashed, crashed.output);
    const dirs = [path.join(project, "docs", "requirements"), path.join(project, ".rafi")];
    const left = dirs.flatMap(temps);
    assert.equal(left.length, 1, `the crash left one temp file: ${left.join(", ")}`);
    for (const keep of KEEP) {
      mkdirSync(path.dirname(path.join(project, keep)), { recursive: true });
      writeFileSync(path.join(project, keep), "not rafi's\n");
    }
    const r = await rafi("resume");
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(dirs.flatMap(temps).filter((n) => !KEEP.some((k) => k.endsWith(`/${n}`))), [],
      "no temp file of rafi's own writes is left");
    for (const keep of KEEP) assert.ok(existsSync(path.join(project, keep)), `${keep} is kept`);
  });
}
