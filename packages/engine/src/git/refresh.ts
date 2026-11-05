// `rafi tickets queue --refresh` (FLAG-TK-21, C233): the state of every PR rafi opened, asked of `gh` or `glab` now.
// Read-only: nothing is recorded (a build records `pr.merged` at its own polls).
import type { Engine } from "../api/engine.js";
import { viewPr, type Provider } from "./provider.js";

export interface PrState {
  readonly branch: string; readonly unit: string; readonly url: string; readonly state: string;
}

export async function refreshPrs(engine: Engine): Promise<PrState[]> {
  const latest = new Map<string, { url: string; unit: string }>();
  for await (const e of engine.events()) {
    const d = (e.data ?? {}) as { url?: string; branch?: string; unit?: string };
    if (e.type === "pr.created" && d.url && d.branch) latest.set(d.branch, { url: d.url, unit: String(d.unit ?? "") });
  }
  const out: PrState[] = [];
  for (const [branch, { url, unit }] of latest) {
    const p: Provider = /merge_requests/.test(url) ? "gitlab" : "github";
    try {
      const pr = await viewPr({ engine, deps: engine.deps }, p, engine.projectDir, url);
      out.push({ branch, unit, url, state: pr ? `${pr.state}${pr.draft && pr.state === "open" ? " (draft)" : ""}`
        : "unknown" });
    } catch (error) {
      out.push({ branch, unit, url, state: `not checked: ${engine.redact((error as Error).message).split("\n")[0]}` });
    }
  }
  return out;
}
