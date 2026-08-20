export type TicketPriority = "P0" | "P1" | "P2" | "P3";
export type TicketSize = "XS" | "S" | "M" | "L" | "XL";
export type TicketRisk = "Low" | "Medium" | "High";

export interface TicketExternalRef {
  provider: "linear" | "jira" | string;
  id: string;
  key?: string | null;
  url?: string | null;
}

/** General provenance reference. `external_refs` remains accepted for compatibility. */
export interface TicketSourceRef {
  source: string;
  item: string;
  url?: string | null;
  fingerprint?: string | null;
  note?: string | null;
}

export interface TicketDef {
  id: string;
  order: number;
  title: string;
  area: string;
  priority: TicketPriority;
  size: TicketSize;
  risk: TicketRisk;
  depends_on: string[];
  summary: string;
  acceptance: string[];
  required_tests: string[];
  likely_files: string[];
  rollback?: string | null;
  notes?: string | null;
  external_refs?: TicketExternalRef[];
  source_refs?: TicketSourceRef[];
  superseded_by?: string[];
  supersedes?: string[];
}

export const TICKET_JSON_SCHEMA = {
  type: "object",
  required: [
    "id", "order", "title", "area", "priority", "size", "risk",
    "depends_on", "summary", "acceptance", "required_tests", "likely_files",
  ],
  additionalProperties: true,
  properties: {
    id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9-_]*$" },
    order: { type: "number", minimum: 0 },
    title: { type: "string", minLength: 1 },
    area: { type: "string", minLength: 1 },
    priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    size: { type: "string", enum: ["XS", "S", "M", "L", "XL"] },
    risk: { type: "string", enum: ["Low", "Medium", "High"] },
    depends_on: { type: "array", items: { type: "string" } },
    summary: { type: "string", minLength: 1 },
    acceptance: { type: "array", items: { type: "string" }, minItems: 1 },
    required_tests: { type: "array", items: { type: "string" }, minItems: 1 },
    likely_files: { type: "array", items: { type: "string" } },
    rollback: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
    external_refs: {
      type: "array",
      items: {
        type: "object",
        required: ["provider", "id"],
        additionalProperties: true,
        properties: {
          provider: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 },
          key: { type: ["string", "null"] },
          url: { type: ["string", "null"] },
        },
      },
    },
    source_refs: {
      type: "array",
      items: {
        type: "object",
        required: ["source", "item"],
        additionalProperties: true,
        properties: {
          source: { type: "string", minLength: 1 },
          item: { type: "string", minLength: 1 },
          url: { type: ["string", "null"] },
          fingerprint: { type: ["string", "null"] },
          note: { type: ["string", "null"] },
        },
      },
    },
    superseded_by: { type: "array", items: { type: "string" }, uniqueItems: true },
    supersedes: { type: "array", items: { type: "string" }, uniqueItems: true },
  },
} as const;

export const TICKETS_FILE_SCHEMA = {
  type: "object",
  required: ["tickets"],
  properties: {
    tickets: { type: "array", items: TICKET_JSON_SCHEMA },
  },
} as const;
