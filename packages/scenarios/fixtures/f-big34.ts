// F-BIG34 (SCN 2.1): thirty-four small independent tickets, current branch, QA off in its config (C159).
import path from "node:path";
import { configure, gitRepo, projectFiles, tempRoot, type FixtureTicket } from "./common.js";

export const BIG34: readonly FixtureTicket[] = Object.freeze(Array.from({ length: 34 }, (_, i) => ({
  id: `T${i + 1}`, title: `Small ticket ${i + 1}` })));

export function fBig34(root = tempRoot()): string {
  const dir = gitRepo(path.join(root, "f-big34"), projectFiles(BIG34));
  configure(dir, { harness: { qa: false } });
  return dir;
}
