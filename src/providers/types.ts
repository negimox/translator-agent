/**
 * Provider Abstraction Layer - Type Definitions (Phase 7.1)
 *
 * Defines interfaces for STT, Translation, and TTS providers
 * allowing seamless switching between Mizan and ElevenLabs.
 */

/**
 * Speech-to-Text request options.
 */
export interface STTRequest {
  /** Audio buffer (WAV format, 16kHz PCM16 mono) */
  audioBuffer: ArrayBuffer;
  /** Source language code (ISO 639-1, e.g., 'en', 'ar', 'ur') */
  language?: string;
  /** Enable VAD filtering */
  vadFilter?: boolean;
}

/**
 * Speech-to-Text response.
 */
export interface STTResponse {
  /** Transcribed text */
  text: string;
  /** Detected language (if available) */
  detectedLanguage?: string;
  /** Confidence score (0-1, if available) */
  confidence?: number;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Translation request options.
 */
export interface TranslationRequest {
  /** Text to translate */
  text: string;
  /** Source language code */
  sourceLanguage: string;
  /** Target language code */
  targetLanguage: string;
  /** Optional conversation context for continuity across chunks */
  conversationContext?: any;
}

/**
 * Translation response.
 */
export interface TranslationResponse {
  /** Translated text */
  text: string;
  /** Detected source language (if different from requested) */
  detectedSourceLanguage?: string;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Text-to-Speech request options.
 */
export interface TTSRequest {
  /** Text to synthesize */
  text: string;
  /** Target language code */
  language: string;
  /** Voice ID (provider-specific) */
  voiceId?: string;
  /** Speech speed (0.5-2.0, default 1.0) */
  speed?: number;
  /** Enable streaming response */
  stream?: boolean;
  /** Output format */
  outputFormat?: "mp3" | "wav" | "pcm" | "opus";
}

/**
 * Text-to-Speech response (non-streaming).
 */
export interface TTSResponse {
  /** Audio buffer */
  audioBuffer: ArrayBuffer;
  /** Content type (e.g., 'audio/mpeg') */
  contentType: string;
  /** Duration in milliseconds (if available) */
  durationMs?: number;
}

/**
 * Provider error with retry information.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public statusCode: number,
    public retryable: boolean,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Speech-to-Text provider interface.
 */
export interface ISTTProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Supported languages */
  readonly supportedLanguages: string[];

  /**
   * Transcribes audio to text.
   * @param request STT request options
   * @returns Promise resolving to transcription result
   */
  transcribe(request: STTRequest): Promise<STTResponse>;

  /**
   * Checks if a language is supported.
   * @param language ISO 639-1 language code
   */
  supportsLanguage(language: string): boolean;

  /**
   * Gets provider health status.
   */
  checkHealth(): Promise<{ healthy: boolean; latencyMs?: number }>;
}

/**
 * Translation provider interface.
 */
export interface ITranslationProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Supported language pairs (source-target) */
  readonly supportedLanguagePairs: Array<{ source: string; target: string }>;

  /**
   * Translates text from source to target language.
   * @param request Translation request options
   * @returns Promise resolving to translation result
   */
  translate(request: TranslationRequest): Promise<TranslationResponse>;

  /**
   * Checks if a language pair is supported.
   * @param source Source language code
   * @param target Target language code
   */
  supportsLanguagePair(source: string, target: string): boolean;

  /**
   * Gets provider health status.
   */
  checkHealth(): Promise<{ healthy: boolean; latencyMs?: number }>;
}

/**
 * Text-to-Speech provider interface.
 */
export interface ITTSProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Supported languages */
  readonly supportedLanguages: string[];

  /**
   * Synthesizes speech from text.
   * @param request TTS request options
   * @returns Promise resolving to audio buffer
   */
  synthesize(request: TTSRequest): Promise<TTSResponse>;

  /**
   * Synthesizes speech with streaming response.
   * @param request TTS request options
   * @returns AsyncGenerator yielding audio chunks
   */
  synthesizeStream(
    request: TTSRequest,
  ): AsyncGenerator<Uint8Array, void, undefined>;

  /**
   * Checks if a language is supported.
   * @param language ISO 639-1 language code
   */
  supportsLanguage(language: string): boolean;

  /**
   * Gets the default voice ID for a language.
   * @param language ISO 639-1 language code
   */
  getDefaultVoice(language: string): string | undefined;

  /**
   * Gets provider health status.
   */
  checkHealth(): Promise<{ healthy: boolean; latencyMs?: number }>;
}

/**
 * Voice configuration for TTS.
 */
export interface VoiceConfig {
  /** Voice ID */
  voiceId: string;
  /** Model to use */
  model: string;
  /** Whether voice is verified for this language */
  verified: boolean;
  /** Voice name for display */
  name?: string;
  /** Voice gender */
  gender?: "male" | "female" | "neutral";
}

/**
 * Provider configuration.
 */
export interface ProviderConfig {
  /** API key or credentials */
  apiKey?: string;
  /** Base URL override */
  baseUrl?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** Additional provider-specific options */
  options?: Record<string, unknown>;
}
