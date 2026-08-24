import { Command } from "commander";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SourceSnapshotStorage } from "rafi-spec";
import {
  deactivateSource,
  loadSourceRegistry,
  refreshSourceRegistry,
  saveSourceRegistry,
  setSourceStorage,
} from "ai-foreman/sources/source-registry.js";

export function buildSourcesCommand(): Command {
  const command = new Command("sources").description("Inspect and manage the project-wide planning source registry.");
  command.command("list")
    .option("-p, --project <dir>", "project directory", ".")
    .option("--all", "include inactive sources")
    .option("--json", "print machine-readable JSON")
    .action((opts) => {
      const root = resolve(opts.project as string); const loaded = loadSourceRegistry(root);
      const entries = loaded.registry.entries.filter((entry) => opts.all || entry.active);
      if (opts.json) { console.log(JSON.stringify({ ...loaded.registry, entries }, null, 2)); return; }
      console.log(`Source storage for new versions: ${loaded.registry.snapshot_storage}`);
      if (!entries.length) console.log("No sources registered.");
      for (const entry of entries) {
        const latest = entry.versions.at(-1);
        console.log(`${entry.id}\t${entry.active ? "active" : "inactive"}\t${entry.type}\t${entry.label}\t${entry.versions.length} version(s)${latest ? `\t${latest.fingerprint.slice(0, 12)}` : ""}`);
      }
      for (const warning of loaded.warnings) console.warn(`warning: ${warning}`);
      for (const pending of loaded.registry.pending ?? []) console.log(`pending\t${pending.description}`);
    });
  command.command("refresh")
    .argument("[ids...]", "source IDs (default: all active sources)")
    .option("-p, --project <dir>", "project directory", ".")
    .option("--source-storage <mode>", "storage for newly captured versions (local | tracked)")
    .action(async (ids: string[], opts) => {
      const root = resolve(opts.project as string); const loaded = loadSourceRegistry(root);
      const storage = parseStorage(opts.sourceStorage);
      const registry = storage ? setSourceStorage(loaded.registry, storage) : loaded.registry;
      const refreshed = await refreshSourceRegistry(root, registry, ids.length ? ids : undefined);
      saveSourceRegistry(root, refreshed.registry);
      console.log(`rafi sources: refreshed ${refreshed.snapshots.length} source snapshot(s)`);
    });
  command.command("remove")
    .argument("<id>", "source ID to deactivate")
    .option("-p, --project <dir>", "project directory", ".")
    .option("-y, --yes", "confirm removal non-interactively")
    .action(async (id: string, opts) => {
      const root = resolve(opts.project as string); const loaded = loadSourceRegistry(root);
      const source = loaded.registry.entries.find((entry) => entry.id === id);
      if (!source) throw new Error(`unknown source: ${id}`);
      const refs = ticketReferences(root, id);
      if (!opts.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("use --yes to deactivate a source non-interactively");
        const { confirm, isCancel } = await import("@clack/prompts");
        const accepted = await confirm({ message: refs.length ? `${refs.length} ticket(s) reference ${id}. Deactivate it for new work? Private cached copies will also be removed.` : `Deactivate ${id} for new work? Private cached copies will also be removed.`, initialValue: false });
        if (isCancel(accepted) || !accepted) return;
      }
      saveSourceRegistry(root, deactivateSource(loaded.registry, id));
      const privateDir = join(root, ".rafi", "source-cache", id);
      if (existsSync(privateDir)) rmSync(privateDir, { recursive: true, force: true });
      console.log(`rafi sources: deactivated ${id}${refs.length ? `; ${refs.length} ticket reference(s) now require restoration of their private snapshots` : ""}`);
    });
  command.command("storage")
    .argument("[mode]", "local or tracked")
    .option("-p, --project <dir>", "project directory", ".")
    .action((mode: string | undefined, opts) => {
      const root = resolve(opts.project as string); const loaded = loadSourceRegistry(root);
      if (!mode) { console.log(loaded.registry.snapshot_storage); return; }
      const storage = parseStorage(mode)!;
      saveSourceRegistry(root, setSourceStorage(loaded.registry, storage));
      console.log(`rafi sources: new versions will use ${storage} storage; existing versions were not moved`);
    });
  return command;
}

function parseStorage(value: unknown): SourceSnapshotStorage | undefined {
  if (value === undefined) return undefined;
  if (value === "local" || value === "tracked") return value;
  throw new Error("source storage must be local or tracked");
}

function ticketReferences(projectDir: string, sourceId: string): string[] {
  const path = join(projectDir, ".tickets", "tickets.yaml");
  if (!existsSync(path)) return [];
  const raw = parseYaml(readFileSync(path, "utf8")) as { tickets?: Array<{ id?: string; source_refs?: Array<{ source_id?: string }> }> };
  return (raw.tickets ?? []).filter((ticket) => ticket.source_refs?.some((ref) => ref.source_id === sourceId)).map((ticket) => ticket.id ?? "unknown");
}
