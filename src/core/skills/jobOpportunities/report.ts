import { escapeHtml as e } from '../../util/text.ts';
import type { Opportunity } from './index.ts';
import { formatSalary, SIZE_BUCKETS, STAGES } from './normalize.ts';
import { toPeerRows } from './redact.ts';

export interface ReportMeta {
  window: { from: string; to: string };
  excluded: string[];
  threadsScanned: number;
  candidates: number;
  notes: string[];
  generatedAt: string;
}

const CSS = `
@page { size: Letter landscape; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font: 9.5pt/1.4 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1d1d1f; margin: 0; }
h1 { font-size: 18pt; margin: 0 0 2px; letter-spacing: -0.01em; }
h2 { font-size: 12pt; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1.5px solid #1d1d1f; break-after: avoid; }
h3 { font-size: 10pt; margin: 10px 0 4px; color: #444; break-after: avoid; }
.sub { color: #666; margin-bottom: 10px; }
.kpis { display: flex; gap: 10px; margin: 10px 0 4px; }
.kpi { flex: 1; border: 1px solid #ddd; border-radius: 6px; padding: 6px 10px; }
.kpi b { display: block; font-size: 15pt; }
.kpi span { color: #666; font-size: 8pt; text-transform: uppercase; letter-spacing: .04em; }
ul.hl { margin: 4px 0 0 16px; padding: 0; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
th { text-align: left; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .04em; color: #555; border-bottom: 1px solid #999; padding: 4px 5px; }
td { border-bottom: 1px solid #e5e5e5; padding: 4px 5px; vertical-align: top; }
tr { break-inside: avoid; }
td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
.muted { color: #888; }
.tag { display: inline-block; border: 1px solid #ccc; border-radius: 3px; padding: 0 4px; margin: 0 2px 2px 0; font-size: 7.5pt; color: #333; }
.tag.ref { border-color: #1a7f37; color: #1a7f37; }
.src { font-size: 7pt; color: #888; }
.group { columns: 2; column-gap: 24px; }
.group > div { break-inside: avoid; margin-bottom: 8px; }
.banner { background: #f5f5f7; border-left: 3px solid #1d1d1f; padding: 6px 10px; margin: 8px 0; font-size: 8.5pt; }
footer { margin-top: 16px; font-size: 7.5pt; color: #777; }
`;

export function renderReport(
  rows: Opportunity[],
  highlights: string[],
  meta: ReportMeta,
  variant: 'private' | 'peer',
): string {
  const view = variant === 'peer' ? toPeerRows(rows) : rows;
  const peer = variant === 'peer';
  const withComp = view.filter((r) => r.salary);
  const refs = view.filter((r) => r.asksForReferrals || r.referralBonus).length;
  const remote = view.filter((r) => r.remote === 'remote').length;

  const banner = peer
    ? `<div class="banner">Shared for job-seeking peers. Recruiter contact details and personal offer terms are removed. If a role interests you, ask me for an intro or referral.</div>`
    : `<div class="banner"><b>Private copy</b> — contains recruiter names and email addresses. Share the peer version instead.</div>`;

  const main = `
  <table>
    <thead><tr>
      <th>#</th><th>Company</th><th>Role</th><th>Level</th><th>Comp</th><th>Size</th><th>Stage</th><th>Where</th><th>Benefits &amp; notes</th>
      ${peer ? '<th>Intro?</th>' : '<th>Contact</th><th>Last seen</th>'}
    </tr></thead>
    <tbody>
    ${view
      .map(
        (r, i) => `<tr>
      <td class="muted">${i + 1}</td>
      <td><b>${e(r.company)}</b>${r.viaAgency ? `<div class="muted">via ${e(r.viaAgency)}</div>` : ''}</td>
      <td>${e(r.role)}</td>
      <td>${e(r.level.label)}</td>
      <td class="num">${e(formatSalary(r.salary))}${r.salary && r.salary.currency !== 'USD' ? '<div class="src">≈USD for sorting</div>' : ''}${r.equity ? `<div class="muted">${e(r.equity)}</div>` : ''}</td>
      <td class="num">${r.headcount ? `~${r.headcount.toLocaleString('en-US')}` : '<span class="muted">?</span>'}${r.sizeSource === 'enrichment' ? '<div class="src">public data</div>' : ''}</td>
      <td>${r.stage === 'Unknown' ? '<span class="muted">?</span>' : e(r.stage)}${r.totalRaisedUsd ? `<div class="muted">$${fmtMoney(r.totalRaisedUsd)}</div>` : ''}${r.stageSource === 'enrichment' ? '<div class="src">public data</div>' : ''}</td>
      <td>${e(r.location ?? '')}${r.remote !== 'unknown' ? ` <span class="tag">${e(r.remote)}</span>` : ''}</td>
      <td>${r.benefits.map((b) => `<span class="tag">${e(b)}</span>`).join('')}${r.referralBonus ? `<span class="tag ref">${e(r.referralBonus)}</span>` : r.asksForReferrals ? '<span class="tag ref">wants referrals</span>' : ''}${r.kind === 'offer' && !peer ? '<span class="tag">offer</span>' : ''}</td>
      ${
        peer
          ? `<td>${r.contact.email ? 'Yes' : '—'}</td>`
          : `<td>${e(r.contact.name || '')}<div class="muted">${e(r.contact.email)}</div></td><td class="num">${e(r.lastSeen)}</td>`
      }
    </tr>`,
      )
      .join('')}
    </tbody>
  </table>`;

  const grouped = (title: string, keys: readonly string[], keyOf: (r: Opportunity) => string) => {
    const groups = [...keys, 'Unknown']
      .map((k) => [k, view.filter((r) => keyOf(r) === k)] as const)
      .filter(([, rs]) => rs.length);
    return `<h2>${title}</h2><div class="group">${groups
      .map(
        ([k, rs]) => `<div><h3>${e(k)} <span class="muted">(${rs.length})</span></h3>${rs
          .map((r) => `<div>${e(r.company)} — ${e(r.role)} <span class="muted">${e(formatSalary(r.salary))}</span></div>`)
          .join('')}</div>`,
      )
      .join('')}</div>`;
  };

  const levels = [...new Set(view.map((r) => r.level.label))].sort(
    (a, b) => (view.find((r) => r.level.label === b)!.level.rank - view.find((r) => r.level.label === a)!.level.rank),
  );

  const sources = [...new Map(view.flatMap((r) => r.sources).map((s) => [s.url, s])).values()];

  return `<!doctype html><html><head><meta charset="utf-8"><title>Job opportunities ${meta.window.from} – ${meta.window.to}</title><style>${CSS}</style></head><body>
  <h1>Inbound job opportunities</h1>
  <div class="sub">${e(meta.window.from)} → ${e(meta.window.to)}${meta.excluded.length ? ` · excluding ${e(meta.excluded.join(', '))}` : ''} · generated ${e(meta.generatedAt.slice(0, 16).replace('T', ' '))} UTC on-device</div>
  ${banner}
  <div class="kpis">
    <div class="kpi"><b>${view.length}</b><span>Opportunities</span></div>
    <div class="kpi"><b>${withComp.length}</b><span>With comp</span></div>
    <div class="kpi"><b>${withComp.length ? formatSalary(topBand(withComp)) : '—'}</b><span>Top band</span></div>
    <div class="kpi"><b>${remote}</b><span>Remote</span></div>
    <div class="kpi"><b>${refs}</b><span>Want referrals</span></div>
  </div>
  ${highlights.length ? `<h2>Highlights</h2><ul class="hl">${highlights.map((h) => `<li>${e(h)}</li>`).join('')}</ul>` : ''}
  <h2>All opportunities — ranked by compensation</h2>
  ${view.length ? main : '<p class="muted">No opportunities found in this window.</p>'}
  ${grouped('By company size (headcount)', SIZE_BUCKETS, (r) => r.sizeBucket)}
  ${grouped('By funding stage', STAGES, (r) => r.stage)}
  ${grouped('By level', levels, (r) => r.level.label)}
  <h2>Method &amp; caveats</h2>
  <ul class="hl">
    <li>${meta.threadsScanned} threads matched the keyword/ATS prefilter; ${meta.candidates} passed rule scoring and were read by the on-device model.</li>
    <li>Compensation, size and funding are copied verbatim from emails and checked against the source text; values not found in the email are left blank unless filled from public data (marked “public data”).</li>
    <li>Ranking uses annualized midpoint in USD (hourly × 2,080; non-USD via a fixed approximate rate). Base vs. total comp is labeled where stated.</li>
    ${meta.notes.map((n) => `<li>${e(n)}</li>`).join('')}
  </ul>
  ${sources.length ? `<div class="src">Sources: ${sources.map((s) => `${e(s.label)} (${e(s.url)})`).join(' · ')}</div>` : ''}
  <footer>Generated by Pocket Agent — inference ran locally; no email content left the device${sources.length ? ' (company lookups used public sources with only the company name)' : ''}.</footer>
  </body></html>`;
}

function topBand(rows: Opportunity[]) {
  return rows.reduce((best, r) => ((r.salary?.annualUsdMax ?? 0) > (best?.annualUsdMax ?? 0) ? r.salary! : best), rows[0].salary!);
}

function fmtMoney(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B raised`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M raised`;
  return `${Math.round(n / 1e3)}k raised`;
}
