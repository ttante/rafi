import Database from "better-sqlite3";
import { registerHandbackWriter } from "../../src/qaHandbackMigration.js";

/** Offline copied fixtures model V3 storage, retaining all QA bytes and old guards. */
export function makeLegacyWorkFixture(path:string):void {
  const db=new Database(path);registerHandbackWriter(db);
  db.function("rafi_protocol_v3",()=>1);db.function("rafi_build_writer_run",()=>"");db.function("rafi_build_writer_token",()=>"");db.function("rafi_build_lease_owner",()=>"");db.function("rafi_build_lease_generation",()=>-1);db.pragma("foreign_keys=OFF");
  try {db.transaction(()=>{
    for(const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'work_v4_%' OR name LIKE 'control_%')").all() as Array<{name:string}>)db.exec(`DROP TRIGGER "${trigger.name}"`);
    for(const table of ["build_instruction_events","build_instruction_deliveries","build_instructions","build_instruction_streams","build_work_events","build_reconciliations","build_ownership_conflicts","build_assignments","build_work_admissions","build_work_scope","build_project_identity","build_work_upgrade_backup"])db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.prepare("DELETE FROM recovery_schema_migrations WHERE migration IN ('004_admitted_build_work','005_manager_controls')").run();
    for(const trigger of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'handback_v3_%'").all() as Array<{name:string;sql:string}>) {db.exec(`DROP TRIGGER "${trigger.name}"`);db.exec(trigger.sql.replace("rafi_writer_protocol() != 4","rafi_writer_protocol() != 3"));}
    db.pragma("user_version=3");
  })();}finally{db.close();}
}
