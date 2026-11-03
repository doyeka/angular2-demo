import type { Db } from '../db/types.ts';
import type { MailMessage } from './types.ts';

export const MAX_BODY_CHARS = 20_000;

interface Row {
  id: string;
  account: string;
  thread_id: string;
  from_name: string;
  from_email: string;
  to_emails: string;
  subject: string;
  snippet: string;
  body: string;
  labels: string;
  internal_date: number;
}

const toMsg = (r: Row): MailMessage => ({
  id: r.id,
  account: r.account,
  threadId: r.thread_id,
  fromName: r.from_name ?? '',
  fromEmail: r.from_email ?? '',
  to: JSON.parse(r.to_emails || '[]'),
  subject: r.subject ?? '',
  snippet: r.snippet ?? '',
  body: r.body ?? '',
  labels: JSON.parse(r.labels || '[]'),
  date: r.internal_date,
});

export class MailStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async upsert(m: MailMessage): Promise<void> {
    await this.db.run(
      `INSERT INTO mail_messages (id, account, thread_id, from_name, from_email, to_emails, subject, snippet, body, labels, internal_date, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET labels=excluded.labels, synced_at=excluded.synced_at`,
      [
        m.id,
        m.account,
        m.threadId,
        m.fromName,
        m.fromEmail.toLowerCase(),
        JSON.stringify(m.to),
        m.subject,
        m.snippet,
        m.body.slice(0, MAX_BODY_CHARS),
        JSON.stringify(m.labels),
        m.date,
        Date.now(),
      ],
    );
  }

  async has(id: string): Promise<boolean> {
    return !!(await this.db.get('SELECT 1 AS x FROM mail_messages WHERE id = ?', [id]));
  }

  async count(): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mail_messages'))?.n ?? 0;
  }

  /**
   * Local search. `text` is an FTS5 MATCH expression (or plain words, which we
   * OR together). Results are restricted to `after` (epoch ms) and ordered by date desc.
   */
  async search(opts: { text?: string; after?: number; before?: number; limit?: number; excludeDomains?: string[] }): Promise<MailMessage[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    let from = 'mail_messages m';
    if (opts.text?.trim()) {
      from = 'mail_fts f JOIN mail_messages m ON m.rowid = f.rowid';
      where.push('mail_fts MATCH ?');
      params.push(toFtsQuery(opts.text));
    }
    if (opts.after) {
      where.push('m.internal_date >= ?');
      params.push(opts.after);
    }
    if (opts.before) {
      where.push('m.internal_date < ?');
      params.push(opts.before);
    }
    for (const d of opts.excludeDomains ?? []) {
      where.push(`m.from_email NOT LIKE ?`);
      params.push(`%@${d.toLowerCase()}`);
      where.push(`m.from_email NOT LIKE ?`);
      params.push(`%.${d.toLowerCase()}`);
    }
    const sql = `SELECT m.* FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY m.internal_date DESC LIMIT ?`;
    params.push(opts.limit ?? 50);
    return (await this.db.all<Row>(sql, params)).map(toMsg);
  }

  async getThread(threadId: string): Promise<MailMessage[]> {
    return (
      await this.db.all<Row>('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY internal_date ASC', [threadId])
    ).map(toMsg);
  }

  async get(id: string): Promise<MailMessage | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM mail_messages WHERE id = ?', [id]);
    return r ? toMsg(r) : undefined;
  }
}

/** Plain words → `"w1" OR "w2"`; anything with FTS operators/quotes passes through. */
export function toFtsQuery(text: string): string {
  if (/["()*:]|\b(AND|OR|NOT|NEAR)\b/.test(text)) return text;
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);
  return words.map((w) => `"${w}"`).join(' OR ');
}
