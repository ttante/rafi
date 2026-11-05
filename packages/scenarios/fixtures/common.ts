// Shared fixture setup (SCN 2.1): a temp git repo with one commit, a fixed author, TZ=UTC; 1.0 file writers.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { cachedRepo } from "../harness/fixture-cache.js";
import { madeTemp } from "../harness/temp.js";

export const GIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "Rafi Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Rafi Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
  GIT_AUTHOR_DATE: "2026-11-01T13:00:00Z", GIT_COMMITTER_DATE: "2026-11-01T13:00:00Z", TZ: "UTC",
});

export function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

/** A temp folder, removed when the test process exits with every test passed (harness/temp.ts). */
export function tempRoot(prefix = "rafi-scn-"): string {
  return madeTemp(prefix);
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A git repo with the given files in one commit (built once per job, then copied: C158). */
export function gitRepo(dir: string, files: Record<string, string>): string {
  const all = { "README.md": "# Fixture\n", ...files };
  return cachedRepo(dir, all, (target) => {
    mkdirSync(target, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", target]);
    writeFiles(target, all);
    git(target, ["add", "-A"]);
    git(target, ["commit", "-qm", "fixture"]);
  });
}

export interface FixtureTicket {
  id: string;
  title: string;
  depends_on?: string[];
  tags?: string[];
  size?: string;
  risk?: string;
  required_tests?: string[];
  likely_files?: string[];
}

export function ticketsYaml(tickets: readonly FixtureTicket[]): string {
  return stringify({
    tickets: tickets.map((t, index) => ({
      id: t.id, order: index + 1, title: t.title, area: "app", summary: t.title, priority: "P1",
      size: t.size ?? "S", risk: t.risk ?? "Low", depends_on: t.depends_on ?? [], tags: t.tags ?? ["backend"],
      acceptance: [`${t.title} works.`], required_tests: t.required_tests ?? ["npm test"],
      likely_files: t.likely_files ?? [`src/${t.id}.txt`],
      rollback: null, needs: { internet: null, local_servers: null, installs: [], services: [], credentials: [] },
      open_decisions: [], person_only: [], locked: [],
    })),
  });
}

/** 1.0 project files: config with the marker, tickets, one current-branch delivery unit per ticket. */
export function projectFiles(tickets: readonly FixtureTicket[], extra: Record<string, unknown> = {}) {
  const config = {
    format_version: 1, appName: "fixture", plan_updates: "change-then-tell",
    tickets: { build: { branch_strategy: "current", completion: "none" } }, ...extra,
  };
  const delivery = { version: 1,
    units: tickets.map((t) => ({ id: `U-${t.id}`, tickets: [t.id], completion: "none" })) };
  return {
    "rafi-config.yaml": stringify(config),
    ".tickets/tickets.yaml": ticketsYaml(tickets),
    ".tickets/delivery.yaml": stringify(delivery),
    "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { test: "node -e 0" } }, null, 2),
  };
}

/** Merges `extra` into a project's rafi-config.yaml (one level deep) and commits. */
export function configure(project: string, extra: Record<string, Record<string, unknown>>): void {
  const file = path.join(project, "rafi-config.yaml");
  const config = parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(extra)) config[key] = { ...(config[key] ?? {}), ...value };
  writeFileSync(file, stringify(config));
  git(project, ["commit", "-qam", "configure"]);
}

/** Writes files into a project and commits them. */
export function addFiles(project: string, files: Record<string, string>): void {
  writeFiles(project, files);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "add files"]);
}

/** Per-ticket overrides of `.tickets/tickets.yaml` (risk, acceptance, qa_preparation, …), committed. */
export function setTickets(project: string, overrides: Record<string, Record<string, unknown>>): void {
  const file = path.join(project, ".tickets", "tickets.yaml");
  const doc = parse(readFileSync(file, "utf8")) as { tickets: Record<string, unknown>[] };
  doc.tickets = doc.tickets.map((t) => ({ ...t, ...(overrides[String(t.id)] ?? {}) }));
  writeFileSync(file, stringify(doc));
  git(project, ["commit", "-qam", "set tickets"]);
}
