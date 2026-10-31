/**
 * Translation Pipeline Orchestrator (Phase 7.2)
 *
 * Coordinates the streaming translation pipeline:
 * Audio Stream → Scribe Realtime (STT) → Translation (Mizan) → TTS (ElevenLabs) → Audio Output
 */

import { EventEmitter } from "events";
import { createLogger } from "../logger";
import { TokenBucket, MIZAN_TOKEN_COSTS } from "./TokenBucket";
import { TokenWaitQueue } from "./TokenWaitQueue";
import { CircuitBreaker, CircuitState } from "./CircuitBreaker";
import { ConversationContext } from "./ConversationContext";
import {
  IRealtimeSTTProvider,
  ITranslationProvider,
  ITTSProvider,
  ProviderFactory,
} from "../providers";

const logger = createLogger("TranslationPipeline");

export interface TranslationPipelineConfig {
  sourceLanguage: string;
  targetLanguage: string;
  translationTemplatePattern: string;
  ttsSpeed: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  maxRetries: number;
  tokenBucketCapacity: number;
  tokenBucketRefillRate: number;
  /** Sentences allowed to wait for tokens; the oldest is dropped beyond this. */
  maxPendingSentences: number;
  /** A sentence that cannot get tokens within this long is dropped. */
  maxTokenWaitMs: number;
  circuitBreakerErrorThreshold: number;
  circuitBreakerWindowMs: number;
  circuitBreakerOpenTimeoutMs: number;
  providerFactory?: ProviderFactory;
  contextWindowSize: number;
  contextStalenessMs: number;
  /**
   * When true, conversation context (prior turns) is injected into the
   * translation request. Should only be enabled when using Mizan LLM
   * (which benefits from context for pronoun resolution).
   *
   * IMPORTANT: Must be false (default) when using DeepL as the translation
   * provider — DeepL doesn't use context and the history injection that
   * was causing output to include prior conversation turns.
   */
  useConversationContext: boolean;
}

export const DEFAULT_PIPELINE_CONFIG: TranslationPipelineConfig = {
  sourceLanguage: "en",
  targetLanguage: "hi",
  translationTemplatePattern: "translator_{target}",
  ttsSpeed: 1,
  retryInitialDelayMs: 500,
  retryMaxDelayMs: 8000,
  maxRetries: 3,
  tokenBucketCapacity: 8,
  tokenBucketRefillRate: 8,
  maxPendingSentences: 12,
  maxTokenWaitMs: 10_000,
  circuitBreakerErrorThreshold: 0.1,
  circuitBreakerWindowMs: 60000,
  circuitBreakerOpenTimeoutMs: 10000,
  providerFactory: undefined,
  contextWindowSize: 5,
  contextStalenessMs: 30000,
  useConversationContext: false,
};

export class TranslationPipeline extends EventEmitter {
  private config: TranslationPipelineConfig;
  private tokenBucket: TokenBucket;
  private tokenWaitQueue: TokenWaitQueue;
  private circuitBreaker: CircuitBreaker;

  private sttProvider: IRealtimeSTTProvider | null = null;
  private translationProvider: ITranslationProvider | null = null;
  private ttsProvider: ITTSProvider | null = null;

  private isRunning: boolean = false;
  /** True once STT exhausted its reconnect attempts; cleared on reconnect. */
  private sttGaveUp: boolean = false;
  private conversationContext: ConversationContext;

  private totalSentencesProcessed: number = 0;
  private totalSentencesFailed: number = 0;

  private onAudioReady:
    | ((audio: ArrayBuffer, sentenceId: string) => void)
    | null = null;

  constructor(config: Partial<TranslationPipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };

    const providerFactory = this.config.providerFactory;
    if (!providerFactory) {
      throw new Error(
        "TranslationPipeline requires a ProviderFactory (ELEVENLABS_API_KEY not set?)",
      );
    }

    this.sttProvider = providerFactory.getSTTProvider(
      "elevenlabs",
      {
        // No languageCode: one agent hears every participant, so STT must
        // auto-detect rather than be pinned to a single language.
        instanceId: this.config.targetLanguage,
      },
    );
    this.translationProvider = providerFactory.getTranslationProvider();
    this.ttsProvider = providerFactory.getTTSProvider("elevenlabs");

    // Hook up STT events
    this.sttProvider.on(
      "committed",
      (data: { text: string; language: string }) =>
        this.handleCommittedTranscript(data.text, data.language),
    );
    this.sttProvider.on("error", (err: any) =>
      logger.error("STT Provider Error", { error: err }),
    );
    this.sttProvider.on("close", () => this.handleSTTClose());
    this.sttProvider.on("reconnected", () => this.handleSTTReconnected());

    this.tokenBucket = new TokenBucket({
      capacity: this.config.tokenBucketCapacity,
      refillRate: this.config.tokenBucketRefillRate,
    });

    this.tokenWaitQueue = new TokenWaitQueue(this.tokenBucket, {
      maxPending: this.config.maxPendingSentences,
      maxWaitMs: this.config.maxTokenWaitMs,
    });

    this.circuitBreaker = new CircuitBreaker({
      errorThreshold: this.config.circuitBreakerErrorThreshold,
      errorWindowMs: this.config.circuitBreakerWindowMs,
      openTimeoutMs: this.config.circuitBreakerOpenTimeoutMs,
    });

    this.conversationContext = new ConversationContext({
      windowSize: this.config.contextWindowSize,
      stalenessMs: this.config.contextStalenessMs,
    });
  }

  setOnAudioReady(
    callback: (audio: ArrayBuffer, sentenceId: string) => void,
  ): void {
    this.onAudioReady = callback;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.sttProvider) {
      try {
        await this.sttProvider.connect();
        logger.info("TranslationPipeline started with Realtime STT");
      } catch (err) {
        logger.error("Failed to connect to Realtime STT", {
          error: String(err),
        });
      }
    }
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    // Release every sentence still waiting for tokens.
    this.tokenWaitQueue.cancelAll();

    if (this.sttProvider) {
      this.sttProvider.disconnect();
    }
    this.conversationContext.reset();
  }

  /**
   * Healthy while running with a live (or still-reconnecting) STT session.
   * Turns false once STT has exhausted its reconnect attempts.
   */
  isHealthy(): boolean {
    return this.isRunning && this.sttProvider !== null && !this.sttGaveUp;
  }

  /** True once STT has permanently given up (not merely not started). */
  hasFailed(): boolean {
    return this.sttGaveUp;
  }

  private handleSTTClose(): void {
    this.sttGaveUp = true;
    logger.warn("STT connection closed permanently", {
      processed: this.totalSentencesProcessed,
      failed: this.totalSentencesFailed,
    });
    // Emit event so TranslatorAgent can handle if needed
    this.emit("stt_disconnected");
  }

  private handleSTTReconnected(): void {
    this.sttGaveUp = false;
    logger.info("STT connection restored", {
      processed: this.totalSentencesProcessed,
      failed: this.totalSentencesFailed,
    });
    // Emit event so TranslatorAgent knows translation can resume
    this.emit("stt_reconnected");
  }

  submitAudio(base64Audio: string): void {
    if (!this.isRunning) return;
    if (this.sttProvider) {
      this.sttProvider.sendAudio(base64Audio);
    }
  }

  private async handleCommittedTranscript(
    text: string,
    detectedLanguage: string,
  ): Promise<void> {
    if (!text.trim()) return;

    // Filter out filler words like "yeah", "um" if they are the only words
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length < 3) {
      const FILLERS = new Set([
        "yeah",
        "um",
        "uh",
        "okay",
        "ok",
        "hmm",
        "hm",
        "ah",
        "oh",
        "right",
        "so",
        "like",
        "well",
        "mhm",
        "mm",
        "mh",
      ]);
      if (words.every((w) => FILLERS.has(w.toLowerCase()))) {
        return;
      }
    }

    // Map the detected language code (e.g. "hin" → "hi", "eng" → "en")
    const mappedLang = this.mapLanguageCode(detectedLanguage || "");

    // Guard 1: If STT reliably detected the language and it matches target, skip.
    if (mappedLang && mappedLang === this.config.targetLanguage) {
      logger.debug("Detected language matches target, skipping translation", {
        detectedLanguage,
        mappedLang,
        targetLanguage: this.config.targetLanguage,
      });
      return;
    }

    // The source language comes only from what STT detected (empty = let
    // DeepL auto-detect). config.sourceLanguage is deliberately NOT used:
    // DeepL echoes a pinned source_lang back as detected_source_language, which
    // defeats Guard 2 and makes the agent re-speak same-language speech.
    const resolvedSourceLanguage = mappedLang;

    const sentenceId = `sent_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    try {
      if (!this.circuitBreaker.allowRequest()) {
        logger.warn("Circuit breaker open, dropping sentence", { text });
        return;
      }

      const gotTokens = await this.tokenWaitQueue.acquire(
        MIZAN_TOKEN_COSTS.FULL_PIPELINE,
      );
      if (!gotTokens || !this.isRunning) {
        // Dropped under backpressure or the pipeline stopped. This is load
        // shedding, not a provider failure, so the circuit breaker is untouched.
        logger.warn("Dropping sentence under backpressure", {
          text,
          pending: this.tokenWaitQueue.pendingCount,
        });
        return;
      }

      let translationResult;

      if (this.translationProvider) {
        // Only inject conversation context when explicitly enabled.
        // With DeepL as the primary provider, context is not used and
        // injecting it was causing the LLM fallback to echo prior turns.
        const conversationContext = this.config.useConversationContext
          ? this.conversationContext.getContextBlock()
          : undefined;

        translationResult = await this.translationProvider.translate({
          text,
          sourceLanguage: resolvedSourceLanguage,
          targetLanguage: this.config.targetLanguage,
          conversationContext,
        });
      } else {
        throw new Error("No translation provider available");
      }

      // Guard 2: Post-translation check — if DeepL detected that the source
      // language is actually the same as the target, discard the result.
      // This handles the case where a speaker uses the target language itself.
      if (
        translationResult.detectedSourceLanguage &&
        this.mapLanguageCode(translationResult.detectedSourceLanguage) ===
          this.config.targetLanguage
      ) {
        logger.debug(
          "Post-translation: detected source matches target, discarding",
          {
            detectedSourceLanguage: translationResult.detectedSourceLanguage,
            targetLanguage: this.config.targetLanguage,
          },
        );
        return;
      }

      this.conversationContext.addTurn(text, translationResult.text);

      let audioBuffer;
      if (this.ttsProvider) {
        const ttsResult = await this.ttsProvider.synthesize({
          text: translationResult.text,
          language: this.config.targetLanguage,
          speed: this.config.ttsSpeed,
        });
        audioBuffer = ttsResult.audioBuffer;
      }

      this.circuitBreaker.recordSuccess();
      this.totalSentencesProcessed++;

      if (this.onAudioReady && audioBuffer) {
        this.onAudioReady(audioBuffer, sentenceId);
      }
    } catch (err) {
      this.circuitBreaker.recordFailure();
      this.totalSentencesFailed++;
      logger.error("Error processing committed transcript", {
        error: String(err),
      });
    }
  }

  private mapLanguageCode(code: string): string {
    const codeMap: Record<string, string> = {
      hin: "hi",
      eng: "en",
      urd: "ur",
      ara: "ar",
      tr: "tr",
      fra: "fr",
    };
    const normalized = code.toLowerCase();
    return codeMap[normalized] || normalized;
  }

  getMetrics() {
    return {
      processed: this.totalSentencesProcessed,
      failed: this.totalSentencesFailed,
    };
  }

  getTokenBucket() {
    return this.tokenBucket;
  }
}
