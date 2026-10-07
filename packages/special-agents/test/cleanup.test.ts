/**
 * Phase 7 — cleanup gate. Asserts that no file in packages/ still references
 * legacy paths that are deleted in this phase. Red until the refs are fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// test/ -> special-agents/ -> packages/
const PACKAGES_DIR = join(HERE, "../..");

function grepPackages(pattern: string): string[] {
  try {
    const out = execSync(
      `grep -r --include="*.ts" --include="*.md" --exclude="cleanup.test.ts" -l ${JSON.stringify(pattern)} ${JSON.stringify(PACKAGES_DIR)}`,
      { encoding: "utf8" },
    ).trim();
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    // grep exits non-zero when no matches — that's success for us
    return [];
  }
}

test("no packages source references bootstrap-project.sh", () => {
  const matches = grepPackages("bootstrap-project.sh");
  assert.deepEqual(
    matches,
    [],
    `References to bootstrap-project.sh found: ${matches.join(", ")}`,
  );
});

test("no packages source references the retired root agent-files/AGENTS path", () => {
  const legacyPath = "agent-files/AGENTS";
  const permittedPrefix = ".rafi/";
  const matches = grepPackages(legacyPath).filter((path) => {
    const source = readFileSync(path, "utf8");
    let offset = source.indexOf(legacyPath);
    while (offset >= 0) {
      if (source.slice(Math.max(0, offset - permittedPrefix.length), offset) !== permittedPrefix) return true;
      offset = source.indexOf(legacyPath, offset + legacyPath.length);
    }
    return false;
  });
  assert.deepEqual(
    matches,
    [],
    `References to the retired root agent-files/AGENTS path found: ${matches.join(", ")}`,
  );
});

test("no packages source references aiTools/rules", () => {
  const matches = grepPackages("aiTools/rules");
  assert.deepEqual(
    matches,
    [],
    `References to aiTools/rules found: ${matches.join(", ")}`,
  );
});

test("no packages source references skillsPlan.md", () => {
  const matches = grepPackages("skillsPlan.md");
  assert.deepEqual(
    matches,
    [],
    `References to skillsPlan.md found: ${matches.join(", ")}`,
  );
});

test("no packages source references nextAdditions.md", () => {
  const matches = grepPackages("nextAdditions.md");
  assert.deepEqual(
    matches,
    [],
    `References to nextAdditions.md found: ${matches.join(", ")}`,
  );
});
