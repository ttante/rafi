// F-ONE (SCN 2.1): one ticket T1 (size S, risk Low, tags backend), current branch, completion none.
import path from "node:path";
import { stringify } from "yaml";
import { gitRepo, projectFiles, tempRoot, ticketsYaml } from "./common.js";

const T1 = { id: "T1", title: "Add the empty-state message", tags: ["backend"] };

export function fOne(root = tempRoot()): string {
  return gitRepo(path.join(root, "f-one"), projectFiles([T1]));
}

/** F-ONE written as 0.10.x files: today's config shape, no format marker (S-ENG-5 step 1). */
export function fOneLegacy(root = tempRoot()): string {
  const config = { app_name: "fixture", harness: { targets: ["codex"] },
    tickets: { build: { branch_strategy: "current", completion: "none" } } };
  return gitRepo(path.join(root, "f-one-legacy"), {
    "rafi-config.yaml": stringify(config), ".tickets/tickets.yaml": ticketsYaml([T1]),
  });
}
