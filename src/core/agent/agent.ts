import type { Db } from '../db/types.ts';
import type { Job } from '../jobs/store.ts';
import { JobStore } from '../jobs/store.ts';
import type { ChatMessage, LLM } from '../llm/types.ts';
import type { McpHub } from '../mcp/hub.ts';
import { MemoryStore } from '../memory/store.ts';
import type { ArtifactOut, Skill, SkillResult } from '../skills/types.ts';
import { type AgentEvent, runReact } from './react.ts';
import { route } from './router.ts';

/** Platform hook: render self-contained HTML to a PDF file and return its path. */
export type PdfRenderer = (html: string, fileStem: string) => Promise<string>;

export interface AgentDeps {
  llm: LLM;
  hub: McpHub;
  db: Db;
  skills: Skill<any>[];
  renderPdf: PdfRenderer;
  selfEmail?: () => string | null;
  now?: () => number;
}

/**
 * Hybrid agent:
 *   user turn ─► router ─┬─► chat: ReAct loop over MCP tools (+ memory in system prompt)
 *                        └─► skill: compiled pipeline, durable job, PDF artifacts
 */
export class Agent {
  readonly jobs: JobStore;
  readonly memory: MemoryStore;
  private history: ChatMessage[] = [];

  private deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.jobs = new JobStore(deps.db);
    this.memory = new MemoryStore(deps.db);
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  async systemPrompt(userText: string): Promise<string> {
    const mems = await this.memory.contextFor(userText);
    const servers = this.deps.hub.servers().map((s) => `${s.name} (${s.kind})`).join(', ');
    return [
      'You are Pocket Agent, a private assistant running fully on the user\'s phone.',
      `Today is ${new Date(this.now()).toISOString().slice(0, 10)}.`,
      `Connected tool servers: ${servers || 'none'}. Prefer offline tools; network tools require the user's approval.`,
      'Be concise. When you learn a durable fact or preference about the user, save it with memory__save.',
      mems.length ? 'Known about the user:\n' + mems.map((m) => `- ${m.content}`).join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async send(userText: string, emit: (e: AgentEvent) => void = () => {}, signal?: AbortSignal): Promise<string> {
    const r = await route(this.deps.llm, this.deps.skills, userText, signal);
    emit({ type: 'route', route: r.kind === 'chat' ? 'chat' : r.skill.name, args: r.kind === 'skill' ? r.args : undefined });

    if (r.kind === 'skill') {
      const job = await this.jobs.create(r.skill.name, r.args);
      const res = await this.runJob(job, emit, signal);
      this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: res.summary });
      return res.summary;
    }

    const messages: ChatMessage[] = [{ role: 'system', content: await this.systemPrompt(userText) }, ...this.history, { role: 'user', content: userText }];
    const out = await runReact(this.deps.llm, this.deps.hub, messages, { signal, emit });
    this.history = out.messages.slice(1).slice(-24);
    return out.text;
  }

  /** Run or resume a durable job. Per-item checkpoints make this idempotent. */
  async runJob(job: Job, emit: (e: AgentEvent) => void = () => {}, signal?: AbortSignal): Promise<SkillResult> {
    const skill = this.deps.skills.find((s) => s.name === job.skill);
    if (!skill) throw new Error(`Unknown skill ${job.skill}`);
    await this.jobs.update(job.id, { status: 'running', error: null });
    try {
      const res = await skill.run(
        {
          llm: this.deps.llm,
          hub: this.deps.hub,
          jobs: this.jobs,
          memory: this.memory,
          selfEmail: this.deps.selfEmail?.() ?? null,
          now: () => this.now(),
          signal,
          onProgress: (p) => emit({ type: 'progress', ...p }),
        },
        job,
        { ...skill.defaults, ...job.args },
      );
      const artifacts: ArtifactOut[] = [];
      for (const a of res.artifacts) {
        const stem = `${job.skill}-${a.variant}-${new Date(this.now()).toISOString().slice(0, 10)}`;
        const path = await this.deps.renderPdf(a.html, stem);
        await this.deps.db.run('INSERT OR REPLACE INTO artifacts(id, job_id, title, variant, path, created_at) VALUES (?,?,?,?,?,?)', [
          `${job.id}:${a.variant}`,
          job.id,
          a.title,
          a.variant,
          path,
          this.now(),
        ]);
        artifacts.push({ ...a, path });
        emit({ type: 'artifact', title: a.title, variant: a.variant, path });
      }
      await this.jobs.update(job.id, { status: 'done', result: { summary: res.summary, artifacts: artifacts.map(({ html, ...rest }) => rest) } });
      emit({ type: 'final', text: res.summary });
      return { ...res, artifacts };
    } catch (e) {
      const aborted = signal?.aborted || /aborted/i.test(String(e));
      await this.jobs.update(job.id, { status: aborted ? 'paused' : 'failed', error: String(e) });
      throw e;
    }
  }

  resetConversation(): void {
    this.history = [];
  }
}
