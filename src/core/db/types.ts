/**
 * Minimal async SQL contract. Implemented by op-sqlite on device
 * (native/opSqliteDb.ts) and node:sqlite in tests/eval (eval/nodeDb.ts).
 * Both are SQLite with FTS5 enabled, so the same SQL runs everywhere.
 */
export type SqlValue = string | number | null | boolean;

export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
