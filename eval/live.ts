/**
 * Run the real skill against your real Gmail from a laptop — same code path as
 * the phone, with llama-server standing in for llama.rn.
 *
 *   llama-server --jinja -m Qwen3-4B-Instruct-2507-Q4_K_M.gguf -c 8192 --port 8080
 *   GMAIL_ACCESS_TOKEN=ya29... npm run live -- --prompt "..." [--no-enrich] [--db ./mail.db]
 *
 * Get a short-lived token with gmail.readonly scope from the OAuth 2.0 Playground
 * (or `gcloud auth print-access-token` with the scope configured).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { OpenAICompatLLM } from '../src/core/llm/openaiCompat.ts';
import { GmailProvider } from '../src/core/mail/gmail.ts';
import { WikidataProvider } from '../src/core/mcp/servers/enrichServer.ts';
import { createRuntime } from '../src/core/runtime.ts';
import { openNodeDb } from './nodeDb.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const token = process.env.GMAIL_ACCESS_TOKEN;
if (!token) {
  console.error('Set GMAIL_ACCESS_TOKEN (gmail.readonly scope).');
  process.exit(2);
}
const prompt =
  flag('--prompt') ??
  "Go through my emails and pull in all employment opportunities I've gotten in the last 90 days besides from Anthropic. Organize by salary, company size, funding round and other benefits / level.";
const outDir = flag('--out') ?? join(import.meta.dirname, 'out', 'live');
mkdirSync(outDir, { recursive: true });

const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
const gmail = new GmailProvider(profile.emailAddress, async () => token);

const rt = await createRuntime({
  db: openNodeDb(flag('--db') ?? join(outDir, 'mail.db')), // persistent → re-runs reuse the cache + checkpoints
  llm: new OpenAICompatLLM({ baseUrl: flag('--llm') ?? 'http://localhost:8080', contextTokens: 8192 }),
  mailProvider: () => gmail,
  enrichProviders: argv.includes('--no-enrich') ? [] : [new WikidataProvider()],
  approver: async ({ tool, reason }) => {
    console.log(`  [approve] ${tool.qualifiedName} — ${reason} (auto-allowed in CLI)`);
    return 'allow-always';
  },
  renderPdf: async (html, stem) => {
    const htmlPath = join(outDir, `${stem}.html`);
    writeFileSync(htmlPath, html);
    try {
      const { chromium } = createRequire(import.meta.url)('playwright');
      const b = await chromium.launch();
      const p = await b.newPage();
      await p.setContent(html, { waitUntil: 'load' });
      const pdf = join(outDir, `${stem}.pdf`);
      await p.pdf({ path: pdf, format: 'Letter', landscape: true, printBackground: true, preferCSSPageSize: true });
      await b.close();
      return pdf;
    } catch {
      return htmlPath; // no playwright → open the HTML and print to PDF
    }
  },
});

console.log(`Account: ${gmail.account}`);
const answer = await rt.agent.send(prompt, (e) => {
  if (e.type === 'route') console.log(`route → ${e.route} ${e.args ? JSON.stringify(e.args) : ''}`);
  if (e.type === 'progress') process.stdout.write(`\r  ${e.stage} ${e.done}/${e.total} ${(e.note ?? '').slice(0, 60).padEnd(60)}`);
  if (e.type === 'artifact') console.log(`\n  → ${e.path}`);
});
console.log(`\n\n${answer}`);
