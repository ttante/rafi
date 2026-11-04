// The full fingerprint (ARCH 4.7, Q-COPY-1; C118): every non-ignored file's content, hashed afresh. A temporary
// index that starts empty (no stat cache to trust) gets `git add -A`; its tree is the fingerprint. Git stores a
// symlink as its link text, so links are never followed (`git hash-object` on a path does follow them), and
// ignored folders are never read. Files and bytes come from `git ls-tree -r -l`. The real index is never touched.
import path from "node:path";
import type { SnapshotDeps } from "./snapshot.js";

export interface FullFingerprint {
  readonly fp: string;
  readonly tree: string;
  readonly files: number;
  readonly bytes: number;
}

async function git(deps: SnapshotDeps, cwd: string, args: string[], index: string): Promise<string> {
  const r = await deps.git(args, { cwd, env: { ...deps.env, GIT_INDEX_FILE: index } });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout;
}

export async function fullFingerprint(deps: SnapshotDeps, cwd: string, key: string): Promise<FullFingerprint> {
  const cache = path.join(cwd, ".rafi", "cache");
  await deps.fs.mkdir(cache);
  const index = path.join(cache, `index-full-${key}`);
  await deps.fs.remove(index);
  try {
    await git(deps, cwd, ["add", "-A", "--", ".", ":(exclude).rafi"], index);
    const tree = (await git(deps, cwd, ["write-tree"], index)).trim();
    let files = 0;
    let bytes = 0;
    for (const line of (await git(deps, cwd, ["ls-tree", "-r", "-l", tree], index)).split("\n")) {
      const size = /^\d+ blob [0-9a-f]+ +(\d+)\t/.exec(line);
      if (!size) continue;
      files += 1;
      bytes += Number(size[1]);
    }
    return { fp: `tree:${tree}`, tree, files, bytes };
  } finally {
    await deps.fs.remove(index);
  }
}
