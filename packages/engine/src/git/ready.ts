// Delivery's checks before any agent turn (C192, C193, C205): the plan's refusals (a hostile prefix, base or branch
// name, a stack deeper than `max_branch_depth`); `git.managed_by: me` with a branch flag or a completion other than
// `none`; a remote for completions that push; and PRM-78, the provider's readiness ("Retry GitHub readiness
// check?" in a terminal, else exit 1 with the fix line). Returns an exit code, or null to go on.
import type { Settings, TicketV1, DeliveryUnit } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { applyDirty, baseline, dirtyPaths, type DirtyMode } from "./dirty.js";
import { deliveryPlan } from "./plan.js";
import { providerFor, readiness } from "./provider.js";
import { gitTry } from "./run.js";

export interface ReadyUI {
  line(text: string): void;
  confirm?(text: string, yes: string): Promise<boolean | null>;
  /** PRM-75: "Uncommitted work found. How should the isolated build start?" (null: Cancel, or the input ended). */
  chooseDirty?(files: readonly string[]): Promise<DirtyMode | "cancel" | null>;
}

/** `rafi start --dirty-work preserve|include` (FLAG-ST-14); `rafi resume` keeps the build's recorded choice. */
export interface DirtyFlag { readonly dirtyWork?: DirtyMode }

/** C206: a dirty checkout and a build that makes worktrees: the flag's or the terminal's choice, applied. */
async function dirtyChoice(engine: Engine, settings: Settings, o: { tty: boolean } & DirtyFlag, ui: ReadyUI):
  Promise<number | null> {
  if (settings.dirty_work) return null;
  const at = { deps: engine.deps, project: engine.projectDir };
  const files = await dirtyPaths(at, engine.projectDir, engine.deps.fs);
  if (!files.length) return null;
  let mode: DirtyMode | "cancel" | null = o.dirtyWork ?? null;
  if (!mode && o.tty && ui.chooseDirty) mode = await ui.chooseDirty(files);
  else if (!mode) {
    ui.line(`Uncommitted work found (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}); say how ` +
      "the isolated build starts with --dirty-work preserve (from committed code) or --dirty-work include.");
    return 1;
  }
  if (mode === "cancel") { ui.line("Cancelled; nothing ran."); return 0; }
  if (mode === null) return 1;
  applyDirty(settings, mode, mode === "include" ? await baseline(engine, at) : null);
  if (settings["tickets.build.branch_strategy"]?.value === "current") {
    settings["tickets.build.branch_strategy"] = { value: "branch-per-ticket", source: "flag" };
  }
  return null;
}

function managedByMe(settings: Settings): string | null {
  if (settings["git.managed_by"]?.value !== "me") return null;
  const strategy = settings["tickets.build.branch_strategy"];
  const completion = settings["tickets.build.completion"];
  if (strategy?.source === "flag" && strategy.value !== "current") return "--branch-per-ticket";
  if (completion?.source === "flag" && completion.value !== "none") return `--completion ${String(completion.value)}`;
  return null;
}

export async function deliveryChecks(engine: Engine, settings: Settings, input: { tickets: readonly TicketV1[];
  units: readonly DeliveryUnit[] }, o: { tty: boolean } & DirtyFlag, ui: ReadyUI): Promise<number | null> {
  const mine = managedByMe(settings);
  if (mine) {
    ui.line(`${mine} needs rafi to manage git; rafi-config.yaml sets git.managed_by: me.`);
    return 1;
  }
  const plan = deliveryPlan({ ...input, settings, project: engine.projectDir, run: "check",
    redact: (t) => engine.redact(t) });
  if (plan.problems.length) { ui.line(plan.problems[0]!); return 1; }
  if (plan.units.some((u) => u.managed)) {
    const dirty = await dirtyChoice(engine, settings, o, ui);
    if (dirty !== null) return dirty;
  }
  const pushing = plan.units.filter((u) => u.managed && u.completion !== "none" && u.completion !== "direct-merge");
  if (!pushing.length) return null;
  const at = { deps: engine.deps, project: engine.projectDir };
  const remotes = await gitTry(at, engine.projectDir, ["remote"]);
  if (!remotes.stdout.split("\n").map((s) => s.trim()).includes("origin")) {
    ui.line(`Completion ${pushing[0]!.completion} pushes to a remote named origin, and this repository has none.`);
    return 1;
  }
  const ctx = { engine, deps: engine.deps };
  const providers = new Set((await Promise.all(pushing.map((u) => providerFor(ctx, u.provider))))
    .filter((p) => p !== null));
  for (const p of providers) {
    for (;;) {
      const problem = await readiness(ctx, p);
      if (!problem) break;
      ui.line(problem);
      if (!o.tty || !ui.confirm) return 1;
      const again = await ui.confirm(`Retry ${p === "github" ? "GitHub" : "GitLab"} readiness check?`, "Retry");
      if (!again) return again === false ? 0 : 1;
    }
  }
  return null;
}
