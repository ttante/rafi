// realDeps(): wires the engine's real deps together. The only file in src/next allowed to reach them.
import type { Deps } from "@rafi-ai/engine";
import { realDeps as engineRealDeps } from "@rafi-ai/engine/deps/real";

export function realDeps(): Deps {
  return engineRealDeps();
}
