/**
 * Deterministic normalization. The LLM extracts *verbatim spans*; all
 * arithmetic, bucketing and ranking happens here, where it is testable.
 */

export type Period = 'year' | 'month' | 'hour';
export type CompBasis = 'base' | 'total' | 'ote' | 'unknown';

export interface Salary {
  raw: string;
  currency: string;
  min: number | null;
  max: number | null;
  period: Period;
  basis: CompBasis;
  /** Annualized, converted to USD with the static table below (approximate for non-USD). */
  annualUsdMin: number | null;
  annualUsdMax: number | null;
}

/** Static, approximate FX for *sorting only*. Displayed values keep the original currency. */
export const FX_TO_USD: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, CHF: 1.13, INR: 0.012, SGD: 0.75 };

const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/C\$|CA\$|\bCAD\b/i, 'CAD'],
  [/A\$|AU\$|\bAUD\b/i, 'AUD'],
  [/S\$|\bSGD\b/i, 'SGD'],
  [/€|\bEUR\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/₹|\bINR\b/i, 'INR'],
  [/\bCHF\b/i, 'CHF'],
  [/\$|\bUSD\b/i, 'USD'],
];

export function parseSalary(raw: string | null | undefined): Salary | null {
  if (!raw || !raw.trim()) return null;
  const text = raw.replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  // Number tokens: 180k, 180,000, 1.2M, 95
  const numRe = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?(?![\w])/g;
  const nums: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(text))) {
    let v = parseFloat(m[1].replace(/,/g, ''));
    const suf = m[2]?.toLowerCase();
    if (suf === 'k') v *= 1_000;
    if (suf === 'm') v *= 1_000_000;
    nums.push(v);
  }
  // Ignore things like "401k", "Series 2", years and percentages
  const cleaned = nums.filter((n, i) => {
    const tok = text.match(numRe)?.[i] ?? '';
    if (/^401k$/i.test(tok.trim())) return false;
    if (n >= 1900 && n <= 2100 && !/[kK,]/.test(tok)) return false;
    return n >= 10;
  });
  if (!cleaned.length) return null;

  let period: Period = 'year';
  if (/\/\s*h(ou)?r|per hour|hourly|\/hr\b|an hour/i.test(text)) period = 'hour';
  else if (/\/\s*mo(nth)?\b|per month|monthly/i.test(text)) period = 'month';

  let values = [...cleaned];
  // "180-210k": the suffix on the upper bound applies to the lower bound too
  if (values.length >= 2 && values[0] < 1000 && values[1] >= 1000) values[0] *= values[1] >= 1e6 ? 1e6 : 1e3;
  // Bare small numbers in a yearly context are almost certainly thousands ("180-220 base")
  if (period === 'year' && values.every((v) => v < 1000) && /base|salary|comp|k\b/i.test(text)) values = values.map((v) => v * 1000);

  const currency = CURRENCY_SYMBOLS.find(([re]) => re.test(text))?.[1] ?? 'USD';
  const upTo = /\bup to\b|\bmax(imum)?\b/i.test(text);
  const plus = /\d\s*[kKmM]?\s*\+/.test(text);
  let min: number | null = values[0];
  let max: number | null = values.length > 1 ? values[1] : values[0];
  if (min !== null && max !== null && min > max) [min, max] = [max, min];
  if (upTo && values.length === 1) min = null;
  if (plus && values.length === 1) max = null;

  let basis: CompBasis = 'unknown';
  if (/\bOTE\b|on[- ]target/i.test(text)) basis = 'ote';
  else if (/\btotal comp|\bTC\b|total compensation|all[- ]in/i.test(text)) basis = 'total';
  else if (/\bbase\b|salary/i.test(text)) basis = 'base';

  const mult = period === 'hour' ? 2080 : period === 'month' ? 12 : 1;
  const fx = FX_TO_USD[currency] ?? 1;
  const ann = (v: number | null) => (v === null ? null : Math.round(v * mult * fx));
  return { raw: raw.trim(), currency, min, max, period, basis, annualUsdMin: ann(min), annualUsdMax: ann(max) };
}

/** Single sort key: midpoint if both ends known, else whichever end exists. */
export function salarySortKey(s: Salary | null): number {
  if (!s) return -1;
  const { annualUsdMin: a, annualUsdMax: b } = s;
  if (a !== null && b !== null) return (a + b) / 2;
  return a ?? b ?? -1;
}

export function formatSalary(s: Salary | null): string {
  if (!s) return '—';
  const sym: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$', SGD: 'S$', INR: '₹' };
  const c = sym[s.currency] ?? `${s.currency} `;
  const f = (v: number) => {
    if (s.period === 'hour') return `${c}${v}`;
    return v >= 1_000_000 ? `${c}${(v / 1_000_000).toFixed(1)}M` : `${c}${Math.round(v / 1000)}k`;
  };
  const range = s.min !== null && s.max !== null && s.min !== s.max ? `${f(s.min)}–${f(s.max)}` : s.min !== null ? `${f(s.min)}${s.max === null ? '+' : ''}` : `up to ${f(s.max!)}`;
  const per = s.period === 'hour' ? '/hr' : s.period === 'month' ? '/mo' : '';
  const basis = s.basis === 'unknown' ? '' : ` ${s.basis === 'ote' ? 'OTE' : s.basis === 'total' ? 'TC' : 'base'}`;
  return `${range}${per}${basis}`;
}

// ---------- company size ----------

export const SIZE_BUCKETS = ['1–10', '11–50', '51–200', '201–1,000', '1,001–5,000', '5,000+'] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number] | 'Unknown';

export function parseHeadcount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kK])?\s*\+?\s*(people|employees|engineers|person|staff|folks|ppl|team members)?/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2]) v *= 1000;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

export function sizeBucket(n: number | null | undefined): SizeBucket {
  if (!n) return 'Unknown';
  if (n <= 10) return '1–10';
  if (n <= 50) return '11–50';
  if (n <= 200) return '51–200';
  if (n <= 1000) return '201–1,000';
  if (n <= 5000) return '1,001–5,000';
  return '5,000+';
}

// ---------- funding ----------

export const STAGES = ['Bootstrapped', 'Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D+', 'Public', 'Acquired/Private'] as const;
export type Stage = (typeof STAGES)[number] | 'Unknown';

export function parseStage(raw: string | null | undefined): Stage {
  if (!raw) return 'Unknown';
  const t = raw.toLowerCase();
  if (/pre[- ]?seed/.test(t)) return 'Pre-seed';
  if (/\bseed\b/.test(t)) return 'Seed';
  const s = t.match(/series\s+([a-z])\b/);
  if (s) {
    const l = s[1].toUpperCase();
    if (l === 'A' || l === 'B' || l === 'C') return `Series ${l}` as Stage;
    return 'Series D+';
  }
  if (/\b(ipo|nyse|nasdaq|publicly traded|public company|\bpublic\b)/.test(t)) return 'Public';
  if (/bootstrap|self[- ]funded|profitable,? no (vc|outside)/.test(t)) return 'Bootstrapped';
  if (/acquired|private equity|\bpe[- ]backed/.test(t)) return 'Acquired/Private';
  return 'Unknown';
}

export function parseMoney(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, '').match(/\$\s*(\d+(?:\.\d+)?)\s*(b|bn|billion|m|mm|million|k)?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = (m[2] ?? '').toLowerCase();
  if (u.startsWith('b')) return v * 1e9;
  if (u.startsWith('m')) return v * 1e6;
  if (u === 'k') return v * 1e3;
  return v;
}

// ---------- level ----------

const LEVELS: [RegExp, string, number][] = [
  [/\b(c[a-z]o|chief)\b/i, 'Exec', 9],
  [/\b(svp|evp|vp|vice president)\b/i, 'VP', 8],
  [/\b(head of|director)\b/i, 'Director / Head', 7],
  [/\b(distinguished|fellow)\b/i, 'Distinguished', 7],
  [/\bprincipal\b/i, 'Principal', 6],
  [/\bstaff\b/i, 'Staff', 5],
  [/\b(manager|em\b|engineering manager)\b/i, 'Manager', 5],
  [/\b(lead|tech lead|tl)\b/i, 'Lead', 4],
  [/\b(senior|sr\.?)\b/i, 'Senior', 3],
  [/\b(junior|jr\.?|associate|new grad|entry)\b/i, 'Junior', 1],
  [/\bintern\b/i, 'Intern', 0],
];

export function normalizeLevel(title: string, levelHint?: string | null): { label: string; rank: number } {
  const t = `${levelHint ?? ''} ${title}`;
  for (const [re, label, rank] of LEVELS) if (re.test(t)) return { label, rank };
  const ic = t.match(/\b(?:L|IC|E)(\d)\b/);
  if (ic) return { label: `IC${ic[1]}`, rank: Math.min(6, Math.max(1, Number(ic[1]) - 2)) };
  return { label: 'Mid / unspecified', rank: 2 };
}

// ---------- company identity ----------

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|ltd|pbc|corp|corporation|co|gmbh|labs?|ai|technologies|technology|hq)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
