// F-UI (SCN 2.1 `:59`; M5 plan C218): T1 with likely files src/App.tsx and src/app.css and no `ui` tag; T2 tagged
// `database`; T3 tagged `ai`; project tags with file patterns (`ui`: **/*.tsx, **/*.css). `flags.usesAI` per scenario.
import path from "node:path";
import { gitRepo, projectFiles, tempRoot, type FixtureTicket } from "./common.js";

export const UI_TICKETS: readonly FixtureTicket[] = Object.freeze([
  { id: "T1", title: "Show the app", tags: [], likely_files: ["src/App.tsx", "src/app.css"] },
  { id: "T2", title: "Store the items", tags: ["database"] },
  { id: "T3", title: "Summarize with a model", tags: ["ai"] },
]);

export function fUi(root = tempRoot(), o: { usesAI?: boolean; extra?: readonly FixtureTicket[] } = {}): string {
  const files = projectFiles([...UI_TICKETS, ...(o.extra ?? [])], {
    flags: { hasFrontend: true, usesAI: o.usesAI ?? false, runsInCloud: false },
    tags: { ui: { patterns: ["**/*.tsx", "**/*.css"] } },
  });
  return gitRepo(path.join(root, `f-ui${o.usesAI ? "-ai" : ""}`), { ...files,
    "src/App.tsx": "export const App = () => null;\n", "src/app.css": "body {}\n" });
}
