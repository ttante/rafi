// The gate's two tiers (SCN 7.10; M5 plan 10.10). The full tier runs every file; the fast tier runs the current and
// previous milestone's files, plus the engine and spec unit tests and check-rules (always). Plain ESM.
//
// - A scenario's milestones are its ARCH 14 Partial milestones and its Must-pass one (checks/registry.ts).
// - A scenario is active when its block in a scenario file calls step( (a block of only pending steps isn't).
// - The current milestone is the newest milestone at which an active scenario first became active.
// - A scenario file's milestone is the newest milestone of its active scenarios that isn't after the current one
//   (else, for a file of only pending scenarios, the earliest of its scenarios' milestones). A scenario file is
//   read with the local helper files it imports (batch-resume.scenario.ts runs batch-resume-shared.ts).
// - A file under scenarios/test/ names its milestone in a "// Milestone: Mn" line among its first 5 lines.
// - A file with a "// Crash enumeration" line among its first 5 lines is a crash enumeration (SCN 7.7's crash at
//   every step): full tier only (SCN 7.10's Fast row, plan 10.12). A file importing checks/crash.js's enumerators
//   (enumerateCrashes, holds) without that line is a problem, so a new shard can't land in the fast tier unmarked.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ID = /\bid: "(S-[A-Z]+-\d+)"/g;
const MARKER = /^\/\/ Milestone: (M\d+)\s*$/;
const CRASH = /^\/\/ Crash enumeration\b/;
const ENUMERATES = /^import \{[^}]*\b(?:enumerateCrashes|holds)\b[^}]*\} from "\.\.\/checks\/crash\.js"/m;
const head = (text) => text.split("\n").slice(0, 5);

const num = (m) => Number(m.slice(1));
const newest = (ms) => ms.reduce((a, b) => (num(b) > num(a) ? b : a));
const earliest = (ms) => ms.reduce((a, b) => (num(b) < num(a) ? b : a));

/** Each `id: "S-…"` in order, active when the text up to the next id calls step( or ctx.step(. */
export function scenarioBlocks(text) {
  const hits = [...text.matchAll(ID)];
  return hits.map((h, i) => ({ id: h[1],
    active: /\bstep\(/.test(text.slice(h.index, i + 1 < hits.length ? hits[i + 1].index : text.length)) }));
}

/**
 * `registry`: entries with `id`, `milestone`, `partial`; `scenarioFiles`, `testFiles`: `{ path, text }`.
 * Returns `{ current, previous, milestones: Map<path, Mn>, crash, fast, full: Set<path>, problems: string[] }`.
 */
export function selectTier({ registry, scenarioFiles, testFiles }) {
  const byId = new Map(registry.map((e) => [e.id, [...(e.partial ?? []), ...(e.milestone ? [e.milestone] : [])]]));
  const problems = [];
  const known = (b) => byId.get(b.id)?.length;
  const parsed = scenarioFiles.map((f) => ({ ...f, blocks: scenarioBlocks(f.text).filter(known) }));
  const firsts = parsed.flatMap((f) => f.blocks.filter((b) => b.active).map((b) => earliest(byId.get(b.id))));
  const current = firsts.length ? newest(firsts) : null;
  const previous = current && num(current) > 1 ? `M${num(current) - 1}` : null;
  const milestones = new Map();
  for (const f of parsed) {
    if (!f.blocks.length) {
      problems.push(`${f.path}: names no registered scenario, so it has no milestone`);
      continue;
    }
    const due = f.blocks.filter((b) => b.active).flatMap((b) => byId.get(b.id)).filter((m) => num(m) <= num(current));
    milestones.set(f.path, due.length ? newest(due) : earliest(f.blocks.flatMap((b) => byId.get(b.id))));
  }
  for (const f of testFiles) {
    const marker = head(f.text).map((l) => MARKER.exec(l)).find(Boolean);
    if (marker) milestones.set(f.path, marker[1]);
    else problems.push(`${f.path}: no "// Milestone: Mn" line in its first 5 lines`);
  }
  const crash = new Set();
  for (const f of [...scenarioFiles, ...testFiles]) {
    if (head(f.text).some((l) => CRASH.test(l))) crash.add(f.path);
    else if (ENUMERATES.test(f.text)) {
      problems.push(`${f.path}: runs a crash enumeration without a "// Crash enumeration" line in its first 5 lines`);
    }
  }
  const full = new Set(milestones.keys());
  const fast = new Set([...milestones].filter(([p, m]) => (m === current || m === previous) && !crash.has(p))
    .map(([p]) => p));
  return { current, previous, milestones, crash, fast, full, problems };
}

function readWithHelpers(dir, name) {
  const text = readFileSync(path.join(dir, name), "utf8");
  const helpers = [...text.matchAll(/from "\.\/([\w-]+)\.js"/g)].map((m) => `${m[1]}.ts`)
    .filter((h) => !h.endsWith(".scenario.ts") && readdirSync(dir).includes(h));
  return [text, ...helpers.map((h) => readFileSync(path.join(dir, h), "utf8"))].join("\n");
}

/** The tree's scenario files and scenarios/test files, with repo-relative paths as the fast suite names them. */
export function loadTierInput(root = repo) {
  const rel = (sub) => path.join("packages", "scenarios", sub);
  const list = (sub, re) => readdirSync(path.join(root, rel(sub))).filter((n) => re.test(n)).sort();
  const sdir = path.join(root, rel("scenarios"));
  return {
    scenarioFiles: list("scenarios", /\.scenario\.ts$/).map((n) => ({ path: path.join(rel("scenarios"), n),
      text: readWithHelpers(sdir, n) })),
    testFiles: list("test", /\.test\.ts$/).map((n) => ({ path: path.join(rel("test"), n),
      text: readFileSync(path.join(root, rel("test"), n), "utf8") })),
  };
}
