// The 1.0 ticket file (ARCH 13, 6.5): the fields M2 reads, with the reserved `workflow` field (ARCH 4.8, FMT-T21).
import { z } from "zod";
import { CUSTOM_WORKFLOWS_MESSAGE } from "./config.js";

export type TicketFieldCheck = { ok: true } | { ok: false; ticket: string; message: string };

export function checkReservedTicketFields(tickets: readonly unknown[]): TicketFieldCheck {
  for (const ticket of tickets) {
    if (ticket && typeof ticket === "object" && "workflow" in ticket) {
      const name = String((ticket as { id?: unknown }).id ?? "?");
      return { ok: false, ticket: name, message: CUSTOM_WORKFLOWS_MESSAGE };
    }
  }
  return { ok: true };
}


const strings = z.array(z.string()).default([]);

/** The five preparation depths, shallow to deep (today's levels, `spec/src/qaPreparation.ts`; C113). */
export const QA_DEPTHS = ["focused", "standard", "extensive", "critical", "exceptional"] as const;
const numbers = z.array(z.number().int().positive()).default([]);

export const ticketV1 = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must start with a letter and use letters, digits, - or _"),
  order: z.number().int().optional(),
  title: z.string().min(1),
  area: z.string().optional(),
  summary: z.string().optional(),
  priority: z.string().optional(),
  size: z.string().optional(),
  /** Required, exactly Low, Medium or High (FMT-T6; P23 (b)): it sets QA's minimum depth (C113). */
  risk: z.enum(["Low", "Medium", "High"]),
  depends_on: strings,
  tags: strings,
  acceptance: z.array(z.string().min(1)).min(1),
  required_tests: strings,
  likely_files: strings,
  rollback: z.string().nullable().optional(),
  needs: z.object({
    internet: z.string().nullable().default(null), local_servers: z.string().nullable().default(null),
    installs: strings, services: strings, credentials: strings,
  }).default({ internet: null, local_servers: null, installs: [], services: [], credentials: [] }),
  open_decisions: strings,
  person_only: numbers,
  locked: numbers,
  manual_checks: z.string().optional(),
  /** The planner's QA preparation depth (FMT-T11, Q-REQ-1; ARCH 13); rafi raises it to its minimum for the risk. */
  qa_preparation: z.object({ depth: z.enum(QA_DEPTHS) }).strict().optional(),
  /** `full`: QA's review uses the full fingerprint whatever the risk (Q-COPY-1; P25 option B). */
  qa_isolation: z.literal("full").optional(),
}).passthrough();

export type TicketV1 = z.infer<typeof ticketV1>;

export type TicketsCheck = { ok: true; tickets: TicketV1[] } | { ok: false; message: string };

/** Validates `.tickets/tickets.yaml`'s parsed content; the first problem names the ticket and the field. */
export function checkTicketsFile(value: unknown): TicketsCheck {
  const list = (value as { tickets?: unknown } | null)?.tickets;
  if (!Array.isArray(list)) return { ok: false, message: "tickets.yaml: `tickets` must be a list." };
  const reserved = checkReservedTicketFields(list);
  if (!reserved.ok) return { ok: false, message: `${reserved.message} (ticket ${reserved.ticket})` };
  const tickets: TicketV1[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of list.entries()) {
    const name = String((raw as { id?: unknown } | null)?.id ?? `#${index + 1}`);
    const parsed = ticketV1.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, message: `tickets.yaml: ticket ${name}: ${issue?.path.join(".") || "ticket"} ` +
        `${issue?.message ?? "is invalid"}.` };
    }
    if (seen.has(parsed.data.id)) return { ok: false, message: `tickets.yaml: ticket ${name} is listed twice.` };
    seen.add(parsed.data.id);
    tickets.push(parsed.data);
  }
  return { ok: true, tickets };
}
