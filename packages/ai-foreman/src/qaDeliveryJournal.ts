import type { ProviderSessionRefV1 } from "rafi-spec";
import type { RuntimeFailure } from "./adapters/types.js";
import { STRUCTURED_AUTHORITY_TABLES } from "./structuredCutover.js";

export type QaDeliveryOutcome = "remediation-reported" | "blocked" | "needs-input" | "response-invalid" | "delivery-uncertain" | "source-drift";

export interface QaDeliveryInvocationV3 {
  version: 3;
  invocationId: string;
  runId: string;
  ticketId: string;
  reviewAttemptId: string;
  reportOccurrenceId: string;
  operationId?: string;
  status: "started" | "completed" | "failed";
  outcome?: QaDeliveryOutcome;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  /** Sequential host spans; provider/capture spans within work are nested. */
  phases: Array<{ name: string; startedAt: string; completedAt?: string; elapsedMs?: number; outcome?: "completed" | "failed" }>;
}

export interface QaDeliveryTurnV3 {
  sealedDispatch?: import("./structuredDispatchRecord.js").SealedDispatchRecordV2;
  structuredResponseDigest?: string;
  version: 3;
  turnRecordId: string;
  operationId: string;
  reportOccurrenceId: string;
  turnIndex: number;
  kind: "remediation" | "response-repair";
  parentTurnRecordId?: string;
  status: "intended" | "completed" | "delivery-uncertain";
  intendedSession: ProviderSessionRefV1;
  observedSession?: ProviderSessionRefV1;
  hostInstructionDigest: string;
  hostInstructionBytes: number;
  providerInstructionDigest?: string;
  providerInstructionBytes?: number;
  providerInstructionAvailability: "unavailable" | "captured";
  providerTurnId?: string;
  providerMetadata?: { provider: string; sessionId?: string; sessionRef?: ProviderSessionRefV1 };
  rawResponseDigest?: string;
  rawResponseBytes?: number;
  cleanedResponseDigest?: string;
  cleanedResponseBytes?: number;
  parsedResponseDigest?: string;
  providerReturnedError?: boolean;
  failure?: RuntimeFailure;
  eventEvidenceDigest?: string;
  toolCount?: number;
  terminalCount?: number;
  parserErrors?: string[];
  validationErrors?: string[];
  responseOnlyViolations?: string[];
  responseOnlySourceChanged?: boolean;
  postSourceDigest?: string;
  sourceCapture: "pending" | "captured" | "unavailable";
  sourceCaptureError?: string;
  startedAt: string;
  completedAt?: string;
  providerElapsedMs?: number;
  captureElapsedMs?: number;
  validationElapsedMs?: number;
}

/** V4 distinguishes evidence continuations from the one response-only repair. */
export interface QaDeliveryTurnV4 extends Omit<QaDeliveryTurnV3,"version"|"kind"> {
  version:4;
  kind:"remediation"|"graph-continuation"|"response-repair";
}
export type QaDeliveryTurn = QaDeliveryTurnV3 | QaDeliveryTurnV4;

/** Independent of preparation's schema revision: old writers cannot mutate an
 * evidence-continuation journal they would interpret as a response-only repair. */
export function registerQaGraphJournalWriter(db: import("better-sqlite3").Database): void {
  db.function("rafi_graph_delivery_protocol", () => 4);
  // A v1 connection must never be able to mutate a journal after the v2
  // cutover.  Keep this connection-local function deliberately separate from
  // the graph-delivery writer version.
  db.function("rafi_structured_communication_protocol", () => 2);
  db.function("rafi_structured_authority_revision", () => 3);
}
export function ensureQaGraphJournalGuards(db: import("better-sqlite3").Database): void {
    const tables = ["qa_delivery_turns", "qa_review_attempts", "qa_remediation_attempts", "qa_turns", "qa_ticket_heads", "qa_operation_journal", "qa_pass_certificates", "build_assignments"];
  db.transaction(() => {
    for (const table of new Set([...STRUCTURED_AUTHORITY_TABLES, ...tables, "workflow_runs", "build_work_scope", "build_work_admissions"])) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        // The old guard was an authority bypass: an old writer could continue
        // to mutate records that the v2 reader treats as sealed.  Dropping it
        // is safe and idempotent because this migration installs its v2
        // replacement in the same SQLite transaction.
        db.exec(`DROP TRIGGER IF EXISTS structured_comms_v1_${table}_${action}`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS structured_authority_v3_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN rafi_structured_authority_revision() <> 3 THEN RAISE(ABORT,'Structured authority revision 3 writer required') END; END;`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS structured_comms_v2_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN rafi_structured_communication_protocol() <> 2 THEN RAISE(ABORT,'Structured communication v2 writer required') END; END;`);
      }
    }
    for (const table of tables) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const action of ["INSERT", "UPDATE", "DELETE"])
        db.exec(`CREATE TRIGGER IF NOT EXISTS graph_delivery_v4_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN rafi_graph_delivery_protocol() <> 4 THEN RAISE(ABORT,'Graph delivery journal requires a compatible Rafi writer') END; END;`);
    }
  })();
}
