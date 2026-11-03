# Architecture

```
┌──────────────────────────── React Native (Expo dev client, Hermes, New Arch) ────────────────────────────┐
│ app/ (expo-router)   Chat · Models · Connections & memory · Reports & jobs · ApprovalSheet               │
│ src/ui/controller.ts  app state, AppState→abort, approval promise bridge                                 │
├───────────────────────────────────────────── src/core (pure TS) ─────────────────────────────────────────┤
│                                                                                                          │
│  Agent.send(text)                                                                                        │
│    └─ router (2 constrained calls: enum route → that skill's arg schema)                                 │
│         ├─ chat  → ReAct loop, native tool calls over McpHub.toolSpecs(), memory in system prompt        │
│         └─ skill → JobStore job → compiled pipeline (code orchestrates, LLM at leaves) → HTML → PDF      │
│                                                                                                          │
│  McpHub  (real MCP Client per server)                                                                    │
│    ├─ mail    in-process (InMemoryTransport)  sync[openWorld] · search · get_thread · stats              │
│    ├─ memory  in-process                       save · search · forget[destructive]                       │
│    ├─ enrich  in-process                       company_lookup[openWorld]  (Wikidata; pluggable)          │
│    └─ <name>  remote Streamable HTTP           (always treated as openWorld)                             │
│    approval gate: openWorldHint || destructiveHint ⇒ Approver(req) → allow-once | allow-always | deny    │
│                                                                                                          │
│  LLM interface ── llama.rn (device) │ OpenAI-compat/llama-server (eval, live) │ Scripted (tests, oracle) │
│  Db interface  ── op-sqlite (device) │ node:sqlite (eval/tests)  — same SQL, FTS5 in both              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Why a hybrid router rather than one loop

A 4B model running a free-form ReAct loop over "90 days of email" fails in a predictable way. It
under-searches, loses track after context compaction, and makes up numbers when it summarizes.
That's how the other app failed. So the corpus-scale work is a **compiled skill**. Code decides
what to read and in what order. The model does three bounded jobs:

| Leaf | Call shape | Guard |
|---|---|---|
| Route | `{route: enum}` | closed enum grammar |
| Args | the skill's `argsSchema` | grammar + defaults merge |
| Per-thread classify + extract | flat 14-field schema, `*_text` fields verbatim | **grounding**: every span must occur in the source email, or it is dropped |
| Highlights | `{highlights: string[≤5]}` | written from the **redacted** rows, so the narrative can't leak a private offer |

Everything numeric happens in `normalize.ts`, where it's unit-tested: salary parsing (ranges,
k/M suffixes, hourly → ×2080, currency), size buckets, funding stage, level ordinal, and the
company identity used for dedup and exclusion.

## job_opportunities_report pipeline

1. **sync** (network, approval): Gmail `q=` prefilter. It combines keywords, ATS sender domains,
   `newer_than:Nd` and `-from:<excluded>`, so only plausible mail is ever downloaded. Mail is
   stored in SQLite + FTS5. This step is idempotent and skips ids already cached.
2. **prefilter**: a local FTS query plus a rule score over inbound messages (the user's own
   replies are ignored). The threshold is deliberately low, because recall matters more than
   precision at this stage.
3. **extract**: constrained LLM call per thread. Each result is checkpointed in `job_items`.
4. **filter / exclude / dedup**: drop kinds outside the requested set. Excluded companies are
   matched on normalized name and also on sender domain, so an agency pitching an Anthropic
   role is excluded too. Threads are merged on `(company, role)`, and derived fields are
   recomputed on merge.
5. **enrich** (network, approval, checkpointed per company): fill headcount and stage only where
   the email didn't state them. Every filled value carries a source, and the report marks it
   "public data".
6. **rank + render**: sort by annualized USD midpoint, then level, then name. Two HTML documents
   are produced and printed to PDF by the OS print engine (`expo-print`).

**Resumability.** A job is identified by its id, and every stage reads its checkpoints first.
When iOS backgrounds the app, the controller aborts. The job is then marked `paused`, and
Reports → Resume re-enters with zero re-extraction. The oracle eval asserts this ("replay made
0 new extraction calls").

**Peer redaction** (`redact.ts`) is deterministic:
- Contact name and email are removed.
- Thread ids are dropped.
- Formal offer terms are removed, and the rows are re-ranked afterwards so position doesn't
  reveal the hidden number.
- A regex PII scan (emails and phone numbers) runs over the final HTML in the eval.

## Memory

The `memories` table is indexed with FTS5. The system prompt always includes the 3 latest
`preference` memories plus the top BM25 matches for the current turn. The model writes memories
through `memory__save` (local, no approval needed); `memory__forget` is marked destructive, so it
asks first. If BM25 recall turns out not to be enough, embedding retrieval can be added behind the
same interface: llama.rn `embedding()` with a small GGUF embedder.

## Context budgeting

`compact()` keeps the prompt within 70% of `n_ctx`. It first truncates old tool results, then
drops the oldest turns, keeping assistant(tool_calls)/tool pairs together. The system prompt and
the latest user turn are never touched. Tool results are capped at 3k characters, and
`get_thread` strips quoted replies before returning.

## Device notes

- **Default model**: Qwen3-4B-Instruct-2507 Q4_K_M (2.50 GB), `n_ctx` 8192, with q8_0 KV cache to
  roughly halve KV RAM. It needs a device with about 6 GB of RAM or more. Qwen3-1.7B is the
  fallback for smaller devices.
- **iOS**: the llama.rn config plugin adds the `increased-memory-limit` and
  `extended-virtual-addressing` entitlements for production builds. Metal offloads all layers
  (`n_gpu_layers: 99`).
- **Android**: OpenCL/Hexagon backends are enabled through the plugin, with CPU fallback.
  `largeHeap` is set.
- **Hermes**: the MCP client uses the cfworker JSON-schema validator instead of ajv, because
  ajv relies on runtime code generation. Gmail query strings are built by hand because RN's
  `URLSearchParams` is incomplete.
