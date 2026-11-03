# Pocket Agent

Pocket Agent is an offline-first personal assistant for iOS and Android. The LLM runs on the
device through llama.cpp (llama.rn). Capabilities connect over **MCP**, and reports are produced
as **PDFs**.

Out of the box it can do this:

> *"Go through my emails and pull in all employment opportunities I've gotten in the last 90 days besides from Anthropic. Organize by salary, company size, funding round and other benefits / level."*

It produces two PDFs. The **private** one includes recruiter contacts and is meant for tracking
referrals. The **peer** one has contacts and personal offer terms removed and is safe to share.

The design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). In short:

- **Hybrid router.** Free-form chat runs a ReAct loop over MCP tools. Corpus-scale requests run a
  compiled skill: code drives a map-reduce, and the LLM does grammar-constrained extraction at
  the leaves.
- **Grounding.** Every extracted fact must appear verbatim in the source email.
- **Deterministic math.** All arithmetic, ranking and redaction is done in code.
- **Bundled MCP servers.** Gmail (synced into SQLite FTS5 on the device), memory, and company
  enrichment are in-process MCP servers. Remote Streamable-HTTP servers can be added from the UI.
- **Approval gate.** Any tool with `openWorldHint` or `destructiveHint` asks the user first.
  Choices are allow once, always, or deny.
- **Resumable jobs.** Durable per-item checkpoints mean a killed or backgrounded scan resumes
  where it stopped.

## Layout

```
app/                 expo-router screens (chat, models, connections, reports)
src/core/            platform-free TS: agent, router, ReAct, MCP hub + servers, skills, stores
src/native/          device adapters: llama.rn, op-sqlite, model download, Gmail OAuth, PDF
src/ui/              controller (state + approval bridge), theme, approval sheet
eval/                Node harness: fixture mailbox + gold labels, oracle LLM, live Gmail runner
tests/               vitest unit/integration tests (node:sqlite, in-memory MCP)
```

## Run it on a device

You need Xcode or Android Studio. llama.rn is a native module, so Expo Go won't work; use a dev
client.

```bash
npm install
cp .env.example .env              # add the Google OAuth client ids (see below)
npx expo prebuild
npm run ios                       # or: npm run android
```

Then open **Models → Download** to fetch Qwen3-4B (2.5 GB, resumable), and
**Connect → Connect Gmail**. After that, ask the question in Chat.

### Google OAuth (Gmail, read-only)

1. In Google Cloud Console, enable the **Gmail API**.
2. Create OAuth client IDs of type **iOS** (bundle id `dev.pocketagent.app`) and **Android**
   (package `dev.pocketagent.app` plus your debug SHA-1).
3. Put them in `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`.
4. On the OAuth consent screen, add yourself as a **test user**. `gmail.readonly` is a
   *restricted* scope: anyone outside the test-user list (max 100) requires Google's security
   assessment. Peers installing their own copy is fine if you add them as test users.

The auth flow is authorization code + PKCE. Tokens are stored in the iOS Keychain or Android
Keystore through `expo-secure-store`.

## Develop without a phone

```bash
npm test                 # 33 unit + integration tests
npm run typecheck
npm run eval             # oracle eval: full pipeline on the fixture mailbox, model replaced by gold labels
npm run eval:pdf         # same, and renders both PDFs to eval/out/ (Playwright)
```

**Scoring a real model** uses the same chat template and grammar engine as the device:

```bash
llama-server --jinja -m Qwen3-4B-Instruct-2507-Q4_K_M.gguf -c 8192 --port 8080
npm run eval -- --llm http://localhost:8080
```

**Answering the question against your real inbox from a laptop**, before you build the app,
runs the same code path:

```bash
GMAIL_ACCESS_TOKEN=ya29.... npm run live      # token w/ gmail.readonly, e.g. from OAuth Playground
```

Output goes to `eval/out/live/`. The mail cache and checkpoints persist there, so re-runs are
incremental.

## Known gaps / next steps

- **Not yet run on a physical device or simulator.** The JS bundles cleanly for iOS and Android
  (Hermes), and the core passes tests and the eval. The native build and on-device performance
  still need a real run.
- **The real-model eval hasn't been run yet.** The authoring environment couldn't reach
  Hugging Face. Run `npm run eval -- --llm …` to get field-level accuracy for Qwen3-4B on the
  fixture set.
- **Enrichment coverage is thin.** Wikidata is good for headcounts of established companies and
  poor for startup funding. Add a Crunchbase or Harmonic provider (an `EnrichmentProvider` is
  about 30 lines) if you have a key.
- **Remote MCP over SSE.** Plain JSON responses work. SSE-streamed responses rely on
  `TextDecoderStream`, which may need a polyfill on Hermes.
- **Download integrity is checked by exact byte size only.** sha256 verification of a 2.5 GB
  file in JS is slow; a native hashing module would fix that.
