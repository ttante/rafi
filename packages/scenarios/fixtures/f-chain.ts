// F-CHAIN (SCN 2.1): seven tickets T1–T7 in queue order; T5 depends on T2; one current-branch unit each.
import path from "node:path";
import { gitRepo, projectFiles, tempRoot, type FixtureTicket } from "./common.js";

export const CHAIN: readonly FixtureTicket[] = Object.freeze(
  [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `T${n}`, title: `Ticket ${n}`, depends_on: n === 5 ? ["T2"] : [] })),
);

export function fChain(root = tempRoot()): string {
  return gitRepo(path.join(root, "f-chain"), projectFiles(CHAIN));
}
