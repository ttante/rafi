import { loadGraphConfig } from "./config.js";
import { adoptGraph } from "./maintenance.js";
/** Source intake already owns activation/capture authority. The accepted selector
 * admits new references but never replaces a previously pinned captured version.
 * No scan, extraction, model or network operation occurs at this boundary. */
export function reconcileGraphSourceSelection(root: string): void {
  const effective = loadGraphConfig(root);
  if (!effective.enabled || effective.config?.sourceSelection !== "active-captured") return;
  adoptGraph(root, { config: effective.config, authorization: effective.adoption!.authorization });
}
