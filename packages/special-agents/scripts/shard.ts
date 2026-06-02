/**
 * Shard the frozen rules.md snapshot into rule packs under
 * content/rules/<category>/<name>.md (verbatim bodies + front-matter) and the
 * registry content/rules/packs.index.yaml.
 *
 * The generator is split into a pure function {@link shard} (snapshot text in →
 * file contents out, no I/O) and a thin {@link main} that reads the snapshot and
 * writes the result. The pure split lets tests assert the on-disk packs reproduce
 * exactly what the generator would emit, without touching the filesystem.
 *
 * Re-runnable and deterministic. Bodies are sliced contiguously from the snapshot,
 * so concatenating them (in index order) reproduces the source exactly — except
 * the three `template: true` packs, where literal stack values are swapped for
 * `{{placeholders}}` that render back to the originals via content/defaults.yaml.
 *
 * Every section maps to a pack. "Test-Driven Development" gets a `process/tdd` pack
 * (so it flattens into AGENTS.md byte-for-byte for Codex) in addition to the richer
 * standalone `tdd` skill that Claude lazy-loads. A `null` MAP value would drop a
 * section from the packs; none currently do.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Sub = [from: string, to: string];
interface Meta {
  dir: "base" | "process" | "domain" | "templated";
  name: string;
  description: string;
  condition: "always" | "frontend" | "ai" | "cloud" | "backend";
  template?: boolean;
  supersededByForeman?: boolean;
  subs?: Sub[];
}

/** Heading text (without "## ") → pack metadata. "Test-Driven Development" omitted on purpose. */
const MAP: Record<string, Meta | null> = {
  "Core Working Agreement": { dir: "base", name: "core", condition: "always", description: "Senior-level working agreement and change discipline." },
  "Git And Workspace Safety": { dir: "base", name: "git-safety", condition: "always", description: "Protect user changes and avoid destructive git operations." },
  "Code Quality": { dir: "base", name: "code-quality", condition: "always", description: "Clarity, focused modules, explicit errors, stable interfaces." },
  "Definition Of Done": { dir: "base", name: "definition-of-done", condition: "always", description: "What must be true before a change is considered complete." },
  "Agent Response Expectations": { dir: "base", name: "response-expectations", condition: "always", description: "What every final response should include." },

  "Default Stack": {
    dir: "templated", name: "stack", condition: "always", template: true,
    description: "Default stack choices (package manager, frontend, backend, database, cloud).",
    subs: [
      ["`pnpm`", "`{{packageManager}}`"],
      ["Default database: PostgreSQL", "Default database: {{database}}"],
      ["Default frontend: React with TypeScript", "Default frontend: {{frontend}}"],
      ["Default backend: Node.js, Python, or both, based on the project needs", "Default backend: {{backend}}"],
      ["Default cloud infrastructure: AWS", "Default cloud infrastructure: {{cloud}}"],
    ],
  },
  "Infrastructure And Local/Cloud Runtime": {
    dir: "templated", name: "infra", condition: "cloud", template: true,
    description: "Local/cloud runtime parity and infrastructure-as-code expectations.",
    subs: [["Document AWS account/region assumptions", "Document {{cloud}} account/region assumptions"]],
  },
  "Data And Database Rules": {
    dir: "templated", name: "database", condition: "always", template: true,
    description: "Database defaults, migrations, and boundary validation.",
    subs: [["Use PostgreSQL by default", "Use {{database}} by default"]],
  },

  "Standard Project Documents": { dir: "process", name: "project-docs", condition: "always", description: "The standard set of project documents to create and maintain." },
  "Ticket Tracking": { dir: "process", name: "tickets", condition: "always", supersededByForeman: true, description: "Ticket log expectations when no external tracker is configured." },
  "Testing And Verification": { dir: "process", name: "testing", condition: "always", description: "Discover and run the repo's quality commands; verification order." },
  "Automation And CI": { dir: "process", name: "ci", condition: "always", description: "Repeatable scripts and CI aligned with local verification." },
  "Dependency And Supply Chain Governance": { dir: "process", name: "dependencies", condition: "always", description: "Dependency, license, SBOM, and vulnerability governance." },
  "API And Contract Documentation": { dir: "process", name: "api-docs", condition: "always", description: "Machine-readable API docs and contract tests." },
  "Release, Versioning, And Change Management": { dir: "process", name: "release", condition: "always", description: "Changelog, semver, release checklist, and post-release notes." },
  "Business Documentation": { dir: "process", name: "business-docs", condition: "always", description: "Keep business assumptions, costs, and risks current." },
  "Architecture And Decisions": { dir: "process", name: "architecture", condition: "always", description: "Architecture digest and ADR/decision-history discipline." },

  "Scalability And Performance": { dir: "domain", name: "scalability", condition: "always", description: "Scaling strategy across server, cloud, AI, frontend, and data." },
  "Data Governance": { dir: "domain", name: "data-governance", condition: "always", description: "Data classification, retention, consent, and PII handling." },
  "Security, Privacy, And Compliance": { dir: "domain", name: "security", condition: "always", description: "Security, privacy, and compliance baseline." },
  "Robustness And Reliability": { dir: "domain", name: "robustness", condition: "always", description: "Resilient workflows, transactions, health checks, backups." },
  "Observability And Operations": { dir: "domain", name: "observability", condition: "always", description: "Logging, metrics, dashboards, runbooks, and AI observability." },
  "Accessibility, UX, And Product Quality": { dir: "domain", name: "accessibility", condition: "frontend", description: "Accessible, resilient UI and product quality." },
  "AI And LLM Safety": { dir: "domain", name: "ai-safety", condition: "ai", description: "Adversarial safety and abuse protection for AI features." },
  "AI Model And Dataset Governance": { dir: "domain", name: "ai-governance", condition: "ai", description: "Model/provider and dataset governance." },
  "AI Quality, Confidence, And Evals": { dir: "domain", name: "ai-evals", condition: "ai", description: "Quality gates, confidence, evals, and examples for AI." },
  "AI Reproducibility, Replayability, And Prompt Tuning": { dir: "domain", name: "ai-reproducibility", condition: "ai", description: "Replayability, prompt versioning, and prompt tuning." },
  "AI Cost Tracking And Learning Loop": { dir: "domain", name: "ai-cost", condition: "ai", description: "AI cost tracking and the correction/learning loop." },

  "Test-Driven Development": { dir: "process", name: "tdd", condition: "always", description: "Test-driven development discipline: identify behavior, write tests first, then minimal code." },
};

/** Expected number of packs emitted (one per section of the snapshot). */
export const EXPECTED_PACK_COUNT = 29;

interface IndexEntry {
  name: string;
  category: string;
  path: string;
  condition: string;
  template: boolean;
  supersededByForeman?: boolean;
  order: number;
}

/** A single generated pack file: path relative to content/rules + full contents. */
export interface ShardedFile {
  /** e.g. `base/core.md` */
  path: string;
  /** Full file contents (front-matter + body). */
  content: string;
}

export interface ShardResult {
  /** Pack files in source order. */
  files: ShardedFile[];
  /** The rendered packs.index.yaml contents (trailing newline included). */
  indexYaml: string;
  /** The document preamble: everything before the first `## ` heading. */
  preamble: string;
}

/**
 * Pure transform: snapshot markdown → pack files + index. No filesystem access, so
 * it is safe to call from tests and is byte-for-byte deterministic for a given input.
 */
export function shard(snapshotText: string): ShardResult {
  const matches = [...snapshotText.matchAll(/^## (.+)$/gm)];
  if (matches.length === 0) throw new Error("snapshot has no `## ` sections");

  // Everything before the first heading is the doc preamble (the "@AGENTS.md"
  // header). It belongs to no pack but is needed to reproduce AGENTS.md.
  const preamble = snapshotText.slice(0, matches[0].index!);

  const index: IndexEntry[] = [];
  const files: ShardedFile[] = [];
  let order = 0;
  const seenNames = new Set<string>();

  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1];
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : snapshotText.length;
    const chunk = snapshotText.slice(start, end); // contiguous: "## Heading\n...\n" through just before next heading

    if (!(heading in MAP)) throw new Error(`Unmapped section heading: ${JSON.stringify(heading)}`);
    const meta = MAP[heading];
    order += 1000;
    if (meta === null) continue; // TDD → skill

    if (seenNames.has(meta.name)) throw new Error(`Duplicate pack name: ${meta.name}`);
    seenNames.add(meta.name);

    let body = chunk;
    for (const [from, to] of meta.subs ?? []) {
      if (!body.includes(from)) throw new Error(`Sub not found in ${meta.name}: ${JSON.stringify(from)}`);
      body = body.replace(from, to);
    }

    const fm: string[] = [
      "---",
      `name: ${meta.name}`,
      `category: ${meta.dir}`,
      `description: ${JSON.stringify(meta.description)}`,
      `condition: ${meta.condition}`,
      `template: ${meta.template ? "true" : "false"}`,
    ];
    if (meta.supersededByForeman) fm.push("supersededByForeman: true");
    fm.push("---", "");

    const relPath = `${meta.dir}/${meta.name}.md`;
    files.push({ path: relPath, content: fm.join("\n") + body });

    index.push({
      name: meta.name,
      category: meta.dir,
      path: relPath,
      condition: meta.condition,
      template: Boolean(meta.template),
      ...(meta.supersededByForeman ? { supersededByForeman: true } : {}),
      order,
    });
  }

  if (files.length !== EXPECTED_PACK_COUNT) {
    throw new Error(`Expected ${EXPECTED_PACK_COUNT} packs, produced ${files.length}`);
  }

  // packs.index.yaml (hand-emitted for stable, readable output)
  const indexLines: string[] = [
    "# Generated by scripts/shard.ts — registry of rule packs in source order.",
    "packs:",
  ];
  for (const e of index) {
    indexLines.push(`  - name: ${e.name}`);
    indexLines.push(`    category: ${e.category}`);
    indexLines.push(`    path: ${e.path}`);
    indexLines.push(`    condition: ${e.condition}`);
    indexLines.push(`    template: ${e.template}`);
    if (e.supersededByForeman) indexLines.push(`    supersededByForeman: true`);
    indexLines.push(`    order: ${e.order}`);
  }

  return { files, indexYaml: indexLines.join("\n") + "\n", preamble };
}

/** Read the snapshot, shard it, and write packs + index to content/rules. */
function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = join(here, "..");
  const snapshot = join(pkg, "test/fixtures/rules.snapshot.md");
  const rulesDir = join(pkg, "content/rules");

  const { files, indexYaml, preamble } = shard(readFileSync(snapshot, "utf8"));
  for (const f of files) {
    const outPath = join(rulesDir, f.path);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, f.content);
  }
  writeFileSync(join(rulesDir, "packs.index.yaml"), indexYaml);
  writeFileSync(join(pkg, "content/preamble.md"), preamble);
  console.log(`Wrote ${files.length} packs (+ packs.index.yaml, preamble.md).`);
}

// Run only when invoked directly (e.g. `tsx scripts/shard.ts`), not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
