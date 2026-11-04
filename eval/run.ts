/**
 * Eval harness — runs the exact on-device pipeline in Node against a fixture mailbox.
 *
 *   npm run eval                                  # oracle LLM (tests everything but the model)
 *   npm run eval -- --llm http://localhost:8080   # real model via `llama-server --jinja -m Qwen3-4B-...gguf`
 *   npm run eval:pdf                              # also render the two PDFs to eval/out/ (needs playwright)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAICompatLLM } from '../src/core/llm/openaiCompat.ts';
import type { LLM } from '../src/core/llm/types.ts';
import type { MailProvider } from '../src/core/mail/types.ts';
import { StaticProvider } from '../src/core/mcp/servers/enrichServer.ts';
import { createRuntime } from '../src/core/runtime.ts';
import { extractOpportunity } from '../src/core/skills/jobOpportunities/extract.ts';
import type { Opportunity } from '../src/core/skills/jobOpportunities/index.ts';
import { normalizeCompany, parseSalary } from '../src/core/skills/jobOpportunities/normalize.ts';
import { findPII } from '../src/core/skills/jobOpportunities/redact.ts';
import { ENRICHMENT_FIXTURE, EXPECTED_COMPANIES, MAILBOX, NOW, SELF, USER_PROMPT } from './fixtures/mailbox.ts';
import { openNodeDb } from './nodeDb.ts';
import { oracleLLM } from './oracle.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const llmArg = flag('--llm') ?? 'oracle';
const wantPdf = argv.includes('--pdf');
const outDir = flag('--out') ?? join(import.meta.dirname, 'out');

const llm: LLM = llmArg === 'oracle' ? oracleLLM() : new OpenAICompatLLM({ baseUrl: llmArg, contextTokens: 8192 });

const fixtureProvider: MailProvider = {
  account: SELF,
  async searchIds(query) {
    const days = Number(query.match(/newer_than:(\d+)d/)?.[1] ?? 3650);
    return MAILBOX.filter((m) => m.date >= NOW - days * 86_400_000).map((m) => m.id);
  },
  async getMessage(id) {
    const { gold, expectInReport, ...m } = MAILBOX.find((x) => x.id === id)!;
    return m;
  },
};

async function renderPdf(html: string, stem: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, `${stem}.html`);
  writeFileSync(htmlPath, html);
  if (!wantPdf) return htmlPath;
  const { createRequire } = await import('node:module');
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  const pdfPath = join(outDir, `${stem}.pdf`);
  await page.pdf({ path: pdfPath, format: 'Letter', landscape: true, printBackground: true, preferCSSPageSize: true });
  await browser.close();
  return pdfPath;
}

const approvals: string[] = [];
const rt = await createRuntime({
  db: openNodeDb(),
  llm,
  renderPdf,
  mailProvider: () => fixtureProvider,
  enrichProviders: [new StaticProvider(ENRICHMENT_FIXTURE)],
  approver: async ({ tool, reason }) => {
    approvals.push(`${tool.qualifiedName}: ${reason}`);
    return 'allow-always';
  },
  now: () => NOW,
});

const t0 = Date.now();
let rows: Opportunity[] = [];
const paths: string[] = [];
await rt.agent.send(USER_PROMPT, (e) => {
  if (e.type === 'route') console.log(`route → ${e.route} ${e.args ? JSON.stringify(e.args) : ''}`);
  if (e.type === 'artifact') paths.push(e.path);
  if (e.type === 'progress' && e.done === e.total) console.log(`  ✓ ${e.stage}${e.note ? ` (${e.note})` : ''}`);
});
const job = (await rt.agent.jobs.list(1))[0];
const jobItems = await rt.agent.jobs.items(job.id, 'extract');
console.log(`job ${job.id}: ${job.status}, ${jobItems.size} threads extracted, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Re-run the pipeline data for scoring (the skill returns rows in result data via the job)
const { jobOpportunitiesSkill } = await import('../src/core/skills/jobOpportunities/index.ts');
const replay = await jobOpportunitiesSkill.run(
  { llm, hub: rt.hub, jobs: rt.agent.jobs, memory: rt.memory, selfEmail: SELF, now: () => NOW },
  job, // same job id → every extraction is served from checkpoints (also exercises resume)
  { ...jobOpportunitiesSkill.defaults, ...(job.args as any) },
);
rows = (replay.data as { rows: Opportunity[] }).rows;
const replayCalls = llmArg === 'oracle' ? (llm as any).calls.filter((c: any) => 'kind' in (c.jsonSchema?.properties ?? {})).length : NaN;

// ---------------- scoring ----------------
const got = new Set(rows.map((r) => normalizeCompany(r.company)));
const exp = new Set(EXPECTED_COMPANIES);
const tp = [...got].filter((c) => exp.has(c)).length;
const precision = got.size ? tp / got.size : 0;
const recall = tp / exp.size;
const anthropicLeak = rows.some((r) => /anthropic/i.test(r.company));
const peerHtml = replay.artifacts.find((a) => a.variant === 'peer')!.html;
const pii = findPII(peerHtml);

// Per-field extraction accuracy on gold threads (meaningful for real models)
let fieldTotal = 0;
let fieldOk = 0;
const fieldMiss: string[] = [];
if (llmArg !== 'oracle') {
  for (const m of MAILBOX.filter((x) => x.gold)) {
    const ex = await extractOpportunity(llm, { threadId: m.threadId, messageId: m.id, from: `${m.fromName} <${m.fromEmail}>`, subject: m.subject, date: new Date(m.date).toISOString(), body: m.body });
    const g = m.gold!;
    const checks: [string, boolean][] = [
      ['kind', ex.kind === g.kind],
      ['company', normalizeCompany(ex.company ?? '') === normalizeCompany(g.company ?? '')],
      ['salary', JSON.stringify(parseSalary(ex.salary_text)?.annualUsdMin ?? null) === JSON.stringify(parseSalary(g.salary_text)?.annualUsdMin ?? null)],
      ['referrals', ex.asks_for_referrals === g.asks_for_referrals],
    ];
    for (const [k, ok] of checks) {
      fieldTotal++;
      if (ok) fieldOk++;
      else fieldMiss.push(`${m.threadId}.${k}`);
    }
  }
}

console.log('\n=== Eval ===');
console.log(`LLM: ${llm.id}`);
console.log(`Report rows: ${rows.length}  precision ${precision.toFixed(2)}  recall ${recall.toFixed(2)}`);
console.log(`Missing: ${[...exp].filter((c) => !got.has(c)).join(', ') || '—'}  Extra: ${[...got].filter((c) => !exp.has(c)).join(', ') || '—'}`);
console.log(`Anthropic excluded: ${!anthropicLeak}   Peer PDF PII hits: ${pii.length ? pii.join(', ') : 'none'}`);
console.log(`Approvals requested: ${approvals.length ? approvals.join(' | ') : 'none'}`);
if (llmArg === 'oracle') console.log(`Resume: replay made ${replayCalls - jobItems.size} new extraction calls (expect 0)`);
if (fieldTotal) console.log(`Field accuracy: ${fieldOk}/${fieldTotal}  misses: ${fieldMiss.join(', ') || '—'}`);
console.log('\nRanked:');
for (const r of rows) console.log(`  ${r.company.padEnd(32)} ${r.role.padEnd(38)} ${r.salary?.raw ?? '—'}`);
console.log(`\nArtifacts:\n  ${paths.join('\n  ')}`);

if (llmArg === 'oracle') {
  const ok = precision === 1 && recall === 1 && !anthropicLeak && pii.length === 0 && replayCalls - jobItems.size === 0;
  if (!ok) {
    console.error('\nORACLE EVAL FAILED — pipeline bug (model was perfect).');
    process.exit(1);
  }
  console.log('\nOracle eval passed.');
}
