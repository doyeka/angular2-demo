import type { Db } from '../db/types.ts';

export type JobStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';

export interface Job {
  id: string;
  skill: string;
  args: Record<string, unknown>;
  status: JobStatus;
  stage: string | null;
  progressDone: number;
  progressTotal: number;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Durable job + per-item checkpoints. A skill stage processes items keyed by a
 * stable id (e.g. thread id); finished items are skipped on resume, so a scan
 * killed by the OS mid-way picks up where it stopped.
 */
export class JobStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(skill: string, args: Record<string, unknown>): Promise<Job> {
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    await this.db.run(
      'INSERT INTO jobs(id, skill, args, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [id, skill, JSON.stringify(args), 'pending', now, now],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Job | undefined> {
    const r = await this.db.get<any>('SELECT * FROM jobs WHERE id = ?', [id]);
    return r ? toJob(r) : undefined;
  }

  async list(limit = 20): Promise<Job[]> {
    return (await this.db.all<any>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', [limit])).map(toJob);
  }

  async resumable(): Promise<Job[]> {
    return (await this.db.all<any>("SELECT * FROM jobs WHERE status IN ('running','paused','pending') ORDER BY created_at DESC")).map(toJob);
  }

  async update(id: string, patch: Partial<Pick<Job, 'status' | 'stage' | 'progressDone' | 'progressTotal' | 'result' | 'error'>>): Promise<void> {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const map: Record<string, string> = { status: 'status', stage: 'stage', progressDone: 'progress_done', progressTotal: 'progress_total', error: 'error' };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'result') {
        cols.push('result = ?');
        vals.push(JSON.stringify(v));
      } else if (map[k]) {
        cols.push(`${map[k]} = ?`);
        vals.push(v as string | number | null);
      }
    }
    cols.push('updated_at = ?');
    vals.push(Date.now(), id);
    await this.db.run(`UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`, vals);
  }

  async checkpoint(jobId: string, stage: string, key: string, status: 'done' | 'failed' | 'skipped', result?: unknown): Promise<void> {
    await this.db.run(
      `INSERT INTO job_items(job_id, stage, item_key, status, result) VALUES (?,?,?,?,?)
       ON CONFLICT(job_id, stage, item_key) DO UPDATE SET status = excluded.status, result = excluded.result`,
      [jobId, stage, key, status, result === undefined ? null : JSON.stringify(result)],
    );
  }

  async items<T>(jobId: string, stage: string): Promise<Map<string, { status: string; result: T | null }>> {
    const rows = await this.db.all<any>('SELECT item_key, status, result FROM job_items WHERE job_id = ? AND stage = ?', [jobId, stage]);
    return new Map(rows.map((r) => [r.item_key, { status: r.status, result: r.result ? JSON.parse(r.result) : null }]));
  }
}

const toJob = (r: any): Job => ({
  id: r.id,
  skill: r.skill,
  args: JSON.parse(r.args),
  status: r.status,
  stage: r.stage,
  progressDone: r.progress_done,
  progressTotal: r.progress_total,
  result: r.result ? JSON.parse(r.result) : null,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
