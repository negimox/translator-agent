/**
 * Mizan Translation Provider (Phase 7.1)
 *
 * Implements translation using Mizan Labs API with template-based approach.
 * Templates: translator_{target} (e.g., translator_en, translator_hi, translator_ar, translator_ur)
 *
 * API: POST https://platform.mizanlabs.com/api/v1/chat/completions?template_name=<name>
 * Auth: Basic Auth
 */

import { createLogger } from "../../logger";
import {
  ITranslationProvider,
  TranslationRequest,
  TranslationResponse,
  ProviderError,
} from "../types";

const logger = createLogger("MizanTranslation");

/**
 * Mizan API configuration.
 */
export interface MizanTranslationConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  /** Template pattern - use {target} placeholder */
  templatePattern: string;
}

/**
 * Default configuration.
 */
export const DEFAULT_MIZAN_TRANSLATION_CONFIG: Omit<
  MizanTranslationConfig,
  "username" | "password"
> = {
  baseUrl: "https://platform.mizanlabs.com/api/v1",
  timeoutMs: 30000,
  templatePattern: "translator_{target}",
};

/**
 * Supported language pairs for Mizan translation.
 * Based on available templates: translator_en, translator_hi, translator_ar, translator_ur
 */
const MIZAN_SUPPORTED_PAIRS: Array<{ source: string; target: string }> = [
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

/**
 * Mizan Translation Provider.
 *
 * Uses template-based translation with Mizan LLM API.
 * Templates are pre-configured on Mizan platform.
 */
export class MizanTranslation implements ITranslationProvider {
  readonly name = "Mizan-Translation";
  readonly supportedLanguagePairs = MIZAN_SUPPORTED_PAIRS;

  private config: MizanTranslationConfig;
  private authHeader: string;
  private requestCount = 0;
  private errorCount = 0;

  constructor(
    config: Partial<MizanTranslationConfig> & {
      username: string;
      password: string;
    },
  ) {
    this.config = {
      ...DEFAULT_MIZAN_TRANSLATION_CONFIG,
      ...config,
    };

    if (!this.config.username || !this.config.password) {
      throw new Error("Mizan API credentials required (username and password)");
    }

    // Create Basic Auth header
    const credentials = `${this.config.username}:${this.config.password}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;

    logger.info("MizanTranslation initialized", {
      baseUrl: this.config.baseUrl,
      templatePattern: this.config.templatePattern,
    });
  }

  /**
   * Translates text from source to target language.
   */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const templateName = this.getTemplateName(request.targetLanguage);
    const url = new URL(`${this.config.baseUrl}/chat/completions`);
    url.searchParams.set("template_name", templateName);

    logger.debug("Sending translation request", {
      templateName,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      textLength: request.text.length,
    });

    const startTime = Date.now();
    this.requestCount++;

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
        throw await this.createError(response);
      }

      const data = await response.json();

      logger.info("Translation request completed", {
        latencyMs,
        responseLength: data.response?.length || 0,
        templateName,
      });

      return {
        text: data.response || "",
        metadata: {
          provider: this.name,
          templateName,
          latencyMs,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      this.errorCount++;
      throw new ProviderError(
        `Translation request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        0,
        true,
      );
    }
  }

  /**
   * Checks if a language pair is supported.
   */
  supportsLanguagePair(source: string, target: string): boolean {
    return this.supportedLanguagePairs.some(
      (pair) => pair.source === source && pair.target === target,
    );
  }

  /**
   * Checks provider health.
   */
  async checkHealth(): Promise<{ healthy: boolean; latencyMs?: number }> {
    const url = `${this.config.baseUrl}/health`;
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
        return { healthy: false, latencyMs };
      }

      const data = await response.json();
      return {
        healthy: data.status === "healthy",
        latencyMs,
      };
    } catch {
      return { healthy: false };
    }
  }

  /**
   * Gets the template name for a target language.
   */
  private getTemplateName(targetLanguage: string): string {
    return this.config.templatePattern.replace("{target}", targetLanguage);
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

    let message = `Mizan Translation error: ${response.status} ${response.statusText}`;

    try {
      const errorData = await response.json();
      if (errorData.error) {
        message = `Mizan Translation error: ${errorData.error}`;
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
