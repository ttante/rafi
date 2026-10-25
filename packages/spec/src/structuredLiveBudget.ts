/** Shared host-only reservations for supervised provider queries and CLI children. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LiveBudgetLedger {
  version: 1; maximumUnits: number; spentUnits: number; blocked?: string;
  reservations: Record<string, { units: number; runner: string; provider: string }>;
  unmeteredQueries?: number;
}
export function structuredLiveBudgetPath(root: string, scope: string, deadline: number): string {
  return join(resolve(root), `structured-budget-${createHash("sha256").update(JSON.stringify([scope, deadline])).digest("hex")}.json`);
}
export function updateStructuredLiveBudget<T>(path: string, change: (ledger: LiveBudgetLedger) => T): T {
  const lock = `${path}.lock`;
  mkdirSync(lock); // Contention or an abandoned lock fails closed.
  try {
    let ledger: LiveBudgetLedger;
    try { ledger = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ledger = { version: 1, maximumUnits: 5_000_000, spentUnits: 0, reservations: {} };
    }
    if (ledger.version !== 1 || ledger.maximumUnits !== 5_000_000 || !Number.isSafeInteger(ledger.spentUnits) || ledger.spentUnits < 0 ||
      !ledger.reservations || typeof ledger.reservations !== "object" || Array.isArray(ledger.reservations)) throw new Error("Malformed authoritative live budget ledger");
    const result = change(ledger);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(ledger, null, 2)); renameSync(temp, path);
    return result;
  } finally { rmdirSync(lock); }
}
export interface LiveQueryLease {
  maximumSpendUsd: number; signal: AbortSignal; record(costUsd: number): void; close(): void;
}
export function reserveStructuredLiveQuery(options: { path: string; runner: string; provider: string; signal: AbortSignal;
  deadline: number; requestedUsd?: number; requireAuthoritativeCost?: boolean; settled?: (result: { provider: string; maximumSpendUsd: number; authoritativeCostUsd: number | null; status: string }) => void }): LiveQueryLease {
  if (options.signal.aborted || Date.now() >= options.deadline) throw new Error("Structured live deadline exhausted");
  const requireCost = options.requireAuthoritativeCost !== false;
  if (options.provider !== "claude" && options.provider !== "codex") throw new Error("Unknown live provider");
  if (requireCost && options.provider !== "claude") throw new Error("Provider lacks an authorized authoritative spend meter");
  const requested = options.requestedUsd ?? (requireCost ? 0.5 : 5);
  if (!Number.isFinite(requested) || requested <= 0 || requested > 5) throw new Error("Invalid live query reservation");
  const id = randomUUID(), units = (value: number) => Math.ceil(value * 1_000_000);
  const reserved = updateStructuredLiveBudget(options.path, ledger => {
    if (requireCost && (ledger.blocked || ledger.unmeteredQueries)) throw new Error(`Live budget blocked: ${ledger.blocked ?? "Earlier query has no authoritative cost"}`);
    const held = Object.values(ledger.reservations).reduce((sum, row) => {
      if (!Number.isSafeInteger(row.units) || row.units < 1) throw new Error("Malformed live spend reservation");
      return sum + row.units;
    }, 0);
    const available = ledger.maximumUnits - ledger.spentUnits - held;
    if (requireCost && available <= 0) throw new Error("Live structured validation reached its $5 spend limit");
    const amount = requireCost ? Math.min(units(requested), available) : units(requested);
    ledger.reservations[id] = { units: amount, runner: options.runner, provider: options.provider };
    return amount;
  });
  let observed: number | undefined, closed = false;
  return {
    maximumSpendUsd: reserved / 1_000_000, signal: options.signal,
    record(costUsd) {
      if (closed) throw new Error("Live query reservation was already settled");
      if (!Number.isFinite(costUsd) || costUsd < 0 || requireCost && units(costUsd) > reserved || observed !== undefined && costUsd < observed) {
        observed = undefined;
        if (!requireCost) return;
        updateStructuredLiveBudget(options.path, ledger => { ledger.blocked = "Invalid authoritative terminal cost"; });
        throw new Error("Provider did not report valid authoritative cost within its enforced reservation");
      }
      observed = costUsd;
    },
    close() {
      if (closed) return;
      updateStructuredLiveBudget(options.path, ledger => {
        if (ledger.reservations[id]?.units !== reserved) throw new Error("Lost live query reservation");
        delete ledger.reservations[id];
        ledger.spentUnits += observed === undefined ? (requireCost ? reserved : 0) : units(observed);
        if (observed === undefined && requireCost) ledger.blocked = "A query ended without authoritative terminal cost";
        if (observed === undefined && !requireCost) ledger.unmeteredQueries = (ledger.unmeteredQueries ?? 0) + 1;
      });
      closed = true;
      options.settled?.({ provider: options.provider, maximumSpendUsd: reserved / 1_000_000,
        authoritativeCostUsd: observed ?? null, status: observed === undefined ? (requireCost ? "uncertain" : "unmetered") : "settled" });
    },
  };
}
