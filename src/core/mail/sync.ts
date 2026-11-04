import type { MailStore } from './store.ts';
import type { MailProvider } from './types.ts';

export interface SyncResult {
  matched: number;
  fetched: number;
  skippedExisting: number;
}

/**
 * Pull provider-side search results into the local FTS cache.
 * Idempotent: already-cached ids are skipped, so an interrupted sync resumes cheaply.
 */
export async function syncQuery(
  provider: MailProvider,
  store: MailStore,
  query: string,
  opts: { max?: number; concurrency?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<SyncResult> {
  const ids = await provider.searchIds(query, { max: opts.max ?? 2000, signal: opts.signal });
  const todo: string[] = [];
  for (const id of ids) if (!(await store.has(id))) todo.push(id);
  let done = 0;
  const conc = opts.concurrency ?? 6;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      if (opts.signal?.aborted) throw new Error('aborted');
      const id = todo[cursor++];
      const msg = await provider.getMessage(id, opts.signal);
      await store.upsert(msg);
      done++;
      opts.onProgress?.(done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, todo.length) }, worker));
  return { matched: ids.length, fetched: done, skippedExisting: ids.length - todo.length };
}
