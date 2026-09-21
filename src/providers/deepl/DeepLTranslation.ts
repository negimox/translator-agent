/**
 * DeepL Translation Provider
 *
 * Implements translation using the DeepL REST API.
 * DeepL is a purpose-built neural translation service — not an LLM — so it is
 * immune to context-leaking problems that affect Qwen/GPT-based translation.
 *
 * API: POST https://api-free.deepl.com/v2/translate  (Free tier)
 *      POST https://api.deepl.com/v2/translate        (Pro tier)
 * Auth: Authorization: DeepL-Auth-Key <key>
 *
 * Supported languages (subset used in this system):
 *   EN → English | HI → Hindi | AR → Arabic | UR → Urdu
 */

import { createLogger } from "../../logger";
import {
  ITranslationProvider,
  TranslationRequest,
  TranslationResponse,
  ProviderError,
} from "../types";

const logger = createLogger("DeepLTranslation");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DeepLTranslationConfig {
  /** DeepL API authentication key (ends in :fx for Free tier) */
  apiKey: string;
  /**
   * Base URL for the DeepL API.
   * Free tier:  https://api-free.deepl.com/v2
   * Pro tier:   https://api.deepl.com/v2
   */
  baseUrl: string;
  /** Request timeout in milliseconds (default: 15000) */
  timeoutMs: number;
}

export const DEFAULT_DEEPL_CONFIG: Omit<DeepLTranslationConfig, "apiKey"> = {
  baseUrl: "https://api-free.deepl.com/v2",
  timeoutMs: 15000,
};

// ---------------------------------------------------------------------------
// Language mappings
// ---------------------------------------------------------------------------

/**
 * Maps ISO 639-1 lowercase codes to DeepL uppercase codes.
 * DeepL uses uppercase codes and has specific variants for some languages.
 */
const TO_DEEPL_CODE: Record<string, string> = {
  en: "EN",
  hi: "HI",
  ar: "AR",
  ur: "UR",
  // Extended languages for future use
  es: "ES",
  fr: "FR",
  de: "DE",
  it: "IT",
  pt: "PT",
  ru: "RU",
  ja: "JA",
  ko: "KO",
  zh: "ZH",
  nl: "NL",
  pl: "PL",
  tr: "TR",
  vi: "VI",
  th: "TH",
  id: "ID",
  ms: "MS",
  ta: "TA",
  te: "TE",
  bn: "BN",
  gu: "GU",
  mr: "MR",
  pa: "PA",
  he: "HE",
  uk: "UK",
  sv: "SV",
  da: "DA",
  fi: "FI",
  nb: "NB",
  cs: "CS",
  sk: "SK",
  sl: "SL",
  ro: "RO",
  hu: "HU",
  bg: "BG",
  hr: "HR",
  lv: "LV",
  lt: "LT",
  et: "ET",
  el: "EL",
};

/**
 * Language pairs supported by DeepL for this system's use cases.
 * All combinations of en, hi, ar, ur (bidirectional).
 */
const DEEPL_SUPPORTED_PAIRS: Array<{ source: string; target: string }> = [
  // English output
  { source: "hi", target: "en" },
  { source: "ar", target: "en" },
  { source: "ur", target: "en" },
  // Hindi output
  { source: "en", target: "hi" },
  { source: "ar", target: "hi" },
  { source: "ur", target: "hi" },
  // Arabic output
  { source: "en", target: "ar" },
  { source: "hi", target: "ar" },
  { source: "ur", target: "ar" },
  // Urdu output
  { source: "en", target: "ur" },
  { source: "hi", target: "ur" },
  { source: "ar", target: "ur" },
];

// ---------------------------------------------------------------------------
// DeepL response types
// ---------------------------------------------------------------------------

interface DeepLTranslationResult {
  detected_source_language: string;
  text: string;
}

interface DeepLResponse {
  translations: DeepLTranslationResult[];
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class DeepLTranslation implements ITranslationProvider {
  readonly name = "DeepL-Translation";
  readonly supportedLanguagePairs = DEEPL_SUPPORTED_PAIRS;

  private config: DeepLTranslationConfig;
  private authHeader: string;
  private requestCount = 0;
  private errorCount = 0;

  constructor(
    config: Partial<DeepLTranslationConfig> & { apiKey: string },
  ) {
    this.config = {
      ...DEFAULT_DEEPL_CONFIG,
      ...config,
    };

    if (!this.config.apiKey) {
      throw new Error("DeepL API key is required (DEEPL_API_KEY)");
    }

    this.authHeader = `DeepL-Auth-Key ${this.config.apiKey}`;

    logger.info("DeepLTranslation initialized", {
      baseUrl: this.config.baseUrl,
      isFree: this.config.baseUrl.includes("api-free"),
    });
  }

  /**
   * Translates text using the DeepL API.
   *
   * Key properties vs LLM translation:
   * - No system prompt — pure translation, no instruction confusion
   * - No conversation context injection — no history leaking
   * - Deterministic — same input always produces same output
   * - Fast — ~150-400ms vs ~600-1200ms for Mizan LLM
   */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const targetCode = TO_DEEPL_CODE[request.targetLanguage];
    if (!targetCode) {
      throw new ProviderError(
        `Unsupported target language for DeepL: ${request.targetLanguage}`,
        this.name,
        0,
        false,
      );
    }

    const sourceCode = request.sourceLanguage
      ? TO_DEEPL_CODE[request.sourceLanguage]
      : undefined;

    const url = `${this.config.baseUrl}/translate`;

    const body: Record<string, unknown> = {
      text: [request.text],
      target_lang: targetCode,
    };

    // Only set source_lang if we know it (auto-detect otherwise)
    if (sourceCode) {
      body.source_lang = sourceCode;
    }

    logger.debug("Sending DeepL translation request", {
      targetLanguage: request.targetLanguage,
      sourceLanguage: request.sourceLanguage || "auto",
      textLength: request.text.length,
      targetCode,
      sourceCode: sourceCode || "auto",
    });

    const startTime = Date.now();
    this.requestCount++;

    try {
      const response = await fetch(url, {
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
        throw await this.createError(response);
      }

      const data = (await response.json()) as DeepLResponse;

      if (!data.translations || data.translations.length === 0) {
        this.errorCount++;
        throw new ProviderError(
          "DeepL returned empty translations array",
          this.name,
          200,
          false,
        );
      }

      const translated = data.translations[0];
      const translatedText = translated.text.trim();
      const detectedSource = translated.detected_source_language?.toLowerCase();

      logger.info("DeepL translation completed", {
        latencyMs,
        responseLength: translatedText.length,
        targetLanguage: request.targetLanguage,
        detectedSourceLanguage: detectedSource,
      });

      return {
        text: translatedText,
        detectedSourceLanguage: detectedSource,
        metadata: {
          provider: this.name,
          targetLanguage: request.targetLanguage,
          latencyMs,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      this.errorCount++;
      const message =
        error instanceof Error ? error.message : String(error);
      throw new ProviderError(
        `DeepL translation request failed: ${message}`,
        this.name,
        0,
        true, // Network errors are retryable
      );
    }
  }

  /**
   * Checks if a language pair is supported.
   *
   * When source is empty/undefined, returns true if the target language is
   * supported — DeepL will auto-detect the source language from the text.
   * This is critical for the case where STT doesn't reliably provide the
   * detected language.
   */
  supportsLanguagePair(source: string, target: string): boolean {
    // Target must be a known DeepL language code
    if (!(target in TO_DEEPL_CODE)) {
      return false;
    }

    // If source is empty/unknown, DeepL can auto-detect — allow it
    if (!source) {
      return true;
    }

    // Otherwise, check the explicit supported pairs list
    return this.supportedLanguagePairs.some(
      (pair) => pair.source === source && pair.target === target,
    );
  }

  /**
   * Checks provider health by calling the /v2/usage endpoint.
   */
  async checkHealth(): Promise<{ healthy: boolean; latencyMs?: number }> {
    const url = `${this.config.baseUrl}/usage`;
    const startTime = Date.now();

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
        },
        signal: AbortSignal.timeout(5000),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        logger.warn("DeepL health check failed", {
          status: response.status,
          latencyMs,
        });
        return { healthy: false, latencyMs };
      }

      const data = (await response.json()) as {
        character_count: number;
        character_limit: number;
      };

      const usagePercent =
        data.character_limit > 0
          ? Math.round((data.character_count / data.character_limit) * 100)
          : 0;

      logger.debug("DeepL usage check", {
        characterCount: data.character_count,
        characterLimit: data.character_limit,
        usagePercent,
        latencyMs,
      });

      // Consider unhealthy if at 99%+ of limit
      const healthy = data.character_count < data.character_limit * 0.99;

      if (!healthy) {
        logger.warn("DeepL character limit nearly exhausted", {
          usagePercent,
        });
      }

      return { healthy, latencyMs };
    } catch {
      return { healthy: false };
    }
  }

  /**
   * Gets provider metrics.
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

  /**
   * Creates a structured ProviderError from a failed HTTP response.
   */
  private async createError(response: Response): Promise<ProviderError> {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : undefined;

    const retryable = response.status === 429 || response.status >= 500;

    let message = `DeepL API error: ${response.status} ${response.statusText}`;
    let errorBody = "";

    try {
      const errorData = await response.json();
      errorBody = JSON.stringify(errorData);
      if (errorData.message) {
        message = `DeepL API error: ${errorData.message}`;
      }
    } catch {
      // Body is not JSON
    }

    logger.error("DeepL API error", {
      status: response.status,
      statusText: response.statusText,
      errorBody: errorBody.substring(0, 200),
      url: response.url,
    });

    return new ProviderError(
      message,
      this.name,
      response.status,
      retryable,
      retryAfterMs,
    );
  }
}
