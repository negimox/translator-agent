/**
 * ElevenLabs Text-to-Speech Provider (Phase 7.1)
 *
 * Implements TTS using ElevenLabs streaming API.
 * Supports 70+ languages with model selection based on language.
 *
 * API: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream
 * Auth: Header "xi-api-key: <API_KEY>"
 */

import { createLogger } from "../../logger";
import { ITTSProvider, TTSRequest, TTSResponse, ProviderError } from "../types";
import {
  ELEVENLABS_API,
  ELEVENLABS_TTS_LANGUAGES,
  ELEVENLABS_VOICES,
  ElevenLabsConfig,
  DEFAULT_ELEVENLABS_CONFIG,
  getVoiceConfig,
  selectTTSModel,
} from "./config";

const logger = createLogger("ElevenLabsTTS");

/**
 * ElevenLabs TTS request body.
 */
interface ElevenLabsTTSBody {
  text: string;
  model_id: string;
  language_code?: string;
  voice_settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
}

/**
 * Output format mapping.
 */
const OUTPUT_FORMAT_MAP: Record<string, string> = {
  mp3: "mp3_44100_128",
  wav: "pcm_44100",
  pcm: "pcm_16000",
  opus: "opus_16000",
};

/**
 * ElevenLabs Text-to-Speech Provider.
 *
 * Features:
 * - Automatic model selection (eleven_v3 for Urdu, flash for others)
 * - Streaming support for low latency first-chunk delivery
 * - Voice configuration per language
 */
export class ElevenLabsTTS implements ITTSProvider {
  readonly name = "ElevenLabs-TTS";
  readonly supportedLanguages = ELEVENLABS_TTS_LANGUAGES;

  private config: Required<ElevenLabsConfig>;
  private requestCount = 0;
  private errorCount = 0;

  constructor(config: ElevenLabsConfig) {
    if (!config.apiKey) {
      throw new Error("ElevenLabs API key is required");
    }

    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || DEFAULT_ELEVENLABS_CONFIG.baseUrl!,
      timeoutMs: config.timeoutMs || DEFAULT_ELEVENLABS_CONFIG.timeoutMs!,
    };

    logger.info("ElevenLabsTTS initialized", {
      baseUrl: this.config.baseUrl,
      configuredVoices: Object.keys(ELEVENLABS_VOICES),
    });
  }

  /**
   * Synthesizes speech from text (non-streaming).
   */
  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const voiceConfig = getVoiceConfig(request.language);
    const voiceId = request.voiceId || voiceConfig.voiceId;
    const model = voiceConfig.model;

    const outputFormat =
      OUTPUT_FORMAT_MAP[request.outputFormat || "mp3"] || "mp3_44100_128";
    const url = `${this.config.baseUrl}${ELEVENLABS_API.TTS_ENDPOINT}/${voiceId}?output_format=${outputFormat}`;

    const body: ElevenLabsTTSBody = {
      text: request.text,
      model_id: model,
      language_code: request.language,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      },
    };

    logger.debug("Sending TTS request", {
      url,
      language: request.language,
      voiceId,
      model,
      textLength: request.text.length,
      verified: voiceConfig.verified,
    });

    const startTime = Date.now();
    this.requestCount++;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.config.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        this.errorCount++;
        throw await this.createError(response);
      }

      const audioBuffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") || "audio/mpeg";

      logger.info("TTS request completed", {
        latencyMs,
        audioSize: audioBuffer.byteLength,
        contentType,
        voiceId,
        model,
      });

      return {
        audioBuffer,
        contentType,
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      this.errorCount++;
      throw new ProviderError(
        `TTS request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        0,
        true,
      );
    }
  }

  /**
   * Synthesizes speech with streaming response.
   * Returns audio chunks as they become available.
   */
  async *synthesizeStream(
    request: TTSRequest,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const voiceConfig = getVoiceConfig(request.language);
    const voiceId = request.voiceId || voiceConfig.voiceId;
    const model = voiceConfig.model;

    // Use streaming endpoint
    const outputFormat =
      OUTPUT_FORMAT_MAP[request.outputFormat || "mp3"] || "mp3_44100_128";
    const url = `${this.config.baseUrl}${ELEVENLABS_API.TTS_ENDPOINT}/${voiceId}/stream?output_format=${outputFormat}`;

    const body: ElevenLabsTTSBody = {
      text: request.text,
      model_id: model,
      language_code: request.language,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      },
    };

    logger.debug("Sending streaming TTS request", {
      url,
      language: request.language,
      voiceId,
      model,
      textLength: request.text.length,
    });

    const startTime = Date.now();
    this.requestCount++;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.config.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        this.errorCount++;
        throw await this.createError(response);
      }

      if (!response.body) {
        throw new ProviderError("Response body is null", this.name, 500, false);
      }

      const reader = response.body.getReader();
      let totalBytes = 0;
      let firstChunkTime: number | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (firstChunkTime === null) {
            firstChunkTime = Date.now();
            logger.debug("TTS first chunk received", {
              latencyMs: firstChunkTime - startTime,
              chunkSize: value.length,
            });
          }

          totalBytes += value.length;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }

      logger.info("TTS streaming completed", {
        totalLatencyMs: Date.now() - startTime,
        firstChunkLatencyMs: firstChunkTime ? firstChunkTime - startTime : null,
        totalBytes,
        voiceId,
        model,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      this.errorCount++;
      throw new ProviderError(
        `TTS streaming failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        0,
        true,
      );
    }
  }

  /**
   * Checks if a language is supported.
   */
  supportsLanguage(language: string): boolean {
    return this.supportedLanguages.includes(language);
  }

  /**
   * Gets the default voice ID for a language.
   */
  getDefaultVoice(language: string): string | undefined {
    const config = ELEVENLABS_VOICES[language];
    return config?.voiceId;
  }

  /**
   * Checks provider health.
   */
  async checkHealth(): Promise<{ healthy: boolean; latencyMs?: number }> {
    const url = `${this.config.baseUrl}${ELEVENLABS_API.USER_ENDPOINT}`;
    const startTime = Date.now();

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "xi-api-key": this.config.apiKey,
        },
        signal: AbortSignal.timeout(5000),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        return { healthy: false, latencyMs };
      }

      return { healthy: true, latencyMs };
    } catch {
      return { healthy: false };
    }
  }

  /**
   * Creates a ProviderError from a fetch response.
   */
  private async createError(response: Response): Promise<ProviderError> {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : undefined;

    const retryable = response.status === 429 || response.status >= 500;

    let message = `ElevenLabs TTS error: ${response.status} ${response.statusText}`;

    try {
      const errorData = await response.json();
      if (errorData.detail) {
        message = `ElevenLabs TTS error: ${JSON.stringify(errorData.detail)}`;
      }
    } catch {
      // Body is not JSON
    }

    return new ProviderError(
      message,
      this.name,
      response.status,
      retryable,
      retryAfterMs,
    );
  }

  /**
   * Gets client metrics.
   */
  getMetrics(): {
    requestCount: number;
    errorCount: number;
    errorRate: number;
  } {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      errorRate:
        this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
    };
  }
}
