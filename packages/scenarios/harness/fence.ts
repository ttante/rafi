// The write fence (SCN 7.7). After a HarnessCrash, every write, rename, remove, database write and git
// command from that instance throws; its open transactions are rolled back; its timers are dropped.
import type { Db, DbStatement, Fs } from "@rafi-ai/engine";

export class FencedWrite extends Error {
  constructor(what: string) {
    super(`fenced: ${what} after the instance crashed`);
  }
}

export class Fence {
  private crashed = false;
  private readonly dbs = new Set<Db>();
  private readonly onCrash: (() => void)[] = [];

  get dead(): boolean {
    return this.crashed;
  }

  check(what: string): void {
    if (this.crashed) throw new FencedWrite(what);
  }

  whenCrashed(fn: () => void): void {
    this.onCrash.push(fn);
  }

  /** Marks the instance dead: open transactions roll back (without committing) and connections close. */
  crash(): void {
    if (this.crashed) return;
    this.crashed = true;
    for (const db of this.dbs) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch {
        // already gone
      }
    }
    for (const fn of this.onCrash) fn();
  }

  /** Closes the fenced instance's connections, once the code that held them has unwound. */
  closeAll(): void {
    for (const db of this.dbs) {
      try { db.close(); } catch { /* already closed */ }
    }
    this.dbs.clear();
  }

  fs(real: Fs): Fs {
    return {
      read: (p) => real.read(p),
      readBytes: (p) => real.readBytes(p),
      writeAtomic: async (p, d) => { this.check(`write ${p}`); await real.writeAtomic(p, d); },
      append: async (p, d) => { this.check(`append ${p}`); await real.append(p, d); },
      rename: async (a, b) => { this.check(`rename ${a}`); await real.rename(a, b); },
      remove: async (p, o) => { this.check(`remove ${p}`); await real.remove(p, o); },
      mkdir: async (p) => { this.check(`mkdir ${p}`); await real.mkdir(p); },
      stat: (p) => real.stat(p),
      realpath: (p) => real.realpath(p),
      list: (p) => real.list(p),
    };
  }

  db(real: Db): Db {
    this.dbs.add(real);
    const fence = this;
    const statement = (inner: DbStatement): DbStatement => ({
      run: (...params) => { fence.check("database write"); return inner.run(...params); },
      get: (...params) => inner.get(...params),
      all: (...params) => inner.all(...params),
    });
    return {
      exec(sql) {
        if (!/^\s*ROLLBACK/i.test(sql)) fence.check("database write");
        real.exec(sql);
      },
      prepare: (sql) => statement(real.prepare(sql)),
      pragma: (sql, o) => {
        if (sql.includes("=")) fence.check("database pragma");
        return real.pragma(sql, o);
      },
      close: () => { fence.dbs.delete(real); real.close(); },
      get inTransaction() { return real.inTransaction; },
    };
  }
}
