// F-HUGE (SCN 2.1, SCN-1): a 1.0 project in a repo with no commit yet; and a variant with one commit and an
// ignored folder of 20,000 small files.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  if (!cloned(big)) writeBig(big);
  return dir;
}

const COUNT = 20_000;
const writeBig = (big: string) => {
  mkdirSync(big);
  for (let i = 0; i < COUNT; i += 1) writeFileSync(path.join(big, `f${i}.txt`), "x");
};

/**
 * Speed (M4 part 4): on macOS the ignored folder is an APFS clone (one clonefile(2) call, about 0.4 s against 1.7 s
 * for 20,000 writes) of a template kept in node_modules/.cache, built once per checkout. The clone holds the same
 * 20,000 files; anywhere else, or if cloning fails, the files are written as before.
 */
function cloned(big: string): boolean {
  if (process.platform !== "darwin") return false;
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const template = path.join(repo, "node_modules", ".cache", "rafi-fixtures", `f-huge-big-${COUNT}`);
  if (!existsSync(path.join(template, `f${COUNT - 1}.txt`))) {
    const building = `${template}.${process.pid}`;
    rmSync(building, { recursive: true, force: true });
    mkdirSync(path.dirname(template), { recursive: true });
    writeBig(building);
    try { renameSync(building, template); } catch { rmSync(building, { recursive: true, force: true }); }
  }
  const clone = "import ctypes, sys\nsys.exit(ctypes.CDLL('libc.dylib').clonefile(sys.argv[1].encode(), " +
    "sys.argv[2].encode(), 0) != 0)";
  return spawnSync("python3", ["-I", "-c", clone, template, big]).status === 0 && existsSync(path.join(big,
    `f${COUNT - 1}.txt`));
}
