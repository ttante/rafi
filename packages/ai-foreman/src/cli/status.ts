import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

function fail(message: string): never {
  console.error(`foreman: ${message}`);
  process.exit(1);
}

export function buildStatusCommand(): Command {
  return new Command("status")
    .description("Summarize the most recent foreman run for a project.")
    .argument("<project>", "path to the project directory")
    .action((project: string) => {
      const dir = join(resolve(project), ".foreman");
      if (!existsSync(dir)) fail(`no foreman runs found under ${dir}`);
      const logs = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
      if (logs.length === 0) fail(`no foreman runs found under ${dir}`);

      const latest = join(dir, logs[logs.length - 1]);
      const records = readFileSync(latest, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      const steps = records.filter((r) => r.event === "step");
      const escalations = records.filter((r) => r.event === "escalation");
      const batchEnd = records.reverse().find((r) => r.event === "batch-end");

      console.log(`foreman: latest run ${logs[logs.length - 1]}`);
      console.log(`foreman: ${steps.length} step record(s), ${escalations.length} escalation(s)`);
      if (batchEnd) {
        console.log(`foreman: outcome — ${batchEnd.outcome} (${batchEnd.completed}/${batchEnd.requested})`);
        if (batchEnd.detail) console.log(`foreman: ${batchEnd.detail}`);
      } else {
        console.log("ai-foreman: run is still in progress or did not finish");
      }
      for (const esc of escalations) {
        console.log(`  escalated: ${esc.tool} — ${esc.reason}`);
      }
    });
}
