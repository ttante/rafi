import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Capture build input with a private index. Never stash, commit, or modify the user's index. */
export function captureDirtyBaseline(projectDir: string, mode: "preserve" | "include"): { base: string; recordPath: string } {
  const git = (args: string[], env = process.env) => execFileSync("git", args, { cwd: projectDir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["diff", "--name-only", "--diff-filter=U"])) throw new Error("Resolve Git conflicts before starting an isolated build; Rafi has preserved your files.");
  const head = (): string | undefined => { try { return git(["rev-parse", "--verify", "HEAD"]); } catch { return undefined; } };
  const parent = head();
  if (!parent && mode === "preserve") throw new Error("This repository has no committed baseline. Use --dirty-work include to capture current files privately, or make an initial commit first.");
  const directory = join(projectDir, ".foreman/dirty-baselines");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const recordPath = mkdtempSync(join(directory, "baseline-"));
  const indexPath = resolve(projectDir, git(["rev-parse", "--git-path", "index"]));
  const indexDigest = existsSync(indexPath) ? createHash("sha256").update(readFileSync(indexPath)).digest("hex") : null;
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: projectDir }).toString().split("\0").filter(path => path && !path.startsWith(".foreman/") && !/^\.rafi\/(recovery|observability)\.sqlite3/.test(path));
  // HEAD paths are needed too: staged deletions/rename sources no longer exist in the user's index.
  if (parent) paths.push(...execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", parent], { cwd: projectDir }).toString().split("\0").filter(path => path && !path.startsWith(".foreman/") && !/^\.rafi\/(recovery|observability)\.sqlite3/.test(path)));
  const files = [...new Set(paths)].map(path => {
    const absolute = join(projectDir, path);
    if (!existsSync(absolute)) return { path, digest: null };
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      if (mode === "include" && execFileSync("git", ["status", "--porcelain"], { cwd: absolute, encoding: "utf8" }).trim()) throw new Error(`Dirty submodule ${path} cannot be included automatically. Commit its work or use --dirty-work preserve.`);
      return { path, digest: null, kind: "submodule" };
    }
    return { path, digest: createHash("sha256").update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute)).digest("hex"), mode: stat.mode, kind: stat.isSymbolicLink() ? "symlink" : "file" };
  });
  const diffBase = parent ?? execFileSync("git", ["hash-object", "-w", "-t", "tree", "--stdin"], { cwd: projectDir, input: "", encoding: "utf8" }).trim();
  const diff = execFileSync("git", ["diff", diffBase, "--binary"], { cwd: projectDir });
  writeFileSync(join(recordPath, "working.patch"), diff, { mode: 0o600 });
  let base = parent!;
  if (mode === "include") {
    const env = { ...process.env, GIT_INDEX_FILE: join(recordPath, "index"), GIT_AUTHOR_NAME: "Rafi baseline", GIT_AUTHOR_EMAIL: "baseline@rafi.local", GIT_COMMITTER_NAME: "Rafi baseline", GIT_COMMITTER_EMAIL: "baseline@rafi.local" };
    git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
    if (paths.length) execFileSync("git", ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: projectDir, env: { ...env, GIT_LITERAL_PATHSPECS: "1" }, input: `${paths.join("\0")}\0`, stdio: ["pipe", "pipe", "pipe"] });
    const tree = git(["write-tree"], env);
    base = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Rafi preserved dirty build input"], env);
  }
  const finalIndexDigest = existsSync(indexPath) ? createHash("sha256").update(readFileSync(indexPath)).digest("hex") : null;
  const changed = head() !== parent || finalIndexDigest !== indexDigest || files.some(file => {
    if (file.kind === "submodule") return false;
    const absolute = join(projectDir, file.path);
    if (!existsSync(absolute)) return file.digest !== null;
    if (file.digest === null) return true;
    const stat = lstatSync(absolute);
    return createHash("sha256").update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute)).digest("hex") !== file.digest || stat.mode !== file.mode;
  });
  if (changed) throw new Error("Checkout or index changed while capturing the baseline. Your work is preserved; retry after those edits finish.");
  writeFileSync(join(recordPath, "manifest.json"), JSON.stringify({ version: 1, mode, parent, base, indexDigest, status, files, patchDigest: createHash("sha256").update(diff).digest("hex"), createdAt: new Date().toISOString(), delivery: "isolated branches; no automatic merge into dirty checkout" }, null, 2), { mode: 0o600 });
  return { base, recordPath };
}
