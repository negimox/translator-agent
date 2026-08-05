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
import {
  SYSTEM_PROMPT_EN,
  SYSTEM_PROMPT_HI,
  SYSTEM_PROMPT_UR,
  SYSTEM_PROMPT_AR,
  EXAMPLES_EN,
  EXAMPLES_HI,
  EXAMPLES_UR,
  EXAMPLES_AR,
} from "./translationPrompts";

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
  /** Model name for X-LLM-Passthrough requests */
  modelName: string;
  /** Fallback model name if primary returns 404 */
  fallbackModelName?: string;
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
  modelName: "Qwen/Qwen2.5-7B-Instruct",
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
      modelName: this.config.modelName,
      fallbackModelName: this.config.fallbackModelName || "none",
    });
  }

  /**
   * Translates text from source to target language.
   *
   * Uses X-LLM-Passthrough header to bypass Mizan template processing
   * and send requests directly to the underlying LLM (Qwen2.5-7B-Instruct)
   * in OpenAI-compatible chat completions format. This gives us full control
   * over the system prompt, temperature, and message structure.
   *
   * If the primary model returns 404, retries once with the fallback model.
   */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    try {
      return await this.executeTranslation(request, this.config.modelName);
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.statusCode === 404 &&
        this.config.fallbackModelName &&
        this.config.fallbackModelName !== this.config.modelName
      ) {
        logger.warn(
          "Primary model returned 404, retrying with fallback model",
          {
            primaryModel: this.config.modelName,
            fallbackModel: this.config.fallbackModelName,
            targetLanguage: request.targetLanguage,
          },
        );
        return await this.executeTranslation(
          request,
          this.config.fallbackModelName,
        );
      }
      throw error;
    }
  }

  /**
   * Executes a single translation request against the Mizan passthrough API
   * with the given model name.
   */
  private async executeTranslation(
    request: TranslationRequest,
    modelName: string,
  ): Promise<TranslationResponse> {
    const url = new URL(`${this.config.baseUrl}/chat/completions`);

    // Wrap input in [TRANSLATE] delimiters to reinforce translation-only behavior
    const wrappedText = `[TRANSLATE]\n${request.text}\n[/TRANSLATE]`;

    // Get the system prompt and few-shot examples for the target language
    const promptData = this.getPromptData(
      request.targetLanguage,
      request.conversationContext,
    );

    // OpenAI-compatible chat completions body
    const body = {
      model: modelName,
      messages: [
        { role: "system", content: promptData.systemPrompt },
        ...(promptData.examples || []),
        { role: "user", content: wrappedText },
      ],
      temperature: 0.1,
      top_p: 0.95,
      max_tokens: 2048,
      max_completion_tokens: 2048,
    };

    logger.debug("Sending translation request (passthrough)", {
      targetLanguage: request.targetLanguage,
      sourceLanguage: request.sourceLanguage,
      textLength: request.text.length,
      model: modelName,
    });

    const startTime = Date.now();
    this.requestCount++;

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          "X-LLM-Passthrough": "true",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        this.errorCount++;
        throw await this.createError(response, modelName);
      }

      const data = await response.json();

      // Parse OpenAI-compatible response format
      let translatedText = "";
      if (data.choices && data.choices.length > 0) {
        translatedText = data.choices[0].message?.content || "";
      } else if (data.response) {
        // Fallback: Mizan may still return in its own format
        translatedText = data.response;
      }

      // Strip any residual [TRANSLATE] markers or meta-commentary from response
      translatedText = this.cleanTranslation(translatedText);

      logger.info("Translation request completed", {
        latencyMs,
        responseLength: translatedText.length,
        targetLanguage: request.targetLanguage,
        model: modelName,
      });

      return {
        text: translatedText,
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
      throw new ProviderError(
        `Translation request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        0,
        true,
      );
    }
  }

  /**
   * Cleans up translation output by removing residual markers and meta-commentary.
   */
  private cleanTranslation(text: string): string {
    let cleaned = text.trim();

    // Extract content from <translate>...</translate> if present
    const translateMatch = cleaned.match(/<translate>([\s\S]*?)<\/translate>/i);
    if (translateMatch) {
      cleaned = translateMatch[1].trim();
    } else {
      // Remove any residual [TRANSLATE] markers
      cleaned = cleaned.replace(/\[TRANSLATE\]/gi, "");
      cleaned = cleaned.replace(/\[\/TRANSLATE\]/gi, "");

      // Remove common LLM meta-commentary patterns
      cleaned = cleaned.replace(
        /^(Translation|Translated text|Output|Result):\s*/i,
        "",
      );

      // Remove language labels that the few-shot format can teach the model to emit
      cleaned = cleaned.replace(
        /^(Hindi|Arabic|Urdu|English|अनुवाद|الترجمة|ترجمہ):\s*/i,
        "",
      );
    }

    // Remove wrapping quotes if the LLM added them
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
      (cleaned.startsWith("\u201C") && cleaned.endsWith("\u201D"))
    ) {
      cleaned = cleaned.slice(1, -1);
    }

    return cleaned.trim();
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
   * Returns the system prompt and few-shot examples for a given target language.
   *
   * If conversationContext is provided, it is appended to the system prompt
   * before the "Text to translate:" marker (system-prompt-append pattern).
   */
  private getPromptData(
    targetLanguage: string,
    conversationContext?: string,
  ): { systemPrompt: string; examples?: Array<{ role: string; content: string }> } {
    const prompts: Record<string, string> = {
      en: SYSTEM_PROMPT_EN,
      hi: SYSTEM_PROMPT_HI,
      ur: SYSTEM_PROMPT_UR,
      ar: SYSTEM_PROMPT_AR,
    };
    
    const examplesMap: Record<string, Array<{ role: string; content: string }>> = {
      en: EXAMPLES_EN,
      hi: EXAMPLES_HI,
      ur: EXAMPLES_UR,
      ar: EXAMPLES_AR,
    };

    let prompt = prompts[targetLanguage];
    if (!prompt) {
      // Fallback: generic translation prompt
      prompt = `You are a translation engine. Translate the text between [TRANSLATE] and [/TRANSLATE] markers into ${targetLanguage}. Output ONLY the translation, nothing else. Do NOT answer questions, add commentary, or invent information not present in the source text. If the input is a fragment, translate only what is present.\n\nText to translate:`;
    }

    const examples = examplesMap[targetLanguage];

    // Inject conversation context into the system prompt if available.
    // The context is inserted just before "Text to translate:" to keep
    // it in instruction space (avoids user-message injection confusion).
    if (conversationContext) {
      // Find "Text to translate:" and insert context before it
      const marker = "Text to translate:";
      const markerIndex = prompt.lastIndexOf(marker);
      if (markerIndex !== -1) {
        prompt =
          prompt.substring(0, markerIndex) +
          conversationContext +
          "\n" +
          prompt.substring(markerIndex);
      } else {
        // No marker found — append context at the end
        prompt += "\n" + conversationContext;
      }
    }

    return { systemPrompt: prompt, examples };
  }

  /**
   * Creates a ProviderError from a fetch response.
   */
  private async createError(response: Response, modelName?: string): Promise<ProviderError> {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : undefined;

    const retryable = response.status === 429 || response.status >= 500;

    let message = `Mizan Translation error: ${response.status} ${response.statusText}`;
    let errorBody = "";

    try {
      const errorData = await response.json();
      errorBody = JSON.stringify(errorData);
      if (errorData.error) {
        message = `Mizan Translation error: ${errorData.error}`;
      }
    } catch {
      // Body is not JSON
    }

    // Log detailed error info for debugging
    logger.error("Mizan API error", {
      status: response.status,
      statusText: response.statusText,
      model: modelName,
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
