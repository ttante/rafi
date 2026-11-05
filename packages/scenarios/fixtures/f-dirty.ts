// F-DIRTY (SCN 2.1 `:64`; M5 plan C219): F-CHAIN with a committer identity and `branch_strategy: branch-per-ticket`
// saved (so the build makes worktrees), plus your uncommitted work: an edit to the tracked `src/T1.txt` and an
// untracked folder `notes/` with two files. QA off (speed).
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CHAIN } from "./f-chain.js";
import { git, gitRepo, projectFiles, tempRoot } from "./common.js";

export function fDirty(root = tempRoot()): string {
  const files = projectFiles(CHAIN, { harness: { qa: false },
    tickets: { build: { branch_strategy: "branch-per-ticket", completion: "none" } } });
  const dir = gitRepo(path.join(root, "f-dirty"), { ...files, "src/T1.txt": "T1 start\n", "src/T2.txt": "T2 start\n" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Rafi Fixture"]);
  git(dir, ["config", "user.email", "fixture@example.test"]);
  writeFileSync(path.join(dir, "src", "T1.txt"), "T1 start\nmy uncommitted edit\n");
  mkdirSync(path.join(dir, "notes"), { recursive: true });
  writeFileSync(path.join(dir, "notes", "a.md"), "# my notes\n");
  writeFileSync(path.join(dir, "notes", "b.txt"), "more notes\n");
  return dir;
}
