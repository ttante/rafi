import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { classifyProcess } from "./processIdentity.js";

export const BUILD_WORK_SCHEMA_VERSION = 4;
const migration = "004_admitted_build_work";

/** A copied database must be rebound by state transfer, never by an ordinary writer. */
export function assertBuildProject(db: Database.Database, projectDir: string): void {
  const identity = db.prepare("SELECT canonical_root FROM build_project_identity WHERE singleton=1").get() as { canonical_root: string };
  if (identity.canonical_root !== realpathSync(projectDir)) throw new Error("Build project identity requires explicit state-transfer rebinding");
}

/** Classify legacy records without converting observed progress into permission. */
export function migrateBuildWork(db: Database.Database, projectDir: string, faults?: { beforeGuards?(): void; beforeCommit?(): void }): void {
  if (db.prepare("SELECT 1 FROM recovery_schema_migrations WHERE migration=?").get(migration)) {
    assertBuildProject(db, projectDir);
    return;
  }
  const lease = db.prepare("SELECT pid,process_start,host FROM project_lease").get() as {pid: number; process_start: string; host: string} | undefined;
  if (lease && classifyProcess(lease.pid, lease.process_start, lease.host).state !== "dead") throw new Error("Work admission upgrade requires stopped, verified writers and a consistent backup");
  const owner = db.prepare("SELECT record_json FROM build_admission").get() as {record_json:string}|undefined;
  if (owner) {const identity=JSON.parse(owner.record_json);if(classifyProcess(identity.pid,identity.processStart,identity.host).state!=="dead")throw new Error("Work admission upgrade requires a stopped, verified build owner");}
  const backup = db.serialize();
  // The coherent WAL-visible backup survives even a rolled-back upgrade.
  // Publish the packet copy and manifest before enabling any new writer.
  const backupDigest=createHash("sha256").update(backup).digest("hex");
  const backupRoot=join(projectDir,".rafi","backups","work-admission-v4");
  const backupPath=join(backupRoot,backupDigest);
  mkdirSync(backupRoot,{recursive:true,mode:0o700});
  if(!existsSync(backupPath)) {
    const staging=join(backupRoot,`${backupDigest}.${randomUUID()}.tmp`);
    mkdirSync(staging,{mode:0o700});
    const file=join(staging,"recovery.sqlite3");writeFileSync(file,backup,{mode:0o600});
    const descriptor=openSync(file,"r");try{fsyncSync(descriptor);}finally{closeSync(descriptor);}
    const packets=join(projectDir,".foreman","qa-report-recovery");
    if(existsSync(packets))cpSync(packets,join(staging,"qa-report-recovery"),{recursive:true,dereference:false});
    const packetFiles=syncBackupTree(staging);
    const manifest=join(staging,"manifest.json");
    writeFileSync(manifest,JSON.stringify({version:1,databaseDigest:backupDigest,canonicalRoot:realpathSync(projectDir),createdAt:new Date().toISOString(),packetCopy:existsSync(packets),files:packetFiles}),{mode:0o600});
    syncFile(manifest);syncDirectory(staging);
    renameSync(staging,backupPath);syncDirectory(backupRoot);
  }
  if(createHash("sha256").update(readFileSync(join(backupPath,"recovery.sqlite3"))).digest("hex")!==backupDigest)throw new Error("Work admission backup failed integrity verification; preserve state before retry");
  try { db.transaction(() => {
    db.exec(`
      CREATE TABLE build_work_upgrade_backup(singleton INTEGER PRIMARY KEY CHECK(singleton=1),database_bytes BLOB NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE build_project_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),project_id TEXT NOT NULL UNIQUE,canonical_root TEXT NOT NULL);
      CREATE TABLE build_work_scope(run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),work_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('ticket','synthetic')),ticket_id TEXT,state TEXT NOT NULL CHECK(state IN ('admitted','quarantined')),definition_json TEXT NOT NULL,PRIMARY KEY(run_id,work_id),UNIQUE(run_id,ticket_id),CHECK((kind='ticket' AND ticket_id=work_id) OR (kind='synthetic' AND ticket_id IS NULL)));
      CREATE TABLE build_work_admissions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,admission_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL,work_id TEXT NOT NULL,assignment_id TEXT NOT NULL,approval_id TEXT NOT NULL,scope_revision TEXT NOT NULL,requirements_digest TEXT NOT NULL,record_json TEXT NOT NULL,admitted_at TEXT NOT NULL,FOREIGN KEY(run_id,work_id) REFERENCES build_work_scope(run_id,work_id));
      CREATE TABLE build_assignments(assignment_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,work_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL,FOREIGN KEY(run_id,work_id) REFERENCES build_work_scope(run_id,work_id));
      CREATE TABLE build_ownership_conflicts(conflict_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,work_id TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,record_json TEXT NOT NULL,FOREIGN KEY(run_id,work_id) REFERENCES build_work_scope(run_id,work_id));
      CREATE TABLE build_work_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),work_id TEXT NOT NULL,table_name TEXT NOT NULL,record_key TEXT NOT NULL,action TEXT NOT NULL,record_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE build_reconciliations(reconciliation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),expected_revision TEXT NOT NULL,record_json TEXT NOT NULL,created_at TEXT NOT NULL);
    `);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO build_work_upgrade_backup VALUES(1,?,?)").run(backup, now);
    db.prepare("INSERT INTO build_project_identity VALUES(1,?,?)").run(randomUUID(), realpathSync(projectDir));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'qa_%'").all() as Array<{name:string}>).filter(({name}) => /^[a-z_]+$/.test(name));
    for (const {name} of tables) {
      const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>;
      if (!columns.some(column => column.name === "run_id") || !columns.some(column => column.name === "ticket_id")) continue;
      for (const row of db.prepare(`SELECT DISTINCT run_id,ticket_id FROM ${name}`).all() as Array<{run_id:string;ticket_id:string}>) {
        db.prepare("INSERT OR IGNORE INTO build_work_scope VALUES(?,?,'ticket',?,'quarantined','{}')").run(row.run_id, row.ticket_id, row.ticket_id);
        db.prepare("INSERT OR IGNORE INTO build_ownership_conflicts VALUES(?,?,?,'unresolved',1,?)").run(`legacy:${row.run_id}:${row.ticket_id}`, row.run_id, row.ticket_id, JSON.stringify({ reason: "Legacy QA progress is not proof of run-bound approval and assignment", classification: "ownership_unestablished", observedTable: name }));
      }
    }
    faults?.beforeGuards?.();
    // Replace V3 guards atomically. Old connections register 3 and fail even on heartbeat writes.
    for (const trigger of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'handback_v3_%'").all() as Array<{name:string;sql:string}>) {
      db.exec(`DROP TRIGGER "${trigger.name}"`);
      db.exec(trigger.sql.replace("rafi_writer_protocol() != 3", "rafi_writer_protocol() != 4"));
    }
    db.function("rafi_writer_protocol", () => 4);
    for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'build_%'").all() as Array<{name:string}>) {
      if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected build storage table");
      for (const action of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS work_v4_protocol_${name}_${action} BEFORE ${action} ON ${name} BEGIN SELECT CASE WHEN rafi_writer_protocol()<>4 THEN RAISE(ABORT,'incompatible work admission writer') END; END`);
    }
    for (const {name} of tables) {
      const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>;
      let scope: (target:string) => string;
      if (columns.some(column => column.name === "run_id") && columns.some(column => column.name === "ticket_id")) scope = target => `s.run_id=${target}.run_id AND s.work_id=${target}.ticket_id`;
      else if (columns.some(column => column.name === "run_id") && columns.some(column => column.name === "work_id")) scope = target => `s.run_id=${target}.run_id AND s.work_id=${target}.work_id`;
      else if (name === "qa_preparation_attempts" || name === "qa_preparation_progress") scope = target => `EXISTS(SELECT 1 FROM qa_preparation_budgets b WHERE b.id=${target}.budget_id AND b.run_id=s.run_id AND b.work_id=s.work_id)`;
      else if (name === "qa_contract_receipts") scope = target => `EXISTS(SELECT 1 FROM qa_verification_contracts c WHERE c.digest=${target}.contract_digest AND c.run_id=s.run_id AND c.work_id=s.work_id)`;
      else if (columns.some(column => column.name === "report_occurrence_id")) scope = target => `EXISTS(SELECT 1 FROM qa_reports r WHERE r.report_occurrence_id=${target}.report_occurrence_id AND r.run_id=s.run_id AND r.ticket_id=s.work_id)`;
      else if (columns.some(column => column.name === "operation_id")) scope = target => `EXISTS(SELECT 1 FROM qa_turns t WHERE t.operation_id=${target}.operation_id AND t.run_id=s.run_id AND t.ticket_id=s.work_id)`;
      else continue;
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const target = action === "DELETE" ? "OLD" : "NEW";
        db.exec(`CREATE TRIGGER work_v4_scope_${name}_${action} BEFORE ${action} ON ${name} WHEN NOT EXISTS(SELECT 1 FROM build_work_scope s WHERE ${scope(target)} AND s.state='admitted') BEGIN SELECT RAISE(ABORT,'QA work is not admitted; reconcile ownership first'); END`);
      }
    }
    for (const {name} of tables) {
      const columns=db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string;pk:number}>;
      if(!columns.some(column=>column.name==="run_id")||!columns.some(column=>column.name==="ticket_id"))continue;
      const keys=columns.filter(column=>column.pk).sort((a,b)=>a.pk-b.pk).map(column=>`NEW.${column.name}`);
      const retained=columns.filter(column=>column.pk||["status","state","disposition","review_number","from_revision","to_revision","source_digest","source_state_digest","report_digest","review_basis_digest","certificate_id","generation","request_digest","response_digest","summary_digest","event_json"].includes(column.name)).flatMap(column=>[`'${column.name}'`,`NEW.${column.name}`]);
      for(const action of ["INSERT","UPDATE"])db.exec(`CREATE TRIGGER work_v4_order_${name}_${action} AFTER ${action} ON ${name} BEGIN INSERT INTO build_work_events(run_id,work_id,table_name,record_key,action,record_json,created_at) VALUES(NEW.run_id,NEW.ticket_id,'${name}',json_array(${keys.join(",")}), '${action.toLowerCase()}',json_object(${retained.join(",")}),strftime('%Y-%m-%dT%H:%M:%fZ','now')); END`);
    }
    for (const {name} of tables) {
      const columns=db.prepare(`PRAGMA table_info(${name})`).all() as Array<{name:string}>;
      if(columns.some(column=>column.name==="run_id")&&columns.some(column=>column.name==="ticket_id")) db.exec(`CREATE TRIGGER work_v4_identity_${name} BEFORE UPDATE ON ${name} WHEN NEW.run_id<>OLD.run_id OR NEW.ticket_id<>OLD.ticket_id BEGIN SELECT RAISE(ABORT,'Scoped QA identity is immutable'); END`);
    }
    for(const action of ["INSERT","UPDATE"]) {
      db.exec(`CREATE TRIGGER work_v4_report_parent_${action} BEFORE ${action} ON qa_reports WHEN NOT EXISTS(SELECT 1 FROM qa_review_attempts p WHERE p.run_id=NEW.run_id AND p.ticket_id=NEW.ticket_id AND p.review_number=NEW.review_number AND p.source_digest=NEW.source_state_digest AND p.report_digest=NEW.report_digest) BEGIN SELECT RAISE(ABORT,'QA report parent ownership mismatch'); END;
        CREATE TRIGGER work_v4_chain_parent_${action} BEFORE ${action} ON qa_report_chains WHEN NOT EXISTS(SELECT 1 FROM qa_reports p JOIN qa_reports s ON p.run_id=s.run_id AND p.ticket_id=s.ticket_id WHERE p.report_occurrence_id=NEW.predecessor_occurrence_id AND s.report_occurrence_id=NEW.successor_occurrence_id AND p.report_digest=NEW.predecessor_report_digest AND s.report_digest=NEW.successor_report_digest) BEGIN SELECT RAISE(ABORT,'QA report chain parent ownership mismatch'); END;
        CREATE TRIGGER work_v4_assignment_${action} BEFORE ${action} ON operation_journal WHEN NEW.kind='build-assignment' AND NOT EXISTS(SELECT 1 FROM build_work_scope s WHERE s.run_id=NEW.run_id AND s.work_id=json_extract(NEW.intent_json,'$.ticketId') AND s.state='admitted') BEGIN SELECT RAISE(ABORT,'Builder assignment is not admitted'); END;
        CREATE TRIGGER work_v4_branch_${action} BEFORE ${action} ON branch_resume_sessions WHEN NOT EXISTS(SELECT 1 FROM build_work_scope s WHERE s.run_id=NEW.run_id AND s.work_id=NEW.ticket AND s.state='admitted') BEGIN SELECT RAISE(ABORT,'Branch work is not admitted'); END;`);
    }
    db.exec(`CREATE TRIGGER work_v4_membership_update BEFORE UPDATE OF state_json ON workflow_runs WHEN EXISTS(SELECT 1 FROM build_work_admissions a WHERE a.run_id=NEW.run_id AND NOT EXISTS(SELECT 1 FROM json_each(NEW.state_json,'$.tickets') j WHERE j.value=a.work_id)) AND json_extract(NEW.state_json,'$.version') IS NOT NULL BEGIN SELECT RAISE(ABORT,'Build snapshot cannot drop admitted work'); END;
      CREATE TRIGGER work_v4_admission_update BEFORE UPDATE ON build_work_admissions BEGIN SELECT RAISE(ABORT,'Work admissions are immutable'); END;
      CREATE TRIGGER work_v4_admission_delete BEFORE DELETE ON build_work_admissions BEGIN SELECT RAISE(ABORT,'Work admissions are immutable'); END;
      CREATE TRIGGER work_v4_scope_identity BEFORE UPDATE ON build_work_scope WHEN NEW.run_id<>OLD.run_id OR NEW.work_id<>OLD.work_id OR NEW.kind<>OLD.kind OR NEW.ticket_id IS NOT OLD.ticket_id BEGIN SELECT RAISE(ABORT,'Work identity is immutable'); END;
      CREATE TRIGGER work_v4_scope_delete BEFORE DELETE ON build_work_scope BEGIN SELECT RAISE(ABORT,'Work scope must be retained'); END;`);
    for (const table of ["build_work_scope", "build_work_admissions", "build_assignments", "build_ownership_conflicts", "build_reconciliations"]) {
      for (const action of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER work_v4_authority_${table}_${action} BEFORE ${action} ON ${table} WHEN rafi_work_authority()=0 BEGIN SELECT RAISE(ABORT,'Restricted work admission authority required'); END`);
    }
    for(const action of ["INSERT","UPDATE"]) db.exec(`CREATE TRIGGER work_v4_remediation_parent_${action} BEFORE ${action} ON qa_remediation_attempts WHEN NOT EXISTS(SELECT 1 FROM qa_review_attempts p WHERE p.attempt_id=NEW.review_attempt_id AND p.run_id=NEW.run_id AND p.ticket_id=NEW.ticket_id) BEGIN SELECT RAISE(ABORT,'Remediation parent ownership mismatch'); END;
      CREATE TRIGGER work_v4_finalization_parent_${action} BEFORE ${action} ON qa_finalization_steps WHEN NOT EXISTS(SELECT 1 FROM qa_pass_certificates p WHERE p.certificate_id=NEW.certificate_id AND p.run_id=NEW.run_id AND p.ticket_id=NEW.ticket_id) BEGIN SELECT RAISE(ABORT,'Finalization parent ownership mismatch'); END;
      CREATE TRIGGER work_v4_handoff_parent_${action} BEFORE ${action} ON qa_failure_handoffs WHEN NOT EXISTS(SELECT 1 FROM qa_reports p JOIN qa_review_attempts a ON a.run_id=p.run_id AND a.ticket_id=p.ticket_id AND a.review_number=p.review_number WHERE p.report_occurrence_id=NEW.report_occurrence_id AND p.run_id=NEW.run_id AND p.ticket_id=NEW.ticket_id AND p.report_digest=NEW.report_digest AND a.attempt_id=NEW.review_attempt_id) BEGIN SELECT RAISE(ABORT,'Failure handoff parent ownership mismatch'); END;
      CREATE TRIGGER work_v4_authorization_parent_${action} BEFORE ${action} ON qa_remediation_authorizations WHEN NOT EXISTS(SELECT 1 FROM qa_review_attempts p WHERE p.attempt_id=NEW.review_attempt_id AND p.run_id=NEW.run_id AND p.ticket_id=NEW.ticket_id) BEGIN SELECT RAISE(ABORT,'Authorization parent ownership mismatch'); END;`);
    for(const action of ["INSERT","UPDATE"]) {
      db.exec(`CREATE TRIGGER work_v4_delivery_parent_${action} BEFORE ${action} ON qa_delivery_turns WHEN NOT EXISTS(SELECT 1 FROM qa_failure_handoffs h WHERE h.operation_id=NEW.operation_id AND h.report_occurrence_id=NEW.report_occurrence_id) BEGIN SELECT RAISE(ABORT,'QA delivery parent ownership mismatch'); END`);
      for(const table of ["qa_findings","qa_report_dispositions"])db.exec(`CREATE TRIGGER work_v4_occurrence_digest_${table}_${action} BEFORE ${action} ON ${table} WHEN NOT EXISTS(SELECT 1 FROM qa_reports r WHERE r.report_occurrence_id=NEW.report_occurrence_id AND r.report_digest=NEW.report_digest) BEGIN SELECT RAISE(ABORT,'QA occurrence digest ownership mismatch'); END`);
    }
    db.exec(`CREATE TRIGGER work_v4_delivery_identity BEFORE UPDATE ON qa_delivery_turns WHEN NEW.operation_id<>OLD.operation_id OR NEW.report_occurrence_id<>OLD.report_occurrence_id OR NEW.turn_index<>OLD.turn_index OR NEW.turn_record_id<>OLD.turn_record_id BEGIN SELECT RAISE(ABORT,'QA delivery identity is immutable'); END`);
    for(const action of ["INSERT","UPDATE"])db.exec(`CREATE TRIGGER work_v4_certificate_parent_${action} BEFORE ${action} ON qa_pass_certificates WHEN NOT EXISTS(SELECT 1 FROM qa_turns t JOIN qa_turn_events e ON e.operation_id=t.operation_id AND e.event_index=0 WHERE t.run_id=NEW.run_id AND t.ticket_id=NEW.ticket_id AND t.source_state_digest=NEW.source_state_digest AND t.review_basis_digest=NEW.review_basis_digest AND t.status='completed' AND e.event_digest=NEW.turn_receipt_digest AND e.event_json=t.receipt_json AND json_extract(t.receipt_json,'$.terminalEventObserved')=1 AND length(json_extract(t.receipt_json,'$.providerTurnId'))>0) BEGIN SELECT RAISE(ABORT,'QA certificate completion receipt ownership mismatch'); END`);
    for(const table of ["build_reconciliations","build_work_events"])for(const action of ["UPDATE","DELETE"])db.exec(`CREATE TRIGGER work_v4_immutable_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Build audit history is immutable'); END`);
    faults?.beforeCommit?.();
    if ((db.pragma("foreign_key_check") as unknown[]).length || db.pragma("integrity_check", {simple:true}) !== "ok") throw new Error("Work admission upgrade integrity failure");
    db.prepare("INSERT INTO recovery_schema_migrations VALUES(?,?)").run(migration, now);
    db.pragma("user_version = 4");
  }).immediate(); } catch(error) {db.function("rafi_writer_protocol",()=>3);throw error;}
}


function syncFile(path:string):void {const descriptor=openSync(path,"r");try{fsyncSync(descriptor);}finally{closeSync(descriptor);}}
function syncDirectory(path:string):void {if(process.platform!=="win32")syncFile(path);}
function syncBackupTree(root:string):Array<{path:string;kind:string;digest:string}> {
  const files:Array<{path:string;kind:string;digest:string}>=[];
  const visit=(directory:string):void=>{
    chmodSync(directory,0o700);
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if(entry.isDirectory())visit(path);
      else {
        const bytes=entry.isSymbolicLink()?Buffer.from(readlinkSync(path)):readFileSync(path);
        if(!entry.isSymbolicLink()){chmodSync(path,0o600);syncFile(path);}
        files.push({path:relative(root,path),kind:entry.isSymbolicLink()?"symlink":"file",digest:createHash("sha256").update(bytes).digest("hex")});
      }
    }
    syncDirectory(directory);
  };
  visit(root);return files.sort((a,b)=>a.path.localeCompare(b.path));
}
