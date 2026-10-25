/** Pure fixture validation happens before workspace creation or provider contact. */
import { readFileSync } from "node:fs";
import { canonicalJson, ticketPopulationPageOutput } from "../../packages/spec/src/index.ts";

export function structuredCapacityPages(env = process.env) {
  const count = Number(env.RAFI_LIVE_CAPACITY_PAGES ?? "2");
  const maxTickets = Number(env.RAFI_LIVE_CAPACITY_MAX_TICKETS ?? "0");
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error("Capacity page count must be from 1 to 60");
  if (!Number.isInteger(maxTickets) || maxTickets < 0 || maxTickets > 9000) throw new Error("Capacity total ticket count must be from 0 to 9000");
  const supplied = env.RAFI_LIVE_CAPACITY_FIXTURE ? JSON.parse(readFileSync(env.RAFI_LIVE_CAPACITY_FIXTURE, "utf8")) : undefined;
  const pages = supplied ? Array.isArray(supplied) ? supplied : [supplied] : Array.from({ length: count }, (_, ordinal) => ({
    version: 1, operation: "ticket-population-page", result: { kind: "completed", summary: "Capacity serialization fixture",
      payload: { plan_id: "fixture", revision: 1, tickets: [], retirements: [], terminal: ordinal === count - 1 } }, continuity: null,
  }));
  if (!pages.length || pages.length > 60) throw new Error("Capacity fixture must contain 1 to 60 pages");
  let total = 0, bytes = 0, identity;
  const slices = new Set();
  for (const [ordinal, page] of pages.entries()) {
    ticketPopulationPageOutput.schema.parse(page);
    if (page.result.kind !== "completed") throw new Error("Capacity fixture requires completed native pages");
    const payload = page.result.payload;
    if (payload.terminal !== (ordinal === pages.length - 1)) throw new Error("Capacity fixture terminal page must be last");
    if (identity && (identity.plan_id !== payload.plan_id || identity.revision !== payload.revision)) throw new Error("Capacity fixture changed plan identity");
    identity = payload; total += payload.tickets.length;
    const pageBytes = Buffer.byteLength(canonicalJson(payload)); bytes += pageBytes;
    if (pageBytes > 750 * 1024 || bytes > 6 * 1024 * 1024) throw new Error("Capacity fixture exceeds canonical page/aggregate bytes");
    for (const ticket of payload.tickets) {
      if (slices.has(ticket.slice_ref)) throw new Error("Capacity fixture repeats a ticket slice");
      slices.add(ticket.slice_ref);
    }
  }
  if (total !== maxTickets) throw new Error("Capacity fixture must contain exactly the requested total ticket count");
  return { pages, maxTickets };
}
