import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BranchRunSummary } from "./types.js";

export interface BranchResumeSession {
  ticket: string;
  branch: string;
  base: string;
  worktreePath: string;
  sessionId: string;
  logPath: string;
  agent?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  qaEnabled?: boolean;
  createPr?: boolean;
  completionMode?: string;
  reviewProvider?: string;
  prReady?: boolean;
  keepWorktrees?: boolean;
  ts?: string;
}

export function findResumableBranchSessions(foremanDir: string): BranchResumeSession[] {
  if (!existsSync(foremanDir)) return [];

  const byTicket = new Map<string, BranchResumeSession>();
  const logs = readdirSync(foremanDir)
    .filter((file) => file.endsWith(".jsonl"))
    .sort();

  for (const file of logs) {
    const logPath = join(foremanDir, file);
    const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (record.event === "branch-session") {
        const ticket = stringField(record.ticket);
        const branch = stringField(record.branch);
        const base = stringField(record.base);
        const worktreePath = stringField(record.worktreePath);
        const sessionId = stringField(record.sessionId);
        if (!ticket || !branch || !base || !worktreePath || !sessionId) continue;

        byTicket.set(ticket, {
          ticket,
          branch,
          base,
          worktreePath,
          sessionId,
          logPath,
          agent: stringField(record.agent),
          model: stringField(record.model),
          effort: stringField(record.effort),
          fast: booleanField(record.fast),
          qaEnabled: booleanField(record.qaEnabled),
          createPr: booleanField(record.createPr),
          completionMode: stringField(record.completionMode),
          reviewProvider: stringField(record.reviewProvider),
          prReady: booleanField(record.prReady),
          keepWorktrees: booleanField(record.keepWorktrees),
          ts: stringField(record.ts),
        });
      } else if (record.event === "branch-complete") {
        const ticket = stringField(record.ticket);
        const status = stringField(record.status);
        if (ticket && status === "done") byTicket.delete(ticket);
      }
    }
  }

  return Array.from(byTicket.values())
    .filter((session) => existsSync(session.worktreePath))
    .sort((a, b) => a.ticket.localeCompare(b.ticket, undefined, { numeric: true }));
}

export function formatBranchContinueCommand(projectDir: string, session: BranchResumeSession): string {
  const args = [
    "ai-foreman",
    "start",
    shellQuote(projectDir),
    "--steps",
    "1",
    ...(session.completionMode && session.completionMode !== "none"
      ? ["--completion", shellQuote(session.completionMode)]
      : [session.createPr ? "--create-pr" : "--branch-per-ticket"]),
    "--continue",
    "--ticket",
    shellQuote(session.ticket),
  ];
  if (session.agent && session.agent !== "claude") args.push("--agent", shellQuote(session.agent));
  if (session.model) args.push("--model", shellQuote(session.model));
  if (session.effort) args.push("--effort", shellQuote(session.effort));
  if (session.reviewProvider) args.push("--provider", shellQuote(session.reviewProvider));
  if (session.fast) args.push("--fast");
  if (session.qaEnabled === false) args.push("--no-qa");
  if (session.prReady) args.push("--pr-ready");
  if (session.keepWorktrees) args.push("--keep-worktrees");
  return args.join(" ");
}

export function formatBranchSummaryFollowupCommands(
  projectDir: string,
  foremanDir: string,
  summaries: Pick<BranchRunSummary, "ticket" | "buildStatus">[],
): string[] {
  const sessions = findResumableBranchSessions(foremanDir);
  const sessionByTicket = new Map(sessions.map((session) => [session.ticket, session]));
  const seen = new Set<string>();
  const commands: string[] = [];

  for (const summary of summaries) {
    if (summary.buildStatus !== "blocked" && summary.buildStatus !== "needs-human") continue;
    if (summary.ticket === "plan" || seen.has(summary.ticket)) continue;
    const session = sessionByTicket.get(summary.ticket);
    if (!session) continue;
    seen.add(summary.ticket);
    commands.push(formatBranchContinueCommand(projectDir, session));
  }

  return commands;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
