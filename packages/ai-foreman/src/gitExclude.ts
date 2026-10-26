import { appendFileSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Add missing ignore entries for Rafi's local state to a repository.
 *
 * Prefers the repository-local `.git/info/exclude`. A git template
 * (`init.templateDir`) can install that file as a symlink to one shared
 * file, so appending through it would add this project's entries to every
 * repository using the template. Such a link is first replaced by a regular
 * file with the same rules, keeping the change local to this repository.
 *
 * Without a local exclude file, entries go to `.gitignore` when
 * `fallbackToGitignore` is set; otherwise nothing is written.
 */
export function ensureLocalGitExcludes(projectDir: string, entries: readonly string[], options: { fallbackToGitignore?: boolean; leadingBlankLine?: boolean } = {}): void {
  const localExclude = join(projectDir, ".git", "info", "exclude");
  let path: string | undefined;
  let isLink = false;
  try { isLink = lstatSync(localExclude).isSymbolicLink(); path = localExclude; } catch { /* no local exclude file */ }
  if (!path) {
    if (!options.fallbackToGitignore) return;
    path = join(projectDir, ".gitignore");
  }
  let existing = "";
  try { existing = existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { existing = ""; }
  const lines = existing.split(/\r?\n/);
  const missing = entries.filter((entry) => !lines.includes(entry));
  if (!missing.length) return;
  if (isLink) {
    unlinkSync(path);
    writeFileSync(path, existing, "utf8");
  }
  const separator = options.leadingBlankLine ? "\n" : existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${separator}${missing.join("\n")}\n`, "utf8");
}
