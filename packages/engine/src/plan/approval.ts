// Scope approval at start (ARCH 7.10, 7.6; M5 plan C191). Only a project with a rafi plan (`<docs>/rafi-plan.json`
// with a revision) has a scope to approve; hand-written tickets start as before (S-START-1). The key is
// `scope|<plan revision>|<digest of the material fields of every ticket in tickets.yaml>`: acceptance (with its
// person-only and locked marks), required tests, dependencies, likely files, tags, order, and which tickets exist.
// Titles and summaries are rewording; rafi's own tags (`ticket.tags_added`) and rafi-owned tickets aren't in the
// file, so they stay out. Approved means a `scope.approved` with this key's fingerprint, or the key saved as an answer
// in `.rafi/progress.yaml` (a project approved on another computer), which is then carried into the log.
import { createHash } from "node:crypto";
import path from "node:path";
import { progressFile } from "rafi-spec/v1";
import { parse } from "yaml";
import type { Engine } from "../api/engine.js";
import type { NewEvent } from "../log/types.js";
import { PROGRESS } from "../progress/write.js";

export interface MaterialTicket {
  readonly id: string;
  readonly order?: number;
  readonly acceptance?: readonly string[];
  readonly person_only?: readonly number[];
  readonly locked?: readonly number[];
  readonly required_tests?: readonly string[];
  readonly depends_on?: readonly string[];
  readonly likely_files?: readonly string[];
  readonly tags?: readonly string[];
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** The scope key for this plan revision and these tickets (pure). */
export function scopeKey(revision: number, tickets: readonly MaterialTicket[]): string {
  const material = tickets.map((t) => [t.id, t.order ?? null, t.acceptance ?? [], t.person_only ?? [], t.locked ?? [],
    t.required_tests ?? [], [...(t.depends_on ?? [])].sort(), [...(t.likely_files ?? [])].sort(),
    [...(t.tags ?? [])].sort()]);
  return `scope|${revision}|${sha(JSON.stringify(material))}`;
}

/** `scope.approved`'s `fp`: the fingerprint of the whole key (revision and material fields). */
export const scopeFingerprint = (key: string) => sha(key);

export type Approval = { kind: "none" } | { kind: "approved"; key: string } | { kind: "carried"; key: string }
  | { kind: "ask"; key: string; changed: boolean };

async function planRevision(engine: Engine, docs: string): Promise<number | null> {
  const file = path.join(engine.projectDir, docs, "rafi-plan.json");
  if ((await engine.deps.fs.stat(file))?.kind !== "file") return null;
  try {
    const revision = (JSON.parse(await engine.deps.fs.read(file)) as { revision?: unknown }).revision;
    return Number.isInteger(revision) && Number(revision) >= 0 ? Number(revision) : null;
  } catch {
    return null;
  }
}

async function savedScopeKeys(engine: Engine): Promise<string[]> {
  const file = path.join(engine.projectDir, PROGRESS);
  if ((await engine.deps.fs.stat(file))?.kind !== "file") return [];
  try {
    const checked = progressFile.safeParse(parse(await engine.deps.fs.read(file), { maxAliasCount: 50 }));
    return checked.success ? Object.keys(checked.data.answers).filter((k) => k.startsWith("scope|")) : [];
  } catch {
    return [];
  }
}

/** Whether this start needs PRM-71 (C191). */
export async function approvalFor(engine: Engine, docs: string, tickets: readonly MaterialTicket[]):
  Promise<Approval> {
  const revision = await planRevision(engine, docs);
  if (revision === null) return { kind: "none" };
  const key = scopeKey(revision, tickets);
  const fp = scopeFingerprint(key);
  let before = false;
  for await (const e of engine.events()) {
    if (e.type !== "scope.approved") continue;
    if ((e.data as { fp: string }).fp === fp) return { kind: "approved", key };
    before = true;
  }
  const saved = await savedScopeKeys(engine);
  if (saved.includes(key)) return { kind: "carried", key };
  return { kind: "ask", key, changed: before || saved.length > 0 };
}

/** The approval as the question record (so its key is saved in the progress file) and `scope.approved`, written
 * with `build.started` (R3). */
export function approvalEvents(engine: Engine, run: string, key: string, by: "user" | "auto-approve" | "carried"):
  NewEvent[] {
  const no = Math.max(0, ...Object.values(engine.fold().questions).map((q) => q.no)) + 1;
  const id = `question-${no}`;
  const source = by === "user" ? "terminal" : by === "carried" ? "progress-file" : "auto-approve";
  const actor = by === "user" ? "user" : "engine";
  return [
    { type: "question.opened", run_id: run, actor: "engine", data: { id, no, kind: "plan", tickets: [],
      text: "How does this plan look?", options: [{ id: "proceed", label: "Proceed — start implementing" },
        { id: "feedback", label: "Give feedback — revise the plan" }, { id: "cancel", label: "Cancel" }],
      recommended: "proceed", context: null, urgency: "normal", key } },
    { type: "question.answered", run_id: run, actor, source, data: { id, choice: "proceed", text: null, note: null,
      save: "project" } },
    { type: "scope.approved", run_id: run, actor, source, data: { fp: scopeFingerprint(key), by } },
  ];
}
