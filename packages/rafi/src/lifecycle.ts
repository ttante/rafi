import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateProjectConfig, type ProjectLifecycleState } from "rafi-spec";
import { normalizeProjectConfig, RAFI_CONFIG_FILE } from "./project.js";

const TRACKER_CONFIG = ".tickets/config.yaml";
const CANONICAL_TICKETS = ".tickets/tickets.yaml";
const STATE_DB = ".tickets/ticket-state.sqlite";

export function detectProjectLifecycle(projectDir: string): ProjectLifecycleState {
  const root = resolve(projectDir);
  const configPath = join(root, RAFI_CONFIG_FILE);
  const trackerPath = join(root, TRACKER_CONFIG);
  const ticketsPath = join(root, CANONICAL_TICKETS);
  const dbPath = join(root, STATE_DB);
  const recognizable = [configPath, trackerPath, ticketsPath, dbPath, join(root, ".rafi"), join(root, ".foreman")]
    .some(existsSync);
  if (!recognizable) return state("uninitialized", [], "rafi create .", true);

  if (!existsSync(configPath)) {
    return state("partial", [`missing ${RAFI_CONFIG_FILE} while Rafi artifacts exist`], "rafi create .", true);
  }
  try {
    const parsed = parseYaml(readFileSync(configPath, "utf8"));
    const normalized = normalizeProjectConfig(parsed);
    const validation = validateProjectConfig(normalized);
    if (!validation.valid) return state("corrupt", validation.errors.map((error) => `${RAFI_CONFIG_FILE}: ${error}`), "rafi create .", false);
  } catch (error) {
    return state("corrupt", [`${RAFI_CONFIG_FILE}: ${message(error)}`], "rafi create .", false);
  }

  const missing: string[] = [];
  if (!existsSync(trackerPath)) missing.push(TRACKER_CONFIG);
  if (!existsSync(ticketsPath)) missing.push(CANONICAL_TICKETS);
  if (missing.length > 0) return state("initializing", missing.map((path) => `missing ${path}`), "rafi resume .", true);

  let hasEvidence = false;
  try {
    const tracker = parseYaml(readFileSync(trackerPath, "utf8"));
    if (!tracker || typeof tracker !== "object" || Array.isArray(tracker)) throw new Error("expected a YAML object");
    const tickets = parseYaml(readFileSync(ticketsPath, "utf8")) as { tickets?: unknown } | null;
    if (!tickets || !Array.isArray(tickets.tickets)) throw new Error(`${CANONICAL_TICKETS}: expected a tickets array`);
    hasEvidence = tickets.tickets.length > 0;
  } catch (error) {
    return state("corrupt", [message(error)], "rafi tickets validate --project .", false);
  }

  if (!existsSync(dbPath)) {
    if (hasEvidence || historyEvidenceExists(root)) {
      return state("corrupt", [`missing ${STATE_DB} while ticket/history evidence exists; automatic recreation could replay completed work`], "rafi tickets validate --project .", false);
    }
    return state("partial", [`missing ${STATE_DB}; the tracker appears empty and may be recreated only after confirmation`], "rafi create .", true);
  }
  try {
    if (!statSync(dbPath).isFile()) throw new Error("not a regular file");
    const header = readFileSync(dbPath).subarray(0, 16).toString("utf8");
    if (header !== "SQLite format 3\u0000") throw new Error("invalid SQLite header");
  } catch (error) {
    return state("corrupt", [`${STATE_DB}: ${message(error)}`], "rafi tickets validate --project .", false);
  }
  return state("initialized", [], undefined, false);
}

export type LifecycleCommand = "create" | "plan" | "tickets-plan" | "start" | "agents" | "uninstall" | "build-resume" | "build-start-over" | "uninstall-recovery";

export function lifecycleCommandError(command: LifecycleCommand, lifecycle: ProjectLifecycleState): string | undefined {
  if (command === "create") {
    if (["uninitialized", "initializing", "partial"].includes(lifecycle.state)) return undefined;
    if (lifecycle.state === "initialized") return "project is already initialized; use `rafi tickets plan` to add or revise work";
  }
  if (command === "plan") {
    if (["initializing", "partial"].includes(lifecycle.state)) return undefined;
    if (lifecycle.state === "initialized") return "initial planning is complete; use `rafi tickets plan` for later work";
    if (lifecycle.state === "uninitialized") return "project is not initialized; start with `rafi create`";
  }
  if (["tickets-plan", "start", "build-resume", "build-start-over"].includes(command) && lifecycle.state !== "initialized") {
    return `project is ${lifecycle.state}; ${lifecycle.repairCommand ? `run \`${lifecycle.repairCommand}\`` : "repair initialization first"}`;
  }
  if (command === "uninstall" && lifecycle.state === "uninitialized") return "no Rafi installation was found";
  if (command === "uninstall-recovery") return undefined;
  if (lifecycle.state === "corrupt") return `${lifecycle.reasons.join("; ")}. ${lifecycle.repairCommand ? `Run \`${lifecycle.repairCommand}\`.` : ""}`.trim();
  return undefined;
}

export function assertLifecycleForCommand(projectDir: string, command: LifecycleCommand): ProjectLifecycleState {
  const lifecycle = detectProjectLifecycle(projectDir);
  const error = lifecycleCommandError(command, lifecycle);
  if (error) throw new Error(error);
  return lifecycle;
}

function historyEvidenceExists(root: string): boolean {
  return ["docs/ticket-progress.md", "docs/ticket-archive.md", ".tickets/history.jsonl"]
    .some((path) => existsSync(join(root, path)) && statSync(join(root, path)).size > 0);
}

function state(
  value: ProjectLifecycleState["state"],
  reasons: string[],
  repairCommand: string | undefined,
  canCreate: boolean,
): ProjectLifecycleState {
  return { state: value, reasons, repairCommand, canCreate };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
