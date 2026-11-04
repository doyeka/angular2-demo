import { DatabaseSync } from 'node:sqlite';
import type { Db, SqlValue } from '../src/core/db/types.ts';

/** node:sqlite (FTS5 built in) implementing the same Db contract as op-sqlite on device. */
export function openNodeDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  const norm = (p: SqlValue[] = []) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  let depth = 0;
  const self: Db = {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params) {
      const r = db.prepare(sql).run(...norm(params));
      return { changes: Number(r.changes) };
    },
    async all(sql, params) {
      return db.prepare(sql).all(...norm(params)) as any[];
    },
    async get(sql, params) {
      return db.prepare(sql).get(...norm(params)) as any;
    },
    async transaction(fn) {
      const sp = `sp${depth++}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const r = await fn();
        db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return self;
}
