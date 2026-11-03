import type { CompletionRequest } from '../src/core/llm/types.ts';
import { ScriptedLLM } from '../src/core/llm/scripted.ts';
import { MAILBOX } from './fixtures/mailbox.ts';

/**
 * Replays gold labels at every LLM leaf. Isolates the *non-model* parts of the
 * system (sync, MCP plumbing, prefilter, grounding, normalization, dedup,
 * exclusion, enrichment, redaction, rendering) so a failure here is a code bug,
 * not a model-quality issue.
 */
export function oracleLLM(): ScriptedLLM {
  return new ScriptedLLM((req: CompletionRequest) => {
    const props = (req.jsonSchema?.properties ?? {}) as Record<string, unknown>;
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if ('route' in props) {
      return JSON.stringify({ route: /job|employment|opportunit|recruit/i.test(user) ? 'job_opportunities_report' : 'chat' });
    }
    if ('days' in props) {
      const days = Number(user.match(/(\d+)\s*days?/i)?.[1] ?? 90);
      const ex = user.match(/(?:besides|except|excluding|other than)\s+(?:from\s+)?([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*)/);
      return JSON.stringify({ days, exclude_companies: ex ? [ex[1]] : [] });
    }
    if ('kind' in props) {
      const id = user.match(/message_id:\s*(\S+)/)?.[1];
      const gold = MAILBOX.find((m) => m.id === id)?.gold;
      return JSON.stringify(
        gold ?? {
          kind: 'not_job', company: null, via_agency: null, role_title: null, level: null, location: null, remote: 'unknown',
          salary_text: null, equity_text: null, company_size_text: null, funding_text: null, benefits: [], referral_bonus_text: null, asks_for_referrals: false,
        },
      );
    }
    if ('highlights' in props) {
      const rows = JSON.parse(user) as { company: string; role: string; comp_usd: [number | null, number | null] | null; remote: string; referrals: boolean }[];
      const top = rows.find((r) => r.comp_usd);
      const h = [
        top ? `Highest posted band: ${top.company} — ${top.role}.` : 'No compensation was disclosed.',
        `${rows.filter((r) => r.remote === 'remote').length} of ${rows.length} roles are fully remote.`,
        (n => `${n} ${n === 1 ? 'company explicitly welcomes' : 'companies explicitly welcome'} referrals.`)(rows.filter((r) => r.referrals).length),
      ];
      return JSON.stringify({ highlights: h });
    }
    return { text: 'Oracle mode: free-form chat is not scripted.', toolCalls: [] };
  }, 'oracle');
}
