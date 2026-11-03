import type { Db } from '../db/types.ts';
import { toFtsQuery } from '../mail/store.ts';

export interface Memory {
  id: number;
  kind: string;
  content: string;
  source: string | null;
  createdAt: number;
}

/**
 * Long-term memory: small, explicit facts/preferences, retrieved by FTS5 BM25.
 * (Embedding retrieval can slot in later via llama.rn's embedding() — the
 * interface stays the same.)
 */
export class MemoryStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async save(content: string, kind = 'fact', source: string | null = null): Promise<number> {
    const dup = await this.db.get<{ id: number }>('SELECT id FROM memories WHERE content = ?', [content]);
    if (dup) return dup.id;
    await this.db.run('INSERT INTO memories(kind, content, source, created_at) VALUES (?,?,?,?)', [
      kind,
      content,
      source,
      Date.now(),
    ]);
    return (await this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id'))!.id;
  }

  async forget(id: number): Promise<void> {
    await this.db.run('DELETE FROM memories WHERE id = ?', [id]);
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    const q = toFtsQuery(query);
    if (!q) return [];
    const rows = await this.db.all<any>(
      `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`,
      [q, limit],
    );
    return rows.map(toMem);
  }

  async all(limit = 100): Promise<Memory[]> {
    return (await this.db.all<any>('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?', [limit])).map(toMem);
  }

  /** Always-on preferences plus query-relevant facts, deduped. */
  async contextFor(query: string, limit = 6): Promise<Memory[]> {
    const prefs = (await this.db.all<any>("SELECT * FROM memories WHERE kind = 'preference' ORDER BY created_at DESC LIMIT 3")).map(toMem);
    const rel = await this.search(query, limit);
    const seen = new Set<number>();
    return [...prefs, ...rel].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).slice(0, limit);
  }
}

const toMem = (r: any): Memory => ({ id: r.id, kind: r.kind, content: r.content, source: r.source, createdAt: r.created_at });
