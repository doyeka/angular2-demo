import type { JobStore, Job } from '../jobs/store.ts';
import type { JSONSchema, LLM } from '../llm/types.ts';
import type { McpHub } from '../mcp/hub.ts';
import type { MemoryStore } from '../memory/store.ts';

export interface ArtifactOut {
  title: string;
  variant: 'private' | 'peer';
  /** Self-contained HTML; the platform renders it to PDF. */
  html: string;
  /** Filled by the platform after rendering. */
  path?: string;
}

export interface SkillResult {
  /** Markdown summary shown in chat. */
  summary: string;
  artifacts: ArtifactOut[];
  data?: unknown;
}

export interface SkillProgress {
  stage: string;
  done: number;
  total: number;
  note?: string;
}

export interface SkillContext {
  llm: LLM;
  hub: McpHub;
  jobs: JobStore;
  memory: MemoryStore;
  /** Mail account address — messages from this address are the user's own. */
  selfEmail: string | null;
  now: () => number;
  signal?: AbortSignal;
  onProgress?: (p: SkillProgress) => void;
}

/**
 * A compiled skill: deterministic orchestration in code, LLM only at
 * well-defined leaf steps (classification, extraction, narrative).
 */
export interface Skill<A = Record<string, unknown>> {
  name: string;
  /** Shown to the router model. */
  description: string;
  /** JSON Schema for args — the router fills it with constrained decoding. */
  argsSchema: JSONSchema;
  defaults: A;
  run(ctx: SkillContext, job: Job, args: A): Promise<SkillResult>;
}
