/**
 * Translation Pipeline Orchestrator (Phase 4 / Updated Phase 7.1)
 *
 * Coordinates the full translation pipeline:
 * Audio Chunk → STT → Translation → TTS → Audio Output
 *
 * Provider Support (Phase 7.1):
 * - STT: ElevenLabs (Scribe v2) or Mizan
 * - Translation: Mizan (template-based)
 * - TTS: ElevenLabs (streaming) or Mizan
 *
 * Features:
 * - Rate limiting via TokenBucket
 * - Circuit breaker for fault tolerance
 * - Priority queue for chunk processing
 * - Adaptive chunking based on load
 * - Retry with exponential backoff
 * - Comprehensive metrics and monitoring
 *
 * Key parameters (from implementation plan):
 * - Retry/backoff: 500ms initial, max 8s, max 3 retries per chunk
 * - Pipeline token cost: 3 tokens (STT + Translation + TTS)
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../logger";
import { AudioChunk } from "../audio/ChunkAggregator";
import {
  MizanClient,
  MizanConfig,
  MizanError,
  TTSLanguageCode,
} from "./MizanClient";
import { TokenBucket, MIZAN_TOKEN_COSTS } from "./TokenBucket";
import {
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
} from "./CircuitBreaker";
import { ChunkQueue, QueuedChunk } from "./ChunkQueue";
import {
  ISTTProvider,
  ITranslationProvider,
  ITTSProvider,
  ProviderError,
  ProviderFactory,
  getVoiceConfig,
} from "../providers";

const logger = createLogger("TranslationPipeline");

/**
 * Translation pipeline configuration.
 */
export interface TranslationPipelineConfig {
  // Mizan API configuration (for legacy mode or translation-only)
  mizan: Partial<MizanConfig>;

  // Source language (what is being spoken)
  sourceLanguage: string;

  // Target language (what to translate to)
  targetLanguage: string;

  // Translation template name pattern
  translationTemplatePattern: string;

  // TTS voice to use (legacy Mizan mode)
  ttsVoice: string;

  // TTS speed (0.25-4)
  ttsSpeed: number;

  // Retry configuration
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  maxRetries: number;

  // Pipeline processing
  processIntervalMs: number;

  // Token bucket configuration
  tokenBucketCapacity: number;
  tokenBucketRefillRate: number;

  // Circuit breaker configuration
  circuitBreakerErrorThreshold: number;
  circuitBreakerWindowMs: number;
  circuitBreakerOpenTimeoutMs: number;

  // Queue configuration
  maxQueueLength: number;
  maxInFlight: number;

  // Debug configuration
  debugMode: boolean;
  debugOutputDir: string;

  // Provider configuration (Phase 7.1)
  /** Provider factory for ElevenLabs+Mizan mode */
  providerFactory?: ProviderFactory;
  /** Use ElevenLabs for STT/TTS (true) or Mizan for all (false) */
  useElevenLabs?: boolean;
}

/**
 * Default pipeline configuration per Phase 4 spec.
 */
export const DEFAULT_PIPELINE_CONFIG: TranslationPipelineConfig = {
  mizan: {},
  sourceLanguage: "en",
  targetLanguage: "hi",
  translationTemplatePattern: "translator_{target}",
  ttsVoice: "hm_psi",
  ttsSpeed: 1,
  retryInitialDelayMs: 500,
  retryMaxDelayMs: 8000,
  maxRetries: 3,
  processIntervalMs: 100,
  tokenBucketCapacity: 8,
  tokenBucketRefillRate: 8,
  circuitBreakerErrorThreshold: 0.1,
  circuitBreakerWindowMs: 60000,
  circuitBreakerOpenTimeoutMs: 10000,
  maxQueueLength: 12,
  maxInFlight: 2,
  debugMode: false,
  debugOutputDir: "./debug_chunks",
  // Provider configuration (Phase 7.1)
  providerFactory: undefined,
  useElevenLabs: false, // Default to legacy Mizan mode for backward compatibility
};

/**
 * Pipeline result for a processed chunk.
 */
export interface PipelineResult {
  chunkId: string;
  success: boolean;
  transcription?: string;
  translation?: string;
  audioBuffer?: ArrayBuffer;
  error?: string;
  latencyMs: number;
  retries: number;
}

/**
 * Pipeline metrics.
 */
export interface PipelineMetrics {
  // Overall stats
  totalChunksReceived: number;
  totalChunksProcessed: number;
  totalChunksDropped: number;
  totalChunksFailed: number;

  // Latency stats
  avgPipelineLatencyMs: number;
  avgSttLatencyMs: number;
  avgTranslationLatencyMs: number;
  avgTtsLatencyMs: number;

  // Component metrics
  tokenBucket: ReturnType<TokenBucket["getMetrics"]>;
  circuitBreaker: ReturnType<CircuitBreaker["getMetrics"]>;
  queue: ReturnType<ChunkQueue["getStats"]>;

  // Status
  isProcessing: boolean;
  circuitState: CircuitState;
}

/**
 * Translation Pipeline Orchestrator.
 */
export class TranslationPipeline extends EventEmitter {
  private config: TranslationPipelineConfig;
  private mizanClient: MizanClient | null = null;
  private tokenBucket: TokenBucket;
  private circuitBreaker: CircuitBreaker;
  private queue: ChunkQueue;

  // Provider instances (Phase 7.1)
  private sttProvider: ISTTProvider | null = null;
  private translationProvider: ITranslationProvider | null = null;
  private ttsProvider: ITTSProvider | null = null;

  private isRunning: boolean = false;
  private processInterval: NodeJS.Timeout | null = null;

  // Rolling context for translation continuity across chunks
  private previousTranscription: string = "";

  // Metrics
  private totalChunksReceived: number = 0;
  private totalChunksProcessed: number = 0;
  private totalChunksDropped: number = 0;
  private totalChunksFailed: number = 0;

  // Latency tracking
  private totalPipelineLatencyMs: number = 0;
  private totalSttLatencyMs: number = 0;
  private totalTranslationLatencyMs: number = 0;
  private totalTtsLatencyMs: number = 0;

  // Callback for processed audio
  private onAudioReady: ((audio: ArrayBuffer, chunkId: string) => void) | null =
    null;

  constructor(config: Partial<TranslationPipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };

    // Initialize providers based on configuration
    if (this.config.useElevenLabs && this.config.providerFactory) {
      // Phase 7.1: Use ElevenLabs for STT/TTS, Mizan for Translation
      this.sttProvider = this.config.providerFactory.getSTTProvider('elevenlabs');
      this.translationProvider = this.config.providerFactory.getTranslationProvider('mizan');
      this.ttsProvider = this.config.providerFactory.getTTSProvider('elevenlabs');
      logger.info("Using ElevenLabs STT/TTS + Mizan Translation");
    } else {
      // Legacy mode: Mizan for all
      this.mizanClient = new MizanClient(this.config.mizan);
      logger.info("Using Mizan for all (legacy mode)");
    }

    // Initialize token bucket
    this.tokenBucket = new TokenBucket({
      capacity: this.config.tokenBucketCapacity,
      refillRate: this.config.tokenBucketRefillRate,
    });

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      errorThreshold: this.config.circuitBreakerErrorThreshold,
      errorWindowMs: this.config.circuitBreakerWindowMs,
      openTimeoutMs: this.config.circuitBreakerOpenTimeoutMs,
    });

    // Initialize queue
    this.queue = new ChunkQueue({
      maxQueueLength: this.config.maxQueueLength,
      maxInFlight: this.config.maxInFlight,
    });

    // Set up event handlers
    this.setupEventHandlers();

    logger.info("TranslationPipeline initialized", {
      sourceLanguage: this.config.sourceLanguage,
      targetLanguage: this.config.targetLanguage,
      templatePattern: this.config.translationTemplatePattern,
    });
  }

  /**
   * Sets up event handlers for components.
   */
  private setupEventHandlers(): void {
    // Token bucket low warning
    this.tokenBucket.on("lowTokens", (data) => {
      logger.warn("Token bucket low - consider adaptive chunking", data);
      this.emit("lowTokens", data);
    });

    // Token bucket recovered
    this.tokenBucket.on("tokensRecovered", (data) => {
      logger.info("Token bucket recovered", data);
      this.emit("tokensRecovered", data);
    });

    // Circuit breaker state changes
    this.circuitBreaker.on("stateChange", (event) => {
      logger.info("Circuit breaker state changed", event);
      this.emit("circuitStateChange", event);
    });

    // Queue backpressure
    this.queue.on("backpressure", (data) => {
      logger.warn("Queue backpressure", data);
      this.emit("backpressure", data);
    });

    // Queue chunk dropped
    this.queue.on("chunkDropped", (data) => {
      this.totalChunksDropped++;
      this.emit("chunkDropped", data);
    });

    // Queue chunk ready - trigger processing
    this.queue.on("chunkReady", () => {
      this.processNextChunk();
    });
  }

  /**
   * Sets the callback for when translated audio is ready.
   */
  setOnAudioReady(
    callback: (audio: ArrayBuffer, chunkId: string) => void,
  ): void {
    this.onAudioReady = callback;
    logger.info("Audio ready callback registered");
  }

  /**
   * Starts the pipeline processing loop.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn("Pipeline already running");
      return;
    }

    this.isRunning = true;

    // Start processing interval
    this.processInterval = setInterval(() => {
      this.processNextChunk();
    }, this.config.processIntervalMs);

    logger.info("TranslationPipeline started");
  }

  /**
   * Stops the pipeline.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }

    // Clear remaining queue
    this.queue.clear();

    logger.info("TranslationPipeline stopped", {
      processed: this.totalChunksProcessed,
      dropped: this.totalChunksDropped,
      failed: this.totalChunksFailed,
    });
  }

  /**
   * Submits a chunk for translation.
   */
  submitChunk(chunk: AudioChunk, speakerId?: string): boolean {
    this.totalChunksReceived++;

    const enqueued = this.queue.enqueue(chunk, speakerId);

    if (!enqueued) {
      this.totalChunksDropped++;
    }

    return enqueued;
  }

  /**
   * Sets the active speaker for prioritization.
   */
  setActiveSpeaker(speakerId: string | null): void {
    this.queue.setActiveSpeaker(speakerId);
  }

  /**
   * Processes the next chunk in the queue.
   */
  private async processNextChunk(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Check if we have capacity
    if (!this.queue.hasCapacity()) {
      return;
    }

    // Check circuit breaker
    if (!this.circuitBreaker.allowRequest()) {
      return;
    }

    // Try to acquire tokens for full pipeline
    const tokenResult = this.tokenBucket.tryAcquire(
      MIZAN_TOKEN_COSTS.FULL_PIPELINE,
    );
    if (!tokenResult.acquired) {
      logger.debug("Waiting for tokens", {
        waitTimeMs: tokenResult.waitTimeMs,
      });
      return;
    }

    // Dequeue a chunk
    const queuedChunk = this.queue.dequeue();
    if (!queuedChunk) {
      // Release tokens if nothing to process
      this.tokenBucket.release(MIZAN_TOKEN_COSTS.FULL_PIPELINE);
      return;
    }

    // Process the chunk
    this.processChunk(queuedChunk);
  }

  /**
   * Processes a single chunk through the full pipeline.
   */
  private async processChunk(queuedChunk: QueuedChunk): Promise<void> {
    const { chunk } = queuedChunk;
    const startTime = Date.now();
    let retries = 0;

    try {
      const result = await this.executeWithRetry(async () => {
        return this.runPipeline(chunk);
      }, chunk.chunkId);

      const latencyMs = Date.now() - startTime;

      // Update metrics
      this.totalChunksProcessed++;
      this.totalPipelineLatencyMs += latencyMs;

      // Mark as processed in queue
      this.queue.markProcessed(chunk.chunkId);

      // Record success in circuit breaker
      this.circuitBreaker.recordSuccess();

      // Emit result
      const pipelineResult: PipelineResult = {
        chunkId: chunk.chunkId,
        success: true,
        transcription: result.transcription,
        translation: result.translation,
        audioBuffer: result.audioBuffer,
        latencyMs,
        retries,
      };

      this.emit("chunkProcessed", pipelineResult);

      // Call audio ready callback
      if (this.onAudioReady && result.audioBuffer) {
        this.onAudioReady(result.audioBuffer, chunk.chunkId);
      }

      logger.info("Chunk processed successfully", {
        chunkId: chunk.chunkId,
        latencyMs,
        transcriptionLength: result.transcription?.length || 0,
        translationLength: result.translation?.length || 0,
        audioSize: result.audioBuffer?.byteLength || 0,
      });
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      // Update metrics
      this.totalChunksFailed++;

      // Mark as failed in queue
      this.queue.markFailed(chunk.chunkId, false);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Only penalize circuit breaker for actual API failures,
      // not for empty content results (which are content issues, not API issues)
      const isContentError =
        error instanceof Error && error.message.startsWith("Empty ");
      if (!isContentError) {
        this.circuitBreaker.recordFailure();
      }

      // Emit failure result
      const pipelineResult: PipelineResult = {
        chunkId: chunk.chunkId,
        success: false,
        error: errorMessage,
        latencyMs,
        retries,
      };

      this.emit("chunkFailed", pipelineResult);

      logger.error("Chunk processing failed", {
        chunkId: chunk.chunkId,
        error: errorMessage,
        latencyMs,
        retries,
      });
    }
  }

  /**
   * Runs the full translation pipeline for a chunk.
   * Uses ElevenLabs providers when configured, otherwise falls back to Mizan.
   */
  private async runPipeline(chunk: AudioChunk): Promise<{
    transcription: string;
    translation: string;
    audioBuffer: ArrayBuffer;
  }> {
    // Use providers if available (Phase 7.1), otherwise use legacy Mizan client
    if (this.sttProvider && this.translationProvider && this.ttsProvider) {
      return this.runPipelineWithProviders(chunk);
    } else {
      return this.runPipelineWithMizan(chunk);
    }
  }

  /**
   * Checks if a transcription should be skipped.
   * Filters out non-speech artifacts and filler-only micro-transcriptions
   * that produce garbled or meaningless TTS output.
   */
  private shouldSkipTranscription(text: string): boolean {
    const trimmed = text.trim();

    // Skip very short text (< 10 chars) — fragments like "Is my wa" produce
    // garbage translations and waste API calls
    if (trimmed.length < 10) return true;

    // Skip non-speech artifacts: [clicking], [music], [applause], etc.
    if (/^\[.*\]$/.test(trimmed)) return true;

    // Skip partial bracket annotations or short bracketed text
    // e.g. "[background" (truncated), "[clicking sound"
    if (/^\[/.test(trimmed) && trimmed.length < 30) return true;

    // Skip common noise-only descriptions that Scribe sometimes returns
    // without brackets (e.g. when tag_audio_events was enabled)
    if (/^(background noise|mouse click|keyboard|clicking)/i.test(trimmed)) return true;

    // Skip very short transcriptions (< 3 words) that are all fillers
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
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
        "dialogue",
        "mm",
        "mh",
      ]);
      const allFillers = words.every((w) => FILLERS.has(w.toLowerCase()));
      if (allFillers) return true;
    }

    return false;
  }

  /**
   * Runs pipeline with ElevenLabs STT/TTS + Mizan Translation (Phase 7.1).
   */
  private async runPipelineWithProviders(chunk: AudioChunk): Promise<{
    transcription: string;
    translation: string;
    audioBuffer: ArrayBuffer;
  }> {
    // Step 1: Speech-to-Text (ElevenLabs)
    // Language hint is intentionally omitted — Scribe v2 auto-detects the
    // spoken language. In a multilingual room the agent captures ALL audio,
    // so a fixed hint would force-transcribe non-matching speech incorrectly.
    const sttStart = Date.now();
    const sttResult = await this.sttProvider!.transcribe({
      audioBuffer: chunk.wavBuffer,
      language: "", // empty = auto-detect (ElevenLabsSTT ignores empty)
      vadFilter: true,
    });
    this.totalSttLatencyMs += Date.now() - sttStart;

    const transcription = sttResult.text || "";

    if (transcription.trim() === "") {
      logger.debug("Empty transcription result, skipping chunk", {
        chunkId: chunk.chunkId,
        provider: this.sttProvider!.name,
      });
      throw new Error("Empty transcription result");
    }

    // Filter non-speech artifacts and filler-only transcriptions
    if (this.shouldSkipTranscription(transcription)) {
      logger.debug("Skipping non-speech/filler transcription", {
        chunkId: chunk.chunkId,
        transcription,
      });
      throw new Error("Empty transcription result");
    }

    // Skip if detected language matches target — no translation needed.
    // e.g. if this is the "en" agent and the speaker is already speaking English.
    const detectedLang = sttResult.detectedLanguage;
    if (detectedLang) {
      const mapped = this.mapLanguageCode(detectedLang);
      if (mapped === this.config.targetLanguage) {
        logger.debug("Detected language matches target, skipping chunk", {
          chunkId: chunk.chunkId,
          detectedLanguage: detectedLang,
          mapped,
          targetLanguage: this.config.targetLanguage,
        });
        throw new Error("Empty transcription result");
      }
    }

    logger.debug("STT completed (ElevenLabs)", {
      chunkId: chunk.chunkId,
      transcription: transcription.substring(0, 50),
      detectedLanguage: sttResult.detectedLanguage,
    });

    // Step 2: Translation (Mizan)
    const translationStart = Date.now();
    const translationResult = await this.translationProvider!.translate({
      text: transcription,
      sourceLanguage: this.config.sourceLanguage,
      targetLanguage: this.config.targetLanguage,
    });
    this.totalTranslationLatencyMs += Date.now() - translationStart;

    const translation = translationResult.text;

    if (!translation || translation.trim() === "") {
      logger.debug("Empty translation result", {
        chunkId: chunk.chunkId,
      });
      throw new Error("Empty translation result");
    }

    logger.debug("Translation completed (Mizan)", {
      chunkId: chunk.chunkId,
      translation: translation.substring(0, 50),
    });

    // Step 3: Text-to-Speech (ElevenLabs)
    const ttsStart = Date.now();
    const ttsResult = await this.ttsProvider!.synthesize({
      text: translation,
      language: this.config.targetLanguage,
      speed: this.config.ttsSpeed,
      outputFormat: "mp3",
    });
    this.totalTtsLatencyMs += Date.now() - ttsStart;

    logger.debug("TTS completed (ElevenLabs)", {
      chunkId: chunk.chunkId,
      audioSize: ttsResult.audioBuffer.byteLength,
    });

    // Save TTS audio for debugging if debug mode is enabled
    if (this.config.debugMode) {
      this.saveTTSDebugFile(
        chunk.chunkId,
        ttsResult.audioBuffer,
        transcription,
        translation,
      );
    }

    // Update rolling context for next chunk
    this.previousTranscription = transcription;

    return {
      transcription,
      translation,
      audioBuffer: ttsResult.audioBuffer,
    };
  }

  /**
   * Runs pipeline with Mizan for all stages (legacy mode).
   */
  private async runPipelineWithMizan(chunk: AudioChunk): Promise<{
    transcription: string;
    translation: string;
    audioBuffer: ArrayBuffer;
  }> {
    if (!this.mizanClient) {
      throw new Error("Mizan client not initialized");
    }

    // Step 1: Speech-to-Text
    const sttStart = Date.now();
    const sttResult = await this.mizanClient.transcribe({
      audioBuffer: chunk.wavBuffer,
      language: this.config.sourceLanguage,
      vadFilter: true,
    });
    this.totalSttLatencyMs += Date.now() - sttStart;

    const transcription = sttResult.asrResult || "";

    if (transcription.trim() === "") {
      logger.debug("Empty transcription result, skipping chunk", {
        chunkId: chunk.chunkId,
        rawAsrResult: sttResult.asrResult,
      });
      throw new Error("Empty transcription result");
    }

    // Filter non-speech artifacts and filler-only transcriptions
    if (this.shouldSkipTranscription(transcription)) {
      logger.debug("Skipping non-speech/filler transcription", {
        chunkId: chunk.chunkId,
        transcription,
      });
      throw new Error("Empty transcription result");
    }

    logger.debug("STT completed", {
      chunkId: chunk.chunkId,
      transcription: transcription.substring(0, 50),
    });

    // Step 2: Translation
    const translationStart = Date.now();
    const templateName = this.getTranslationTemplateName();
    const translationResult = await this.mizanClient.translate({
      text: transcription,
      templateName,
    });
    this.totalTranslationLatencyMs += Date.now() - translationStart;

    const translation = translationResult.response;

    if (!translation || translation.trim() === "") {
      logger.debug("Empty translation result, using transcription", {
        chunkId: chunk.chunkId,
      });
      throw new Error("Empty translation result");
    }

    logger.debug("Translation completed", {
      chunkId: chunk.chunkId,
      translation: translation.substring(0, 50),
    });

    // Step 3: Text-to-Speech
    const ttsStart = Date.now();
    const ttsLangCode = this.getTTSLanguageCode();
    const ttsResult = await this.mizanClient.synthesize({
      text: translation,
      voice: this.config.ttsVoice,
      langCode: ttsLangCode,
      speed: this.config.ttsSpeed,
      responseFormat: "mp3",
      stream: false,
    });
    this.totalTtsLatencyMs += Date.now() - ttsStart;

    logger.debug("TTS completed", {
      chunkId: chunk.chunkId,
      audioSize: ttsResult.audioBuffer.byteLength,
    });

    // Save TTS audio for debugging if debug mode is enabled
    if (this.config.debugMode) {
      this.saveTTSDebugFile(
        chunk.chunkId,
        ttsResult.audioBuffer,
        transcription,
        translation,
      );
    }

    // Update rolling context for next chunk
    this.previousTranscription = transcription;

    return {
      transcription,
      translation,
      audioBuffer: ttsResult.audioBuffer,
    };
  }

  /**
   * Saves TTS audio to a debug file for manual verification.
   */
  private saveTTSDebugFile(
    chunkId: string,
    audioBuffer: ArrayBuffer,
    transcription: string,
    translation: string,
  ): void {
    try {
      // Ensure debug directory exists
      if (!fs.existsSync(this.config.debugOutputDir)) {
        fs.mkdirSync(this.config.debugOutputDir, { recursive: true });
      }

      // Save audio file
      const audioFilePath = path.join(
        this.config.debugOutputDir,
        `tts_${chunkId}.mp3`,
      );
      fs.writeFileSync(audioFilePath, Buffer.from(audioBuffer));

      // Save metadata file with transcription and translation
      const metaFilePath = path.join(
        this.config.debugOutputDir,
        `tts_${chunkId}.json`,
      );
      const metadata = {
        chunkId,
        timestamp: new Date().toISOString(),
        transcription,
        translation,
        audioFile: `tts_${chunkId}.mp3`,
        audioSize: audioBuffer.byteLength,
      };
      fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 2));

      logger.info("TTS debug file saved", {
        audioFile: audioFilePath,
        metaFile: metaFilePath,
        transcription,
        translation,
        audioSize: audioBuffer.byteLength,
      });
    } catch (error) {
      logger.warn("Failed to save TTS debug file", {
        chunkId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Executes a function with retry and exponential backoff.
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    chunkId: string,
  ): Promise<T> {
    let lastError: Error | null = null;
    let delay = this.config.retryInitialDelayMs;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        const isRetryable = this.isRetryableError(error);

        if (!isRetryable || attempt >= this.config.maxRetries) {
          throw lastError;
        }

        // Handle 429 Retry-After
        if (error instanceof MizanError && error.retryAfterMs) {
          delay = Math.max(delay, error.retryAfterMs);
        }

        logger.warn("Retrying chunk", {
          chunkId,
          attempt: attempt + 1,
          maxRetries: this.config.maxRetries,
          delayMs: delay,
          error: lastError.message,
        });

        await this.sleep(delay);

        // Exponential backoff
        delay = Math.min(delay * 2, this.config.retryMaxDelayMs);
      }
    }

    throw lastError || new Error("Unknown error");
  }

  /**
   * Checks if an error is retryable.
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof MizanError) {
      return error.retryable;
    }
    if (error instanceof ProviderError) {
      return error.retryable;
    }
    if (error instanceof CircuitOpenError) {
      return false;
    }
    // Empty transcription/translation results are not retryable -
    // resending the same audio will produce the same empty result
    if (error instanceof Error && error.message.startsWith("Empty ")) {
      return false;
    }
    // Network errors are generally retryable
    return true;
  }

  /**
   * Gets the translation template name based on source/target languages.
   */
  private getTranslationTemplateName(): string {
    return this.config.translationTemplatePattern
      .replace("{source}", this.config.sourceLanguage)
      .replace("{target}", this.config.targetLanguage);
  }

  /**
   * Maps target language to TTS language code.
   */
  private getTTSLanguageCode(): TTSLanguageCode {
    const languageMap: Record<string, TTSLanguageCode> = {
      en: "a", // American English
      "en-us": "a",
      "en-gb": "b",
      hi: "h", // Hindi
      ur: "h", // Urdu (uses Hindi TTS — mutually intelligible spoken form)
      ar: "h", // Arabic (uses Hindi TTS — romanized/transliterated text via Hindi voice)
      es: "e", // Spanish
      fr: "f", // French
      ja: "j", // Japanese
      zh: "z", // Mandarin
      it: "i", // Italian
      pt: "p", // Brazilian Portuguese
    };

    return languageMap[this.config.targetLanguage.toLowerCase()] || "a";
  }

  /**
   * Returns the optimal TTS voice for a given target language.
   * This is a static utility so the orchestrator can also use it
   * to pass the correct TTS_VOICE env var to child agents.
   */
  static getVoiceForLanguage(language: string): string {
    const voiceMap: Record<string, string> = {
      en: "af_heart", // American English female
      hi: "hm_psi", // Hindi male — best quality for Hindi
      ur: "hm_psi", // Urdu — uses Hindi voice (mutually intelligible)
      ar: "hm_psi", // Arabic — romanized/transliterated text read by Hindi voice
      es: "ef_dora", // Spanish female
      fr: "ff_siwis", // French female
      ja: "jf_alpha", // Japanese female
      zh: "zf_xiaoxiao", // Mandarin female
      it: "if_sara", // Italian female
      pt: "pf_dora", // Brazilian Portuguese female
    };

    return voiceMap[language.toLowerCase()] || "af_heart";
  }

  /**
   * Gets pipeline metrics.
   */
  getMetrics(): PipelineMetrics {
    return {
      totalChunksReceived: this.totalChunksReceived,
      totalChunksProcessed: this.totalChunksProcessed,
      totalChunksDropped: this.totalChunksDropped,
      totalChunksFailed: this.totalChunksFailed,
      avgPipelineLatencyMs:
        this.totalChunksProcessed > 0
          ? this.totalPipelineLatencyMs / this.totalChunksProcessed
          : 0,
      avgSttLatencyMs:
        this.totalChunksProcessed > 0
          ? this.totalSttLatencyMs / this.totalChunksProcessed
          : 0,
      avgTranslationLatencyMs:
        this.totalChunksProcessed > 0
          ? this.totalTranslationLatencyMs / this.totalChunksProcessed
          : 0,
      avgTtsLatencyMs:
        this.totalChunksProcessed > 0
          ? this.totalTtsLatencyMs / this.totalChunksProcessed
          : 0,
      tokenBucket: this.tokenBucket.getMetrics(),
      circuitBreaker: this.circuitBreaker.getMetrics(),
      queue: this.queue.getStats(),
      isProcessing: this.isRunning,
      circuitState: this.circuitBreaker.getState(),
    };
  }

  /**
   * Checks if the pipeline is healthy.
   */
  isHealthy(): boolean {
    const circuitState = this.circuitBreaker.getState();
    return this.isRunning && circuitState !== CircuitState.OPEN;
  }

  /**
   * Gets the token bucket for adaptive chunking.
   */
  getTokenBucket(): TokenBucket {
    return this.tokenBucket;
  }

  /**
   * Gets the chunk queue.
   */
  getQueue(): ChunkQueue {
    return this.queue;
  }

  /**
   * Gets the circuit breaker.
   */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Maps ElevenLabs ISO 639-3 language codes to our 2-letter codes.
   * Scribe v2 returns codes like "eng", "hin", "urd", "arb".
   */
  private mapLanguageCode(iso3: string): string {
    const map: Record<string, string> = {
      eng: "en",
      hin: "hi",
      urd: "ur",
      arb: "ar",
      ara: "ar",
      spa: "es",
      fra: "fr",
      deu: "de",
      ita: "it",
      por: "pt",
      rus: "ru",
      jpn: "ja",
      kor: "ko",
      zho: "zh",
      nld: "nl",
      pol: "pl",
      tur: "tr",
      vie: "vi",
      tha: "th",
      ind: "id",
      msa: "ms",
      tam: "ta",
      tel: "te",
      ben: "bn",
      guj: "gu",
      mar: "mr",
      pan: "pa",
    };
    return map[iso3] || iso3.substring(0, 2);
  }

  /**
   * Sleep utility.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
