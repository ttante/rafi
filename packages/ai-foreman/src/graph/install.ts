import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GRAPHIFY_VERSION } from "rafi-spec";
import { resolveGraphPython, runBridge } from "./bridge.js";
import { confined } from "./util.js";
function run(executable: string, args: string[], deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP } });
    let diagnostics = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Graph installation deadline exceeded")); }, Math.max(1, deadline - Date.now()));
    child.stderr.on("data", chunk => {
      if (diagnostics.length < 8000)
        diagnostics += String(chunk).slice(0, 8000 - diagnostics.length);
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Graph environment setup failed (${code}): ${diagnostics}`)); });
  });
}
export function ownedGraphPython(root: string): string { return join(root, "graphify-out", "rafi", "runtime", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"); }
/** Installation is called only after an explicit adoption/setup grant. */
export async function ensureGraphInstallation(root: string): Promise<string> {
  try {
    return await resolveGraphPython();
  }
  catch { /* Preserve incompatible/shared installations. */ }
  const existing = ownedGraphPython(root);
  if (existsSync(existing)) {
    await runBridge(existing, { action: "probe" }, { timeoutMs: 5000 });
    return existing;
  }
  const base = join(root, "graphify-out", "rafi");
  mkdirSync(base, { recursive: true });
  confined(root, "graphify-out/rafi");
  const temporary = join(base, `runtime-${randomUUID()}`), deadline = Date.now() + 120000;
  const python = process.platform === "win32" ? "python" : "python3";
  try {
    await run(python, ["-I", "-m", "venv", temporary], deadline);
    const isolated = join(temporary, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
    await run(isolated, ["-I", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input", `graphifyy==${GRAPHIFY_VERSION}`], deadline);
    await runBridge(isolated, { action: "probe" }, { timeoutMs: 5000 });
    renameSync(temporary, join(base, "runtime"));
    return existing;
  }
  catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw new Error(`Graphify enabled-unavailable. Install a supported Python with venv/pip, then retry graph adopt. ${String(error)}`);
  }
}
