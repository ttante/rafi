import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { invalidStructuredRun, STRUCTURED_CUTOVER_REASON } from "./structuredCutover.js";

/** Only these declared local projections can carry resumable communication state. */
export const COMMUNICATION_FILE_OWNERSHIP = Object.freeze([
  { directory: ".rafi/interviews", kind: "interview", recurse: false },
  { directory: ".foreman/runs", kind: "build-checkpoint", recurse: false },
  { directory: ".foreman/delivery-sessions", kind: "branch-session", recurse: false },
  { directory: ".tickets/delivery-sessions", kind: "branch-session", recurse: false },
  { directory: ".foreman/qa-report-recovery", kind: "qa-recovery", recurse: true },
]);

/** Unknown/oversized file state conservatively retains evidence until classified. */
export function communicationFileEvidenceReferences(root: string): Set<string> {
  const references = new Set<string>();
  const walk = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { references.add("*"); return; }
    if (stat.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) { references.add("*"); return; }
    for (const match of readFileSync(path, "utf8").matchAll(/\b[a-f0-9]{64}\b/g)) references.add(match[0]);
  };
  for (const owner of COMMUNICATION_FILE_OWNERSHIP) walk(join(root, owner.directory));
  walk(join(root, ".rafi", "communication-quarantine"));
  return references;
}

export function quarantineCommunicationFiles(root: string, db: Database.Database): void {
  const archive = join(root, ".rafi", "communication-quarantine");
  const sync = (path: string): void => { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
  for (const owner of COMMUNICATION_FILE_OWNERSHIP) {
    if (owner.kind === "qa-recovery") {
      const directory = join(root, owner.directory);
      if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("QA recovery storage symlink is not allowed during cutover");
      if (existsSync(directory)) for (const name of readdirSync(directory)) {
        const packet = join(directory, name);
        if (lstatSync(packet).isSymbolicLink()) throw new Error("Cutover cannot classify symlinked QA recovery state");
        if (lstatSync(packet).isDirectory()) {
          const manifestPath = join(packet, "manifest.json");
          if (existsSync(manifestPath)) {
            if (lstatSync(manifestPath).isSymbolicLink()) throw new Error("QA recovery manifest symlink is not allowed during cutover");
            let manifest: Record<string, unknown> = {};
            try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) ?? {}; } catch { /* Incompatible packet remains preserved behind the sentinel. */ }
            if (manifest.version === 2 && typeof manifest.runId === "string" && typeof manifest.packetDigest === "string"
              && db.prepare(`SELECT 1 FROM workflow_runs r JOIN qa_packet_projections p ON p.run_id=r.run_id
                WHERE r.run_id=? AND r.checkpoint<>? AND p.packet_digest=? AND p.ticket_id=?
                AND CASE WHEN json_valid(p.manifest_json) THEN json_extract(p.manifest_json,'$.revision') ELSE NULL END=? AND p.path=?`)
                .get(manifest.runId, STRUCTURED_CUTOVER_REASON, manifest.packetDigest, manifest.ticketId, manifest.revision, packet)) continue;
          }
          const marker = join(packet, ".structured-communication-v2-cutover");
          if (existsSync(marker) && lstatSync(marker).isSymbolicLink()) throw new Error("Unsafe QA cutover marker");
          if (!existsSync(marker)) writeFileSync(marker, STRUCTURED_CUTOVER_REASON, { mode: 0o600, flag: "wx" });
          sync(marker); sync(packet);
        }
      }
      continue;
    }
    const walk = (directory: string): void => {
      if (!existsSync(directory)) return;
      if (lstatSync(directory).isSymbolicLink()) throw new Error(`Cutover cannot classify symlinked communication storage: ${directory}`);
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`Cutover cannot classify a symlinked communication projection: ${path}`);
        if (stat.isDirectory()) { if (owner.recurse) walk(path); continue; }
        if (!name.endsWith(".json") || !stat.isFile()) continue;
        const bytes = readFileSync(path);
        let value: Record<string, any>;
        try { value = JSON.parse(bytes.toString()); }
        catch { value = {}; }
        if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
        if (value.structuredCommunicationCutover?.reason === STRUCTURED_CUTOVER_REASON) continue;
        if (owner.kind === "interview" && value.communicationProtocolVersion === 2 && value.version === 2
          && typeof value.id === "string" && typeof value.workflow === "string" && typeof value.checkpoint === "string"
          && value.answers && typeof value.answers === "object" && value.runtime && typeof value.runtime === "object"
          && !value.runtime.sessionId && value.sessionIds && Object.keys(value.sessionIds).length === 0
          && Array.isArray(value.outputs) && value.outputs.every(output => output && typeof output.path === "string" && (output.sha256 === null || /^[a-f0-9]{64}$/.test(output.sha256)))) continue; // Human answers, file observations and host-only preparation.
        if (value.communicationProtocolVersion === 2 && typeof value.runId === "string" && Object.keys(value).every(key => ["communicationProtocolVersion","runId","dispatchId"].includes(key))) {
          const run = db.prepare("SELECT checkpoint FROM workflow_runs WHERE run_id=?").get(value.runId) as {checkpoint:string}|undefined;
          if (run && run.checkpoint !== STRUCTURED_CUTOVER_REASON && typeof value.dispatchId === "string" && db.prepare("SELECT 1 FROM operation_journal WHERE run_id=? AND idempotency_key=? AND status='confirmed'").get(value.runId, value.dispatchId)) continue;
        }
        if (owner.kind === "interview" && value.communicationProtocolVersion === 2 && value.version === 2 && value.workflow === "tickets-plan") {
          const reference = value.decisions?.nativeDispatch;
          try {
            const run = reference && db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(reference.runId) as Record<string, any> | undefined;
            const operation = reference && db.prepare("SELECT intent_json FROM operation_journal WHERE run_id=? AND idempotency_key=? AND status='confirmed'").get(reference.runId, reference.dispatchId) as { intent_json: string } | undefined;
            const tuple = operation && JSON.parse(operation.intent_json).tuple;
            if (reference?.version === 2 && Object.keys(reference).length === 4 && reference.runId === `ticket-plan:${value.id}` &&
              tuple?.operation === "ticket-plan" && tuple.digest === reference.tupleDigest && tuple.sessionId === value.runtime?.sessionId &&
              !value.decisions.structuredResponse && !value.decisions.proposalResponse && run && !invalidStructuredRun(db, run, root)) continue;
          } catch { /* Unverifiable native references remain incompatible. */ }
        }
        if (owner.kind === "build-checkpoint") {
          const run = db.prepare("SELECT checkpoint FROM workflow_runs WHERE run_id=?").get(value.runId) as { checkpoint: string } | undefined;
          if (run && run.checkpoint !== STRUCTURED_CUTOVER_REASON && !value.builder && !value.qa && !value.receipts && !value.sessionBindings) continue;
        }
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        if (lstatSync(archive).isSymbolicLink()) throw new Error("Unsafe communication quarantine storage");
        const digest = createHash("sha256").update(bytes).digest("hex");
        const archived = join(archive, `${digest}.json`);
        if (!existsSync(archived)) writeFileSync(archived, bytes, { mode: 0o600, flag: "wx" });
        if (lstatSync(archived).isSymbolicLink() || createHash("sha256").update(readFileSync(archived)).digest("hex") !== digest) throw new Error("Communication quarantine integrity failure");
        sync(archived); sync(archive);
        const next = { ...value, status: owner.kind === "interview" ? "incompatible" : "superseded",
          checkpoint: STRUCTURED_CUTOVER_REASON, runtime: {}, sessionIds: {}, continuityLost: true,
          structuredCommunicationCutover: { version: 2, reason: STRUCTURED_CUTOVER_REASON, archiveDigest: digest, kind: owner.kind } };
        // The archive and stage survive SQLite rollback. A restart can classify
        // either original or incompatible bytes without losing the input or
        // treating a partial filesystem rewrite as completed DB repair.
        const replacement = `${JSON.stringify(next, null, 2)}\n`;
        const stageDigest = createHash("sha256").update(path).update(digest).digest("hex");
        const stage = join(archive, `${stageDigest}.stage.json`);
        const stagedBytes = JSON.stringify({ version: 1, path, originalDigest: digest,
          replacementDigest: createHash("sha256").update(replacement).digest("hex"), replacement });
        if (!existsSync(stage)) writeFileSync(stage, stagedBytes, { mode: 0o600, flag: "wx" });
        if (lstatSync(stage).isSymbolicLink() || readFileSync(stage, "utf8") !== stagedBytes) throw new Error("Communication quarantine stage integrity failure");
        sync(stage); sync(archive);
        const temporary = `${path}.${randomUUID()}.cutover.tmp`;
        writeFileSync(temporary, replacement, { mode: 0o600, flag: "wx" });
        sync(temporary);
        renameSync(temporary, path);
        sync(directory);
      }
    };
    walk(join(root, owner.directory));
  }
}
