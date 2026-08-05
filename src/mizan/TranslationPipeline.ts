/**
 * Translation Pipeline Orchestrator (Phase 7.2)
 *
 * Coordinates the streaming translation pipeline:
 * Audio Stream → Scribe Realtime (STT) → Translation (Mizan) → TTS (ElevenLabs) → Audio Output
 */

import { EventEmitter } from "events";
import { createLogger } from "../logger";
import { MizanClient, MizanConfig } from "./MizanClient";
import { TokenBucket, MIZAN_TOKEN_COSTS } from "./TokenBucket";
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
  mizan: Partial<MizanConfig>;
  sourceLanguage: string;
  targetLanguage: string;
  translationTemplatePattern: string;
  ttsVoice: string;
  ttsSpeed: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  maxRetries: number;
  tokenBucketCapacity: number;
  tokenBucketRefillRate: number;
  circuitBreakerErrorThreshold: number;
  circuitBreakerWindowMs: number;
  circuitBreakerOpenTimeoutMs: number;
  providerFactory?: ProviderFactory;
  useElevenLabs?: boolean;
  contextWindowSize: number;
  contextStalenessMs: number;
}

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
  tokenBucketCapacity: 8,
  tokenBucketRefillRate: 8,
  circuitBreakerErrorThreshold: 0.1,
  circuitBreakerWindowMs: 60000,
  circuitBreakerOpenTimeoutMs: 10000,
  providerFactory: undefined,
  useElevenLabs: true, // Switched to true for Realtime migration
  contextWindowSize: 5,
  contextStalenessMs: 30000,
};

export class TranslationPipeline extends EventEmitter {
  private config: TranslationPipelineConfig;
  private tokenBucket: TokenBucket;
  private circuitBreaker: CircuitBreaker;

  private sttProvider: IRealtimeSTTProvider | null = null;
  private translationProvider: ITranslationProvider | null = null;
  private ttsProvider: ITTSProvider | null = null;
  private mizanClient: MizanClient | null = null;

  private isRunning: boolean = false;
  private conversationContext: ConversationContext;

  private totalSentencesProcessed: number = 0;
  private totalSentencesFailed: number = 0;

  private onAudioReady: ((audio: ArrayBuffer, sentenceId: string) => void) | null = null;

  constructor(config: Partial<TranslationPipelineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };

    if (this.config.useElevenLabs && this.config.providerFactory) {
      this.sttProvider = this.config.providerFactory.getSTTProvider('elevenlabs', {
        languageCode: this.config.sourceLanguage,
        instanceId: this.config.sourceLanguage,
      });
      this.translationProvider = this.config.providerFactory.getTranslationProvider('mizan');
      this.ttsProvider = this.config.providerFactory.getTTSProvider('elevenlabs');
      
      // Hook up STT events
      this.sttProvider.on("committed", (data: {text: string, language: string}) => this.handleCommittedTranscript(data.text, data.language));
      this.sttProvider.on("error", (err: any) => logger.error("STT Provider Error", { error: err }));
      this.sttProvider.on("close", () => this.handleSTTClose());
      this.sttProvider.on("reconnected", () => this.handleSTTReconnected());
    } else {
      this.mizanClient = new MizanClient(this.config.mizan);
    }

    this.tokenBucket = new TokenBucket({
      capacity: this.config.tokenBucketCapacity,
      refillRate: this.config.tokenBucketRefillRate,
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

  setOnAudioReady(callback: (audio: ArrayBuffer, sentenceId: string) => void): void {
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
        logger.error("Failed to connect to Realtime STT", { error: String(err) });
      }
    }
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    
    if (this.sttProvider) {
      this.sttProvider.disconnect();
    }
    this.conversationContext.reset();
  }

  private handleSTTClose(): void {
    logger.warn("STT connection closed permanently", {
      processed: this.totalSentencesProcessed,
      failed: this.totalSentencesFailed
    });
    // Emit event so TranslatorAgent can handle if needed
    this.emit("stt_disconnected");
  }

  private handleSTTReconnected(): void {
    logger.info("STT connection restored", {
      processed: this.totalSentencesProcessed,
      failed: this.totalSentencesFailed
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

  private async handleCommittedTranscript(text: string, detectedLanguage: string): Promise<void> {
    if (!text.trim()) return;
    
    // Filter out filler words like "yeah", "um" if they are the only words
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length < 3) {
      const FILLERS = new Set(["yeah", "um", "uh", "okay", "ok", "hmm", "hm", "ah", "oh", "right", "so", "like", "well", "mhm", "mm", "mh"]);
      if (words.every(w => FILLERS.has(w.toLowerCase()))) {
        return;
      }
    }

    const mappedLang = this.mapLanguageCode(detectedLanguage || "en");
    if (mappedLang === this.config.targetLanguage) {
      logger.debug("Detected language matches target, skipping translation", { detectedLanguage, targetLanguage: this.config.targetLanguage });
      return;
    }

    const sentenceId = `sent_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    
    try {
      if (!this.circuitBreaker.allowRequest()) {
        logger.warn("Circuit breaker open, dropping sentence", { text });
        return;
      }

      await this.waitForTokens(MIZAN_TOKEN_COSTS.FULL_PIPELINE);
      
      let translationResult;
      
      if (this.translationProvider) {
        translationResult = await this.translationProvider.translate({
          text,
          sourceLanguage: detectedLanguage || this.config.sourceLanguage, // Pass the dynamically detected language
          targetLanguage: this.config.targetLanguage,
          conversationContext: this.conversationContext.getContextBlock(),
        });
      } else {
        throw new Error("No translation provider available");
      }
      
      this.conversationContext.addTurn(text, translationResult.text);

      let audioBuffer;
      if (this.ttsProvider) {
        const ttsResult = await this.ttsProvider.synthesize({
          text: translationResult.text,
          language: this.config.targetLanguage,
          voiceId: this.config.ttsVoice,
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
      logger.error("Error processing committed transcript", { error: String(err) });
    }
  }

  private mapLanguageCode(code: string): string {
    const codeMap: Record<string, string> = {
      hin: "hi",
      eng: "en",
      urd: "ur",
      ara: "ar",
      tr: "tr",
      fra: "fr"
    };
    return codeMap[code] || code;
  }
  
  private async waitForTokens(amount: number): Promise<void> {
    return new Promise((resolve) => {
      const checkTokens = () => {
        const result = this.tokenBucket.tryAcquire(amount);
        if (result.acquired) {
          resolve();
        } else {
          setTimeout(checkTokens, result.waitTimeMs);
        }
      };
      checkTokens();
    });
  }
  
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
