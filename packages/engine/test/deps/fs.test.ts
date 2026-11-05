// C182 (M4 follow-up 3): the takeover's sweep finds writeAtomic's leftovers by name, so the name real writeAtomic
// leaves behind when its rename doesn't happen must match build/resume.ts's pattern, with the file's own name in it.
// The rename is made to fail by putting a non-empty folder where the file goes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TORN_TEMP } from "../../src/build/resume.js";
import { realFs } from "../../src/deps/real/fs.js";
import { tempDir } from "../helpers.js";

test("real writeAtomic's leftover temp file is named as the takeover's sweep expects", async () => {
  const dir = tempDir();
  for (const name of ["T1.md", "progress.yaml", "index-snapshot", "run-T1-1.json"]) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "x"), "x");
    const fs = realFs({ id: () => randomUUID(), jitter: () => 0 });
    await assert.rejects(fs.writeAtomic(path.join(dir, name), "data"));
    const left = readdirSync(dir).filter((n) => n !== name && n.includes(name));
    assert.equal(left.length, 1, `one temp file beside ${name}: ${left.join(", ")}`);
    assert.equal(TORN_TEMP.exec(left[0]!)?.[1], name, `${left[0]} matches, naming ${name}`);
  }
});
