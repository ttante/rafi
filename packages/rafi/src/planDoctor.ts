import { Command } from "commander";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readInterviewRecords, type InterviewRecord } from "ai-foreman/interviews.js";

export function planningSessionAge(updatedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

export function buildPlanDoctorCommand(options: {
  resume: (projectDir: string, record: InterviewRecord) => Promise<void>;
  select?: (records: InterviewRecord[]) => Promise<string | undefined>;
}): Command {
  return new Command("plan:doctor")
    .description("Recover saved create, plan, and ticket-planning sessions; no flags required.")
    .argument("[project]", "project directory (default: discover from cwd)")
    .action(async (project: string | undefined) => {
      let root = resolve(project ?? process.cwd());
      if (!project) {
        const start = root;
        while (!["rafi-config.yaml", "project.yaml", ".rafi", ".tickets", ".foreman"].some(path => existsSync(join(root, path)))) {
          if (dirname(root) === root) { root = start; break; }
          root = dirname(root);
        }
      }
      const read = readInterviewRecords(root);
      for (const problem of read.problems) console.warn(`rafi plan:doctor: ${problem.path}: ${problem.reason}`);
      const records = read.records.filter(record => record.status !== "completed" && record.status !== "incompatible")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (!records.length) { console.log("rafi plan:doctor: no unfinished planning sessions found. Start with `rafi create`, `rafi plan`, or `rafi tickets plan`."); return; }
      const label = (record: InterviewRecord) => `${record.workflow} ${record.id.slice(0, 8)} — ${planningSessionAge(record.updatedAt)} — ${record.checkpoint}`;
      let id: string | undefined;
      if (options.select) id = await options.select(records);
      else if (!process.stdin.isTTY || !process.stdout.isTTY) {
        for (const record of records) console.log(`${label(record)}\n  ${record.failure?.summary ?? "Interrupted"}\n  rafi resume '${root.replace(/'/g, "'\\''")}' --id ${record.id}`);
        console.log("Run `rafi plan:doctor` in a terminal to select and recover a session.");
        return;
      } else if (records.length === 1) id = records[0]!.id;
      else {
        const { select, isCancel } = await import("@clack/prompts");
        const chosen = await select({ message: "Which planning session should Rafi recover?", options: records.map(record => ({ value: record.id, label: label(record), hint: record.failure?.summary })) });
        if (!isCancel(chosen)) id = chosen;
      }
      if (!id) return;
      const record = records.find(item => item.id === id);
      if (!record) throw new Error("Selected planning session is no longer available");
      console.log(`rafi plan:doctor: recovering ${label(record)}; proposals are revalidated before approval.`);
      await options.resume(root, record);
    });
}
