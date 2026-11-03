/**
 * Synthetic mailbox for the eval harness. All companies, people and addresses
 * are fictional. Each thread's first inbound message carries the gold label
 * (`gold`) — the ideal extraction — used both for scoring a real model and for
 * the `oracle` LLM that replays it (to test everything *around* the model).
 */
import type { Extraction } from '../../src/core/skills/jobOpportunities/extract.ts';
import type { MailMessage } from '../../src/core/mail/types.ts';

export const SELF = 'me@example.com';
export const NOW = Date.parse('2026-11-03T15:00:00Z');
const daysAgo = (d: number) => NOW - d * 86_400_000;

export interface FixtureMessage extends MailMessage {
  gold?: Extraction;
  /** Should this thread appear in the final report? */
  expectInReport?: boolean;
}

const base = (x: Partial<Extraction>): Extraction => ({
  kind: 'not_job',
  company: null,
  via_agency: null,
  role_title: null,
  level: null,
  location: null,
  remote: 'unknown',
  salary_text: null,
  equity_text: null,
  company_size_text: null,
  funding_text: null,
  benefits: [],
  referral_bonus_text: null,
  asks_for_referrals: false,
  ...x,
});

let n = 0;
const msg = (m: Omit<FixtureMessage, 'id' | 'account' | 'to' | 'snippet' | 'labels'> & { id?: string }): FixtureMessage => {
  n += 1;
  return { id: m.id ?? `m${String(n).padStart(3, '0')}`, account: SELF, to: [SELF], snippet: m.body.slice(0, 120), labels: ['INBOX'], ...m };
};

export const MAILBOX: FixtureMessage[] = [
  msg({
    threadId: 't-kestrel',
    fromName: 'Priya Natarajan',
    fromEmail: 'priya@kestreldynamics.com',
    subject: 'Staff ML Engineer at Kestrel Dynamics',
    date: daysAgo(20),
    body: `Hi there,

I came across your profile and your agent work really stood out. I'm the technical recruiter at Kestrel Dynamics — we build autonomy software for warehouse robots. We just closed a $60M Series B and we're ~180 people.

We're hiring a Staff ML Engineer (remote, US). The range is $240k–$290k base + equity. Perks include a 4-day week in summer and a $10k learning budget.

Open to a quick chat next week?

Priya`,
    expectInReport: true,
    gold: base({
      kind: 'recruiter_outreach',
      company: 'Kestrel Dynamics',
      role_title: 'Staff ML Engineer',
      level: 'Staff',
      location: 'US',
      remote: 'remote',
      salary_text: '$240k–$290k base + equity',
      equity_text: 'equity',
      company_size_text: '~180 people',
      funding_text: '$60M Series B',
      benefits: ['4-day week in summer', '$10k learning budget'],
    }),
  }),
  msg({
    threadId: 't-kestrel',
    fromName: 'Me',
    fromEmail: SELF,
    subject: 'Re: Staff ML Engineer at Kestrel Dynamics',
    date: daysAgo(19),
    body: `Thanks Priya — I'm not looking right now, but I know a few people who might be. On Mon, Priya wrote:\n> Hi there,`,
  }),
  msg({
    threadId: 't-anthropic',
    fromName: 'Anthropic Recruiting',
    fromEmail: 'talent@anthropic.com',
    subject: 'Welcome aboard — onboarding details',
    date: daysAgo(10),
    body: `We're thrilled you accepted our offer for Member of Technical Staff. Your compensation details: $400k base salary. Please complete onboarding forms.`,
    expectInReport: false,
    gold: base({ kind: 'offer', company: 'Anthropic', role_title: 'Member of Technical Staff', salary_text: '$400k base salary' }),
  }),
  msg({
    threadId: 't-anthropic-agency',
    fromName: 'Jordan Blake',
    fromEmail: 'jordan@summitsearch.io',
    subject: 'Research Engineer role at Anthropic',
    date: daysAgo(30),
    body: `Hi! I'm a recruiter with Summit Search, hiring for Anthropic on a Research Engineer, Interpretability role. Comp is $350k–$500k. Interested?`,
    expectInReport: false,
    gold: base({
      kind: 'recruiter_outreach',
      company: 'Anthropic',
      via_agency: 'Summit Search',
      role_title: 'Research Engineer, Interpretability',
      salary_text: '$350k–$500k',
    }),
  }),
  msg({
    threadId: 't-bluefin',
    fromName: 'Sam Ortiz',
    fromEmail: 'sam@bluefintalent.com',
    subject: 'Senior Backend Engineer — Series A fintech (NYC, hybrid)',
    date: daysAgo(35),
    body: `Hello — I'm a recruiter at Bluefin Talent working with a Series A fintech (client confidential for now). Senior Backend Engineer, hybrid in NYC, $180-210k base plus equity. Great health coverage and a 401k match. Let me know if you'd like details!`,
    expectInReport: true,
    gold: base({
      kind: 'recruiter_outreach',
      company: null,
      via_agency: 'Bluefin Talent',
      role_title: 'Senior Backend Engineer',
      level: 'Senior',
      location: 'NYC',
      remote: 'hybrid',
      salary_text: '$180-210k base plus equity',
      equity_text: 'equity',
      funding_text: 'Series A fintech',
      benefits: ['Great health coverage', '401k match'],
    }),
  }),
  msg({
    threadId: 't-quill-1',
    fromName: 'Dana Whitfield',
    fromEmail: 'dana@quillstack.dev',
    subject: 'Quillstack — Senior Software Engineer, Platform',
    date: daysAgo(55),
    body: `Hi, Dana from Quillstack here. We're a seed-stage devtools company (team of 70 after our $25M Seed). We're hiring a Senior Software Engineer, Platform — $195,000 - $225,000 + equity, remote-friendly (US time zones). Would you be open to a call?`,
    expectInReport: true,
    gold: base({
      kind: 'recruiter_outreach',
      company: 'Quillstack',
      role_title: 'Senior Software Engineer, Platform',
      level: 'Senior',
      location: 'US time zones',
      remote: 'remote',
      salary_text: '$195,000 - $225,000 + equity',
      equity_text: 'equity',
      company_size_text: 'team of 70',
      funding_text: '$25M Seed',
    }),
  }),
  msg({
    threadId: 't-quill-2',
    fromName: 'Quillstack Hiring',
    fromEmail: 'no-reply@greenhouse.io',
    subject: 'Interview confirmation: Senior Software Engineer, Platform',
    date: daysAgo(45),
    body: `Your interview with Quillstack for Senior Software Engineer, Platform is confirmed for Thursday at 2pm PT with the hiring manager. Next steps: a system design onsite.`,
    expectInReport: true, // dedups into t-quill-1
    gold: base({ kind: 'interview_process', company: 'Quillstack', role_title: 'Senior Software Engineer, Platform', level: 'Senior' }),
  }),
  msg({
    threadId: 't-linkedin',
    fromName: 'LinkedIn Job Alerts',
    fromEmail: 'jobalerts-noreply@linkedin.com',
    subject: '30 new jobs for "staff engineer"',
    date: daysAgo(5),
    body: `Jobs you may be interested in: Staff Engineer at A, Staff Engineer at B, ... Unsubscribe | Job alert settings`,
    expectInReport: false,
    gold: base({ kind: 'job_alert_digest' }),
  }),
  msg({
    threadId: 't-order',
    fromName: 'Shop',
    fromEmail: 'orders@shop.example',
    subject: 'Your order #4411 has shipped',
    date: daysAgo(7),
    body: `Order confirmation: your purchase of 1x desk lamp has shipped. Receipt attached.`,
    expectInReport: false,
  }),
  msg({
    threadId: 't-helio',
    fromName: 'Marcus Lee',
    fromEmail: 'marcus.lee@helioform.com',
    subject: 'Offer letter — Principal Engineer',
    date: daysAgo(60),
    body: `We're pleased to offer you the position of Principal Engineer at Helioform. Base salary: $310,000 per year, plus 0.25% equity and a $20k relocation stipend. Helioform is a publicly traded company (NASDAQ: HLFM) with about 2,300 employees. Please review and sign the offer letter by Friday.`,
    expectInReport: true,
    gold: base({
      kind: 'offer',
      company: 'Helioform',
      role_title: 'Principal Engineer',
      level: 'Principal',
      salary_text: '$310,000 per year',
      equity_text: '0.25% equity',
      company_size_text: 'about 2,300 employees',
      funding_text: 'publicly traded company (NASDAQ: HLFM)',
      benefits: ['$20k relocation stipend'],
    }),
  }),
  msg({
    threadId: 't-mossbank',
    fromName: 'Elena Rossi',
    fromEmail: 'elena@mossbank.co',
    subject: 'Contract: Lead Data Engineer (6 months, remote)',
    date: daysAgo(15),
    body: `Hi — Mossbank is looking for a Lead Data Engineer on a 6-month contract, fully remote. Rate is $110/hr. We're a small team. Interested in the opportunity?`,
    expectInReport: true,
    gold: base({
      kind: 'recruiter_outreach',
      company: 'Mossbank',
      role_title: 'Lead Data Engineer',
      level: 'Lead',
      remote: 'remote',
      salary_text: '$110/hr',
    }),
  }),
  msg({
    threadId: 't-arcturus',
    fromName: 'Lena Fischer',
    fromEmail: 'lena.fischer@arcturus-health.de',
    subject: 'Senior ML Engineer in Berlin — Arcturus Health',
    date: daysAgo(50),
    body: `Hallo! Arcturus Health (Series C, about 400 employees) is hiring a Senior ML Engineer in Berlin. Salary €95k–€115k, visa sponsorship and 30 days vacation. Would you be open to talking?`,
    expectInReport: true,
    gold: base({
      kind: 'recruiter_outreach',
      company: 'Arcturus Health',
      role_title: 'Senior ML Engineer',
      level: 'Senior',
      location: 'Berlin',
      remote: 'onsite',
      salary_text: '€95k–€115k',
      company_size_text: 'about 400 employees',
      funding_text: 'Series C',
      benefits: ['visa sponsorship', '30 days vacation'],
    }),
  }),
  msg({
    threadId: 't-tallow',
    fromName: 'Chris Amari',
    fromEmail: 'chris@tallowtree.com',
    subject: 'Engineering Manager, Infrastructure — Tallowtree',
    date: daysAgo(25),
    body: `Hey! Tallowtree is bootstrapped and profitable, ~35 people. We're hiring an Engineering Manager, Infrastructure. If it's not for you, we pay a $7,500 referral bonus for engineers we hire — know anyone who'd be a fit?`,
    expectInReport: true,
    gold: base({
      kind: 'recruiter_outreach',
      company: 'Tallowtree',
      role_title: 'Engineering Manager, Infrastructure',
      level: 'Manager',
      company_size_text: '~35 people',
      funding_text: 'bootstrapped and profitable',
      referral_bonus_text: '$7,500 referral bonus',
      asks_for_referrals: true,
    }),
  }),
  msg({
    threadId: 't-vantorra-old',
    fromName: 'Old Recruiter',
    fromEmail: 'hr@vantorra.io',
    subject: 'Senior Engineer opportunity at Vantorra',
    date: daysAgo(120),
    body: `We're hiring a Senior Engineer, $170k-$190k. Interested in this opportunity?`,
    expectInReport: false, // outside 90-day window
    gold: base({ kind: 'recruiter_outreach', company: 'Vantorra', role_title: 'Senior Engineer', salary_text: '$170k-$190k' }),
  }),
  msg({
    threadId: 't-newsletter',
    fromName: 'Pragmatic Weekly',
    fromEmail: 'hello@pragmaticweekly.example',
    subject: 'Hiring trends: which roles are hot this quarter',
    date: daysAgo(8),
    body: `This week: hiring for AI roles keeps growing; staff engineer salaries are up. Read the full digest in browser. Unsubscribe.`,
    expectInReport: false,
    gold: base({ kind: 'not_job' }),
  }),
  msg({
    threadId: 't-corvid',
    fromName: 'Corvid Security Careers',
    fromEmail: 'no-reply@ashbyhq.com',
    subject: 'Thank you for applying to Corvid Security',
    date: daysAgo(12),
    body: `Thank you for applying for the Security Engineer position. We received your application and will be in touch.`,
    expectInReport: false,
    gold: base({ kind: 'application_update', company: 'Corvid Security', role_title: 'Security Engineer' }),
  }),
  msg({
    threadId: 't-brightloop',
    fromName: 'Ava Chen',
    fromEmail: 'ava@brightloop.ai',
    subject: 'Head of Solutions Engineering at Brightloop',
    date: daysAgo(3),
    body: `Hi! Brightloop (Series D, 900 people) is hiring a Head of Solutions Engineering. OTE $260k with a 60/40 split, fully remote, unlimited PTO. Your background in agentic systems is exactly what we need — open to a chat? Call me at 415-555-0142.`,
    expectInReport: true,
    gold: base({
      kind: 'recruiter_outreach',
      company: 'Brightloop',
      role_title: 'Head of Solutions Engineering',
      level: 'Head of',
      remote: 'remote',
      salary_text: 'OTE $260k',
      company_size_text: '900 people',
      funding_text: 'Series D',
      benefits: ['unlimited PTO'],
    }),
  }),
];

/** Expected unique report rows (after dedup + exclusions), by normalized company. */
export const EXPECTED_COMPANIES = ['brightloop', 'helioform', 'kestrel dynamics', 'mossbank', 'quillstack', 'arcturus health', 'tallowtree', 'undisclosed (via bluefin talent)'];

export const ENRICHMENT_FIXTURE = {
  mossbank: { headcount: 24, lastRound: 'Seed', sources: [{ label: 'Fixture registry', url: 'https://example.org/mossbank', retrievedAt: '2026-11-03' }] },
};

export const USER_PROMPT =
  "Can you go through my emails and pull in all employment opportunities I've gotten in the last 90 days besides from Anthropic? Organize by salary, company size, company fundraising round and other benefits / level";
