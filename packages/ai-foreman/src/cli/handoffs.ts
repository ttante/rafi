import { Command } from "commander";
import { resolve } from "node:path";
import { recoverableBuildRuns } from "../buildRuns.js";
import { HandoffService, writeHandoffInspection } from "../handoffs.js";
import { WorkflowDb } from "../workflowDb.js";

export function buildHandoffsCommand(): Command {
  const command = new Command("handoffs").description("Inspect and explicitly manage validated cumulative handoffs.");

  command.command("inspect")
    .requiredOption("--run <id>", "build run ID")
    .option("--generation <n>", "handoff generation")
    .option("--format <format>", "markdown or json", "markdown")
    .option("--output <path>", "write inspection to a file")
    .option("--project <dir>", "project directory", ".")
    .action((opts: Record<string, unknown>) => {
      const format = String(opts.format);
      if (!["markdown", "json"].includes(format)) throw new Error("--format must be markdown or json");
      const generation = opts.generation === undefined ? undefined : positiveInteger(opts.generation, "--generation");
      const service = new HandoffService(resolve(String(opts.project)));
      const value = service.inspect(String(opts.run), generation);
      const content = format === "json"
        ? `${JSON.stringify({ version: 1, lineage: value.lineage, manifest: value.manifest }, null, 2)}\n`
        : value.markdown;
      if (opts.output) {
        writeHandoffInspection(String(opts.output), content);
        console.log(`rafi handoffs: wrote ${format} inspection to ${resolve(String(opts.output))}`);
      } else process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    });

  command.command("prune-cache")
    .requiredOption("--run <id>", "build run ID")
    .option("--keep-latest <n>", "number of newest cache generations to keep", "1")
    .option("--project <dir>", "project directory", ".")
    .action((opts: Record<string, unknown>) => {
      const keep = nonNegativeInteger(opts.keepLatest, "--keep-latest");
      const removed = new HandoffService(resolve(String(opts.project))).pruneCache(String(opts.run), keep);
      console.log(`rafi handoffs: pruned ${removed.length} disposable cache generation(s); durable history was preserved`);
    });

  command.command("delete-history")
    .requiredOption("--run <id>", "build run ID")
    .requiredOption("--yes", "confirm irreversible durable history deletion")
    .option("--project <dir>", "project directory", ".")
    .action((opts: Record<string, unknown>) => {
      const projectDir = resolve(String(opts.project));
      const runId = String(opts.run);
      const recoverable = recoverableBuildRuns(projectDir).find((run) => run.runId === runId);
      if (recoverable) throw new Error(`run ${runId} is active or recoverable; finish or explicitly clean up the run before deleting durable handoff history`);
      const db = new WorkflowDb(projectDir);
      try {
        const deleted = db.deleteHandoffHistory(runId);
        console.log(`rafi handoffs: deleted ${deleted} durable handoff generation(s) for run ${runId}`);
        console.log(`rafi handoffs: disposable copies remain until pruned; run: rafi handoffs prune-cache --run ${shellQuote(runId)} --keep-latest 1`);
      } finally { db.close(); }
    });

  return command;
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive safe integer`);
  return result;
}
function nonNegativeInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return result;
}
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
