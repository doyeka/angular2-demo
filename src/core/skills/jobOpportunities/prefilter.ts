import type { MailMessage } from '../../mail/types.ts';
import { domainOf } from '../../util/text.ts';

/** Applicant-tracking / recruiting platforms whose mail is almost always job-related. */
export const ATS_DOMAINS = [
  'greenhouse.io',
  'greenhouse-mail.io',
  'lever.co',
  'hire.lever.co',
  'ashbyhq.com',
  'gem.com',
  'workablemail.com',
  'workable.com',
  'smartrecruiters.com',
  'myworkday.com',
  'icims.com',
  'jobvite.com',
  'hired.com',
  'wellfound.com',
  'angel.co',
  'otta.com',
  'welcometothejungle.com',
  'triplebyte.com',
  'linkedin.com',
  'dover.com',
  'rippling.com',
  'teamtailor.com',
  'paraform.com',
];

const KEYWORDS = [
  'recruiter',
  'recruiting',
  'opportunity',
  'opportunities',
  'role',
  'position',
  'hiring',
  'job',
  'opening',
  'offer',
  'compensation',
  'salary',
  'interview',
  'headhunter',
  'talent',
  '"reach out"',
  '"your background"',
  '"your profile"',
  '"open to"',
];

/** Stage 1 of the cascade — provider-side query, so we only ever download plausible mail. */
export function buildGmailQuery(days: number, excludeDomains: string[]): string {
  const from = ATS_DOMAINS.map((d) => `from:${d}`).join(' OR ');
  const kw = KEYWORDS.join(' OR ');
  const excl = excludeDomains.map((d) => `-from:${d}`).join(' ');
  return `newer_than:${days}d (${kw} OR ${from}) -in:chats -category:promotions ${excl}`.trim();
}

/** Same intent, as a local FTS5 query, so the pipeline also works on an already-synced cache offline. */
export const LOCAL_FTS_QUERY = KEYWORDS.map((k) => (k.startsWith('"') ? k : `"${k}"`)).join(' OR ');

export interface PrefilterScore {
  score: number;
  reasons: string[];
}

const POS: [RegExp, number, string][] = [
  [/\b(recruit(er|ing)|talent (partner|acquisition)|sourc(er|ing))\b/i, 3, 'recruiter language'],
  [/\b(role|position|opening|opportunit(y|ies))\b/i, 2, 'role language'],
  [/\b(salary|compensation|base pay|equity|ote|total comp|\$\d{2,3}k)\b/i, 2, 'comp mentioned'],
  [/\b(your (background|experience|profile)|came across your|open to (new|chat|hear))\b/i, 3, 'outreach phrasing'],
  [/\b(offer letter|pleased to offer|extend (you )?an offer)\b/i, 5, 'offer'],
  [/\b(interview|phone screen|onsite|hiring manager|next steps)\b/i, 2, 'process'],
  [/\b(series [a-f]|seed|raised|backed by|funding)\b/i, 1, 'funding mention'],
  [/\b(we('| a)re hiring|is hiring|hiring (a|an|for)|join (our|the) team)\b/i, 3, 'hiring language'],
  [/\b(referral bonus|know anyone|refer (someone|a friend|people))\b/i, 2, 'referral ask'],
  [/\b(staff|senior|principal|lead|head of|director|engineer(s|ing)?|scientist|manager)\b/i, 1, 'title words'],
];

const NEG: [RegExp, number, string][] = [
  [/\b(unsubscribe|view in browser|newsletter|digest|webinar)\b/i, -2, 'bulk mail'],
  [/\b(receipt|invoice|order (confirmation|#)|your (order|purchase)|shipping)\b/i, -5, 'transactional'],
  [/\b(jobs you may be interested in|job alert|new jobs (for|matching)|recommended jobs)\b/i, -3, 'job-alert digest'],
  [/\b(thank you for applying|we received your application|application (received|submitted))\b/i, -1, 'application receipt'],
];

/** Stage 2 — cheap rule score. Threshold is deliberately low: this trims obvious noise, the LLM decides. */
export function scoreMessage(m: MailMessage): PrefilterScore {
  const text = `${m.subject}\n${m.body.slice(0, 4000)}`;
  let score = 0;
  const reasons: string[] = [];
  if (ATS_DOMAINS.some((d) => domainOf(m.fromEmail).endsWith(d))) {
    score += 3;
    reasons.push('ATS sender');
  }
  for (const [re, w, why] of [...POS, ...NEG]) {
    if (re.test(text)) {
      score += w;
      reasons.push(why);
    }
  }
  return { score, reasons };
}

export const PREFILTER_THRESHOLD = 3;

export function isExcludedSender(email: string, excludeDomains: string[]): boolean {
  const d = domainOf(email);
  return excludeDomains.some((x) => d === x || d.endsWith(`.${x}`));
}
