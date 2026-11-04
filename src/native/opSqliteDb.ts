import { open } from '@op-engineering/op-sqlite';
import { splitStatements } from '../core/db/split';
import type { Db, SqlValue } from '../core/db/types';

/**
 * op-sqlite (JSI, synchronous native core) behind the shared async Db contract.
 * FTS5 is enabled via `"op-sqlite": { "fts5": true }` in package.json.
 */
export function openDeviceDb(name = 'pocket-agent.db'): Db {
  const db = open({ name });
  const norm = (p: SqlValue[] = []) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  let depth = 0;
  const self: Db = {
    async exec(sql) {
      // op-sqlite executes one statement per call; split migration scripts on statement boundaries.
      for (const stmt of splitStatements(sql)) await db.execute(stmt);
    },
    async run(sql, params) {
      const r = await db.execute(sql, norm(params));
      return { changes: r.rowsAffected ?? 0 };
    },
    async all(sql, params) {
      return (await db.execute(sql, norm(params))).rows as any[];
    },
    async get(sql, params) {
      return (await db.execute(sql, norm(params))).rows[0] as any;
    },
    async transaction(fn) {
      const sp = `sp${depth++}`;
      await db.execute(`SAVEPOINT ${sp}`);
      try {
        const r = await fn();
        await db.execute(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        await db.execute(`ROLLBACK TO ${sp}`);
        await db.execute(`RELEASE ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return self;
}
