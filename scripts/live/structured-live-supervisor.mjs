/** Shared retention, absolute deadline and cross-process authoritative spend reservations. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertStructuredLiveProvidersAuditable, createStructuredRetainedEvidenceDirectory, probeConfig } from "./structured-output-support.mjs";

import { structuredLiveBudgetPath, updateStructuredLiveBudget, reserveStructuredLiveQuery } from "../../packages/spec/src/structuredLiveBudget.ts";
let currentSupervisor;
export function trackStructuredLiveChild(child) {
  currentSupervisor?.track(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once("close", resolve));
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await closed; } finally { clearTimeout(force); }
  });
  return child;
}
export class StructuredLiveRunSupervisor {
  controller = new AbortController();
  owned = new Set();
  leases = new Set();
  results = [];
  stopped = false;
  constructor(name, env = process.env) {
    this.config = probeConfig(env);
    assertStructuredLiveProvidersAuditable(this.config.providers, this.config.requireAuthoritativeCost);
    this.evidenceRoot = createStructuredRetainedEvidenceDirectory(this.config.liveValidation, name);
    this.budgetPath = structuredLiveBudgetPath(this.config.liveValidation.retainedLogDirectory, this.config.liveValidation.credentialScope, this.config.deadline);
    this.name = name;
    this.reportPath = join(this.evidenceRoot, "supervisor.json");
    try { this.updateBudget(budget => budget); }
    catch (error) { this.save("failed", String(error)); throw error; }
    this.save("running");
    this.timer = setTimeout(() => this.abort(new Error("Structured live absolute deadline expired")), Math.max(0, this.config.deadline - Date.now()));
  }
  get signal() { return this.controller.signal; }
  check() {
    if (this.stopped || this.signal.aborted || Date.now() >= this.config.deadline) throw this.signal.reason ?? new Error("Structured live deadline exhausted");
  }
  updateBudget(change) { return updateStructuredLiveBudget(this.budgetPath, change); }
  reserveQuery(provider, requestedUsd) {
    this.check();
    if (!this.config.providers.includes(provider)) throw new Error("Unauthorized live provider");
    let lease;
    lease = reserveStructuredLiveQuery({ path: this.budgetPath, runner: this.name, provider, signal: this.signal,
      deadline: this.config.deadline, requestedUsd, requireAuthoritativeCost: this.config.requireAuthoritativeCost, settled: result => {
        this.leases.delete(lease); this.results.push(result); this.save("running");
      } });
    this.leases.add(lease); return lease;
  }
  track(close) {
    this.check(); let cleanup;
    const once = () => cleanup ??= Promise.resolve().then(close);
    this.owned.add(once); return () => this.owned.delete(once);
  }
  abort(error = new Error("Structured live run aborted")) {
    if (!this.signal.aborted) this.controller.abort(error);
    for (const close of this.owned) Promise.resolve().then(close).catch(() => {});
    this.save("aborted", String(error));
  }
  save(status, error) {
    writeFileSync(this.reportPath, JSON.stringify({ version: 1, runner: this.name, status, error,
      deadline: new Date(this.config.deadline).toISOString(), maximumSpendUsd: this.config.maximumSpendUsd,
      requireAuthoritativeCost: this.config.requireAuthoritativeCost,
      budgetPath: this.budgetPath, results: this.results }, null, 2));
  }
  async execute(work) {
    let status = "failed", error;
    let removeAbort = () => {};
    try {
      this.check();
      const aborted = new Promise((_, reject) => {
        const stop = () => reject(this.signal.reason ?? new Error("Structured live run aborted"));
        this.signal.addEventListener("abort", stop, { once: true });
        removeAbort = () => this.signal.removeEventListener("abort", stop);
      });
      const value = await Promise.race([Promise.resolve().then(() => work(this)), aborted]);
      this.check(); status = "passed"; return value;
    }
    catch (cause) { error = String(cause); this.abort(cause); throw cause; }
    finally {
      clearTimeout(this.timer); removeAbort();
      let cleanupTimer;
      const cleanup = await Promise.race([Promise.allSettled([...this.owned].map(close => close())),
        new Promise(resolve => { cleanupTimer = setTimeout(() => resolve([{ status: "rejected", reason: "Provider cleanup timed out" }]), 5000); })]);
      clearTimeout(cleanupTimer);
      try {
        for (const lease of this.leases) lease.close();
        const budget = this.updateBudget(ledger => ({ ...ledger }));
        if ((this.config.requireAuthoritativeCost && budget.blocked) || Object.values(budget.reservations).some(row => row.runner === this.name || row.runner.startsWith(`${this.name}/`))) {
          status = "failed"; error ??= `Missing authoritative terminal cost or unsettled child query: ${budget.blocked ?? "reservation retained"}`;
        }
      } catch (cause) { status = "failed"; error ??= String(cause); }
      if (this.signal.aborted || Date.now() >= this.config.deadline) { status = "failed"; error ??= "Structured live absolute deadline expired"; }
      this.stopped = true;
      if (cleanup.some(row => row.status === "rejected")) { status = "failed"; error ??= "Owned provider cleanup failed"; }
      if (this.results.some(row => row.status === "uncertain")) { status = "failed"; error ??= "Missing authoritative terminal cost"; }
      this.save(status, error);
      if (status !== "passed") throw new Error(error ?? "Structured live validation failed");
    }
  }
}
/** @param {string} name @param {(supervisor: StructuredLiveRunSupervisor) => Promise<unknown>} work */
export async function runSupervisedStructuredLive(name, work, env = process.env) {
  const supervisor = new StructuredLiveRunSupervisor(name, env);
  const values = { RAFI_STRUCTURED_LIVE_RUNNER: name, RAFI_STRUCTURED_LIVE_BUDGET_PATH: supervisor.budgetPath,
    RAFI_STRUCTURED_LIVE_EVIDENCE_ROOT: supervisor.evidenceRoot };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const previousSupervisor = currentSupervisor; currentSupervisor = supervisor;
  let settled = false;
  const interrupt = () => supervisor.abort(new Error("Structured live run interrupted by SIGINT"));
  const terminate = () => supervisor.abort(new Error("Structured live run interrupted by SIGTERM"));
  const exiting = code => { if (!settled) supervisor.save("failed", `Process exited before supervised completion (code ${code})`); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate); process.once("exit", exiting);
  try { return await supervisor.execute(work); }
  finally {
    settled = true;
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); process.removeListener("exit", exiting);
    currentSupervisor = previousSupervisor;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
