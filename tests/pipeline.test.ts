import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compact, runReact } from '../src/core/agent/react.ts';
import { route } from '../src/core/agent/router.ts';
import { migrate } from '../src/core/db/schema.ts';
import { ScriptedLLM } from '../src/core/llm/scripted.ts';
import { parseHermesToolCalls } from '../src/core/llm/types.ts';
import { MailStore } from '../src/core/mail/store.ts';
import { McpHub } from '../src/core/mcp/hub.ts';
import { ground } from '../src/core/skills/jobOpportunities/extract.ts';
import { jobOpportunitiesSkill } from '../src/core/skills/jobOpportunities/index.ts';
import { buildGmailQuery, scoreMessage } from '../src/core/skills/jobOpportunities/prefilter.ts';
import { findPII } from '../src/core/skills/jobOpportunities/redact.ts';
import { MAILBOX } from '../eval/fixtures/mailbox.ts';
import { openNodeDb } from '../eval/nodeDb.ts';

describe('grounding', () => {
  it('drops fabricated spans, keeps verbatim ones', () => {
    const src = 'We are hiring. The range is $240k–$290k base. We have about 180 people.';
    const g = ground(
      {
        kind: 'recruiter_outreach', company: 'X', via_agency: null, role_title: 'Eng', level: null, location: null, remote: 'unknown',
        salary_text: '$240k–$290k base', equity_text: '0.5% equity', company_size_text: 'about 180 people', funding_text: 'Series B',
        benefits: ['unlimited PTO'], referral_bonus_text: null, asks_for_referrals: false,
      },
      src,
    );
    expect(g.salary_text).toBe('$240k–$290k base');
    expect(g.company_size_text).toBe('about 180 people');
    expect(g.equity_text).toBeNull();
    expect(g.funding_text).toBeNull();
    expect(g.benefits).toEqual([]);
  });
});

describe('prefilter', () => {
  it('scores outreach above noise', () => {
    const by = (t: string) => MAILBOX.find((m) => m.threadId === t)!;
    expect(scoreMessage(by('t-kestrel')).score).toBeGreaterThanOrEqual(3);
    expect(scoreMessage(by('t-tallow')).score).toBeGreaterThanOrEqual(3);
    expect(scoreMessage(by('t-order')).score).toBeLessThan(3);
  });
  it('gmail query carries window and exclusions', () => {
    const q = buildGmailQuery(90, ['anthropic.com']);
    expect(q).toContain('newer_than:90d');
    expect(q).toContain('-from:anthropic.com');
  });
});

describe('PII scan', () => {
  it('finds emails and phone numbers', () => {
    expect(findPII('<td>a@b.com</td> call 415-555-0142')).toEqual(['a@b.com', '415-555-0142']);
    expect(findPII('<td>$240k</td> 2026-11-03')).toEqual([]);
  });
});

describe('hermes tool-call fallback parser', () => {
  it('parses Qwen-style blocks', () => {
    const r = parseHermesToolCalls('ok <tool_call>{"name":"mail__search","arguments":{"text":"offer"}}</tool_call>');
    expect(r.content).toBe('ok');
    expect(r.toolCalls[0]).toMatchObject({ name: 'mail__search', arguments: { text: 'offer' } });
  });
});

async function hubWithTools(): Promise<McpHub> {
  const hub = new McpHub();
  const s = new McpServer({ name: 't', version: '0' });
  s.registerTool('echo', { description: 'echo', inputSchema: { v: z.string() }, annotations: { readOnlyHint: true } }, async ({ v }) => ({
    content: [{ type: 'text', text: `echo:${v}` }],
  }));
  s.registerTool('net', { description: 'net', inputSchema: {}, annotations: { openWorldHint: true } }, async () => ({
    content: [{ type: 'text', text: 'fetched' }],
  }));
  await hub.addInProcess('t', s);
  return hub;
}

describe('MCP hub approval gate', () => {
  it('local tools run without approval; network tools need it; allow-always sticks', async () => {
    const hub = await hubWithTools();
    const asked: string[] = [];
    let answer: 'deny' | 'allow-always' = 'deny';
    hub.setApprover(async (r) => (asked.push(r.tool.qualifiedName), answer));
    expect((await hub.call('t__echo', { v: 'hi' })).text).toBe('echo:hi');
    expect(asked).toEqual([]);
    expect((await hub.call('t__net', {})).isError).toBe(true);
    answer = 'allow-always';
    expect((await hub.call('t__net', {})).text).toBe('fetched');
    expect((await hub.call('t__net', {})).text).toBe('fetched');
    expect(asked).toEqual(['t__net', 't__net']);
  });
  it('denies network tools when no approver is set', async () => {
    const hub = await hubWithTools();
    expect((await hub.call('t__net', {})).isError).toBe(true);
  });
});

describe('ReAct loop', () => {
  it('executes a tool call then answers', async () => {
    const hub = await hubWithTools();
    const llm = new ScriptedLLM((req, i) =>
      i === 0
        ? { text: '', toolCalls: [{ id: 'c1', name: 't__echo', arguments: { v: 'x' } }] }
        : { text: `done: ${req.messages.at(-1)!.content}`, toolCalls: [] },
    );
    const out = await runReact(llm, hub, [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
    expect(out.text).toBe('done: echo:x');
    expect(llm.calls[0].tools?.map((t) => t.name)).toContain('t__echo');
  });
  it('compaction keeps system + latest turn within budget', () => {
    const big = 'x'.repeat(4000);
    const ms = [
      { role: 'system' as const, content: 'sys' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user', content: big })),
      { role: 'user' as const, content: 'latest' },
    ];
    const c = compact(ms, 3000);
    expect(c[0].content).toBe('sys');
    expect(c.at(-1)!.content).toBe('latest');
    expect(c.length).toBeLessThan(ms.length);
  });
});

describe('router', () => {
  it('routes to the skill and fills args through two constrained calls', async () => {
    const llm = new ScriptedLLM((req) =>
      'route' in (req.jsonSchema!.properties as object)
        ? JSON.stringify({ route: 'job_opportunities_report' })
        : JSON.stringify({ days: 90, exclude_companies: ['Anthropic'] }),
    );
    const r = await route(llm, [jobOpportunitiesSkill], 'jobs in last 90 days besides Anthropic');
    expect(r.kind).toBe('skill');
    if (r.kind === 'skill') expect(r.args).toMatchObject({ days: 90, exclude_companies: ['Anthropic'], enrich: true });
    expect(llm.calls.every((c) => !!c.jsonSchema)).toBe(true);
  });
});

describe('mail store FTS', () => {
  it('searches cached mail with date window and domain exclusion', async () => {
    const db = openNodeDb();
    await migrate(db);
    const store = new MailStore(db);
    for (const m of MAILBOX) await store.upsert(m);
    const now = Date.parse('2026-11-03T15:00:00Z');
    const res = await store.search({ text: 'recruiter', after: now - 90 * 86_400_000, excludeDomains: ['anthropic.com'], limit: 50 });
    expect(res.length).toBeGreaterThan(0);
    expect(res.some((m) => m.fromEmail.endsWith('anthropic.com'))).toBe(false);
    expect(res.some((m) => m.threadId === 't-vantorra-old')).toBe(false);
  });
});

describe('statement splitter (device migrations)', async () => {
  const { splitStatements } = await import('../src/core/db/split.ts');
  it('keeps trigger bodies intact', () => {
    const parts = splitStatements(`CREATE TABLE a(x);\nCREATE TRIGGER t AFTER INSERT ON a BEGIN\n  INSERT INTO b VALUES (1);\n  INSERT INTO c VALUES (2);\nEND;\nCREATE INDEX i ON a(x);`);
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatch(/^CREATE TRIGGER[\s\S]*END;$/);
  });
  it('splits every real migration into executable statements', async () => {
    const db = openNodeDb();
    const { MIGRATIONS } = await import('../src/core/db/schema.ts');
    for (const m of MIGRATIONS) for (const stmt of splitStatements(m)) await db.exec(stmt);
    expect((await db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name='mail_fts'"))!.n).toBe(1);
  });
});
