import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOCS_DIR, loadDocsIndex } from "special-agents";
import type { ProjectFlags } from "rafi-spec";

export interface CopyDocsOptions {
  force?: boolean;
}

/**
 * Copy starter doc templates from special-agents into `<targetDir>/docs/`,
 * respecting gate flags. Returns the list of paths actually written.
 */
export function copyDocs(
  targetDir: string,
  flags: ProjectFlags,
  opts: CopyDocsOptions = {},
): string[] {
  const entries = loadDocsIndex();
  const written: string[] = [];

  for (const entry of entries) {
    const include =
      entry.gate === "always" ||
      (entry.gate === "ai" && flags.usesAI) ||
      (entry.gate === "frontend" && flags.hasFrontend);
    if (!include) continue;

    const dest = join(targetDir, "docs", entry.path);
    if (!opts.force && existsSync(dest)) continue;

    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(DOCS_DIR, entry.path), dest);
    written.push(entry.path);
  }

  return written;
}
