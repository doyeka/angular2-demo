import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface CompanyFacts {
  company: string;
  headcount?: number;
  headcountAsOf?: string;
  lastRound?: string; // e.g. "Series B"
  lastRoundDate?: string;
  totalRaisedUsd?: number;
  publiclyTraded?: boolean;
  sources: { label: string; url: string; retrievedAt: string }[];
}

export interface EnrichmentProvider {
  readonly name: string;
  lookup(company: string, domain?: string, signal?: AbortSignal): Promise<Partial<CompanyFacts> | null>;
}

/**
 * Opt-in, network-only enrichment. Every returned value carries a source so the
 * report can cite it; unknowns stay unknown (no model recall).
 */
export function createEnrichServer(providers: EnrichmentProvider[]): McpServer {
  const server = new McpServer({ name: 'enrich', version: '0.1.0' });
  const cache = new Map<string, CompanyFacts>();

  server.registerTool(
    'company_lookup',
    {
      title: 'Look up company size & funding',
      description:
        'Look up headcount and latest funding round for a company from public sources. Requires network. Returns only sourced facts.',
      inputSchema: { company: z.string(), domain: z.string().optional() },
      annotations: { openWorldHint: true, readOnlyHint: true, idempotentHint: true },
    },
    async ({ company, domain }, extra) => {
      const key = `${company.toLowerCase()}|${domain ?? ''}`;
      let facts = cache.get(key);
      if (!facts) {
        facts = { company, sources: [] };
        for (const p of providers) {
          try {
            const r = await p.lookup(company, domain, extra.signal);
            if (!r) continue;
            for (const [k, v] of Object.entries(r)) {
              if (k === 'sources') facts.sources.push(...(v as CompanyFacts['sources']));
              else if (v !== undefined && (facts as any)[k] === undefined) (facts as any)[k] = v;
            }
          } catch {
            /* provider failure is non-fatal */
          }
        }
        cache.set(key, facts);
      }
      return { content: [{ type: 'text', text: JSON.stringify(facts) }], structuredContent: facts as any };
    },
  );

  return server;
}

/** Wikidata: free, keyless, good for headcount of established companies; weak on startups/funding. */
export class WikidataProvider implements EnrichmentProvider {
  readonly name = 'wikidata';
  private fetchImpl: typeof fetch;
  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async lookup(company: string, domain?: string, signal?: AbortSignal): Promise<Partial<CompanyFacts> | null> {
    const api = 'https://www.wikidata.org/w/api.php';
    const s = await this.get(`${api}?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=${encodeURIComponent(company)}`, signal);
    const candidates: any[] = (s.search ?? []).filter((e: any) =>
      /compan|business|corporat|startup|enterprise|firm|developer|manufacturer|lab/i.test(e.description ?? ''),
    );
    if (!candidates.length) return null;
    const ids = candidates.map((c) => c.id).join('|');
    const ents = await this.get(`${api}?action=wbgetentities&format=json&props=claims&ids=${ids}`, signal);
    let chosen: any = null;
    for (const c of candidates) {
      const e = ents.entities?.[c.id];
      if (!e) continue;
      const site: string | undefined = e.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      if (domain && site && site.includes(domain)) {
        chosen = e;
        break;
      }
      chosen ??= e;
    }
    if (!chosen) return null;
    const emp = latestQuantity(chosen.claims?.P1128);
    const traded = !!chosen.claims?.P414?.length; // stock exchange
    const now = new Date().toISOString();
    return {
      headcount: emp?.value,
      headcountAsOf: emp?.asOf,
      publiclyTraded: traded || undefined,
      sources: [{ label: `Wikidata ${chosen.id}`, url: `https://www.wikidata.org/wiki/${chosen.id}`, retrievedAt: now }],
    };
  }

  private async get(url: string, signal?: AbortSignal): Promise<any> {
    const r = await this.fetchImpl(url, { signal, headers: { 'user-agent': 'pocket-agent/0.1 (offline assistant)' } });
    if (!r.ok) throw new Error(`wikidata ${r.status}`);
    return r.json();
  }
}

function latestQuantity(claims: any[] | undefined): { value: number; asOf?: string } | undefined {
  if (!claims?.length) return undefined;
  const parsed = claims
    .map((c) => ({
      value: Number(c.mainsnak?.datavalue?.value?.amount),
      asOf: c.qualifiers?.P585?.[0]?.datavalue?.value?.time?.slice(1, 11),
    }))
    .filter((x) => Number.isFinite(x.value));
  parsed.sort((a, b) => (b.asOf ?? '').localeCompare(a.asOf ?? ''));
  return parsed[0];
}

/** Fixture-backed provider for tests/eval. */
export class StaticProvider implements EnrichmentProvider {
  readonly name = 'static';
  private data: Record<string, Partial<CompanyFacts>>;
  constructor(data: Record<string, Partial<CompanyFacts>>) {
    this.data = data;
  }
  async lookup(company: string): Promise<Partial<CompanyFacts> | null> {
    return this.data[company.toLowerCase()] ?? null;
  }
}
