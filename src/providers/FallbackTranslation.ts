/**
 * Fallback Translation Provider
 *
 * Composite ITranslationProvider that tries a primary provider (DeepL)
 * and falls back to a secondary provider (Mizan LLM) when:
 *   - The primary is unavailable (network error, auth failure)
 *   - The primary doesn't support the requested language pair
 *   - The primary returns a non-retryable error
 *
 * This pattern means:
 *   - DeepL handles the vast majority of requests (fast, accurate, no context leaking)
 *   - Mizan LLM handles edge cases (outage, unsupported pairs)
 */

import { createLogger } from "../logger";
import {
  ITranslationProvider,
  TranslationRequest,
  TranslationResponse,
  ProviderError,
} from "./types";

const logger = createLogger("FallbackTranslation");

export class FallbackTranslation implements ITranslationProvider {
  readonly name: string;

  /**
   * Union of all language pairs supported by either provider.
   */
  readonly supportedLanguagePairs: Array<{ source: string; target: string }>;

  private primary: ITranslationProvider;
  private secondary: ITranslationProvider;
  private primaryFailureCount = 0;
  private secondaryFailureCount = 0;
  private primarySuccessCount = 0;
  private secondarySuccessCount = 0;

  constructor(primary: ITranslationProvider, secondary: ITranslationProvider) {
    this.primary = primary;
    this.secondary = secondary;
    this.name = `${primary.name}→${secondary.name}`;

    // Union of supported pairs from both providers
    const seen = new Set<string>();
    this.supportedLanguagePairs = [
      ...primary.supportedLanguagePairs,
      ...secondary.supportedLanguagePairs,
    ].filter((pair) => {
      const key = `${pair.source}:${pair.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    logger.info("FallbackTranslation initialized", {
      primary: primary.name,
      secondary: secondary.name,
      totalSupportedPairs: this.supportedLanguagePairs.length,
    });
  }

  /**
   * Translates text using the primary provider, falling back to secondary on failure.
   *
   * Fallback triggers on:
   *   1. Primary throws ProviderError (any HTTP error)
   *   2. Primary throws any other error (network, timeout)
   *   3. Primary doesn't support the language pair
   *
   * IMPORTANT: conversationContext is intentionally NOT forwarded to the primary
   * (DeepL) — DeepL doesn't need it. It IS forwarded to the secondary (Mizan LLM)
   * when falling back, so the LLM still has context if available.
   */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    // Check if primary supports this language pair
    const primarySupports = this.primary.supportsLanguagePair(
      request.sourceLanguage,
      request.targetLanguage,
    );

    if (primarySupports) {
      try {
        // For the primary (DeepL), strip conversation context — DeepL doesn't
        // use it and passing it would be wasted bandwidth.
        const primaryRequest: TranslationRequest = {
          ...request,
          conversationContext: undefined,
        };

        const result = await this.primary.translate(primaryRequest);
        this.primarySuccessCount++;

        logger.debug("Primary translation succeeded", {
          provider: this.primary.name,
          targetLanguage: request.targetLanguage,
        });

        return result;
      } catch (error) {
        this.primaryFailureCount++;
        const errMsg =
          error instanceof Error ? error.message : String(error);
        logger.warn("Primary translation failed, falling back to secondary", {
          primary: this.primary.name,
          secondary: this.secondary.name,
          error: errMsg,
          targetLanguage: request.targetLanguage,
        });
        // Fall through to secondary below
      }
    } else {
      logger.debug("Primary does not support language pair, using secondary", {
        primary: this.primary.name,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
      });
    }

    // Secondary fallback — pass full request including conversation context
    if (!this.secondary.supportsLanguagePair(
      request.sourceLanguage,
      request.targetLanguage,
    )) {
      throw new ProviderError(
        `Neither ${this.primary.name} nor ${this.secondary.name} supports ` +
          `${request.sourceLanguage}→${request.targetLanguage}`,
        this.name,
        0,
        false,
      );
    }

    try {
      const result = await this.secondary.translate(request);
      this.secondarySuccessCount++;

      logger.info("Secondary (fallback) translation succeeded", {
        provider: this.secondary.name,
        targetLanguage: request.targetLanguage,
      });

      return result;
    } catch (error) {
      this.secondaryFailureCount++;
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Both primary and secondary translation failed", {
        primary: this.primary.name,
        secondary: this.secondary.name,
        error: errMsg,
      });
      throw error;
    }
  }

  /**
   * Language pair is supported if either provider supports it.
   * When source is empty, the primary (DeepL) can auto-detect.
   */
  supportsLanguagePair(source: string, target: string): boolean {
    return (
      this.primary.supportsLanguagePair(source, target) ||
      this.secondary.supportsLanguagePair(source, target)
    );
  }

  /**
   * Healthy if either provider is healthy.
   */
  async checkHealth(): Promise<{ healthy: boolean; latencyMs?: number }> {
    const [primaryHealth, secondaryHealth] = await Promise.allSettled([
      this.primary.checkHealth(),
      this.secondary.checkHealth(),
    ]);

    const primaryOk =
      primaryHealth.status === "fulfilled" && primaryHealth.value.healthy;
    const secondaryOk =
      secondaryHealth.status === "fulfilled" && secondaryHealth.value.healthy;

    logger.debug("Fallback provider health check", {
      primary: { name: this.primary.name, healthy: primaryOk },
      secondary: { name: this.secondary.name, healthy: secondaryOk },
    });

    // Healthy if at least one is healthy
    return { healthy: primaryOk || secondaryOk };
  }

  /**
   * Gets combined metrics.
   */
  getMetrics() {
    return {
      primarySuccessCount: this.primarySuccessCount,
      primaryFailureCount: this.primaryFailureCount,
      secondarySuccessCount: this.secondarySuccessCount,
      secondaryFailureCount: this.secondaryFailureCount,
      fallbackRate:
        this.primarySuccessCount + this.primaryFailureCount > 0
          ? this.primaryFailureCount /
            (this.primarySuccessCount + this.primaryFailureCount)
          : 0,
    };
  }
}
