/**
 * Mizan Labs API Client (Phase 4)
 *
 * Handles communication with the Mizanlabs platform for:
 * - Speech-to-Text (STT): POST /audio/transcriptions
 * - Translation: POST /chat/completions?template_name=translator_<lang>
 * - Text-to-Speech (TTS): POST /audio/speech (with streaming support)
 *
 * Authentication: Basic Auth
 * Base URL: https://platform.mizanlabs.com/api/v1
 */

import { createLogger } from "../logger";

const logger = createLogger("MizanClient");

/**
 * Mizan API configuration.
 */
export interface MizanConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

/**
 * Default Mizan configuration.
 */
export const DEFAULT_MIZAN_CONFIG: MizanConfig = {
  baseUrl: "https://platform.mizanlabs.com/api/v1",
  username: "",
  password: "",
  timeoutMs: 30000,
};

/**
 * STT request options.
 */
export interface STTRequest {
  audioBuffer: ArrayBuffer;
  language?: string; // ISO 639-1 code (e.g., 'en', 'hi')
  vadFilter?: boolean;
}

/**
 * STT response from Mizan.
 */
export interface STTResponse {
  message: string;
  audioType: string;
  asrResult: string;
}

/**
 * Translation request options.
 */
export interface TranslationRequest {
  text: string;
  templateName: string; // e.g., 'translator_en_to_hi'
}

/**
 * Translation response from Mizan.
 */
export interface TranslationResponse {
  response: string;
}

/**
 * TTS request options.
 */
export interface TTSRequest {
  text: string;
  voice?: string;
  langCode?: TTSLanguageCode;
  speed?: number;
  stream?: boolean;
  responseFormat?: "mp3" | "opus" | "flac" | "wav" | "pcm";
}

/**
 * TTS language codes supported by Mizan.
 */
export type TTSLanguageCode =
  | "a" // American English
  | "b" // British English
  | "j" // Japanese
  | "z" // Mandarin Chinese
  | "e" // Spanish
  | "f" // French
  | "h" // Hindi
  | "i" // Italian
  | "p"; // Brazilian Portuguese

/**
 * TTS response (non-streaming).
 */
export interface TTSResponse {
  audioBuffer: ArrayBuffer;
  contentType: string;
}

/**
 * Mizan API error.
 */
export class MizanError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public retryable: boolean,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "MizanError";
  }
}

/**
 * Mizan Labs API Client.
 */
export class MizanClient {
  private config: MizanConfig;
  private authHeader: string;

  // Metrics
  private requestCount: number = 0;
  private errorCount: number = 0;
  private lastRequestTime: number = 0;

  constructor(config: Partial<MizanConfig> = {}) {
    this.config = { ...DEFAULT_MIZAN_CONFIG, ...config };

    // Validate required credentials
    if (!this.config.username || !this.config.password) {
      throw new Error("Mizan API credentials required (username and password)");
    }

    // Create Basic Auth header
    const credentials = `${this.config.username}:${this.config.password}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;

    logger.info("MizanClient initialized", {
      baseUrl: this.config.baseUrl,
      username: this.config.username,
    });
  }

  /**
   * Transcribes audio using Mizan STT.
   * POST /audio/transcriptions
   */
  async transcribe(request: STTRequest): Promise<STTResponse> {
    const url = new URL(`${this.config.baseUrl}/audio/transcriptions`);

    // Add query parameters
    if (request.language) {
      url.searchParams.set("language", request.language);
    }
    url.searchParams.set("output", "json");
    if (request.vadFilter !== undefined) {
      url.searchParams.set("vad_filter", String(request.vadFilter));
    }

    // Create multipart form data
    const formData = new FormData();
    const audioBlob = new Blob([request.audioBuffer], { type: "audio/wav" });
    formData.append("audio_file", audioBlob, "audio.wav");

    logger.debug("Sending STT request", {
      url: url.toString(),
      language: request.language,
      audioSize: request.audioBuffer.byteLength,
    });

    const startTime = Date.now();
    this.requestCount++;
    this.lastRequestTime = startTime;

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
        },
        body: formData,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        this.errorCount++;
        throw this.createError(response, await this.safeReadText(response));
      }

      const data = await response.json();

      // asr_result is an object with shape: { language: string, segments: [], text: string }
      // Extract the text field from the asr_result object
      const asrResultObj = data.asr_result;
      const transcriptionText =
        typeof asrResultObj === "object" && asrResultObj !== null
          ? asrResultObj.text || ""
          : typeof asrResultObj === "string"
            ? asrResultObj
            : "";

      logger.info("STT request completed", {
        latencyMs,
        resultLength: transcriptionText.length,
        transcription: transcriptionText.substring(0, 100),
      });

      return {
        message: data.message || "",
        audioType: data.audio_type || "",
        asrResult: transcriptionText,
      };
    } catch (error) {
      this.errorCount++;
      if (error instanceof MizanError) {
        throw error;
      }
      throw new MizanError(
        `STT request failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        true,
      );
    }
  }

  /**
   * Translates text using Mizan LLM with a template.
   * POST /chat/completions?template_name=<name>
   */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const url = new URL(`${this.config.baseUrl}/chat/completions`);
    url.searchParams.set("template_name", request.templateName);

    logger.debug("Sending translation request", {
      templateName: request.templateName,
      textLength: request.text.length,
    });

    const startTime = Date.now();
    this.requestCount++;
    this.lastRequestTime = startTime;

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: request.text }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        this.errorCount++;
        throw this.createError(response, await this.safeReadText(response));
      }

      const data = await response.json();

      logger.info("Translation request completed", {
        latencyMs,
        responseLength: data.response?.length || 0,
        inputText: request.text,
        translatedText: data.response,
      });

      return {
        response: data.response,
      };
    } catch (error) {
      this.errorCount++;
      if (error instanceof MizanError) {
        throw error;
      }
      throw new MizanError(
        `Translation request failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        true,
      );
    }
  }

  /**
   * Generates speech using Mizan TTS.
   * POST /audio/speech
   *
   * Returns the audio buffer directly (non-streaming).
   */
  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const url = new URL(`${this.config.baseUrl}/audio/speech`);

    const body = {
      input: request.text,
      voice: request.voice || "af_heart",
      response_format: request.responseFormat || "mp3",
      speed: request.speed || 1,
      stream: request.stream || false,
      lang_code: request.langCode || "a",
    };

    logger.debug("Sending TTS request", {
      textLength: request.text.length,
      voice: body.voice,
      langCode: body.lang_code,
      stream: body.stream,
    });

    const startTime = Date.now();
    this.requestCount++;
    this.lastRequestTime = startTime;

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        this.errorCount++;
        throw this.createError(response, await this.safeReadText(response));
      }

      const audioBuffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") || "audio/mpeg";

      logger.info("TTS request completed", {
        latencyMs,
        audioSize: audioBuffer.byteLength,
        contentType,
      });

      return {
        audioBuffer,
        contentType,
      };
    } catch (error) {
      this.errorCount++;
      if (error instanceof MizanError) {
        throw error;
      }
      throw new MizanError(
        `TTS request failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        true,
      );
    }
  }

  /**
   * Generates speech with streaming response.
   * Returns an async iterable of audio chunks.
   */
  async *synthesizeStream(
    request: TTSRequest,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const url = new URL(`${this.config.baseUrl}/audio/speech`);

    const body = {
      input: request.text,
      voice: request.voice || "af_heart",
      response_format: request.responseFormat || "mp3",
      speed: request.speed || 1,
      stream: true,
      lang_code: request.langCode || "a",
    };

    logger.debug("Sending streaming TTS request", {
      textLength: request.text.length,
      voice: body.voice,
    });

    const startTime = Date.now();
    this.requestCount++;
    this.lastRequestTime = startTime;

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        this.errorCount++;
        throw this.createError(response, await this.safeReadText(response));
      }

      if (!response.body) {
        throw new MizanError("Response body is null", 500, false);
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
      });
    } catch (error) {
      this.errorCount++;
      if (error instanceof MizanError) {
        throw error;
      }
      throw new MizanError(
        `TTS streaming failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        true,
      );
    }
  }

  /**
   * Checks Mizan API health.
   * GET /health
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    db: string;
    llm: string;
    asr: string;
  }> {
    const url = `${this.config.baseUrl}/health`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          healthy: false,
          db: "unknown",
          llm: "unknown",
          asr: "unknown",
        };
      }

      const data = await response.json();
      return {
        healthy: data.status === "healthy",
        db: data.checks?.db || "unknown",
        llm: data.checks?.llm || "unknown",
        asr: data.checks?.asr || "unknown",
      };
    } catch {
      return { healthy: false, db: "error", llm: "error", asr: "error" };
    }
  }

  /**
   * Gets available TTS voices.
   * GET /audio/speech/voices
   */
  async getVoices(): Promise<{ id: string; name: string }[]> {
    const url = `${this.config.baseUrl}/audio/speech/voices`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw this.createError(response, await this.safeReadText(response));
      }

      const data = await response.json();
      return data.voices || [];
    } catch (error) {
      logger.error("Failed to fetch voices", { error: String(error) });
      return [];
    }
  }

  /**
   * Creates a MizanError from a fetch response.
   */
  private createError(response: Response, body: string): MizanError {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : undefined;

    // 429 Too Many Requests is retryable
    // 5xx errors are retryable
    const retryable = response.status === 429 || response.status >= 500;

    let message = `Mizan API error: ${response.status} ${response.statusText}`;
    try {
      const errorData = JSON.parse(body);
      if (errorData.error) {
        message = `Mizan API error: ${errorData.error}`;
      }
    } catch {
      // Body is not JSON
    }

    return new MizanError(message, response.status, retryable, retryAfterMs);
  }

  /**
   * Safely reads response text without throwing.
   */
  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  /**
   * Gets client metrics.
   */
  getMetrics(): {
    requestCount: number;
    errorCount: number;
    errorRate: number;
    lastRequestTime: number;
  } {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      errorRate:
        this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
      lastRequestTime: this.lastRequestTime,
    };
  }

  /**
   * Resets metrics.
   */
  resetMetrics(): void {
    this.requestCount = 0;
    this.errorCount = 0;
    this.lastRequestTime = 0;
  }
}
