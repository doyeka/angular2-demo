import { type ChatMessage, completeJSON, type LLM } from '../../llm/types.ts';

export const OPPORTUNITY_KINDS = [
  'recruiter_outreach',
  'offer',
  'interview_process',
  'job_alert_digest',
  'application_update',
  'not_job',
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

export interface Extraction {
  kind: OpportunityKind;
  company: string | null;
  via_agency: string | null;
  role_title: string | null;
  level: string | null;
  location: string | null;
  remote: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  salary_text: string | null;
  equity_text: string | null;
  company_size_text: string | null;
  funding_text: string | null;
  benefits: string[];
  referral_bonus_text: string | null;
  asks_for_referrals: boolean;
}

const nullableString = { type: ['string', 'null'] };

/**
 * Kept flat and small: 3–4B models follow flat schemas far more reliably.
 * Grammar-constrained decoding guarantees shape; grounding (below) guards content.
 */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'company',
    'via_agency',
    'role_title',
    'level',
    'location',
    'remote',
    'salary_text',
    'equity_text',
    'company_size_text',
    'funding_text',
    'benefits',
    'referral_bonus_text',
    'asks_for_referrals',
  ],
  properties: {
    kind: { type: 'string', enum: OPPORTUNITY_KINDS },
    company: nullableString,
    via_agency: nullableString,
    role_title: nullableString,
    level: nullableString,
    location: nullableString,
    remote: { type: 'string', enum: ['remote', 'hybrid', 'onsite', 'unknown'] },
    salary_text: nullableString,
    equity_text: nullableString,
    company_size_text: nullableString,
    funding_text: nullableString,
    benefits: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    referral_bonus_text: nullableString,
    asks_for_referrals: { type: 'boolean' },
  },
} as const;

const SYSTEM = `You extract structured data about job opportunities from a single email thread.
Rules:
- "kind": recruiter_outreach = a person reaching out about a specific role or about hiring the reader; offer = a formal job offer; interview_process = scheduling/feedback for a role the reader is interviewing for; job_alert_digest = automated lists of many jobs; application_update = automated receipt/rejection for an application; not_job = anything else.
- "company" is the HIRING company. If a third-party agency or recruiter firm sent it, put the agency in "via_agency" and the client in "company" (null if undisclosed).
- *_text fields must be copied VERBATIM from the email (shortest span that contains the fact). Use null if not stated. Never guess or use outside knowledge.
- salary_text: the compensation range/amount as written (e.g. "$190k–$230k base + equity").
- company_size_text: e.g. "~120 people", "team of 40". funding_text: e.g. "just raised a $40M Series B".
- benefits: short phrases stated in the email (e.g. "unlimited PTO", "4-day week", "visa sponsorship"). Empty list if none.
- referral_bonus_text: verbatim mention of a referral bonus. asks_for_referrals: true if they ask the reader to refer others.`;

export interface ThreadInput {
  threadId: string;
  messageId: string;
  from: string;
  subject: string;
  date: string;
  body: string;
}

export function buildExtractionMessages(t: ThreadInput): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `message_id: ${t.messageId}\nFrom: ${t.from}\nDate: ${t.date}\nSubject: ${t.subject}\n\n${t.body}`,
    },
  ];
}

export async function extractOpportunity(llm: LLM, t: ThreadInput, signal?: AbortSignal): Promise<Extraction> {
  const raw = await completeJSON<Extraction>(llm, buildExtractionMessages(t), EXTRACTION_SCHEMA, { maxTokens: 400, signal });
  return ground(raw, `${t.subject}\n${t.body}`);
}

/**
 * Hallucination guard: any *_text field that does not appear (fuzzily) in the
 * source is dropped. Cheap, deterministic, and catches the classic small-model
 * failure of inventing a salary band.
 */
export function ground(x: Extraction, source: string): Extraction {
  const norm = (s: string) => s.toLowerCase().replace(/[\s,.–—-]+/g, ' ').replace(/[^\p{L}\p{N}$€£%+ ]/gu, '').trim();
  const src = norm(source);
  const keep = (v: string | null) => (v && src.includes(norm(v)) ? v : v && tokenOverlap(norm(v), src) >= 0.8 ? v : null);
  return {
    ...x,
    salary_text: keep(x.salary_text),
    equity_text: keep(x.equity_text),
    company_size_text: keep(x.company_size_text),
    funding_text: keep(x.funding_text),
    referral_bonus_text: keep(x.referral_bonus_text),
    benefits: (x.benefits ?? []).filter((b) => keep(b) !== null),
  };
}

function tokenOverlap(needle: string, hay: string): number {
  const toks = needle.split(' ').filter((t) => t.length > 1);
  if (!toks.length) return 0;
  const hs = new Set(hay.split(' '));
  return toks.filter((t) => hs.has(t)).length / toks.length;
}
