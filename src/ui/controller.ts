import { AppState } from 'react-native';
import { useSyncExternalStore } from 'react';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { AgentEvent } from '../core/agent/react';
import type { Db } from '../core/db/types';
import { defaultModel, MODELS, type ModelEntry } from '../core/llm/models';
import type { CompletionRequest, LLM } from '../core/llm/types';
import type { MailProvider } from '../core/mail/types';
import type { ApprovalDecision, ApprovalRequest } from '../core/mcp/hub';
import { WikidataProvider } from '../core/mcp/servers/enrichServer';
import { createRuntime, type Runtime } from '../core/runtime';
import type { Job } from '../core/jobs/store';
import { connectGmail, disconnectGmail, restoreGmail } from '../native/gmailAuth';
import { LlamaRnLLM } from '../native/llamaRnLLM';
import { type DownloadState, ModelDownload, modelState } from '../native/modelDownloader';
import { openDeviceDb } from '../native/opSqliteDb';
import { renderPdf } from '../native/pdf';

export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'progress' | 'artifact';
  text: string;
  path?: string;
}

export interface AppStateShape {
  ready: boolean;
  model: ModelEntry;
  modelStates: Record<string, DownloadState>;
  modelLoaded: string | null;
  loadProgress: number | null;
  gmail: string | null;
  enrichEnabled: boolean;
  items: ChatItem[];
  busy: boolean;
  pendingApproval: (ApprovalRequest & { resolve: (d: ApprovalDecision) => void }) | null;
  resumable: Job[];
  error: string | null;
}

/** Swappable LLM so the runtime can be built before a model is downloaded/loaded. */
class LazyLLM implements LLM {
  inner: LLM | null = null;
  get id() {
    return this.inner?.id ?? 'none';
  }
  get contextTokens() {
    return this.inner?.contextTokens ?? 8192;
  }
  complete(req: CompletionRequest) {
    if (!this.inner) return Promise.reject(new Error('No model loaded — download one under Models.'));
    return this.inner.complete(req);
  }
}

let state: AppStateShape = {
  ready: false,
  model: defaultModel(),
  modelStates: {},
  modelLoaded: null,
  loadProgress: null,
  gmail: null,
  enrichEnabled: true,
  items: [],
  busy: false,
  pendingApproval: null,
  resumable: [],
  error: null,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<AppStateShape>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
export const useApp = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);

let db: Db;
let runtime: Runtime;
const llm = new LazyLLM();
let mail: MailProvider | null = null;
let abort: AbortController | null = null;
const downloads = new Map<string, ModelDownload>();
let seq = 0;
const nid = () => `i${++seq}`;

export async function init(): Promise<void> {
  if (state.ready) return;
  try {
    db = openDeviceDb();
    mail = await restoreGmail();
    runtime = await createRuntime({
      db,
      llm,
      renderPdf,
      mailProvider: () => mail,
      enrichProviders: [new WikidataProvider()],
      // Hermes: avoid ajv's runtime codegen
      clientOptions: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
      approver: (req) => new Promise((resolve) => set({ pendingApproval: { ...req, resolve } })),
    });
    const modelStates: Record<string, DownloadState> = {};
    for (const m of MODELS) modelStates[m.id] = await modelState(m);
    set({ ready: true, gmail: mail?.account ?? null, modelStates, resumable: await runtime.agent.jobs.resumable() });
    const ms = modelStates[state.model.id];
    if (ms.status === 'ready') void loadModel(state.model);
  } catch (e) {
    set({ error: (e as Error).message });
  }

  // iOS suspends GPU work in background; pause cleanly so the job is resumable.
  AppState.addEventListener('change', async (s) => {
    if (s === 'background' && abort) abort.abort();
    if (s === 'active' && runtime) set({ resumable: await runtime.agent.jobs.resumable() });
  });
}

export function resolveApproval(d: ApprovalDecision) {
  state.pendingApproval?.resolve(d);
  set({ pendingApproval: null });
}

export async function loadModel(m: ModelEntry) {
  const ms = await modelState(m);
  if (ms.status !== 'ready') return;
  set({ loadProgress: 0, model: m });
  try {
    if (llm.inner instanceof LlamaRnLLM) await llm.inner.release();
    llm.inner = await LlamaRnLLM.load(ms.path, { id: m.id, nCtx: m.nCtx, onProgress: (p) => set({ loadProgress: p }) });
    set({ modelLoaded: m.id, loadProgress: null });
  } catch (e) {
    set({ error: `Model load failed: ${(e as Error).message}`, loadProgress: null });
  }
}

export function downloadModel(m: ModelEntry) {
  const d = new ModelDownload(m, (s) => {
    set({ modelStates: { ...state.modelStates, [m.id]: s } });
    if (s.status === 'ready' && m.id === state.model.id) void loadModel(m);
  });
  downloads.set(m.id, d);
  void d.start();
}

export function pauseDownload(m: ModelEntry) {
  void downloads.get(m.id)?.pause();
}

export async function linkGmail() {
  try {
    await connectGmail();
    mail = await restoreGmail();
    set({ gmail: mail?.account ?? null });
  } catch (e) {
    set({ error: (e as Error).message });
  }
}

export async function unlinkGmail() {
  await disconnectGmail();
  mail = null;
  set({ gmail: null });
}

export async function setEnrichment(on: boolean) {
  if (on) {
    const { createEnrichServer } = await import('../core/mcp/servers/enrichServer');
    await runtime.hub.addInProcess('enrich', createEnrichServer([new WikidataProvider()]));
  } else {
    await runtime.hub.remove('enrich');
  }
  set({ enrichEnabled: on });
}

export async function addRemoteServer(name: string, url: string, bearer?: string) {
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { fetch: expoFetch } = await import('expo/fetch'); // WinterCG fetch with streaming bodies
  const t = new StreamableHTTPClientTransport(new URL(url), {
    fetch: expoFetch as unknown as typeof fetch,
    requestInit: bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined,
  });
  await runtime.hub.addRemote(name, t);
}

export const servers = () => runtime?.hub.servers() ?? [];
export const memories = () => runtime?.memory.all() ?? Promise.resolve([]);
export const artifacts = () =>
  db ? db.all<{ id: string; title: string; variant: string; path: string; created_at: number }>('SELECT * FROM artifacts ORDER BY created_at DESC') : Promise.resolve([]);

function onEvent(e: AgentEvent) {
  const items = [...state.items];
  const last = items[items.length - 1];
  switch (e.type) {
    case 'token':
      if (last?.role === 'assistant' && state.busy) items[items.length - 1] = { ...last, text: last.text + e.text };
      else items.push({ id: nid(), role: 'assistant', text: e.text });
      break;
    case 'tool_call':
      items.push({ id: nid(), role: 'tool', text: `→ ${e.call.name}(${JSON.stringify(e.call.arguments).slice(0, 120)})` });
      break;
    case 'tool_result':
      items.push({ id: nid(), role: 'tool', text: `${e.isError ? '✗' : '✓'} ${e.name}: ${e.preview.slice(0, 120)}` });
      break;
    case 'progress': {
      const text = `${e.stage} ${e.done}/${e.total}${e.note ? ` — ${e.note}` : ''}`;
      if (last?.role === 'progress') items[items.length - 1] = { ...last, text };
      else items.push({ id: nid(), role: 'progress', text });
      break;
    }
    case 'artifact':
      items.push({ id: nid(), role: 'artifact', text: e.title, path: e.path });
      break;
    case 'final':
      if (last?.role === 'assistant') items[items.length - 1] = { ...last, text: e.text };
      else items.push({ id: nid(), role: 'assistant', text: e.text });
      break;
    case 'route':
      if (e.route !== 'chat') items.push({ id: nid(), role: 'progress', text: `Running skill ${e.route}` });
      break;
  }
  set({ items });
}

export async function send(text: string) {
  if (state.busy || !text.trim()) return;
  abort = new AbortController();
  set({ busy: true, error: null, items: [...state.items, { id: nid(), role: 'user', text }] });
  try {
    await runtime.agent.send(text, onEvent, abort.signal);
  } catch (e) {
    set({ error: (e as Error).message });
  } finally {
    abort = null;
    set({ busy: false, resumable: await runtime.agent.jobs.resumable() });
  }
}

export async function resumeJob(job: Job) {
  if (state.busy) return;
  abort = new AbortController();
  set({ busy: true, error: null });
  try {
    await runtime.agent.runJob(job, onEvent, abort.signal);
  } catch (e) {
    set({ error: (e as Error).message });
  } finally {
    abort = null;
    set({ busy: false, resumable: await runtime.agent.jobs.resumable() });
  }
}

export function stop() {
  abort?.abort();
}
