// C158 (M4 plan, slice 0): a fixture repo is built once per job into a cache folder, then byte-copied per use. The
// repo's commit ids stay the same because the author, the time and the content are fixed (fixtures/common.ts).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { madeTemp } from "./temp.js";

const templates = new Map<string, string>();
let folder: string | null = null;

export const fixtureCache = { hits: 0, builds: 0 };

/** This job's template folder, once a fixture was built (the cleanup test). */
export function cacheFolder(): string | null {
  return folder;
}

/** Copies the template for `files` into `dir`, building it with `make` the first time in this job. */
export function cachedRepo(dir: string, files: Record<string, string>, make: (target: string) => void): string {
  const key = createHash("sha256").update(JSON.stringify(Object.entries(files).sort())).digest("hex").slice(0, 16);
  let template = templates.get(key);
  if (template && existsSync(template)) {
    fixtureCache.hits += 1;
  } else {
    folder ??= madeTemp("rafi-fixture-cache-");
    template = path.join(folder, key);
    make(template);
    templates.set(key, template);
    fixtureCache.builds += 1;
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  cpSync(template, dir, { recursive: true, verbatimSymlinks: true });
  return dir;
}
