/** Minimal pre-CLI child. No providers or mutable workflow code before acknowledgement. */
import { WorkflowDb } from "./workflowDb.js";
import { pathToFileURL } from "node:url";

const [entry, project, token, ...args] = process.argv.slice(2);
if (!entry || !project || !token || !process.send || !process.connected) throw new Error("Missing resume startup channel");
const db = new WorkflowDb(project);
try { db.registerBuildLaunchChild(token); } finally { db.close(); }
await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => finish(new Error("Resume startup acknowledgement timed out")), 10_000);
  const disconnected = () => finish(new Error("Resume launcher exited before acknowledgement"));
  const message = (value: unknown) => { if (value === "rafi-launch-ack") finish(); };
  function finish(error?: Error) {
    clearTimeout(timeout); process.off("disconnect", disconnected); process.off("message", message);
    if (error) reject(error); else resolve();
  }
  process.once("disconnect", disconnected); process.on("message", message);
  process.send!({ kind: "rafi-launch-registered", token });
});
// The durable claim still validates the token atomically after acknowledgement.
if (!process.env.RAFI_BUILD_WORKER_RUN) process.disconnect();
process.argv = [process.execPath, entry, ...args];
await import(pathToFileURL(entry).href);
