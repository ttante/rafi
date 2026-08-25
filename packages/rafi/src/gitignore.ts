import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readInstallManifest } from "./ownership.js";

export type CreateGitignoreMode = "local-junk" | "all-rafi";
export type CreateGitignoreSelection = CreateGitignoreMode | "none";

const BLOCK_START = "# rafi:start";
const BLOCK_END = "# rafi:end";

const LOCAL_JUNK_PATTERNS = [
  ".foreman/",
  ".rafi/interviews/",
  ".rafi/source-cache/",
  ".rafi/staging/",
  ".rafi/recovery.sqlite3",
  ".rafi/ownership-backups/",
  ".tickets/imports/",
  ".tickets/backups/",
  ".tickets/ticket-state.sqlite",
  ".tickets/ticket-state.sqlite-shm",
  ".tickets/ticket-state.sqlite-wal",
  ".tickets/.gitignore",
];

export function updateCreateGitignore(projectDir: string, mode: CreateGitignoreMode | undefined): void {
  if (!mode) return;
  const patterns = mode === "all-rafi"
    ? unique([...LOCAL_JUNK_PATTERNS, ...ownedCreatedPaths(projectDir)])
    : LOCAL_JUNK_PATTERNS;
  writeManagedBlock(projectDir, patterns);
}

export function createGitignoreModeFromSelection(selection: CreateGitignoreSelection | undefined): CreateGitignoreMode | undefined {
  return selection === "local-junk" || selection === "all-rafi" ? selection : undefined;
}

function ownedCreatedPaths(projectDir: string): string[] {
  const manifest = readInstallManifest(projectDir);
  if (!manifest) return [];
  return manifest.files
    .filter((entry) => entry.mode === "created" || entry.mode === "generated")
    .map((entry) => normalizePattern(entry.path))
    .filter(Boolean);
}

function writeManagedBlock(projectDir: string, patterns: string[]): void {
  const path = join(projectDir, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = [
    BLOCK_START,
    ...unique(patterns).sort(),
    BLOCK_END,
    "",
  ].join("\n");
  const pattern = new RegExp(`${escapeRegExp(BLOCK_START)}\\n[\\s\\S]*?${escapeRegExp(BLOCK_END)}\\n?`);
  const next = pattern.test(current)
    ? current.replace(pattern, block)
    : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${block}`;
  if (next !== current) writeFileSync(path, next, "utf8");
}

function normalizePattern(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
