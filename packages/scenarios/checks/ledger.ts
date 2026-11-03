// The coverage ledger (SCN 7.9, harness E01; plan choice C21). It generates the coverage table from the
// registered scenarios and compares it with SCN section 10; it never rewrites the locked doc.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Registered } from "./registry.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const readDoc = (name: string) => readFileSync(path.join(repo, name), "utf8");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`can't find "${start}" … "${end}"`);
  return text.slice(from, to);
}

/** First-column IDs of every table row in REQ sections 2–8. */
export function requirementIds(req: string): string[] {
  const body = between(req, "\n## 2. ", "\n## 9. ");
  const ids = body.split("\n").map((line) => /^\| ([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+) \|/.exec(line)?.[1])
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

/** SCN section 10 as a map: ID → the scenarios it lists, or "not-testable". */
export function coverageTable(scn: string): Map<string, string[] | "not-testable"> {
  const body = between(scn, "\n## 10. Coverage", "\n## 11. ");
  const table = new Map<string, string[] | "not-testable">();
  for (const line of body.split("\n")) {
    const row = /^\| ([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+) \| ([^|]*) \|/.exec(line);
    if (!row) continue;
    const cell = row[2]!;
    table.set(row[1]!, cell.includes("not scenario-testable") ? "not-testable" : cell.match(/S-[A-Z]+-\d+/g) ?? []);
  }
  return table;
}

/** The coverage table the registry implies. */
export function generatedTable(registry: readonly Registered[], ids: readonly string[]): Map<string, string[]> {
  const table = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const entry of registry) {
    for (const id of entry.covers) table.get(id)?.push(entry.id);
  }
  return table;
}

export interface LedgerReport {
  readonly uncovered: string[];
  readonly drift: string[];
  readonly unknownCovers: string[];
}

export function ledger(registry: readonly Registered[], req: string, scn: string): LedgerReport {
  const ids = requirementIds(req);
  const doc = coverageTable(scn);
  const generated = generatedTable(registry, ids);
  const uncovered = ids.filter((id) => generated.get(id)!.length === 0 && doc.get(id) !== "not-testable");
  const drift: string[] = [];
  for (const id of ids) {
    const want = doc.get(id);
    const got = [...generated.get(id)!].sort();
    if (want === undefined) drift.push(`${id} is missing from SCN section 10`);
    else if (want === "not-testable") { if (got.length) drift.push(`${id}: SCN says not testable, covered by ${got}`); }
    else if (JSON.stringify([...want].sort()) !== JSON.stringify(got)) {
      drift.push(`${id}: SCN 10 lists ${[...want].sort().join(", ")}; the scenarios give ${got.join(", ")}`);
    }
  }
  for (const id of doc.keys()) if (!ids.includes(id)) drift.push(`${id} is in SCN 10 but not in REQ 2–8`);
  const known = new Set(ids);
  const unknownCovers = registry.flatMap((e) => e.covers.filter((id) => !known.has(id)).map((id) => `${e.id}: ${id}`));
  return { uncovered, drift, unknownCovers };
}
