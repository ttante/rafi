// F-CHAIN trimmed to T1–T3 (S-CRASH-1, S-CRASH-5): three independent tickets in queue order.
import path from "node:path";
import { CHAIN } from "./f-chain.js";
import { gitRepo, projectFiles, tempRoot } from "./common.js";

export function fChain3(root = tempRoot()): string {
  return gitRepo(path.join(root, "f-chain"), projectFiles(CHAIN.slice(0, 3)));
}
