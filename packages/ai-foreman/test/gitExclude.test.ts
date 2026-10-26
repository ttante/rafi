import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalGitExcludes } from "../src/gitExclude.js";
import { ensureForemanExcluded } from "../src/branch/git.js";

test("a template-symlinked info/exclude is made repository-local instead of written through", () => {
  // Regression: init.templateDir installed .git/info/exclude as a link to a
  // shared dotfiles file, so every repository's Rafi entries landed there.
  const root = mkdtempSync(join(tmpdir(), "rafi-git-exclude-"));
  try {
    const shared = join(root, "shared-exclude");
    writeFileSync(shared, "# shared template rules\n*.swp\n");
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    symlinkSync(shared, join(repo, ".git", "info", "exclude"));

    ensureLocalGitExcludes(repo, [".rafi/recovery.sqlite3"], { fallbackToGitignore: true });
    ensureForemanExcluded(repo);

    assert.equal(readFileSync(shared, "utf8"), "# shared template rules\n*.swp\n", "the shared file is untouched");
    const local = join(repo, ".git", "info", "exclude");
    assert.equal(lstatSync(local).isSymbolicLink(), false);
    assert.equal(readFileSync(local, "utf8"), "# shared template rules\n*.swp\n.rafi/recovery.sqlite3\n\n.foreman/\n", "the repository keeps the template rules plus its own");

    ensureLocalGitExcludes(repo, [".rafi/recovery.sqlite3"], { fallbackToGitignore: true });
    assert.equal(readFileSync(local, "utf8").split(".rafi/recovery.sqlite3").length, 2, "entries are added once");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("without a local exclude file entries go to .gitignore only when allowed", () => {
  const repo = mkdtempSync(join(tmpdir(), "rafi-git-exclude-fallback-"));
  try {
    ensureForemanExcluded(repo);
    assert.throws(() => readFileSync(join(repo, ".gitignore"), "utf8"));
    ensureLocalGitExcludes(repo, [".rafi/observability.sqlite3"], { fallbackToGitignore: true });
    assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), ".rafi/observability.sqlite3\n");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
