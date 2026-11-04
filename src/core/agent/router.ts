import { completeJSON, type LLM } from '../llm/types.ts';
import type { Skill } from '../skills/types.ts';

export type Route = { kind: 'chat' } | { kind: 'skill'; skill: Skill<any>; args: Record<string, unknown> };

/**
 * Two small constrained calls instead of one big one:
 *  1) pick a route from a closed enum (chat | skill names)
 *  2) if a skill, fill *that skill's* arg schema
 * Each grammar is tiny, which is what keeps a 4B model reliable here.
 */
export async function route(llm: LLM, skills: Skill<any>[], userText: string, signal?: AbortSignal): Promise<Route> {
  if (!skills.length) return { kind: 'chat' };
  const names = skills.map((s) => s.name);
  const pick = await completeJSON<{ route: string }>(
    llm,
    [
      {
        role: 'system',
        content:
          'Route the user request. Choose a skill only if the request clearly asks for what the skill does; otherwise choose "chat".\nSkills:\n' +
          skills.map((s) => `- ${s.name}: ${s.description}`).join('\n'),
      },
      { role: 'user', content: userText },
    ],
    { type: 'object', additionalProperties: false, required: ['route'], properties: { route: { type: 'string', enum: ['chat', ...names] } } },
    { maxTokens: 40, signal },
  );
  const skill = skills.find((s) => s.name === pick.route);
  if (!skill) return { kind: 'chat' };
  const args = await completeJSON<Record<string, unknown>>(
    llm,
    [
      {
        role: 'system',
        content: `Extract arguments for "${skill.name}" from the user's request. Use defaults when unstated: ${JSON.stringify(skill.defaults)}.`,
      },
      { role: 'user', content: userText },
    ],
    skill.argsSchema,
    { maxTokens: 120, signal },
  );
  return { kind: 'skill', skill, args: { ...skill.defaults, ...args } };
}
