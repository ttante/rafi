import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, writeRafiConfigYaml } from "../src/compiler.js";
import { createGitignoreModeFromSelection, updateCreateGitignore } from "../src/gitignore.js";
import { buildProjectConfig, defaultAnswers } from "../src/project.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rafi-gitignore-test-"));
}

test("create gitignore saved resume choice normalizes none to no-op", () => {
  assert.equal(createGitignoreModeFromSelection("local-junk"), "local-junk");
  assert.equal(createGitignoreModeFromSelection("all-rafi"), "all-rafi");
  assert.equal(createGitignoreModeFromSelection("none"), undefined);
  assert.equal(createGitignoreModeFromSelection(undefined), undefined);
});

test("create gitignore local-junk mode writes only runtime and cache patterns", () => {
  const dir = tempDir();
  try {
    updateCreateGitignore(dir, "local-junk");
    const content = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(content, /# rafi:start/);
    assert.match(content, /\.foreman\//);
    assert.match(content, /\.rafi\/interviews\//);
    assert.match(content, /\.tickets\/ticket-state\.sqlite/);
    assert.doesNotMatch(content, /rafi-config\.yaml/);
    assert.doesNotMatch(content, /AGENTS\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create gitignore all-rafi mode includes Rafi-created files but not pre-existing root instructions", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "user-owned guidance\n", "utf8");
    const config = buildProjectConfig({ ...defaultAnswers(), runtimeTargets: ["codex"] });
    writeRafiConfigYaml(dir, config);
    compile(dir, config);
    assert.ok(existsSync(join(dir, "rafi-config.yaml")));
    assert.ok(existsSync(join(dir, "docs", "architecture.md")));

    updateCreateGitignore(dir, "all-rafi");
    const content = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(content, /rafi-config\.yaml/);
    assert.match(content, /\.codex\/agents\/builder\.toml/);
    assert.match(content, /docs\/architecture\.md/);
    assert.doesNotMatch(content, /^AGENTS\.md$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
