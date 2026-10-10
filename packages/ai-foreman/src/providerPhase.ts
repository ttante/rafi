/** Host-selected provider boundary. Never inferred from agent prose. */
export type ProviderTurnPurpose = "implementation" | "planning" | "contract-acceptance" | "preparation" | "assessment" | "initialization" | "response-repair";
export class ProviderPhaseBarrier {
  purpose: ProviderTurnPurpose = "implementation";
  private needsRenewal = false;
  private enforcing = false;
  compactionSequence = 0;
  begin(purpose: ProviderTurnPurpose): void { this.purpose = purpose; }
  enableEnforcement(): void { if (!this.enforcing) this.needsRenewal = true; this.enforcing = true; }
  compact(): void { this.compactionSequence++; if (this.enforcing) this.needsRenewal = true; }
  accept(sequence: number): void { if (sequence !== this.compactionSequence) throw new Error("Compaction occurred during contract delivery"); this.needsRenewal = false; }
  denial(tool: string): string | undefined {
    if (this.enforcing && ["Agent", "Task", "TaskOutput"].includes(tool)) return "Enforcing Builder cannot delegate mutation outside the contract tool barrier";
    if (this.needsRenewal) return "Contract delivery renewal required after native compaction; implementation tools paused";
    if (this.purpose === "implementation") return undefined;
    if (["contract-acceptance", "initialization", "response-repair"].includes(this.purpose)) return "Host response-only phase forbids all tools";
    if (!["Read", "Glob", "Grep", "ListMcpResourcesTool", "ReadMcpResourceTool"].includes(tool)) return "Host planning phase forbids mutation, shell commands, installs, and child agents";
    return undefined;
  }
}
