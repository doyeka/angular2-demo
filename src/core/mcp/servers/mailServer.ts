import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MailStore } from '../../mail/store.ts';
import { syncQuery } from '../../mail/sync.ts';
import type { MailProvider } from '../../mail/types.ts';
import { stripQuotedAndFooter } from '../../util/text.ts';

const DAY = 86_400_000;

const json = (v: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(v) }],
  structuredContent: v as Record<string, unknown>,
});

/**
 * In-process MCP server over the local mail cache.
 * `sync` is the only network tool (openWorldHint) — everything else works offline.
 */
export function createMailServer(deps: { store: MailStore; provider: () => MailProvider | null; now?: () => number }): McpServer {
  const now = deps.now ?? Date.now;
  const server = new McpServer({ name: 'mail', version: '0.1.0' });

  server.registerTool(
    'sync',
    {
      title: 'Sync mail from provider',
      description:
        'Download messages matching a provider search query (Gmail syntax, e.g. `newer_than:90d recruiter`) into the on-device cache. Requires network.',
      inputSchema: {
        query: z.string().describe('Gmail search query'),
        max: z.number().int().min(1).max(5000).default(1000),
      },
      annotations: { openWorldHint: true, readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, max }, extra) => {
      const p = deps.provider();
      if (!p) return { isError: true, content: [{ type: 'text', text: 'No mail account connected.' }] };
      const r = await syncQuery(p, deps.store, query, { max, signal: extra.signal });
      return json({ ...r, cached: await deps.store.count() });
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search cached mail',
      description:
        'Full-text search over cached mail (offline). Returns message summaries, newest first. Use plain keywords; they are OR-ed.',
      inputSchema: {
        text: z.string().optional().describe('Keywords or FTS5 expression'),
        newer_than_days: z.number().int().min(1).max(3650).optional(),
        exclude_sender_domains: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(500).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ text, newer_than_days, exclude_sender_domains, limit }) => {
      const msgs = await deps.store.search({
        text,
        after: newer_than_days ? now() - newer_than_days * DAY : undefined,
        excludeDomains: exclude_sender_domains,
        limit,
      });
      return json({
        messages: msgs.map((m) => ({
          id: m.id,
          thread_id: m.threadId,
          from: `${m.fromName} <${m.fromEmail}>`,
          subject: m.subject,
          date: new Date(m.date).toISOString(),
          snippet: m.snippet.slice(0, 200),
        })),
      });
    },
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Read a thread',
      description: 'Read all cached messages in a thread (quoted replies stripped). Offline.',
      inputSchema: {
        thread_id: z.string(),
        max_chars_per_message: z.number().int().min(200).max(20000).default(4000),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ thread_id, max_chars_per_message }) => {
      const msgs = await deps.store.getThread(thread_id);
      return json({
        thread_id,
        messages: msgs.map((m) => ({
          id: m.id,
          from_name: m.fromName,
          from_email: m.fromEmail,
          subject: m.subject,
          date: new Date(m.date).toISOString(),
          body: stripQuotedAndFooter(m.body).slice(0, max_chars_per_message),
        })),
      });
    },
  );

  server.registerTool(
    'stats',
    {
      title: 'Cache stats',
      description: 'How many messages are cached locally and whether an account is connected.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json({ cached: await deps.store.count(), account: deps.provider()?.account ?? null }),
  );

  return server;
}
