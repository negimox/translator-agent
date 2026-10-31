/**
 * Builds the TranslationPipeline for an agent.
 *
 * Kept separate from TranslatorAgent so it can be tested without Chrome. The
 * ProviderFactory alone decides which credentials the chosen
 * TRANSLATION_PROVIDER needs (DeepL only, Mizan only, or both), so this does
 * not second-guess them.
 */

import { AgentConfig } from "../config";
import { TranslationPipeline } from "../mizan";
import { ProviderFactory } from "../providers";

export type CreatePipelineResult =
  | { pipeline: TranslationPipeline }
  | { error: string };

export function createTranslationPipeline(
  config: AgentConfig,
  getFactory: () => ProviderFactory,
): CreatePipelineResult {
  if (!config.elevenLabsApiKey) {
    return {
      error: "ELEVENLABS_API_KEY not set - realtime STT and TTS unavailable",
    };
  }

  try {
    const providerFactory = getFactory();
    // Surface missing translation credentials now rather than on first sentence.
    providerFactory.getTranslationProvider();

    const pipeline = new TranslationPipeline({
      providerFactory,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      translationTemplatePattern: config.translationTemplatePattern,
      ttsSpeed: config.ttsSpeed,
      retryInitialDelayMs: config.retryInitialDelayMs,
      retryMaxDelayMs: config.retryMaxDelayMs,
      maxRetries: config.maxRetries,
      tokenBucketCapacity: config.tokenBucketCapacity,
      tokenBucketRefillRate: config.tokenBucketRefillRate,
      circuitBreakerErrorThreshold: config.circuitBreakerErrorThreshold,
      circuitBreakerWindowMs: config.circuitBreakerWindowMs,
      circuitBreakerOpenTimeoutMs: config.circuitBreakerOpenTimeoutMs,
    });
    return { pipeline };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
