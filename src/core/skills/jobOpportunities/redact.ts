import type { Opportunity } from './index.ts';
import { salarySortKey } from './normalize.ts';

/**
 * Deterministic redaction for the shareable copy. Never delegated to the LLM.
 *  - recruiter name/email removed (only "intro available" survives)
 *  - thread ids removed
 *  - terms of a formal personal offer removed (bands from outreach are kept —
 *    those are typically the posted range and useful to peers)
 */
export function toPeerRows(rows: Opportunity[]): Opportunity[] {
  const redacted = rows.map((r) => ({
    ...r,
    contact: { name: '', email: r.contact.email ? 'available' : '' },
    threadIds: [],
    salary: r.kind === 'offer' ? null : r.salary,
    equity: r.kind === 'offer' ? null : r.equity,
    // Personal process state isn't the peer's business; present as outreach.
    kind: r.kind === 'offer' || r.kind === 'interview_process' ? ('recruiter_outreach' as const) : r.kind,
  }));
  // Re-rank on what's visible, so position doesn't reveal a hidden offer.
  return redacted.sort(
    (a, b) => salarySortKey(b.salary) - salarySortKey(a.salary) || b.level.rank - a.level.rank || a.company.localeCompare(b.company),
  );
}

/** Belt-and-braces check used by tests and before export: no emails/phones leak into peer HTML. */
export function findPII(html: string): string[] {
  const hits = new Set<string>();
  for (const m of html.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) hits.add(m[0]);
  for (const m of html.matchAll(/\+?\d[\d\s().-]{8,}\d/g)) {
    if (/\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/.test(m[0])) hits.add(m[0].trim());
  }
  return [...hits];
}
