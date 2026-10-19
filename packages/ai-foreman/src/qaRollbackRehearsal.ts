import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { captureFrozenQaSource, createDisposableQaSnapshot } from "./qaSnapshot.js";
import { canonicalToolPath, isWithinProject } from "./permissions/shellForms.js";

/** Rehearse the current uncommitted product changes against HEAD, never the source Git index. */
export function rehearseRollback(projectDir: string): string {
  const unsafeGitEnvironment = Object.keys(process.env).filter(key => /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|EXEC_PATH|TEMPLATE_DIR|SHALLOW_FILE|QUARANTINE_PATH|NAMESPACE)$/.test(key));
  if (unsafeGitEnvironment.length) throw new Error(`Rollback rehearsal cannot use Git repository overrides: ${unsafeGitEnvironment.join(", ")}`);
  // Provider sandboxes may inject Git configuration. Never apply those
  // settings to the independent clone, and restore the caller's environment.
  const configKeys = Object.keys(process.env).filter(key => /^GIT_CONFIG(?:$|_)/.test(key));
  const savedConfig = new Map(configKeys.map(key => [key, process.env[key]]));
  for (const key of configKeys) delete process.env[key];
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  try { return rehearseWithCleanGitConfig(projectDir); }
  finally {
    for (const key of Object.keys(process.env).filter(key => /^GIT_CONFIG(?:$|_)/.test(key))) delete process.env[key];
    for (const [key, value] of savedConfig) if (value !== undefined) process.env[key] = value;
  }
}

function rehearseWithCleanGitConfig(projectDir: string): string {
  const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, encoding: "utf8", timeout: 30_000 });
  if (topLevel.error || topLevel.status !== 0) throw new Error("Rollback rehearsal requires a Git project");
  if (canonicalToolPath(projectDir) !== canonicalToolPath(topLevel.stdout.trim())) throw new Error("Run rollback rehearsal from the Git project root");
  if (isWithinProject(projectDir, tmpdir())) throw new Error("Rollback rehearsal requires a temporary directory outside the source project");
  const snapshot = createDisposableQaSnapshot(projectDir, { projectDependencies: false });
  const output: string[] = [];
  const childEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", npm_config_offline: "true", npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" };
  // Inherited node:test context otherwise makes a nested test runner silently
  // skip all test files while returning success.
  delete childEnv.NODE_TEST_CONTEXT;
  const run = (program: string, args: string[]) => {
    const result = spawnSync(program, args, {
      cwd: snapshot.path, encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
      env: childEnv,
    });
    if (!args.includes("--stage")) output.push(`$ ${[program, ...args].join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    if (result.error || result.status !== 0) throw new Error(`Rollback rehearsal failed: ${program} ${args.join(" ")} (${result.error?.message ?? `exit ${result.status}`})\n${output.join("\n")}`);
    return result.stdout;
  };
  try {
    const source = snapshot.frozenState;
    if (source.untracked.some(item => item.kind === "symlink")) throw new Error("Rollback rehearsal cannot run with untracked symbolic links");
    run("git", ["-c", "core.hooksPath=/dev/null", "add", "-A", "--", ".", ":(exclude).foreman/**", ":(exclude).rafi/**"]);
    const entries = run("git", ["ls-files", "--stage", "-z"]);
    if (entries.split("\0").some(entry => entry.startsWith("120000 "))) throw new Error("Rollback rehearsal cannot run with tracked symbolic links");
    const changed = run("git", ["diff", "--cached", "--name-only"]);
    if (!changed.trim()) throw new Error("Rollback rehearsal requires uncommitted product changes relative to HEAD");
    run("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Rafi rehearsal", "-c", "user.email=rafi-rehearsal@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Temporary rollback rehearsal"]);
    run("npm", ["test"]);
    run("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Rafi rehearsal", "-c", "user.email=rafi-rehearsal@example.invalid", "-c", "commit.gpgsign=false", "revert", "--no-edit", "HEAD"]);
    run("npm", ["test"]);
    run("git", ["diff", "--exit-code", source.head]);
    const after = captureFrozenQaSource(projectDir);
    if (after.digest !== source.digest) throw new Error("Source project changed during rollback rehearsal; inspect it before continuing");
    return `Rollback rehearsal passed in an independent temporary repository. Verification: npm test before revert exited 0; git revert exited 0; npm test after revert exited 0; git diff --exit-code against captured HEAD exited 0. Its tracked files match the captured HEAD baseline: ${source.head}. The synthetic commit contains all uncommitted product changes, not necessarily only one ticket. Source digest: ${source.digest}.\n${output.join("\n")}`;
  } finally {
    snapshot.remove();
  }
}
