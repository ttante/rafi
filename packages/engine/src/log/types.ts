// The event shapes the log reads and writes.
export interface NewEvent {
  readonly type: string;
  readonly run_id?: string | null;
  readonly ticket_id?: string | null;
  readonly actor: string;
  readonly source?: string | null;
  readonly data: unknown;
}

export interface StoredEvent {
  readonly seq: number;
  readonly id: string;
  readonly run_id: string | null;
  readonly ticket_id: string | null;
  readonly type: string;
  readonly v: number;
  readonly class: "state" | "detail";
  readonly at: string;
  readonly actor: string;
  readonly source: string | null;
  readonly origin: "local" | "imported";
  readonly idem_key: string | null;
  readonly data: unknown;
}

/** A row that failed validation on read, or a transition the fold refused (ARCH 4.1, plan choice C9). */
export interface Violation {
  readonly seq: number;
  readonly type: string;
  readonly reason: string;
}
