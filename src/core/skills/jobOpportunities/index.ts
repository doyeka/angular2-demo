import { completeJSON } from '../../llm/types.ts';
import type { CompanyFacts } from '../../mcp/servers/enrichServer.ts';
import { domainOf } from '../../util/text.ts';
import type { Skill, SkillContext } from '../types.ts';
import { type Extraction, extractOpportunity, type OpportunityKind } from './extract.ts';
import {
  normalizeCompany,
  normalizeLevel,
  parseHeadcount,
  parseMoney,
  parseSalary,
  parseStage,
  type Salary,
  salarySortKey,
  type SizeBucket,
  sizeBucket,
  type Stage,
} from './normalize.ts';
import { buildGmailQuery, isExcludedSender, LOCAL_FTS_QUERY, PREFILTER_THRESHOLD, scoreMessage } from './prefilter.ts';
import { toPeerRows } from './redact.ts';
import { renderReport } from './report.ts';

export interface JobOppArgs {
  days: number;
  exclude_companies: string[];
  exclude_domains: string[];
  include_kinds: OpportunityKind[];
  enrich: boolean;
  sync: boolean;
}

export interface Opportunity {
  key: string;
  company: string;
  viaAgency: string | null;
  role: string;
  level: { label: string; rank: number };
  location: string | null;
  remote: Extraction['remote'];
  kind: OpportunityKind;
  salary: Salary | null;
  equity: string | null;
  headcount: number | null;
  sizeBucket: SizeBucket;
  sizeSource: 'email' | 'enrichment' | null;
  stage: Stage;
  stageSource: 'email' | 'enrichment' | null;
  totalRaisedUsd: number | null;
  benefits: string[];
  referralBonus: string | null;
  asksForReferrals: boolean;
  contact: { name: string; email: string };
  firstSeen: string;
  lastSeen: string;
  threadIds: string[];
  sources: { label: string; url: string }[];
}

interface ThreadExtraction {
  threadId: string;
  ex: Extraction;
  from: { name: string; email: string };
  date: number;
}

const DAY = 86_400_000;

export const jobOpportunitiesSkill: Skill<JobOppArgs> = {
  name: 'job_opportunities_report',
  description:
    'Scan the mailbox for employment opportunities (recruiter outreach, offers, interview processes) within a time window, organize them by salary, company size, funding stage, level and benefits, and produce a PDF report (private + shareable peer version).',
  argsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['days', 'exclude_companies'],
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365 },
      exclude_companies: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    },
  },
  defaults: {
    days: 90,
    exclude_companies: [],
    exclude_domains: [],
    include_kinds: ['recruiter_outreach', 'offer', 'interview_process'],
    enrich: true,
    sync: true,
  },

  async run(ctx, job, args) {
    const excludeDomains = [
      ...args.exclude_domains,
      ...args.exclude_companies.map((c) => `${normalizeCompany(c).replace(/\s+/g, '')}.com`),
    ];
    const excludeNames = args.exclude_companies.map(normalizeCompany).filter(Boolean);
    const progress = (stage: string, done: number, total: number, note?: string) => {
      ctx.onProgress?.({ stage, done, total, note });
      void ctx.jobs.update(job.id, { stage, progressDone: done, progressTotal: total });
    };
    const notes: string[] = [];

    // ---- Stage 1: provider-side prefilter + sync into local cache -------------
    if (args.sync && ctx.hub.tool('mail__sync')) {
      progress('sync', 0, 1, 'Fetching candidate mail');
      const done = await ctx.jobs.items(job.id, 'sync');
      if (!done.has('query')) {
        const r = await ctx.hub.call('mail__sync', { query: buildGmailQuery(args.days, excludeDomains), max: 2000 }, ctx.signal);
        if (r.isError) notes.push(`Mail sync skipped (${r.text.slice(0, 120)}); used the on-device cache.`);
        await ctx.jobs.checkpoint(job.id, 'sync', 'query', r.isError ? 'failed' : 'done', r.text.slice(0, 500));
      }
      progress('sync', 1, 1);
    }

    // ---- Stage 2: local candidate set + rule scoring ---------------------------
    const search = await ctx.hub.callJSON<{ messages: { id: string; thread_id: string }[] }>(
      'mail__search',
      { text: LOCAL_FTS_QUERY, newer_than_days: args.days, exclude_sender_domains: excludeDomains, limit: 500 },
      ctx.signal,
    );
    const threadIds = [...new Set(search.messages.map((m) => m.thread_id))];
    const threads: { threadId: string; input: Parameters<typeof extractOpportunity>[1]; from: { name: string; email: string }; date: number }[] = [];
    for (const [i, tid] of threadIds.entries()) {
      progress('prefilter', i, threadIds.length);
      const t = await ctx.hub.callJSON<{ messages: { id: string; from_name: string; from_email: string; subject: string; date: string; body: string }[] }>(
        'mail__get_thread',
        { thread_id: tid, max_chars_per_message: 4000 },
        ctx.signal,
      );
      const inbound = t.messages.filter(
        (m) => m.from_email !== ctx.selfEmail && !isExcludedSender(m.from_email, excludeDomains),
      );
      if (!inbound.length) continue;
      const best = Math.max(
        ...inbound.map(
          (m) =>
            scoreMessage({
              id: m.id,
              account: '',
              threadId: tid,
              fromName: m.from_name,
              fromEmail: m.from_email,
              to: [],
              subject: m.subject,
              snippet: '',
              body: m.body,
              labels: [],
              date: Date.parse(m.date),
            }).score,
        ),
      );
      if (best < PREFILTER_THRESHOLD) continue;
      const first = inbound[0];
      threads.push({
        threadId: tid,
        from: { name: first.from_name, email: first.from_email },
        date: Date.parse(inbound[inbound.length - 1].date),
        input: {
          threadId: tid,
          messageId: first.id,
          from: `${first.from_name} <${first.from_email}>`,
          subject: first.subject,
          date: first.date,
          body: inbound.map((m) => m.body).join('\n\n---\n\n').slice(0, 6000),
        },
      });
    }
    progress('prefilter', threadIds.length, threadIds.length, `${threads.length} candidate threads`);

    // ---- Stage 3: constrained LLM classification + extraction (checkpointed) ---
    const prior = await ctx.jobs.items<Extraction>(job.id, 'extract');
    const extracted: ThreadExtraction[] = [];
    for (const [i, t] of threads.entries()) {
      if (ctx.signal?.aborted) throw new Error('aborted');
      progress('extract', i, threads.length, t.input.subject);
      let ex = prior.get(t.threadId)?.result ?? null;
      if (!ex) {
        try {
          ex = await extractOpportunity(ctx.llm, t.input, ctx.signal);
          await ctx.jobs.checkpoint(job.id, 'extract', t.threadId, 'done', ex);
        } catch (e) {
          await ctx.jobs.checkpoint(job.id, 'extract', t.threadId, 'failed', { error: String(e) });
          continue;
        }
      }
      extracted.push({ threadId: t.threadId, ex, from: t.from, date: t.date });
    }
    progress('extract', threads.length, threads.length);

    // ---- Stage 4: deterministic filtering, exclusion, normalization, dedup -----
    const opps = new Map<string, Opportunity>();
    for (const { threadId, ex, from, date } of extracted) {
      if (!args.include_kinds.includes(ex.kind)) continue;
      const company = (ex.company ?? '').trim() || (ex.via_agency ? `Undisclosed (via ${ex.via_agency})` : domainCompany(from.email));
      const nc = normalizeCompany(company);
      if (excludeNames.some((x) => nc === x || nc.split(' ').includes(x))) continue;
      const role = ex.role_title?.trim() || 'Unspecified role';
      const key = `${nc}|${normalizeCompany(role)}`;
      const salary = parseSalary(ex.salary_text);
      const headcount = parseHeadcount(ex.company_size_text);
      const stage = parseStage(ex.funding_text);
      const iso = new Date(date).toISOString().slice(0, 10);
      const existing = opps.get(key);
      if (existing) {
        existing.threadIds.push(threadId);
        existing.salary ??= salary;
        existing.equity ??= ex.equity_text;
        existing.location ??= ex.location;
        if (existing.remote === 'unknown') existing.remote = ex.remote;
        existing.viaAgency ??= ex.via_agency;
        if (!existing.headcount && headcount) {
          existing.headcount = headcount;
          existing.sizeBucket = sizeBucket(headcount);
          existing.sizeSource = 'email';
        }
        if (existing.stage === 'Unknown' && stage !== 'Unknown') {
          existing.stage = stage;
          existing.stageSource = 'email';
        }
        existing.totalRaisedUsd ??= parseMoney(ex.funding_text);
        existing.benefits = [...new Set([...existing.benefits, ...ex.benefits])];
        existing.referralBonus ??= ex.referral_bonus_text;
        existing.asksForReferrals ||= ex.asks_for_referrals;
        if (rankKind(ex.kind) > rankKind(existing.kind)) existing.kind = ex.kind;
        if (iso < existing.firstSeen) existing.firstSeen = iso;
        if (iso > existing.lastSeen) existing.lastSeen = iso;
        continue;
      }
      opps.set(key, {
        key,
        company,
        viaAgency: ex.via_agency,
        role,
        level: normalizeLevel(role, ex.level),
        location: ex.location,
        remote: ex.remote,
        kind: ex.kind,
        salary,
        equity: ex.equity_text,
        headcount,
        sizeBucket: sizeBucket(headcount),
        sizeSource: headcount ? 'email' : null,
        stage,
        stageSource: stage !== 'Unknown' ? 'email' : null,
        totalRaisedUsd: parseMoney(ex.funding_text),
        benefits: ex.benefits,
        referralBonus: ex.referral_bonus_text,
        asksForReferrals: ex.asks_for_referrals,
        contact: from,
        firstSeen: iso,
        lastSeen: iso,
        threadIds: [threadId],
        sources: [],
      });
    }

    // ---- Stage 5: opt-in enrichment (network, approval-gated, cited) -----------
    if (args.enrich && ctx.hub.tool('enrich__company_lookup')) {
      const companies = [...new Map([...opps.values()].filter((o) => !o.company.startsWith('Undisclosed')).map((o) => [normalizeCompany(o.company), o])).values()];
      const prev = await ctx.jobs.items<CompanyFacts>(job.id, 'enrich');
      for (const [i, o] of companies.entries()) {
        progress('enrich', i, companies.length, o.company);
        const nc = normalizeCompany(o.company);
        let facts = prev.get(nc)?.result ?? null;
        if (!facts && !prev.has(nc)) {
          const r = await ctx.hub.call('enrich__company_lookup', { company: o.company, domain: domainOf(o.contact.email) || undefined }, ctx.signal);
          if (r.isError) {
            notes.push('Company enrichment was declined or failed; size/funding come from emails only.');
            await ctx.jobs.checkpoint(job.id, 'enrich', nc, 'failed');
            if (/declined/i.test(r.text)) break;
            continue;
          }
          facts = (r.structured as CompanyFacts) ?? JSON.parse(r.text);
          await ctx.jobs.checkpoint(job.id, 'enrich', nc, 'done', facts);
        }
        if (!facts) continue;
        for (const opp of opps.values()) {
          if (normalizeCompany(opp.company) !== nc) continue;
          if (!opp.headcount && facts.headcount) {
            opp.headcount = facts.headcount;
            opp.sizeBucket = sizeBucket(facts.headcount);
            opp.sizeSource = 'enrichment';
          }
          if (opp.stage === 'Unknown') {
            const s = facts.publiclyTraded ? 'Public' : parseStage(facts.lastRound);
            if (s !== 'Unknown') {
              opp.stage = s;
              opp.stageSource = 'enrichment';
            }
          }
          opp.totalRaisedUsd ??= facts.totalRaisedUsd ?? null;
          opp.sources.push(...facts.sources.map((s) => ({ label: s.label, url: s.url })));
        }
      }
      progress('enrich', companies.length, companies.length);
    }

    // ---- Stage 6: rank + narrative + render -------------------------------------
    const rows = [...opps.values()].sort(
      (a, b) => salarySortKey(b.salary) - salarySortKey(a.salary) || b.level.rank - a.level.rank || a.company.localeCompare(b.company),
    );
    progress('report', 0, 1, 'Writing summary');
    // Highlights are written from the *redacted* rows so neither copy can leak a private offer via narrative.
    const highlights = rows.length ? await writeHighlights(ctx, toPeerRows(rows)) : [];
    const window = { from: new Date(ctx.now() - args.days * DAY).toISOString().slice(0, 10), to: new Date(ctx.now()).toISOString().slice(0, 10) };
    const meta = { window, excluded: args.exclude_companies, threadsScanned: threadIds.length, candidates: threads.length, notes, generatedAt: new Date(ctx.now()).toISOString() };
    const artifacts = [
      { title: 'Job opportunities — private', variant: 'private' as const, html: renderReport(rows, highlights, meta, 'private') },
      { title: 'Job opportunities — peer share', variant: 'peer' as const, html: renderReport(rows, highlights, meta, 'peer') },
    ];
    progress('report', 1, 1);

    const withComp = rows.filter((r) => r.salary).length;
    const summary = [
      `Found **${rows.length} opportunities** in the last ${args.days} days` +
        (args.exclude_companies.length ? ` (excluding ${args.exclude_companies.join(', ')})` : '') +
        ` from ${threadIds.length} candidate threads.`,
      `${withComp} include compensation; ${rows.filter((r) => r.asksForReferrals || r.referralBonus).length} explicitly welcome referrals.`,
      ...highlights.map((h) => `- ${h}`),
      ...notes.map((n) => `> ${n}`),
      'Two PDFs were generated: a **private** copy (recruiter contacts) and a **peer** copy (no contact details or personal offers).',
    ].join('\n');
    return { summary, artifacts, data: { rows, meta } };
  },
};

function rankKind(k: OpportunityKind): number {
  return k === 'offer' ? 3 : k === 'interview_process' ? 2 : k === 'recruiter_outreach' ? 1 : 0;
}

function domainCompany(email: string): string {
  const d = domainOf(email).split('.');
  const base = d.length >= 2 ? d[d.length - 2] : d[0] || 'Unknown';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

async function writeHighlights(ctx: SkillContext, rows: Opportunity[]): Promise<string[]> {
  const compact = [...rows]
    .sort((a, b) => salarySortKey(b.salary) - salarySortKey(a.salary))
    .slice(0, 25).map((r) => ({
    company: r.company,
    role: r.role,
    level: r.level.label,
    comp_usd: r.salary ? [r.salary.annualUsdMin, r.salary.annualUsdMax] : null,
    size: r.sizeBucket,
    stage: r.stage,
    remote: r.remote,
    referrals: r.asksForReferrals || !!r.referralBonus,
  }));
  try {
    const out = await completeJSON<{ highlights: string[] }>(
      ctx.llm,
      [
        {
          role: 'system',
          content:
            'You write 3-5 short factual bullet highlights about a list of job opportunities for job-seeking engineers. Only use the data given. No speculation. Each bullet under 25 words.',
        },
        { role: 'user', content: JSON.stringify(compact) },
      ],
      { type: 'object', required: ['highlights'], additionalProperties: false, properties: { highlights: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 } } },
      { maxTokens: 350, signal: ctx.signal },
    );
    return out.highlights.slice(0, 5);
  } catch {
    return [];
  }
}
