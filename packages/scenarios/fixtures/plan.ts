// A minimal approved rafi plan for scope approval (M5 plan C191): `<docs>/rafi-plan.json` with its revision, and the
// approved scope saved as an answer in `.rafi/progress.yaml` (ARCH 7.6), as a project that was planned and approved
// on another computer arrives. The key is the engine's own (`scope|<revision>|<digest>`), from the tickets on disk.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { scopeKey } from "@rafi-ai/engine";
import { addFiles } from "./common.js";

export function approvedPlan(project: string, revision = 1): string {
  const tickets = (parse(readFileSync(path.join(project, ".tickets", "tickets.yaml"), "utf8")) as
    { tickets: Parameters<typeof scopeKey>[1] }).tickets;
  const key = scopeKey(revision, tickets);
  addFiles(project, {
    "docs/rafi-plan.json": `${JSON.stringify({ version: 1, plan_id: "pln_fixture", revision, summary: "Fixture plan",
      slices: [] }, null, 2)}\n`,
    ".rafi/progress.yaml": stringify({ version: 1, tickets: {}, questions: {},
      answers: { [key]: { at: "2026-11-01T12:00:00Z", choice: "proceed", source: "terminal" } } }),
  });
  return key;
}
