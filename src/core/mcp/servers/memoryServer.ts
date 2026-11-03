import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryStore } from '../../memory/store.ts';

export function createMemoryServer(store: MemoryStore): McpServer {
  const server = new McpServer({ name: 'memory', version: '0.1.0' });

  server.registerTool(
    'save',
    {
      title: 'Remember',
      description:
        'Persist a durable fact or preference about the user for future conversations (e.g. "prefers remote roles", "referral bonus at Acme is $5k"). Keep it to one short sentence.',
      inputSchema: {
        content: z.string().min(3).max(500),
        kind: z.enum(['fact', 'preference', 'person']).default('fact'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ content, kind }) => {
      const id = await store.save(content, kind, 'agent');
      return { content: [{ type: 'text', text: `Saved memory #${id}` }] };
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Recall',
      description: 'Search saved memories.',
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(20).default(5) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const res = await store.search(query, limit);
      return { content: [{ type: 'text', text: JSON.stringify(res.map((m) => ({ id: m.id, kind: m.kind, content: m.content }))) }] };
    },
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget',
      description: 'Delete a saved memory by id.',
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      await store.forget(id);
      return { content: [{ type: 'text', text: `Forgot #${id}` }] };
    },
  );

  return server;
}
