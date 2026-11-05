// The checks before any agent turn that can ask (ARCH 7.3, 6.9): today the test sandbox, or the no-sandbox
// decision when the machine has none (C60). M7's upfront check gathers the rest into one list.
import path from "node:path";
import type { Settings } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { type SandboxTool, noSandboxDecision, rememberNoSandbox, sandboxInfo, savedNoSandbox, stopLine, WARNING }
  from "./grants.js";

/** The no-sandbox warning in a terminal: true runs the tests without one (C60 d). */
export interface UpfrontUI {
  line(text: string): void;
  confirmNoSandbox?(warning: string): Promise<boolean>;
}

export async function sandboxFor(engine: Engine, settings: Settings, o: { tty: boolean }, ui: UpfrontUI):
  Promise<{ tool: SandboxTool | null } | { code: number }> {
  const info = sandboxInfo(await engine.deps.checks.sandbox());
  if (info.available) { settings.sandbox = { value: "os", source: "default" }; return { tool: info.tool }; }
  const { fs, machine } = engine.deps;
  const saved = await savedNoSandbox(fs, machine.stateDir, engine.projectDir);
  const decision = noSandboxDecision({ saved, setting: settings["checks.run_without_sandbox"]?.value === true,
    autoApprove: settings["approvals.mode"]?.value === "auto", tty: o.tty });
  if (decision === "stop") { ui.line(stopLine(info.missing)); return { code: 1 }; }
  if (decision === "ask") {
    if (!(await ui.confirmNoSandbox?.(WARNING(info.missing)))) {
      ui.line("Cancelled; nothing ran.");
      return { code: 0 };
    }
  }
  const source = decision === "ask" ? "terminal" : decision;
  if (decision === "ask" || decision === "auto-approve") {
    await rememberNoSandbox(fs, machine.stateDir, engine.projectDir, engine.deps.clock.now().toISOString());
    ui.line(`Tests will run without a sandbox on this machine for this project (saved in ` +
      `${path.join(machine.stateDir, "grants.yaml")}; remove the entry to be asked again).`);
  }
  settings.sandbox = { value: "none", source };
  return { tool: null };
}
