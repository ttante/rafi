// ARCH 4.4's row "— (no project yet; a 1.0 config and tickets on disk) → `ready`, recorded by the first command that
// writes, as `project.created` plus `tickets.changed` (added)" (P19, C62): a project written by hand, by the harness
// or a fresh clone. Moved here from api/start.ts in M5 (the first-write adoption is the tracker's).
import type { Engine } from "../api/engine.js";
import { ENGINE_VERSION } from "../version.js";

export async function adoptProject(engine: Engine, config: Record<string, unknown>, ids: readonly string[]):
  Promise<void> {
  const defs = ids.map((id) => ({ id, dependsOn: [] }));
  if (!ids.length || engine.fold(defs).project.state !== "none") return;
  await engine.append([{ type: "project.created", actor: "engine", data: { app_name: String(config.appName ?? ""),
    rafi_version: ENGINE_VERSION } }, { type: "tickets.changed", actor: "engine", data: { by: "user",
    items: ids.map((ticket) => ({ ticket, field: "added" })), material: false } }]);
}
