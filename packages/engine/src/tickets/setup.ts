// `rafi tickets setup:init` and `setup:update` on the engine side (FLAG-TK-1, FLAG-TK-2, FMT-C8; M5 plan C230): the
// answers become `tickets.*` keys in `rafi-config.yaml` through rafi's one config writer (C187, under its lock), with
// source tokens saved by variable name only. `setup:update` with a source flag replaces the saved sources. Each new
// source's access is checked first (one request each, tickets/sources.ts) unless `--skip-access-check`: a local
// path or a URL that can't be read stops the setup with nothing written; a Linear or Jira check that fails is one
// line, as today. With `git.managed_by: me` (ARCH-6), branch and completion settings other than "current" and
// "none" are refused, naming the setting.
import { parse } from "yaml";
import path from "node:path";
import { lookup } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { CONFIG_FILE } from "../config/load.js";
import { saveConfig, type SetEntry } from "../config/set.js";
import { checkSource, type Source } from "./sources.js";

export interface SetupAnswers {
  readonly appName?: string;
  readonly docsRoot?: string;
  /** Undefined: keep the saved sources (none for a first setup). */
  readonly sources?: readonly Source[];
  readonly populate?: Readonly<Record<string, unknown>>;
  readonly build?: Readonly<Record<string, unknown>>;
  readonly checklist?: readonly string[];
}

export type SetupResult = { ok: true; lines: string[] } | { ok: false; message: string; lines: string[] };

export async function managedByMe(engine: Engine): Promise<boolean> {
  try {
    const config = parse(await engine.deps.fs.read(path.join(engine.projectDir, CONFIG_FILE))) as Record<string,
      unknown>;
    return lookup(config, "git.managed_by") === "me";
  } catch {
    return false;
  }
}

function edits(a: SetupAnswers, update: boolean): SetEntry[] {
  const out: SetEntry[] = [];
  if (a.appName !== undefined) out.push({ path: "appName", value: a.appName });
  if (a.docsRoot !== undefined) out.push({ path: "docs.root", value: a.docsRoot });
  if (a.sources !== undefined || !update) out.push({ path: "tickets.sources", value: [...(a.sources ?? [])] });
  for (const [k, v] of Object.entries(a.populate ?? {})) if (v !== undefined) out.push({ path: `tickets.populate.${k}`,
    value: v });
  for (const [k, v] of Object.entries(a.build ?? {})) if (v !== undefined) out.push({ path: `tickets.build.${k}`,
    value: v });
  if (a.checklist !== undefined) out.push({ path: "tickets.build.validation_checklist", value: [...a.checklist] });
  return out;
}

export async function setupTickets(engine: Engine, a: SetupAnswers, o: { update: boolean; skipAccessCheck: boolean }):
  Promise<SetupResult> {
  const lines: string[] = [];
  if (await managedByMe(engine)) {
    const b = a.build ?? {};
    if (b.branch_strategy !== undefined && b.branch_strategy !== "current") return { ok: false, lines, message:
      "git.managed_by is me, so tickets.build.branch_strategy stays current (change git.managed_by first)." };
    if (b.completion !== undefined && b.completion !== "none") return { ok: false, lines, message:
      "git.managed_by is me, so tickets.build.completion stays none (change git.managed_by first)." };
  }
  if (!o.skipAccessCheck) {
    for (const source of a.sources ?? []) {
      const checked = await checkSource(engine.deps, engine.projectDir, source);
      lines.push(checked.line);
      if (checked.fatal) return { ok: false, lines, message: "Nothing was saved; fix the source, or pass " +
        "--skip-access-check." };
    }
  }
  const saved = await saveConfig(engine.deps, engine.projectDir, edits(a, o.update));
  if (!saved.ok) return { ok: false, lines, message: saved.message };
  lines.push(`Saved the ticket setup in ${CONFIG_FILE}.`);
  return { ok: true, lines };
}
