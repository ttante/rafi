// Saved interviews (C150, FILE-31): `.rafi/interviews/<id>.json` in the 1.0 shape, read and validated here. The
// picker lists unfinished ones, newest first; `--discard` removes one by a unique prefix; every command that writes
// prunes completed records older than 30 days on the clock, never unfinished ones (P38). A record whose real path
// leaves the folder (a symlink), whose id isn't plain, or that's over 1 MB is skipped and never read or removed.
import path from "node:path";
import { checkInterview, type InterviewV1 } from "rafi-spec/v1";
import type { Fs } from "../deps/types.js";

export const INTERVIEWS_DIR = path.join(".rafi", "interviews");
export const RETENTION_MS = 30 * 24 * 3_600_000;
const MAX_BYTES = 1_000_000;
const PLAIN = /^[A-Za-z0-9-]+$/;

/** The command each interview belongs to, and the milestone that builds it. */
export const INTERVIEW_COMMANDS: Readonly<Record<string, { command: string; milestone: string }>> = Object.freeze({
  create: { command: "rafi create", milestone: "M10" }, plan: { command: "rafi plan", milestone: "M9" },
  "ticket-setup": { command: "rafi tickets plan", milestone: "M9" },
});

export type Interview = InterviewV1 & { readonly file: string };

export interface InterviewRead {
  readonly records: Interview[];
  readonly skipped: { file: string; why: string }[];
}

async function inside(fs: Fs, folder: string, file: string): Promise<boolean> {
  const [real, root] = await Promise.all([fs.realpath(file), fs.realpath(folder)]);
  return Boolean(real && root && path.dirname(real) === root);
}

export async function readInterviews(fs: Fs, project: string): Promise<InterviewRead> {
  const folder = path.join(project, INTERVIEWS_DIR);
  const out: InterviewRead = { records: [], skipped: [] };
  if ((await fs.stat(folder))?.kind !== "dir") return out;
  for (const name of (await fs.list(folder)).filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(folder, name);
    const skip = (why: string) => out.skipped.push({ file: name, why });
    if (!PLAIN.test(name.slice(0, -5))) { skip("its name isn't a plain id"); continue; }
    if (!(await inside(fs, folder, file))) { skip("it points outside .rafi/interviews/"); continue; }
    const info = await fs.stat(file);
    if (info?.kind !== "file") { skip("it isn't a file"); continue; }
    if (info.size > MAX_BYTES) { skip(`it's ${info.size} bytes, over 1 MB`); continue; }
    let value: unknown;
    try { value = JSON.parse(await fs.read(file)); } catch { skip("it isn't valid JSON"); continue; }
    const checked = checkInterview(value);
    if (!checked.ok) { skip(checked.reason); continue; }
    if (`${checked.record.id}.json` !== name) { skip("its id doesn't match its file name"); continue; }
    out.records.push({ ...checked.record, file });
  }
  return out;
}

export function unfinishedInterviews(records: readonly Interview[]): Interview[] {
  return records.filter((r) => r.status !== "completed")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
}

export function findInterview(records: readonly Interview[], prefix: string): Interview | { message: string } {
  if (!PLAIN.test(prefix)) return { message: `${prefix} isn't an interview id.` };
  const matches = records.filter((r) => r.id.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) return { message: `There's no saved interview ${prefix} here.` };
  return { message: `${prefix} matches more than one saved interview (${matches.map((r) => r.id).join(", ")}).` };
}

export async function discardInterview(fs: Fs, project: string, prefix: string):
  Promise<{ ok: true; record: Interview } | { ok: false; message: string }> {
  const found = findInterview((await readInterviews(fs, project)).records, prefix);
  if ("message" in found) return { ok: false, message: found.message };
  await fs.remove(found.file);
  return { ok: true, record: found };
}

/** Removes completed records older than 30 days; returns their ids. Only commands that write call this. */
export async function pruneInterviews(fs: Fs, project: string, now: Date): Promise<string[]> {
  const removed: string[] = [];
  for (const r of (await readInterviews(fs, project)).records) {
    const done = r.status === "completed" ? Date.parse(r.completed_at ?? r.updated_at) : NaN;
    if (now.getTime() - done > RETENTION_MS) {
      await fs.remove(r.file);
      removed.push(r.id);
    }
  }
  return removed;
}
