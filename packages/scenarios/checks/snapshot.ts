// A content snapshot of a folder tree (path → size and SHA-256), for "nothing was written" checks.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export function snapshot(dir: string, skip: readonly string[] = [".git"]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const child = rel ? path.join(rel, name) : name;
      if (skip.includes(child)) continue;
      const full = path.join(dir, child);
      const info = statSync(full);
      if (info.isDirectory()) {
        out[`${child}/`] = "dir";
        walk(child);
      } else {
        out[child] = `${info.size}:${createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16)}`;
      }
    }
  };
  walk("");
  return out;
}
