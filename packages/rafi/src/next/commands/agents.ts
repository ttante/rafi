// `rafi agents [project]` (CMD-16; PRM-110, FLAG-AG-1–6; M5 plan C186): per-role runtime, model, reasoning, fast
// mode, session continuity, cost display and compaction, saved in rafi-config.yaml by the engine's one writer.
// With flags it saves at once; with none it walks PRM-110 in a terminal; with neither it exits 1.
import {
  COMPACTING_ROLES, ROLE_NAMES, roleSettingsOf, saveAgentSettings, type Deps, type RoleSettings,
} from "@rafi-ai/engine";
import { askText, choose, chooseMany } from "../ui/prompts.js";
import { line } from "../ui/lines.js";
import type { ActionContext } from "./actions.js";

type Role = (typeof ROLE_NAMES)[number];
type Parsed = { ok: true; roles: Role[]; settings: RoleSettings } | { ok: false; message: string };
const REASONING: readonly string[] = ["default", "low", "medium", "high", "xhigh"];
const label = (role: string) => (role === "qa" ? "QA" : role[0]!.toUpperCase() + role.slice(1));

function parseFlags(opts: Record<string, unknown>): Parsed {
  const type = String(opts.agentType ?? "");
  const roles = type === "all" ? [...ROLE_NAMES] : ROLE_NAMES.filter((r) => r === type);
  if (!roles.length) return { ok: false, message: `--agent-type takes ${ROLE_NAMES.join(", ")} or all.` };
  const s: RoleSettings = {};
  if (opts.agentMake !== undefined) {
    if (opts.agentMake !== "claude" && opts.agentMake !== "codex") {
      return { ok: false, message: "--agent-make takes claude or codex." };
    }
    s.make = opts.agentMake;
  }
  if (opts.model !== undefined) s.model = String(opts.model);
  if (opts.reasoning !== undefined) s.reasoning = String(opts.reasoning);
  if (opts.fast !== undefined) s.fast = opts.fast === true;
  if (opts.sessionStrategy !== undefined) {
    if (opts.sessionStrategy !== "compact" && opts.sessionStrategy !== "fresh") {
      return { ok: false, message: "--session-strategy takes compact or fresh." };
    }
    s.session_strategy = opts.sessionStrategy;
  }
  if (opts.showSessionCost !== undefined) s.display_session_cost = opts.showSessionCost === true;
  for (const [flag, field, ok] of [["autoCompactThreshold", "auto_compact_threshold_percent",
    (n: number) => n >= 1 && n <= 99], ["compactMaximum", "compact_maximum", (n: number) => n >= 1]] as const) {
    if (opts[flag] === undefined) continue;
    const name = `--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const n = Number(opts[flag]);
    if (!Number.isInteger(n) || !ok(n)) {
      return { ok: false, message: `${name} takes a whole number${field === "compact_maximum" ? ", 1 or more"
        : " from 1 to 99"}.` };
    }
    if (roles.some((r) => !COMPACTING_ROLES.includes(r)) && type !== "all") {
      return { ok: false, message: `${name} applies to builder and qa only.` };
    }
    s[field] = n;
  }
  return { ok: true, roles, settings: s };
}

/** PRM-110 in a terminal. Null: cancelled. */
async function walkthrough(deps: Deps, project: string): Promise<Record<string, RoleSettings> | null> {
  const picked = await chooseMany(deps, "Which roles should share these settings?", ROLE_NAMES);
  if (!picked) return null;
  const roles = picked.map((i) => ROLE_NAMES[i]!);
  const s: RoleSettings = {};
  const make = await choose(deps, "Runtime:", ["Claude", "Codex"]);
  if (make === null) return null;
  s.make = make === 0 ? "claude" : "codex";
  const model = await choose(deps, "Model:", ["Runtime default (Recommended)", "Validated custom ID"]);
  if (model === null) return null;
  if (model === 1) {
    const id = await askText(deps, "Custom model ID:", { required: true, refusal: "Type a model ID." });
    if (!id) return null;
    s.model = id;
  }
  const reasoning = await choose(deps, "Reasoning:", REASONING);
  if (reasoning === null) return null;
  if (reasoning > 0) s.reasoning = REASONING[reasoning]!;
  const fast = await choose(deps, "Enable fast mode when supported?", ["Yes", "No"]);
  if (fast === null) return null;
  s.fast = fast === 0;
  const session = await choose(deps, "Session continuity:", ["Fresh conversation (Recommended)",
    "Compact and continue (one session reused across tickets)"]);
  if (session === null) return null;
  s.session_strategy = session === 0 ? "fresh" : "compact";
  const out: Record<string, RoleSettings> = {};
  for (const role of roles) {
    out[role] = { ...s };
    if (!COMPACTING_ROLES.includes(role)) continue;
    const saved = await roleSettingsOf(deps.fs, project, role);
    for (const [field, prompt, ok] of [["auto_compact_threshold_percent", "automatic compaction threshold (1-99):",
      (n: number) => n >= 1 && n <= 99], ["compact_maximum", "maximum compactions per session:",
      (n: number) => n >= 1]] as const) {
      const now = saved[field] ?? (field === "compact_maximum" ? 10 : 65);
      const typed = await askText(deps, `${label(role)} ${prompt} [${now}]`, { required: false, refusal: "" });
      if (typed === null) return null;
      const n = typed === "" ? now : Number(typed);
      if (!Number.isInteger(n) || !ok(n)) { deps.terminal.write(`That isn't a valid number.\n`); return null; }
      out[role]![field] = n;
    }
  }
  const ok = await choose(deps, `Apply to ${roles.join(", ")} in ${project}?`, ["Yes", "No"]);
  return ok === 0 ? out : ok === 1 ? {} : null;
}

const FLAGS: readonly string[] = ["agentType", "agentMake", "model", "reasoning", "fast", "sessionStrategy",
  "showSessionCost", "autoCompactThreshold", "compactMaximum"];

export async function agentsAction(ctx: ActionContext): Promise<number> {
  const { deps, opts } = ctx;
  let changes: Record<string, RoleSettings> | null;
  if (FLAGS.some((f) => opts[f] !== undefined)) {
    const parsed = parseFlags(opts);
    if (!parsed.ok) { deps.terminal.error(line(parsed.message)); return 1; }
    changes = Object.fromEntries(parsed.roles.map((r) => [r, COMPACTING_ROLES.includes(r) ? parsed.settings
      : { ...parsed.settings, auto_compact_threshold_percent: undefined, compact_maximum: undefined }]));
    for (const s of Object.values(changes)) for (const k of Object.keys(s) as (keyof RoleSettings)[]) {
      if (s[k] === undefined) delete s[k];
    }
  } else if (deps.terminal.isTTY) {
    changes = await walkthrough(deps, ctx.project);
    if (changes === null) { deps.terminal.write("Cancelled. Nothing was saved.\n"); return 1; }
  } else {
    deps.terminal.error(line("rafi agents needs a terminal for its questions, or flags (--agent-type and a " +
      "setting); see rafi agents --help."));
    return 1;
  }
  if (!Object.keys(changes).length) { deps.terminal.write("Nothing was saved.\n"); return 0; }
  const saved = await saveAgentSettings(deps, ctx.project, changes);
  if (!saved.ok) { deps.terminal.error(line(saved.message)); return 1; }
  deps.terminal.write(`Saved in rafi-config.yaml:\n${saved.lines.map((l) => `  ${l}`).join("\n")}\n`);
  return 0;
}
