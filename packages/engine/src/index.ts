// @rafi-ai/engine public surface.
export { openEngine, STATE_DB, type Engine } from "./api/engine.js";
export type * from "./deps/types.js";
export { loadConfig, CONFIG_FILE, TICKETS_FILE } from "./config/load.js";
export { unfinishedLegacyBuild, type LegacyRun } from "./migrate/legacyRuns.js";
export { redactor, escapeControl } from "./log/redact.js";
export { openLog, StorageError, type Log } from "./log/db.js";
export { append, InvalidEventError } from "./log/append.js";
export { fold } from "./state/fold.js";
export { decide } from "./state/decide.js";
export { standard } from "./workflow/standard.js";
export { roles } from "./workflow/roles.js";
export { checkWorkflow } from "./workflow/checks.js";
