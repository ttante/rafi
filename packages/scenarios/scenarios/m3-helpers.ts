// Shared by M3's scenario files: the event export, transcript lookups, quoted blocks, run numbers, a ticket's JSON.
import assert from "node:assert/strict";
import type { EventsExport } from "../checks/invariants.js";
import type { TranscriptEntry } from "../checks/transcript.js";
import type { ScenarioContext } from "../harness/scenario.js";

export async function exported(ctx: Pick<ScenarioContext, "rafi">, cwd?: string): Promise<EventsExport> {
  const r = await ctx.rafi("stats export", { cwd });
  assert.equal(r.code, 0, r.output);
  return JSON.parse(r.out) as EventsExport;
}

export const of = (e: EventsExport, type: string, ticket?: string) => e.events
  .filter((x) => x.type === type && (!ticket || x.ticket_id === ticket)).map((x) => x.data as never);

export const turn = (t: readonly TranscriptEntry[], role: string, step: string, attempt: number, ticket = "T1") =>
  t.find((x) => x.role === role && x.step === step && x.attempt === attempt && x.ticket === ticket && !x.repair);

export const turns = (t: readonly TranscriptEntry[], role: string, step: string, ticket = "T1") =>
  t.filter((x) => x.role === role && x.step === step && x.ticket === ticket && !x.repair);

/** The text inside the message's quoted blocks (```text … ```, any fence length). */
export const insideQuotes = (message: string) => [...message.matchAll(/(`{3,})text\n([\s\S]*?)\n\1/g)]
  .map((m) => m[2]!).join("\n");

export const runNumbers = (text: string) => [...text.matchAll(/^- run (\d+):/gm)].map((m) => Number(m[1]));

/** `rafi tickets show <id> --json`'s record. */
export async function ticketJson(ctx: Pick<ScenarioContext, "rafi">, id: string, cwd?: string) {
  const r = await ctx.rafi(`tickets show ${id} --json`, { cwd });
  assert.equal(r.code, 0, r.output);
  return (JSON.parse(r.out) as { tickets: Record<string, unknown>[] }).tickets.find((t) => t.id === id)!;
}
