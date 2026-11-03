// F-HUGE (SCN 2.1, SCN-1): a 1.0 project in a repo with no commit yet; and a variant with one commit and an
// ignored folder of 20,000 small files.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitRepo, projectFiles, tempRoot, writeFiles } from "./common.js";

const T1 = { id: "T1", title: "Add the empty-state message" };

export function fHuge(root = tempRoot(), variant: "no-commit" | "ignored"): string {
  const dir = path.join(root, `f-huge-${variant}`);
  if (variant === "no-commit") {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    writeFiles(dir, { "README.md": "# Fixture\n", ...projectFiles([T1]) });
    return dir;
  }
  gitRepo(dir, { ...projectFiles([T1]), ".gitignore": "big/\n" });
  const big = path.join(dir, "big");
  mkdirSync(big);
  for (let i = 0; i < 20_000; i += 1) writeFileSync(path.join(big, `f${i}.txt`), "x");
  return dir;
}
