// Copies a frozen 0.10.x fixture (F-LEGACY, F-LEGACY-RUNNING) into a fresh git repo. The manifest says which
// paths git tracks; the rest (.rafi/, .tickets/ticket-state.sqlite, …) are copied untracked, as 0.10.2 left them.
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./common.js";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
export const LEGACY_DIR = path.join(here, "legacy");

interface Manifest {
  readonly generatedWith: string;
  readonly tracked: readonly string[];
  readonly unfinishedRun?: string;
}

export function legacyManifest(name: "F-LEGACY" | "F-LEGACY-RUNNING"): Manifest {
  const file = path.join(LEGACY_DIR, name, "manifest.json");
  if (!existsSync(file)) {
    throw new Error(`${name} isn't generated; run node packages/scenarios/fixtures/legacy/generate.mjs once`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

export function copyLegacy(name: "F-LEGACY" | "F-LEGACY-RUNNING", root: string): string {
  const manifest = legacyManifest(name);
  const dest = path.join(root, name.toLowerCase());
  cpSync(path.join(LEGACY_DIR, name, "project"), dest, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dest]);
  git(dest, ["add", "--", ...manifest.tracked]);
  git(dest, ["commit", "-qm", "frozen 0.10.x fixture"]);
  return dest;
}
