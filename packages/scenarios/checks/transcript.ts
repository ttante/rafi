// The fake agent's transcript (SCN 2.2, 7.3): one JSONL line per request the fake got, and helpers.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface TranscriptEntry {
  readonly role: string;
  readonly ticket: string | null;
  readonly step: string | null;
  readonly attempt: number | null;
  readonly session: "new" | "reused";
  readonly instructions: string;
  readonly message: string;
  readonly sandbox: unknown;
}

export function appendTranscript(file: string, entry: TranscriptEntry): void {
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readTranscript(file: string): TranscriptEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TranscriptEntry);
}

/** How many times a rule pack's text appears per session (S-CTX-1: rules go once per session). */
export function countPerSession(entries: readonly TranscriptEntry[], text: string): number[] {
  const counts: number[] = [];
  for (const entry of entries) {
    if (entry.session === "new") counts.push(0);
    const n = (entry.instructions + entry.message).split(text).length - 1;
    if (counts.length) counts[counts.length - 1]! += n;
  }
  return counts;
}

/** The turns in order, as "builder T3#1" labels, for order assertions. */
export function turnOrder(entries: readonly TranscriptEntry[]): string[] {
  return entries.map((e) => `${e.role} ${e.ticket ?? "-"}#${e.attempt ?? 0}`);
}
