// Saved interviews (SCN S-CLI-13, S-CRASH-4 step 2; C150): 1.0 records under `.rafi/interviews/<id>.json`, timed on
// the fake clock (it starts 2026-11-01T14:00:00Z): the completed one is 29 days and 23 hours old then, 31 days old
// after a 25-hour clock.advance. Not committed: `.rafi/` is ignored.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface InterviewFixture {
  readonly id: string;
  readonly workflow: "create" | "plan" | "ticket-setup";
  readonly status: "in_progress" | "paused" | "needs_review" | "completed";
  readonly title: string;
  readonly updated_at: string;
  readonly completed_at?: string;
}

export const SAVED: readonly InterviewFixture[] = Object.freeze([
  { id: "create-a1b2", workflow: "create", status: "in_progress", title: "Create the fixture app",
    updated_at: "2026-10-20T10:00:00.000Z" },
  { id: "plan-c3d4", workflow: "plan", status: "paused", title: "Plan the search feature",
    updated_at: "2026-11-01T13:30:00.000Z" },
  { id: "tickets-e5f6", workflow: "ticket-setup", status: "needs_review", title: "Ticket the search plan",
    updated_at: "2026-09-22T09:00:00.000Z" },
  { id: "plan-old9", workflow: "plan", status: "completed", title: "An old finished plan",
    updated_at: "2026-10-02T15:00:00.000Z", completed_at: "2026-10-02T15:00:00.000Z" },
]);

export function writeInterviews(project: string, list: readonly InterviewFixture[] = SAVED): void {
  const dir = path.join(project, ".rafi", "interviews");
  mkdirSync(dir, { recursive: true });
  for (const r of list) {
    writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify({ version: 1, id: r.id, workflow: r.workflow,
      status: r.status, title: r.title, created_at: r.updated_at, updated_at: r.updated_at,
      ...(r.completed_at ? { completed_at: r.completed_at } : {}), checkpoint: { step: 1, answers: {} } }, null, 2));
  }
}
