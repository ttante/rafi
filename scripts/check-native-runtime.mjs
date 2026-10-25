import assert from "node:assert/strict";
import Database from "better-sqlite3";

// No user files: exercise native loading, transactions and serialized reopen.
const db = new Database(":memory:");
try {
  db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.transaction(() => db.prepare("INSERT INTO smoke VALUES (?, ?)").run(1, "retained"))();
  const reopened = new Database(db.serialize());
  try {
    assert.equal(reopened.prepare("SELECT value FROM smoke WHERE id = 1").get().value, "retained");
    console.log(JSON.stringify({ node: process.version, abi: process.versions.modules,
      platform: process.platform, arch: process.arch,
      sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
      nativeSmoke: "passed" }));
  } finally { reopened.close(); }
} finally { db.close(); }
