// Reads rafi-config.yaml through deps.fs and checks M1's 1.0 subset (plan choice C17).
import path from "node:path";
import {
  checkConfigV1, checkReservedTicketFields, firstProblem, keyFor, lookup, settingsOf, type ConfigV1, type Settings,
  type SettingSource,
} from "rafi-spec/v1";
import { parse } from "yaml";
import type { Fs } from "../deps/types.js";
import { POLICY_SHOWN, readPolicy } from "./policy.js";
import { parseSets, setPath, type SetEntry } from "./set.js";

export const CONFIG_FILE = "rafi-config.yaml";
export const TICKETS_FILE = path.join(".tickets", "tickets.yaml");

export type ConfigLoad = { ok: true; config: ConfigV1 } | { ok: false; message: string };

function parseYaml(text: string, name: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: parse(text) };
  } catch (error) {
    const first = String((error as Error).message).split("\n")[0];
    return { ok: false, message: `${name} isn't valid YAML: ${first}` };
  }
}

/** Loads and checks the project's config, and the reserved ticket `workflow` field. */
export async function loadConfig(fs: Fs, projectDir: string): Promise<ConfigLoad> {
  const parsed = parseYaml(await fs.read(path.join(projectDir, CONFIG_FILE)), CONFIG_FILE);
  if (!parsed.ok) return parsed;
  const checked = checkConfigV1(parsed.value);
  if (!checked.ok) return checked;
  const ticketsPath = path.join(projectDir, TICKETS_FILE);
  if (await fs.stat(ticketsPath)) {
    const tickets = parseYaml(await fs.read(ticketsPath), TICKETS_FILE);
    if (!tickets.ok) return tickets;
    const list = (tickets.value as { tickets?: unknown[] } | null)?.tickets ?? [];
    const reserved = checkReservedTicketFields(Array.isArray(list) ? list : []);
    if (!reserved.ok) return { ok: false, message: `${reserved.message} (ticket ${reserved.ticket})` };
  }
  return { ok: true, config: checked.config };
}

/** This build's flags (ARCH 8.6): each overrides one setting, with source `flag`. */
export interface Flags {
  readonly qa?: boolean;
  readonly agent?: "claude" | "codex";
  readonly model?: string;
  readonly effort?: string;
  readonly fast?: boolean;
  readonly autoApprove?: boolean;
  readonly completion?: string;
  /** `--branch-per-ticket` (true) or `--no-branch-per-ticket` (false); `--base <ref>` (M5 slice 5). */
  readonly branchPerTicket?: boolean;
  readonly base?: string;
  /** `--set key=value`, repeatable (C183). */
  readonly set?: readonly string[];
}

/** The config keys the start flags set (a locked key refuses its flag). */
const FLAG_KEYS: Readonly<Record<string, string>> = Object.freeze({ qa: "harness.qa", autoApprove: "approvals.mode",
  completion: "tickets.build.completion", branchPerTicket: "tickets.build.branch_strategy",
  base: "tickets.build.base_branch" });

export type Layered = { ok: true; settings: Settings; lines: string[] } | { ok: false; message: string };

const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const related = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/**
 * Settings in layers, lowest first: defaults, the project file, flags, `--set`, and the org policy's locked keys on
 * top, each value with its source (S-START-4, S-CLI-3, S-CLI-19, GUI-R20; C183, C184). A flag or `--set` naming a
 * locked key exits 1; a project value the policy overrides gets one line. A `--set` inside a structured key
 * (`agent_defaults.roles.qa.model`) is also kept under its own path, so a reader can tell its source.
 */
export function layered(config: ConfigV1, flags: Flags, o: { sets?: readonly SetEntry[];
  locked?: Readonly<Record<string, unknown>> } = {}): Layered {
  const sets = o.sets ?? [];
  const locked = o.locked ?? {};
  const lockedBy = (p: string) => Object.keys(locked).find((l) => related(l, p));
  const refusal = (p: string): Layered => ({ ok: false, message: `${p} is locked by your organization's policy ` +
    `(${POLICY_SHOWN}).` });
  for (const [flag, key] of Object.entries(FLAG_KEYS)) {
    const value = (flags as Record<string, unknown>)[flag];
    if (value !== undefined && value !== (flag === "qa") && lockedBy(key)) return refusal(key);
  }
  const hit = sets.find((s) => lockedBy(s.path));
  if (hit) return refusal(hit.path);
  let merged = config as Record<string, unknown>;
  for (const s of sets) merged = setPath(merged, s.path.split("."), s.value);
  const problem = firstProblem(merged);
  if (problem) {
    const by = sets.find((s) => related(s.path, problem.path));
    return { ok: false, message: by ? `--set ${by.path}: ${problem.message.replace(/^rafi-config\.yaml: /, "")}`
      : problem.message };
  }
  const lines: string[] = [];
  for (const [p, value] of Object.entries(locked)) {
    const mine = lookup(config as Record<string, unknown>, p);
    if (mine !== undefined && JSON.stringify(mine) !== JSON.stringify(value)) {
      lines.push(`${CONFIG_FILE} sets ${p} to ${shown(mine)}; your organization's policy locks it to ${shown(value)} ` +
        `(${POLICY_SHOWN}).`);
    }
    merged = setPath(merged, p.split("."), value);
  }
  const settings = settingsOf(merged);
  const mark = (p: string, value: unknown, source: SettingSource) => {
    const key = keyFor(p)!.key;
    settings[key] = { value: settings[key]!.value, source };
    if (key !== p) settings[p] = { value, source };
  };
  for (const s of sets) mark(s.path, s.value, "flag");
  const set = (key: string, value: unknown) => { if (value !== undefined) settings[key] = { value, source: "flag" }; };
  if (flags.qa === false) set("harness.qa", false);
  set("agent.runtime", flags.agent);
  set("agent.model", flags.model);
  set("agent.effort", flags.effort);
  if (flags.fast) set("agent.fast", true);
  if (flags.autoApprove) set("approvals.mode", "auto");
  set("tickets.build.completion", flags.completion);
  if (flags.branchPerTicket !== undefined) {
    set("tickets.build.branch_strategy", flags.branchPerTicket ? "branch-per-ticket" : "current");
  }
  set("tickets.build.base_branch", flags.base);
  for (const [p, value] of Object.entries(locked)) mark(p, value, "policy");
  return { ok: true, settings, lines };
}

/** A build's settings from the project file, the org policy, its flags and `--set`; lines the policy adds go to
 * `line`. Refused with one line for a bad config, a damaged policy, a bad `--set` or a locked key. */
export async function settingsFor(deps: { fs: Fs; machine: { stateDir: string } }, projectDir: string, flags: Flags,
  line: (text: string) => void): Promise<{ ok: true; settings: Settings; config: ConfigV1 } | { ok: false;
  message: string }> {
  const config = await loadConfig(deps.fs, projectDir);
  if (!config.ok) return config;
  const policy = await readPolicy(deps.fs, deps.machine.stateDir);
  if (!policy.ok) return policy;
  const sets = parseSets(flags.set ?? []);
  if (!sets.ok) return sets;
  const layers = layered(config.config, flags, { sets: sets.sets, locked: policy.locked });
  if (!layers.ok) return layers;
  for (const text of layers.lines) line(text);
  return { ok: true, settings: layers.settings, config: config.config };
}
