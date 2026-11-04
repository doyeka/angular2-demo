import type { Db } from './types.ts';

export const MIGRATIONS: string[] = [
  // 1: mail cache + FTS index
  `
  CREATE TABLE IF NOT EXISTS mail_messages (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    from_name TEXT,
    from_email TEXT,
    to_emails TEXT,
    subject TEXT,
    snippet TEXT,
    body TEXT,
    labels TEXT,
    internal_date INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mail_messages_date ON mail_messages(internal_date);
  CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages(thread_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
    subject, body, from_name, from_email,
    content='mail_messages', content_rowid='rowid', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS mail_ai AFTER INSERT ON mail_messages BEGIN
    INSERT INTO mail_fts(rowid, subject, body, from_name, from_email)
    VALUES (new.rowid, new.subject, new.body, new.from_name, new.from_email);
  END;
  CREATE TRIGGER IF NOT EXISTS mail_ad AFTER DELETE ON mail_messages BEGIN
    INSERT INTO mail_fts(mail_fts, rowid, subject, body, from_name, from_email)
    VALUES ('delete', old.rowid, old.subject, old.body, old.from_name, old.from_email);
  END;
  CREATE TRIGGER IF NOT EXISTS mail_au AFTER UPDATE ON mail_messages BEGIN
    INSERT INTO mail_fts(mail_fts, rowid, subject, body, from_name, from_email)
    VALUES ('delete', old.rowid, old.subject, old.body, old.from_name, old.from_email);
    INSERT INTO mail_fts(rowid, subject, body, from_name, from_email)
    VALUES (new.rowid, new.subject, new.body, new.from_name, new.from_email);
  END;
  CREATE TABLE IF NOT EXISTS mail_sync_state (
    account TEXT PRIMARY KEY,
    history_id TEXT,
    last_full_sync INTEGER
  );
  `,
  // 2: long-term memory
  `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    source TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, content='memories', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  `,
  // 3: resumable jobs (skill runs) with per-item checkpoints
  `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    skill TEXT NOT NULL,
    args TEXT NOT NULL,
    status TEXT NOT NULL,          -- pending | running | paused | done | failed
    stage TEXT,
    progress_done INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_items (
    job_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    item_key TEXT NOT NULL,
    status TEXT NOT NULL,          -- done | failed | skipped
    result TEXT,
    PRIMARY KEY (job_id, stage, item_key)
  );
  `,
  // 4: chat transcript + generated artifacts
  `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    title TEXT NOT NULL,
    variant TEXT NOT NULL,         -- private | peer
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

export async function migrate(db: Db): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY)');
  const row = await db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM _migrations');
  const current = row?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    await db.transaction(async () => {
      await db.exec(MIGRATIONS[i]);
      await db.run('INSERT INTO _migrations(version) VALUES (?)', [i + 1]);
    });
  }
}
