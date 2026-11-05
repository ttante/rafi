// A `.rafi/progress.yaml` that git left with conflict markers (ARCH 3.7 `:414`; M5 C225, S-PORT-2): split into ours
// (between `<<<<<<<` and `=======`, without a diff3 `|||||||` base section) and theirs (up to `>>>>>>>`), the shared
// lines in both; each side parsed and validated as strictly as an unconflicted file. Merged per entry by the newer
// `at` (ties keep ours), with one line per conflicting ticket naming the side it kept. One invalid side keeps the
// valid side, with one line; two invalid sides are damaged (the database wins). Two rafi-owned entries under one id
// with different identities are both kept, theirs under the next free FIX-<n> (P49). Pure: the caller writes it.
import { checkProgressFile, type ProgressFile } from "rafi-spec/v1";
import { parse } from "yaml";

type Entry = ProgressFile["tickets"][string];
type Side = "ours" | "theirs";
export type Merge = { file: ProgressFile; lines: string[] } | { invalid: string };

const MARK = Object.freeze({ ours: /^<{7}( |$)/, base: /^\|{7}( |$)/, mid: /^={7}$/, theirs: /^>{7}( |$)/ });

export function hasMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})( |$)/m.test(text);
}

/** The two sides' texts, or null when the markers don't pair up. */
function split(text: string): Record<Side, string> | null {
  const out = { ours: [] as string[], theirs: [] as string[] };
  let at: "common" | "ours" | "base" | "theirs" = "common";
  for (const line of text.split("\n")) {
    if (MARK.ours.test(line) && at === "common") at = "ours";
    else if (MARK.base.test(line) && at === "ours") at = "base";
    else if (MARK.mid.test(line) && (at === "ours" || at === "base")) at = "theirs";
    else if (MARK.theirs.test(line) && at === "theirs") at = "common";
    else if (MARK.ours.test(line) || MARK.mid.test(line) || MARK.theirs.test(line) || MARK.base.test(line)) {
      return null;
    } else {
      if (at === "common" || at === "ours") out.ours.push(line);
      if (at === "common" || at === "theirs") out.theirs.push(line);
    }
  }
  return at === "common" ? { ours: out.ours.join("\n"), theirs: out.theirs.join("\n") } : null;
}

function check(text: string): { ok: true; file: ProgressFile } | { ok: false; why: string } {
  try {
    const checked = checkProgressFile(parse(text, { maxAliasCount: 100 }));
    return checked.ok ? checked : { ok: false, why: checked.message };
  } catch {
    return { ok: false, why: "it isn't valid YAML" };
  }
}

const time = (at: string) =>
  (Number.isNaN(Date.parse(at)) ? "?" : new Date(Date.parse(at)).toISOString().slice(11, 16));
const newer = (a: { at: string }, b: { at: string }) =>
  (Date.parse(b.at) || -Infinity) > (Date.parse(a.at) || -Infinity);
const identity = (o: Entry["owned"]) => (o ? JSON.stringify([o.source, o.requirements, o.hint]) : null);

/** Keys by newer `at`, ties ours. */
function byKey<T extends { at: string }>(ours: Record<string, T>, theirs: Record<string, T>): Record<string, T> {
  const out = { ...ours };
  for (const [k, v] of Object.entries(theirs)) if (!out[k] || newer(out[k]!, v)) out[k] = v;
  return out;
}

function fixId(used: Set<string>): string {
  const ns = [...used].map((id) => /^FIX-(\d+)$/.exec(id)).filter(Boolean).map((m) => Number(m![1]));
  return `FIX-${Math.max(0, ...ns) + 1}`;
}

function tickets(ours: ProgressFile["tickets"], theirs: ProgressFile["tickets"], taken: ReadonlySet<string>) {
  const out: Record<string, Entry> = { ...ours };
  const lines: string[] = [];
  const used = new Set([...taken, ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const [id, mine] of Object.entries(ours).sort(([a], [b]) => a.localeCompare(b))) {
    const other = theirs[id];
    if (!other || JSON.stringify(mine) === JSON.stringify(other)) continue;
    if ((mine.owned || other.owned) && identity(mine.owned) !== identity(other.owned)) {
      const key = fixId(used);
      used.add(key);
      out[key] = other;
      lines.push(`${id}: the other side has a different fix ticket with that id; kept it as ${key}.`);
      continue;
    }
    const side: Side = newer(mine, other) ? "theirs" : "ours";
    const [kept, lost] = side === "ours" ? [mine, other] : [other, mine];
    out[id] = kept;
    lines.push(`${id}: kept ${side} (${time(kept.at)} vs ${time(lost.at)})`);
  }
  for (const [id, entry] of Object.entries(theirs)) if (!ours[id]) out[id] = entry;
  return { tickets: out, lines };
}

/** Merges a conflicted progress file; `taken`: ticket ids this computer's database already has. */
export function mergeConflicted(text: string, taken: ReadonlySet<string>): Merge {
  const sides = split(text);
  if (!sides) return { invalid: "its conflict markers don't pair up" };
  const ours = check(sides.ours);
  const theirs = check(sides.theirs);
  if (!ours.ok && !theirs.ok) return { invalid: `neither side of the conflict is valid (${ours.why})` };
  if (!ours.ok || !theirs.ok) {
    const [bad, good] = ours.ok ? ["their", "ours"] : ["our", "theirs"];
    const why = ours.ok ? (theirs as { why: string }).why : ours.why;
    return { file: ours.ok ? ours.file : (theirs as { file: ProgressFile }).file,
      lines: [`.rafi/progress.yaml: ${bad} side of the conflict isn't valid (${why}); kept ${good}.`] };
  }
  const t = tickets(ours.file.tickets, theirs.file.tickets, taken);
  return { file: { version: 1, tickets: t.tickets, questions: byKey(ours.file.questions, theirs.file.questions),
    answers: byKey(ours.file.answers, theirs.file.answers) }, lines: t.lines };
}
