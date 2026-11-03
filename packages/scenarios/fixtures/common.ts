// Shared fixture setup (SCN 2.1): a temp git repo with one commit, a fixed author, TZ=UTC; 1.0 file writers.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";

export const GIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "Rafi Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Rafi Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
  GIT_AUTHOR_DATE: "2026-11-01T13:00:00Z", GIT_COMMITTER_DATE: "2026-11-01T13:00:00Z", TZ: "UTC",
});

export function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

export function tempRoot(prefix = "rafi-scn-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A git repo with the given files in one commit. */
export function gitRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFiles(dir, { "README.md": "# Fixture\n", ...files });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "fixture"]);
  return dir;
}

export interface FixtureTicket {
  id: string;
  title: string;
  depends_on?: string[];
  tags?: string[];
  size?: string;
  risk?: string;
}

export function ticketsYaml(tickets: readonly FixtureTicket[]): string {
  return stringify({
    tickets: tickets.map((t, index) => ({
      id: t.id, order: index + 1, title: t.title, area: "app", summary: t.title, priority: "P1",
      size: t.size ?? "S", risk: t.risk ?? "Low", depends_on: t.depends_on ?? [], tags: t.tags ?? ["backend"],
      acceptance: [`${t.title} works.`], required_tests: ["npm test"], likely_files: [`src/${t.id}.txt`],
      rollback: null, needs: { internet: null, local_servers: null, installs: [], services: [], credentials: [] },
      open_decisions: [], person_only: [], locked: [],
    })),
  });
}

/** 1.0 project files: config with the marker, tickets, one current-branch delivery unit per ticket. */
export function projectFiles(tickets: readonly FixtureTicket[], extra: Record<string, unknown> = {}) {
  const config = {
    format_version: 1, app_name: "fixture", plan_updates: "change-then-tell",
    tickets: { build: { branch_strategy: "current", completion: "none" } }, ...extra,
  };
  const delivery = { delivery_units: tickets.map((t) => ({ id: `U-${t.id}`, tickets: [t.id], completion: "none" })) };
  return {
    "rafi-config.yaml": stringify(config),
    ".tickets/tickets.yaml": ticketsYaml(tickets),
    ".tickets/delivery.yaml": stringify(delivery),
    "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { test: "node -e 0" } }, null, 2),
  };
}
