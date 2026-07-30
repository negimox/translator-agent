/**
 * ElevenLabs Speech-to-Text Provider (Phase 7.1)
 *
 * Implements batch STT using ElevenLabs Scribe v2 model.
 * Supports 90+ languages including Arabic and Urdu.
 *
 * API: POST https://api.elevenlabs.io/v1/speech-to-text
 * Auth: Header "xi-api-key: <API_KEY>"
 */

import { createLogger } from "../../logger";
import { ISTTProvider, STTRequest, STTResponse, ProviderError } from "../types";
import {
  ELEVENLABS_API,
  ELEVENLABS_STT_MODELS,
  ELEVENLABS_STT_LANGUAGES,
  ElevenLabsConfig,
  DEFAULT_ELEVENLABS_CONFIG,
} from "./config";

const logger = createLogger("ElevenLabsSTT");



/**
 * ElevenLabs STT response structure.
 */
interface ElevenLabsSTTResponse {
  text: string;
  language_code?: string;
  language_probability?: number;
  words?: Array<{
    text: string;
    start: number;
    end: number;
    confidence: number;
  }>;
}

/**
 * ElevenLabs Speech-to-Text Provider.
 *
 * Uses batch STT endpoint for transcription.
 * For lower latency, see WebSocket implementation in Phase 7.2.
 */
export class ElevenLabsSTT implements ISTTProvider {
  readonly name = "ElevenLabs-STT";
  readonly supportedLanguages = ELEVENLABS_STT_LANGUAGES;

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

    logger.info("ElevenLabsSTT initialized", {
      baseUrl: this.config.baseUrl,
    });
  }

  /**
   * Transcribes audio to text using ElevenLabs Scribe v2.
   */
  async transcribe(request: STTRequest): Promise<STTResponse> {
    const url = `${this.config.baseUrl}${ELEVENLABS_API.STT_ENDPOINT}`;

    // Create multipart form data
    const formData = new FormData();

    // Audio file - ElevenLabs accepts various formats
    const audioBlob = new Blob([request.audioBuffer], { type: "audio/wav" });
    formData.append("file", audioBlob, "audio.wav");

    // Model selection
    formData.append("model_id", ELEVENLABS_STT_MODELS.SCRIBE_V2);

    // Do NOT pass language_code — let Scribe v2 auto-detect the spoken language.
    // In a multilingual room, the agent captures audio from ALL participants
    // regardless of their language, so a fixed hint (e.g. "en") would cause
    // Scribe to force-transcribe non-English speech as English, producing
    // garbled output. Auto-detection is more accurate for this use case.

    // Remove filler words (Yeah, Um, Uh) and false starts at model level
    // This produces cleaner text for the translation LLM
    formData.append("remove_disfluencies", "true");

    // Don't tag audio events ([clicking], [music]) — we filter them anyway
    // and suppressing at source avoids wasting pipeline cycles
    formData.append("tag_audio_events", "false");



    logger.debug("Sending STT request", {
      url,
      language: request.language,
      audioSize: request.audioBuffer.byteLength,
    });

    const startTime = Date.now();
    this.requestCount++;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.config.apiKey,
        },
        body: formData,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        this.errorCount++;
        throw await this.createError(response);
      }

      const data: ElevenLabsSTTResponse = await response.json();

      logger.info("STT request completed", {
        latencyMs,
        textLength: data.text?.length || 0,
        detectedLanguage: data.language_code,
        confidence: data.language_probability,
      });

      return {
        text: data.text || "",
        detectedLanguage: data.language_code,
        confidence: data.language_probability,
        metadata: {
          words: data.words,
          provider: this.name,
          latencyMs,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      this.errorCount++;
      throw new ProviderError(
        `STT request failed: ${error instanceof Error ? error.message : String(error)}`,
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
   * Checks provider health by making a minimal API call.
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

    // 429 Too Many Requests and 5xx errors are retryable
    const retryable = response.status === 429 || response.status >= 500;

    let message = `ElevenLabs STT error: ${response.status} ${response.statusText}`;

    try {
      const errorData = await response.json();
      if (errorData.detail) {
        message = `ElevenLabs STT error: ${JSON.stringify(errorData.detail)}`;
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
