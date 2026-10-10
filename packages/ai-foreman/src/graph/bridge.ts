import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const asset = fileURLToPath(new URL("./bridge.py", import.meta.url));
/** Resolve existing tools only. Never executes discovery commands which can install. */
export function graphPythonCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.RAFI_GRAPH_PYTHON)
    candidates.push(process.env.RAFI_GRAPH_PYTHON);
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const bin = join(dir, process.platform === "win32" ? "graphify.exe" : "graphify");
    if (existsSync(bin)) {
      if (process.platform === "win32")
        candidates.push(join(dirname(dirname(bin)), "python.exe"));
      else {
        const line = readFileSync(realpathSync(bin), "utf8").split(/\r?\n/, 1)[0];
        if (line?.startsWith("#!/") && !line.slice(2).includes("\0") && !line.includes("/env "))
          candidates.push(line.slice(2).trim());
      }
    }
  }
  candidates.push(process.platform === "win32" ? "python" : "python3");
  return [...new Set(candidates)];
}
function dispatchBridge<T>(python: string, input: unknown, options: {
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  signal?: AbortSignal;
} = {}): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new Error("Graph operation cancelled"));
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 128 * 1024 * 1024)
    return Promise.reject(new Error("Graph bridge input budget exceeded"));
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONHASHSEED: "0" };
    const child = spawn(python, ["-I", "-B", asset], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let done = false, size = 0, errorBytes = 0;
    const chunks: Buffer[] = [];
    const stop = (): void => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else
          child.kill("SIGKILL");
      }
      catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (error?: Error, result?: T): void => {
      if (done)
        return; done = true; clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); if (error) {
          stop();
          reject(error);
        }
      else
        resolve(result!);
    };
    const aborted = (): void => finish(new Error("Graph operation cancelled"));
    const timer = setTimeout(() => finish(new Error("Graph bridge deadline exceeded")), options.timeoutMs ?? 15000);
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted)
      aborted();
    child.on("error", error => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length; if (size > (options.maxOutputBytes ?? 1024 * 1024))
        finish(new Error("Graph bridge output limit exceeded"));
      else
        chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length; if (errorBytes > 64 * 1024)
        finish(new Error("Graph bridge diagnostic limit exceeded"));
    });
    child.stdin.on("error", error => finish(error));
    child.on("close", code => {
      if (done)
        return;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (code !== 0 || result.ok !== true)
          throw new Error(result.error ?? `Graph bridge exited ${code}`);
        finish(undefined, result.result as T);
      }
      catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(serialized);
  });
}
export async function resolveGraphPython(): Promise<string> {
  const errors: string[] = [];
  for (const candidate of graphPythonCandidates()) {
    try {
      await runBridge(candidate, { action: "probe" }, { timeoutMs: 5000 });
      return candidate;
    }
    catch (error) {
      errors.push(String(error));
    }
  }
  throw new Error(`Compatible graphifyy==0.9.82 unavailable. Run graph adopt to repair an authorized installation. ${errors.at(-1) ?? ""}`);
}
let activeWorkers = 0;
const workerWaiters: Array<() => void> = [];
export async function runBridge<T>(python: string, input: unknown, options: {
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  if (options.signal?.aborted) throw new Error("Graph operation cancelled");
  if (activeWorkers >= 2)
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      const ready = (): void => { cleanup(); resolve(); };
      const fail = (message: string): void => {
        const index = workerWaiters.indexOf(ready);
        if (index < 0) return;
        workerWaiters.splice(index, 1);
        cleanup();
        reject(new Error(message));
      };
      const abort = (): void => fail("Graph operation cancelled while waiting for worker capacity");
      const timer = setTimeout(() => fail("Graph worker capacity deadline exceeded"), Math.max(1, deadline - Date.now()));
      workerWaiters.push(ready);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  else
    activeWorkers++;
  try {
    return await dispatchBridge<T>(python, input, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
  }
  finally {
    const next = workerWaiters.shift();
    if (next) next(); // Transfer the occupied slot directly to the queued caller.
    else activeWorkers--;
  }
}
