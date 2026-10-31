# Ultrareview Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding that still applies from the two ultrareviews of `depl` (2026-10-31), most severe first.

**Architecture:** Each task is a small, independently shippable fix that lives in the module that owns the bug. Two pieces of logic move into new, focused files so they can be unit-tested without Chrome or network: a bounded token-wait queue (`src/mizan/TokenWaitQueue.ts`) and pipeline construction (`src/agent/createTranslationPipeline.ts`). Tests use Node's built-in `node:test` runner through `ts-node`, so nothing new is added to the runtime.

**Tech Stack:** TypeScript 5 (strict, CommonJS), Node 24, `@elevenlabs/elevenlabs-js` 2.61 realtime STT, DeepL REST, Mizan LLM, `node:test` + `node:assert/strict`.

**Spec:** this document. Part A analyses the findings. Part B is the plan.

---

# Part A — Findings analysis

The two reviews returned 20 findings. Nine of them were in code that later commits removed or rewrote (the old `ChunkAggregator` / `AdaptiveChunkController` / batch pipeline), so they need no action. The rest map to tasks as follows.

| # | Finding | Root cause (current code) | Fix | Task |
|---|---------|---------------------------|-----|------|
| S1 | Mizan username and password hardcoded and pushed | `scripts/update-templates.ts:19-21` uses the literals as `\|\|` fallbacks | Remove the fallbacks and exit when env vars are missing. **Rotate the password** (manual). Purging history is optional and your call. | 1 |
| 7 | Mizan voice `af_heart` sent to ElevenLabs | `TranslationPipeline.ts:318` passes `voiceId: this.config.ttsVoice`, which overrides `getVoiceConfig(lang)` in `ElevenLabsTTS.ts:88`. `TTS_VOICE` defaults to `af_heart` (`config.ts:218`), and the orchestrator injects old voice IDs (`AgentManager.ts:419`) | Stop sending `voiceId` from the pipeline so `ELEVENLABS_VOICES` is the single source of truth. Delete the dead `ttsVoice` / `TTS_VOICE` / `getVoiceForLanguage` plumbing | 2 |
| 8 | Agents re-speak same-language speech in 2-language rooms | `AgentManager.buildChildEnv` pins `SOURCE_LANGUAGE` to the other room language. The pipeline then sends that pin as DeepL `source_lang` (`TranslationPipeline.ts:252`), so DeepL echoes it back as `detected_source_language` and Guard 2 never fires. STT is also locked to that language (`:104`). STT never reports the language because `language_code` only exists on `committed_transcript_with_timestamps`, which needs `includeTimestamps: true` | Auto-detect STT (no `languageCode`), turn on `includeTimestamps`, and emit `committed` from the timestamped event with its `language_code`. Resolve the DeepL source **only** from the STT-detected language, otherwise `""` (auto) | 3 |
| 1 | A failed STT reconnect is never retried | `connect()` throws before `attachEventHandlers()`, so no CLOSE handler exists. The catch in `scheduleReconnect` (`ElevenLabsRealtimeSTT.ts:370-376`) only logs. An initial failure in `pipeline.start()` is also swallowed | On a non-intentional connect failure, `connect()` itself calls `scheduleReconnect()` (bounded) and rethrows | 4 |
| 2 | The reconnect cap never trips | `reconnectAttempts = 0` runs on every successful handshake (`:124`). A server that accepts and then closes loops forever at a 1 s delay | Reset the counter in the CLOSE handler, and only if the session lived at least `stableSessionMs` (10 s) | 4 |
| — | (found while reading) Reconnect is disabled after a stop/start | `intentionalClose` is set by `disconnect()` and never cleared | Clear it at the start of `connect()` | 4 |
| 3 | A dead pipeline still reports healthy | `TranslatorAgent.ts:457` hardcodes `pipelineHealthy = true`, and nothing listens for `stt_disconnected` | Add `TranslationPipeline.isHealthy()` (running, STT present, STT not given up). The agent uses it, and the watchdog already restarts on 503 (`HealthServer.ts:45`) | 5 |
| 4 | DeepL-only setups never start | `TranslatorAgent.ts:262-267` returns early without Mizan credentials | Remove the agent-level Mizan check. `ProviderFactory` already decides what each `TRANSLATION_PROVIDER` needs, so construction errors are surfaced instead | 5 |
| 5 | Legacy Mizan-only mode silently drops audio | With no ElevenLabs key or factory, the pipeline builds a `MizanClient` but has no STT | Fail loudly: pipeline construction throws without a factory. Delete the dead `MizanClient` path. A disabled pipeline counts as unhealthy | 5 |
| 9 | No limit on pending translations; waits never end | `waitForTokens` (`TranslationPipeline.ts:351-363`) polls with no deadline, cap, or stop check. Per-agent capacity is `12 / N` (`AgentManager.ts:301-313`), so with 5+ agents it drops below `FULL_PIPELINE = 3` and can never be satisfied | New `TokenWaitQueue`: FIFO, `maxPending` evicting the oldest, `maxWaitMs` deadline, `cancelAll()` on stop. Floor per-agent capacity at `FULL_PIPELINE` | 6 |
| 6 | The Mizan fallback is dead in auto-detect rooms | `MizanTranslation.supportsLanguagePair("", target)` only matches explicit pairs, so `FallbackTranslation.ts:122` throws | An empty source is supported whenever the target is (the Mizan prompt already renders `Unknown`) | 7 |
| 10 | `<think>` reasoning reaches TTS | `cleanTranslation` (`MizanTranslation.ts:273-298`) strips reasoning only when a full `<translate>…</translate>` pair exists | Always strip `<think>…</think>`, an unterminated `<think>…`, and stray `<translate>` tags. The pipeline skips TTS for an empty result | 8 |
| P2-a | Speaker labels never filled in | No producer passes `speakerId` | **No action.** Conversation context is off: `useConversationContext` defaults to `false` and is never set (`TranslationPipeline.ts:73`, not passed by the agent). Revisit if context is re-enabled | — |
| P2-b | Context recorded out of order | Concurrent `handleCommittedTranscript` calls | **No action**, for the same reason as P2-a | — |

**No longer applies (rewritten code):** adaptive max-chunk ratchet, CRITICAL load ordering, Urdu Devanagari replacement, empty-after-validate TTS call, unguarded CJK retry, chunk-floor/silence padding, TTS-retry duplicate turn (the retry loop is gone).

---

# Part B — Implementation plan

## Global Constraints

- Work on a new branch from `depl`: `fix/ultrareview-findings`. One commit per task. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No new runtime or dev dependencies. Tests use `node:test`, `node:assert/strict`, and `mock.timers` from `node:test`.
- Tests live in `test/` (outside `rootDir: ./src`, so `tsc` does not emit them) and are named `*.test.ts`.
- Test command: `npm test`, defined as `TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register --test "test/**/*.test.ts"`. This was verified working on Node v24.11.1.
- `npm run build` must stay green after every task.
- Match the surrounding style: `createLogger(...)` per module, structured log metadata, and doc comments on public methods.
- Leave `SOURCE_LANGUAGE` / `AgentManager.buildChildEnv` source computation alone. After Task 3 the pipeline no longer reads it, and removing it is out of scope.

## Review Focus

1. **STT reports Urdu for Hindi speech (or the reverse) in an hi+ur room.** Expect: the agent whose target matches the reported language stays silent. Test in Task 3 (`skips when STT reports target language in ISO-639-3`).
2. **STT omits `language_code` entirely.** Expect: the DeepL source is `""` (auto). If DeepL then reports the target language, nothing is spoken. Test in Task 3.
3. **`stop()` while sentences are waiting for tokens.** Expect: every waiter resolves `false`, no timer stays scheduled, and nothing is translated. Test in Task 6.
4. **The server accepts and then closes immediately, forever (quota or auth).** Expect: exactly `maxReconnectAttempts` reconnects, then a single `close`. Test in Task 4.
5. **A Mizan reply that is only `<think>…` (cut off).** Expect: no TTS call, and the sentence is not counted as a circuit-breaker failure. Test in Task 8.

---

### Task 1: Remove hardcoded Mizan credentials

**Files:**
- Modify: `scripts/update-templates.ts:16-21`

**Interfaces:** none.

- [ ] **Step 1: Rotate the Mizan password (manual, user).** Do this first. The value is already public on `origin/depl` and 9 feature branches, so the code change alone does not contain the leak.
- [ ] **Step 2: Replace the fallbacks.** `MIZAN_USERNAME` and `MIZAN_PASSWORD` read from `process.env` only. If either is empty, `console.error("MIZAN_USERNAME and MIZAN_PASSWORD must be set")` and `process.exit(1)` before `authHeader` is built. Keep the `MIZAN_BASE_URL` default; it is not a secret.
- [ ] **Step 3: Verify.**
  Run: `grep -n "Tf0139\|cloudclinic" scripts/update-templates.ts; env -u MIZAN_USERNAME -u MIZAN_PASSWORD npx ts-node scripts/update-templates.ts; echo $?`
  Expected: grep prints nothing, the script prints the error, and the exit code is `1`.
- [ ] **Step 4: Commit.** `git commit -m "fix(security): drop hardcoded Mizan credentials from template script"`
- [ ] **Step 5 (optional, user decision):** purge the history with `git filter-repo --replace-text` and force-push every branch. This rewrites shared history, so coordinate with anyone who has clones.

---

### Task 2: Test harness and TTS voice fix

**Files:**
- Modify: `package.json` (add a `test` script)
- Create: `test/helpers/fakes.ts`
- Create: `test/TranslationPipeline.voice.test.ts`
- Modify: `src/mizan/TranslationPipeline.ts:28,59,315-320,365-380`
- Modify: `src/agent/TranslatorAgent.ts:285`
- Modify: `src/orchestrator/AgentManager.ts:419` (drop the `TTS_VOICE` line and the now-unused `TranslationPipeline` import, if nothing else uses it)
- Modify: `src/config.ts:94,218`, `src/orchestrator/OrchestratorConfig.ts:38,95`, `.env.example:107` (remove `ttsVoice` / `TTS_VOICE`)

**Interfaces:**
- Produces, in `test/helpers/fakes.ts`, the following for Tasks 3, 5, 6 and 8:
  - `class FakeSTT extends EventEmitter` with `name = "fake-stt"`, `connect = async () => {}`, `sendAudio(_: string) {}`, `disconnect() {}`, and `lastOptions?: { languageCode?: string; instanceId?: string }`.
  - `makeFakeFactory(opts?: { translate?: (req: TranslationRequest) => Promise<TranslationResponse>; synthesize?: (req: TTSRequest) => Promise<TTSResponse> }): { factory: ProviderFactory; stt: FakeSTT; translateCalls: TranslationRequest[]; ttsCalls: TTSRequest[] }`. The defaults translate to `{ text: "translated", detectedSourceLanguage: undefined }` and synthesize `{ audioBuffer: new ArrayBuffer(4) }`. `getSTTProvider(type, options)` records `options` on `stt.lastOptions`. Return the object cast with `as unknown as ProviderFactory`.
  - `flush(): Promise<void>`, which awaits `setImmediate` three times so fire-and-forget handlers settle.
- After this task `TranslationPipelineConfig` has no `ttsVoice` field.

- [ ] **Step 1: Add the script.** `"test": "TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register --test \"test/**/*.test.ts\""`.
- [ ] **Step 2: Write the fakes** (as specified under Interfaces), then the failing test:

```ts
test("TTS request carries no voiceId so ELEVENLABS_VOICES decides", async () => {
  const { factory, stt, ttsCalls } = makeFakeFactory();
  const p = new TranslationPipeline({ providerFactory: factory, useElevenLabs: true, targetLanguage: "hi" });
  await p.start();
  stt.emit("committed", { text: "how are you feeling today", language: "eng" });
  await flush();
  assert.equal(ttsCalls.length, 1);
  assert.equal(ttsCalls[0].voiceId, undefined);
  assert.equal(ttsCalls[0].language, "hi");
  p.stop();
});
```

- [ ] **Step 3: Run it.** `npm test`. Expected: FAIL, because `voiceId` is `"EXAVITQu4vr4xnSDxMaL"`.
- [ ] **Step 4: Implement.** Remove `voiceId` from the `synthesize` call. Delete the `ttsVoice` field and its default, `static getVoiceForLanguage`, the agent's `ttsVoice:` line, `TTS_VOICE` in `buildChildEnv`, and `ttsVoice` in both configs and `.env.example`. Then `grep -rn "ttsVoice\|TTS_VOICE\|getVoiceForLanguage" src .env.example` must print nothing.
- [ ] **Step 5: Run.** `npm test && npm run build`. Expected: PASS, and the build is clean.
- [ ] **Step 6: Commit.** `git commit -m "fix(tts): let ELEVENLABS_VOICES pick the voice; drop Mizan-era TTS_VOICE"`

---

### Task 3: Real language detection; stop pinning the source language

**Files:**
- Modify: `src/providers/elevenlabs/ElevenLabsRealtimeSTT.ts:107-120,218-239`
- Modify: `src/mizan/TranslationPipeline.ts:100-107,234-261`
- Create: `test/ElevenLabsRealtimeSTT.test.ts`
- Create: `test/TranslationPipeline.language.test.ts`

**Interfaces:**
- Consumes: `makeFakeFactory`, `flush` (Task 2).
- Produces, for Task 4: in `test/ElevenLabsRealtimeSTT.test.ts`, a local helper `makeSTT(connectImpl: () => Promise<FakeConnection>): ElevenLabsRealtimeSTT`. It builds the provider with `apiKey: "k"` and replaces the private client via `(stt as any).client = { speechToText: { realtime: { connect: connectImpl } } }`. `FakeConnection` is an `EventEmitter` with `send() {}`, `commit() {}`, `close() { this.emit(RealtimeEvents.CLOSE, {}) }`, plus `lastConnectArgs` captured by the helper.
- Behaviour contract: `committed` is emitted **once per segment**, from `COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS`, with `language: data.language_code ?? ""`. The plain `COMMITTED_TRANSCRIPT` event only updates `lastCommittedText` and logs.

- [ ] **Step 1: Write the failing STT tests.**

```ts
test("connects with includeTimestamps and no languageCode when none configured", async () => {
  // makeSTT(...) with no languageCode; await stt.connect()
  assert.equal(conn.lastConnectArgs.includeTimestamps, true);
  assert.equal("languageCode" in conn.lastConnectArgs, false);
});
test("emits committed once, with language from the timestamped event", async () => {
  // conn.emit(COMMITTED_TRANSCRIPT, {text:"hello"}); conn.emit(COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, {text:"hello", language_code:"eng"})
  assert.deepEqual(events, [{ text: "hello", language: "eng" }]);
});
```

- [ ] **Step 2: Write the failing pipeline tests** (`sourceLanguage: "hi", targetLanguage: "en"`, i.e. the 2-language-room config):

```ts
test("does not pin STT language", ...)                      // stt.lastOptions.languageCode === undefined
test("passes STT-detected language to translation", ...)    // emit language "hin" → translateCalls[0].sourceLanguage === "hi"
test("uses auto-detect when STT gives no language", ...)    // emit language "" → translateCalls[0].sourceLanguage === ""
test("skips when STT reports target language in ISO-639-3", ...) // emit "eng" → translateCalls.length === 0, ttsCalls.length === 0
test("discards when DeepL detects target language", ...)    // language "", translate returns detectedSourceLanguage "EN" → ttsCalls.length === 0
```

- [ ] **Step 3: Run.** `npm test`. Expected: the new tests FAIL (the STT is pinned, the source is `"hi"`, and `committed` fires from the wrong event).
- [ ] **Step 4: Implement the STT side.** Add `includeTimestamps: true` to the `realtime.connect` options. Move the `emit("committed", …)` into the `COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS` handler, using `data.language_code ?? ""` and dropping both `@ts-ignore`s. The plain handler keeps caching `lastCommittedText`.
- [ ] **Step 5: Implement the pipeline side.** Call `getSTTProvider("elevenlabs", { instanceId: this.config.targetLanguage })` with no `languageCode`. Replace lines 247-261 with `const resolvedSourceLanguage = mappedLang;` (Guard 1 already returns when `mappedLang === targetLanguage`). Rewrite the comment to explain why `config.sourceLanguage` is not used: pinning it makes DeepL echo it and defeats Guard 2. Make `mapLanguageCode` lowercase its input, because DeepL returns `"EN"`.
- [ ] **Step 6: Run.** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 7: Commit.** `git commit -m "fix(stt): auto-detect language and stop pinning DeepL source to avoid same-language echo"`

---

### Task 4: Reliable STT reconnect

**Files:**
- Modify: `src/providers/elevenlabs/ElevenLabsRealtimeSTT.ts:41-58,95-133,282-301,342-378`
- Test: `test/ElevenLabsRealtimeSTT.test.ts` (extend)

**Interfaces:**
- Consumes: `makeSTT` / `FakeConnection` (Task 3).
- Produces: a new config field `stableSessionMs?: number` (default `10_000`) in `ElevenLabsRealtimeConfig` and `DEFAULTS`. A session that stays open at least this long resets the attempt counter when it closes. Unchanged event contract: `close` is emitted exactly once when giving up, and `reconnected` after each successful reconnect.

- [ ] **Step 1: Write the failing tests.** Use `mock.timers.enable({ apis: ["setTimeout", "Date"] })` and `config { maxReconnectAttempts: 3, reconnectDelayMs: 1000 }`.

```ts
test("retries after a failed reconnect handshake", ...)
// connect ok → conn.close() → connect now rejects twice then resolves; tick through delays
// assert connect call count === 4 and one "reconnected" event, zero "close"
test("initial connect failure schedules a retry", ...)
// connect rejects once then resolves; await assert.rejects(stt.connect()); tick 1000 → stt.isConnected() === true
test("open-then-close loop gives up after maxReconnectAttempts", ...)
// every connect resolves a conn that the test closes immediately (elapsed < stableSessionMs)
// assert connect calls === 1 + 3 and closeEvents === 1
test("a session longer than stableSessionMs resets the attempt budget", ...)
// close after tick(11_000) four times → never emits "close"
test("connect after disconnect re-enables reconnect", ...)
// connect, disconnect, connect, conn.close() → a reconnect is scheduled (connect calls increase after tick)
```

- [ ] **Step 2: Run.** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `connect()`: set `this.intentionalClose = false` first. In the catch, if not intentional, call `this.scheduleReconnect()` and then rethrow.
  - Remove `this.reconnectAttempts = 0` from `connect()`. Record `this.connectedAt = Date.now()`.
  - CLOSE handler: if `Date.now() - this.connectedAt >= this.config.stableSessionMs`, reset `reconnectAttempts = 0` before `scheduleReconnect()`.
  - `scheduleReconnect()` timer: `await this.connect()` then emit `reconnected`. The catch only logs, because `connect()` has already scheduled the next attempt. Fix the misleading comment.
  - Guard: `scheduleReconnect()` returns early if a `reconnectTimer` is already pending.
- [ ] **Step 4: Run.** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix(stt): retry failed reconnects and bound open-then-close loops"`

---

### Task 5: Honest pipeline health and provider-driven setup

**Files:**
- Create: `src/agent/createTranslationPipeline.ts`
- Modify: `src/agent/TranslatorAgent.ts:240-287,457`
- Modify: `src/mizan/TranslationPipeline.ts` (constructor `:96-143`, `start`, `handleSTTClose`, `handleSTTReconnected`, and remove the `mizan` config and `mizanClient`)
- Delete: `src/mizan/MizanClient.ts` and its export in `src/mizan/index.ts` (verify with `grep -rn MizanClient src` that nothing else imports it)
- Test: `test/TranslationPipeline.health.test.ts`, `test/createTranslationPipeline.test.ts`

**Interfaces:**
- Consumes: `makeFakeFactory`, `FakeSTT`, `flush` (Task 2).
- Produces:
  - `TranslationPipeline.isHealthy(): boolean`. True iff `isRunning`, an STT provider exists, and STT has not emitted `close` since the last `reconnected`.
  - The `TranslationPipeline` constructor throws `Error("TranslationPipeline requires a ProviderFactory (ELEVENLABS_API_KEY not set?)")` when `providerFactory` is missing. The `useElevenLabs` config field is removed.
  - `createTranslationPipeline(config: AgentConfig, getFactory: () => ProviderFactory): { pipeline: TranslationPipeline } | { error: string }` in `src/agent/createTranslationPipeline.ts`. It returns `{ error }` when `config.elevenLabsApiKey` is empty, when `getFactory()` throws, or when `getTranslationProvider()` throws (e.g. `TRANSLATION_PROVIDER=mizan` without credentials). It does **not** check Mizan credentials itself. It maps the remaining `AgentConfig` fields onto `TranslationPipelineConfig` exactly as `TranslatorAgent.ts:282-294` does today, minus `mizan` and `ttsVoice`.

- [ ] **Step 1: Write the failing tests.**

```ts
// health
test("healthy after start", ...)                 // p.isHealthy() === true
test("unhealthy after STT gives up", ...)        // stt.emit("close") → false
test("healthy again after reconnect", ...)       // emit close then reconnected → true
test("unhealthy after stop", ...)
test("constructor throws without a factory", () => assert.throws(() => new TranslationPipeline({}), /requires a ProviderFactory/));
// setup
test("DeepL-only config builds a pipeline without Mizan creds", ...)  // mizanUsername "", fake factory → "pipeline" in result
test("missing ElevenLabs key returns error", ...)                     // /ELEVENLABS_API_KEY/
test("factory translation-provider error is surfaced", ...)           // getTranslationProvider throws "Mizan credentials not configured" → error matches
```

- [ ] **Step 2: Run.** `npm test`. Expected: FAIL (`isHealthy` and `createTranslationPipeline` don't exist yet).
- [ ] **Step 3: Implement the pipeline changes.** Add a `sttGaveUp` flag: `handleSTTClose` sets it, and `handleSTTReconnected` clears it. Add `isHealthy()`. The constructor throws without a factory, and the legacy branch, `mizanClient` and `mizan` config are removed. In `start()`, the catch around `connect()` stays as a log; Task 4 makes the STT retry by itself.
- [ ] **Step 4: Implement `createTranslationPipeline`** and call it from `initializeTranslationPipeline`. On `{ error }`, `logger.error("Translation pipeline disabled", { error })` and return. In `getHealth`, use `const pipelineHealthy = this.translationPipeline?.isHealthy() ?? false;`.
- [ ] **Step 5: Run.** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "fix(agent): report real pipeline health; let ProviderFactory decide required credentials"`

---

### Task 6: Bounded token waits and a usable per-agent capacity

**Files:**
- Create: `src/mizan/TokenWaitQueue.ts`
- Create: `src/orchestrator/rateLimit.ts`
- Modify: `src/mizan/TranslationPipeline.ts` (replace `waitForTokens` `:351-363`, and its call at `:271`; call `cancelAll()` in `stop()`)
- Modify: `src/orchestrator/AgentManager.ts:301-313`
- Modify: `src/mizan/index.ts` (export `TokenWaitQueue`)
- Test: `test/TokenWaitQueue.test.ts`, `test/rateLimit.test.ts`, `test/TranslationPipeline.backpressure.test.ts`

**Interfaces:**
- Consumes: `TokenBucket` (`tryAcquire(n): { acquired: boolean; waitTimeMs?: number }`, `getMetrics().capacity`), `MIZAN_TOKEN_COSTS.FULL_PIPELINE` (= 3).
- Produces:
  - `export interface TokenWaitQueueConfig { maxPending: number; maxWaitMs: number }`
  - `export class TokenWaitQueue { constructor(bucket: TokenBucket, config: TokenWaitQueueConfig); acquire(amount: number): Promise<boolean>; cancelAll(): void; get pendingCount(): number }`. `acquire` resolves `false` when the request is dropped.
  - `export function computePerAgentRateLimit(globalCapacity: number, globalRefillRate: number, activeCount: number): { capacity: number; refillRate: number }`. Capacity is `max(globalCapacity / activeCount, MIZAN_TOKEN_COSTS.FULL_PIPELINE)` and refill rate is `globalRefillRate / activeCount`.
  - New pipeline config fields `maxPendingSentences` (default `12`, the old `maxQueueLength`) and `maxTokenWaitMs` (default `10_000`). The agent passes `config.maxQueueLength` for the first.

**Queue algorithm** (not fixed by the signature):

- `acquire`: if `amount > capacity`, warn and resolve `false`. If nothing is queued and `tryAcquire` succeeds, resolve `true`. Otherwise enqueue `{ amount, deadline: now + maxWaitMs, resolve }`; if the queue is now longer than `maxPending`, shift and resolve the oldest `false`; then ensure a pump is scheduled.
- Pump: drop and resolve `false` every head whose deadline has passed. While the head's `tryAcquire` succeeds, shift and resolve `true`. If entries remain, reschedule at `min(waitTimeMs, head.deadline - now)`.
- `cancelAll`: clear the timer and resolve every entry `false`.

- [ ] **Step 1: Write the failing tests.** Use `mock.timers` with `setTimeout` and `Date`, and a bucket of `{ capacity: 3, refillRate: 1 }`.

```ts
test("resolves true immediately when tokens available", ...)
test("FIFO: later waiter is not served before earlier", ...)
test("evicts oldest when maxPending exceeded", ...)        // maxPending 2, three waiters → first resolves false
test("times out after maxWaitMs", ...)                      // tick(maxWaitMs+1) → false
test("amount above capacity resolves false at once", ...)
test("cancelAll resolves all pending false and leaves no timers", ...)  // pendingCount === 0
test("computePerAgentRateLimit floors capacity at FULL_PIPELINE", () => {
  assert.deepEqual(computePerAgentRateLimit(12, 12, 5), { capacity: 3, refillRate: 2.4 });
  assert.deepEqual(computePerAgentRateLimit(12, 12, 2), { capacity: 6, refillRate: 6 });
});
test("pipeline stop() drops waiting sentences without translating", ...) // capacity 3, emit 3 committed, stop, flush → translateCalls.length === 1
```

- [ ] **Step 2: Run.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `TokenWaitQueue`, `computePerAgentRateLimit`, and the pipeline wiring. When `acquire` returns `false`: `logger.warn("Dropping sentence under backpressure", …)`, return, and do not count it as a circuit-breaker failure. `broadcastRateLimitUpdate` uses `computePerAgentRateLimit`.
- [ ] **Step 4: Run.** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix(pipeline): bound token waits and floor per-agent capacity at one sentence"`

---

### Task 7: Mizan fallback accepts auto-detected source

**Files:**
- Modify: `src/providers/mizan/MizanTranslation.ts` (`supportsLanguagePair`)
- Test: `test/FallbackTranslation.test.ts`

**Interfaces:**
- Produces: `MizanTranslation.supportsLanguagePair("", target)` returns `true` iff some supported pair has that `target`. This also makes `FallbackTranslation.supportsLanguagePair("", target)` true through its union.

- [ ] **Step 1: Write the failing tests.** The primary is a stub `ITranslationProvider` whose `supportsLanguagePair` returns true and whose `translate` rejects. The secondary is a real `new MizanTranslation({ username: "u", password: "p" })` with `translate` stubbed on the instance.

```ts
test("falls back to Mizan when DeepL fails and source is auto", async () => {
  const r = await new FallbackTranslation(primary, mizan).translate({ text: "x", sourceLanguage: "", targetLanguage: "en" });
  assert.equal(r.text, "fallback");
});
test("Mizan rejects auto source for unsupported target", () => assert.equal(mizan.supportsLanguagePair("", "fr"), false));
```

- [ ] **Step 2: Run.** `npm test`. Expected: the first test FAILS with "Neither … supports".
- [ ] **Step 3: Implement** the `source === ""` branch in `supportsLanguagePair`.
- [ ] **Step 4: Run.** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix(translation): allow Mizan fallback for auto-detected source language"`

---

### Task 8: Never speak model reasoning

**Files:**
- Modify: `src/providers/mizan/MizanTranslation.ts:270-298` (extract the logic into an exported pure function; `cleanTranslation` delegates to it)
- Modify: `src/mizan/TranslationPipeline.ts` (skip empty results before TTS)
- Test: `test/cleanTranslationOutput.test.ts`, `test/TranslationPipeline.empty.test.ts`

**Interfaces:**
- Produces: `export function cleanTranslationOutput(text: string): string` in `MizanTranslation.ts`.

- [ ] **Step 1: Write the failing tests.**

```ts
const cases: Array<[string, string]> = [
  ["<think>r</think><translate>Hello</translate>", "Hello"],          // unchanged behaviour
  ["<think>r</think><translate>Hello", "Hello"],                      // missing close
  ["<think>r</think>Hello", "Hello"],                                 // no translate tags
  ["<think>reasoning cut off mid", ""],                               // unterminated think
  ["Hello</translate>", "Hello"],                                     // stray close
  ["Translation: \"Hello\"", "Hello"],                                // existing label + quote stripping kept
];
for (const [input, expected] of cases) test(`clean: ${input}`, () => assert.equal(cleanTranslationOutput(input), expected));

test("pipeline skips TTS and does not record failure on empty translation", ...)
// translate resolves { text: "  " } → ttsCalls.length === 0 and p.getMetrics().failed === 0
```

- [ ] **Step 2: Run.** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** First remove `/<think>[\s\S]*?(<\/think>|$)/gi`. Then, if a full `<translate>` pair exists, extract it. Otherwise strip `/<\/?translate>/gi` and apply the existing marker, label and reference cleanup. Quote stripping and the final trim run last. In the pipeline, after Guard 2: `if (!translationResult.text.trim()) { logger.debug(...); return; }`.
- [ ] **Step 4: Run.** `npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix(mizan): always strip <think> reasoning; skip empty translations"`

---

## Done criteria

- `npm test` and `npm run build` are green on `fix/ultrareview-findings`.
- `grep -rn "Tf0139\|ttsVoice\|TTS_VOICE\|MizanClient\|pipelineHealthy = true" src scripts .env.example` prints nothing.
- Manual smoke test in an en+hi room: English speech is spoken only by `translator-hi`, Hindi speech only by `translator-en`, and each uses its `ELEVENLABS_VOICES` voice.
