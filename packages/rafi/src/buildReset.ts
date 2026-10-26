import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { resetTickets } from "ai-foreman/tickets/reset.js";
import { readRecoveryOwners } from "ai-foreman/recovery-owners.js";
import { classifyProcess } from "ai-foreman/process-identity.js";

/**
 * Return the project to the durable state immediately after ticket
 * population. Recovery history is retained in a timestamped archive; it is
 * not allowed to participate in the next build.
 */
export function resetBuildState(projectDir: string, now = new Date()): { archiveDir: string; tickets: string[] } {
  const root = resolve(projectDir);
  const dbPath = join(root, ".rafi", "recovery.sqlite3");
  // Inspect owners without migrating: a database written by an older Rafi
  // cannot be opened as a writer while it still holds a dead build's admission.
  for (const owner of readRecoveryOwners(dbPath)) {
    if (owner.pid === null || classifyProcess(owner.pid, owner.processStart, owner.host).state !== "dead") {
      throw new Error(`cannot reset while a live or unverified Rafi process owns the project (${owner.source} pid ${owner.pid ?? "unknown"}, run ${owner.runId})`);
    }
  }

  const stamp = now.toISOString().replaceAll(/[^0-9A-Za-z-]/g, "-");
  const archiveDir = join(root, ".rafi", "recovery-archive", stamp);
  mkdirSync(archiveDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) renameSync(source, join(archiveDir, `recovery.sqlite3${suffix}`));
  }

  const runsDir = join(root, ".foreman", "runs");
  const archivedRuns = join(archiveDir, "foreman-runs");
  if (existsSync(runsDir)) {
    mkdirSync(archivedRuns, { recursive: true });
    for (const name of readdirSync(runsDir)) {
      if (name.endsWith(".json")) renameSync(join(runsDir, name), join(archivedRuns, name));
    }
  }

  const reset = resetTickets(root, "all", "build-reset", now);
  return { archiveDir, tickets: reset.tickets };
}

export function buildResetCommand(): Command {
  return new Command("build:reset")
    .description("Archive all Rafi recovery state and reset tickets to their post-population state.")
    .argument("[project]", "project directory", ".")
    .option("--yes", "confirm the destructive-to-recovery-state reset")
    .action((project: string, opts: { yes?: boolean }) => {
      if (!opts.yes) throw new Error("build:reset archives all recovery state; rerun with --yes");
      const result = resetBuildState(project);
      console.log(`rafi: archived recovery state at ${result.archiveDir}`);
      console.log(`rafi: reset ${result.tickets.length} ticket(s) to planned`);
      console.log("rafi: source files and diagnostic logs were preserved");
    });
}
