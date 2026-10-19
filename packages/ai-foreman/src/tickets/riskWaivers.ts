import { createHash } from "node:crypto";
import type { TicketDef } from "./ticketSchema.js";

/** Digest the complete definition so an edit automatically invalidates a waiver. */
export function ticketDefinitionDigest(ticket: TicketDef): string {
  return createHash("sha256").update(stableJson(ticket)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
