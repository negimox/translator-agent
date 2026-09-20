/**
 * Provider Factory (Phase 7.1 / DeepL update)
 *
 * Factory for creating and managing STT, Translation, and TTS providers.
 * Supports ElevenLabs (STT/TTS), Mizan LLM (Translation), and DeepL (Translation).
 *
 * Default translation strategy: 'deepl-with-mizan-fallback'
 *   - DeepL handles all requests (fast, deterministic, no context leaking)
 *   - Mizan LLM takes over automatically if DeepL fails or is unconfigured
 */

import { createLogger } from "../logger";
import {
  IRealtimeSTTProvider,
  ITranslationProvider,
  ITTSProvider,
  ProviderConfig,
} from "./types";
import { ElevenLabsRealtimeSTT } from "./elevenlabs/ElevenLabsRealtimeSTT";
import { ElevenLabsTTS } from "./elevenlabs/ElevenLabsTTS";
import {
  MizanTranslation,
  MizanTranslationConfig,
} from "./mizan/MizanTranslation";
import {
  DeepLTranslation,
  DeepLTranslationConfig,
} from "./deepl/DeepLTranslation";
import { FallbackTranslation } from "./FallbackTranslation";

const logger = createLogger("ProviderFactory");

/**
 * Available provider types.
 */
export type STTProviderType = "elevenlabs";
export type TranslationProviderType =
  | "mizan"
  | "deepl"
  | "deepl-with-mizan-fallback";
export type TTSProviderType = "elevenlabs";

/**
 * Provider factory configuration.
 */
export interface ProviderFactoryConfig {
  elevenlabs?: {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
  };
  mizan?: {
    username: string;
    password: string;
    baseUrl?: string;
    timeoutMs?: number;
    templatePattern?: string;
  };
  deepl?: {
    apiKey: string;
    /** Defaults to https://api-free.deepl.com/v2 */
    baseUrl?: string;
    timeoutMs?: number;
  };
  /**
   * Which translation provider to use.
   * - 'deepl'                    → DeepL only (fastest, no context leaking)
   * - 'mizan'                    → Mizan LLM only (legacy)
   * - 'deepl-with-mizan-fallback' → DeepL primary, Mizan fallback (default)
   */
  translationProvider?: TranslationProviderType;
}

/**
 * Provider instances managed by the factory.
 */
interface ProviderInstances {
  stt: Map<string, IRealtimeSTTProvider>;
  translation: Map<string, ITranslationProvider>;
  tts: Map<string, ITTSProvider>;
}

/**
 * Provider Factory.
 *
 * Creates and caches provider instances for reuse.
 * Ensures singleton pattern for each provider type.
 */
export class ProviderFactory {
  private config: ProviderFactoryConfig;
  private instances: ProviderInstances = {
    stt: new Map(),
    translation: new Map(),
    tts: new Map(),
  };

  constructor(config: ProviderFactoryConfig) {
    this.config = config;

    // Validate required configurations
    if (!config.elevenlabs?.apiKey) {
      logger.warn("ElevenLabs API key not configured - STT/TTS will fail");
    }
    if (!config.mizan?.username || !config.mizan?.password) {
      logger.warn("Mizan credentials not configured - Translation will fail");
    }

    logger.info("ProviderFactory initialized", {
      hasElevenLabs: !!config.elevenlabs?.apiKey,
      hasMizan: !!config.mizan?.username,
      hasDeepL: !!config.deepl?.apiKey,
      translationProvider: config.translationProvider || "deepl-with-mizan-fallback",
    });
  }

  getSTTProvider(
    type: STTProviderType = "elevenlabs",
    options?: { languageCode?: string; instanceId?: string }
  ): IRealtimeSTTProvider {
    const cacheKey = `${type}_${options?.instanceId || 'default'}`;
    const cached = this.instances.stt.get(cacheKey);
    if (cached) {
      return cached;
    }

    let provider: IRealtimeSTTProvider;

    switch (type) {
      case "elevenlabs":
        if (!this.config.elevenlabs?.apiKey) {
          throw new Error("ElevenLabs API key not configured");
        }
        provider = new ElevenLabsRealtimeSTT({
          apiKey: this.config.elevenlabs.apiKey,
          languageCode: options?.languageCode,
        });
        break;
      default:
        throw new Error(`Unknown STT provider type: ${type}`);
    }

    this.instances.stt.set(cacheKey, provider);
    logger.info("STT provider created", { type, name: provider.name, cacheKey });
    return provider;
  }

  /**
   * Gets a Translation provider instance.
   *
   * Type selection:
   *   'deepl'                    → DeepL only
   *   'mizan'                    → Mizan LLM only
   *   'deepl-with-mizan-fallback' → DeepL primary, Mizan automatic fallback
   */
  getTranslationProvider(
    type?: TranslationProviderType,
  ): ITranslationProvider {
    // Use configured default if not specified
    const resolvedType =
      type ||
      this.config.translationProvider ||
      "deepl-with-mizan-fallback";

    const cached = this.instances.translation.get(resolvedType);
    if (cached) {
      return cached;
    }

    let provider: ITranslationProvider;

    switch (resolvedType) {
      case "mizan":
        if (!this.config.mizan?.username || !this.config.mizan?.password) {
          throw new Error("Mizan credentials not configured");
        }
        provider = new MizanTranslation({
          username: this.config.mizan.username,
          password: this.config.mizan.password,
          baseUrl: this.config.mizan.baseUrl,
          timeoutMs: this.config.mizan.timeoutMs,
          templatePattern: this.config.mizan.templatePattern,
        });
        break;

      case "deepl":
        if (!this.config.deepl?.apiKey) {
          throw new Error(
            "DeepL API key not configured (DEEPL_API_KEY)",
          );
        }
        provider = new DeepLTranslation({
          apiKey: this.config.deepl.apiKey,
          baseUrl: this.config.deepl.baseUrl,
          timeoutMs: this.config.deepl.timeoutMs,
        });
        break;

      case "deepl-with-mizan-fallback": {
        // Build DeepL primary
        if (!this.config.deepl?.apiKey) {
          logger.warn(
            "DeepL API key not configured — falling back to Mizan-only mode",
          );
          // Degrade gracefully to Mizan-only if DeepL key is absent
          return this.getTranslationProvider("mizan");
        }
        const deepLProvider = new DeepLTranslation({
          apiKey: this.config.deepl.apiKey,
          baseUrl: this.config.deepl.baseUrl,
          timeoutMs: this.config.deepl.timeoutMs,
        });

        // Build Mizan fallback (optional — if credentials not configured, use DeepL only)
        if (!this.config.mizan?.username || !this.config.mizan?.password) {
          logger.warn(
            "Mizan credentials not configured — using DeepL-only mode (no fallback)",
          );
          provider = deepLProvider;
        } else {
          const mizanProvider = new MizanTranslation({
            username: this.config.mizan.username,
            password: this.config.mizan.password,
            baseUrl: this.config.mizan.baseUrl,
            timeoutMs: this.config.mizan.timeoutMs,
            templatePattern: this.config.mizan.templatePattern,
          });
          provider = new FallbackTranslation(deepLProvider, mizanProvider);
        }
        break;
      }

      default:
        throw new Error(`Unknown Translation provider type: ${resolvedType}`);
    }

    this.instances.translation.set(resolvedType, provider);
    logger.info("Translation provider created", {
      type: resolvedType,
      name: provider.name,
    });
    return provider;
  }

  /**
   * Gets a TTS provider instance.
   */
  getTTSProvider(type: TTSProviderType = "elevenlabs"): ITTSProvider {
    const cached = this.instances.tts.get(type);
    if (cached) {
      return cached;
    }

    let provider: ITTSProvider;

    switch (type) {
      case "elevenlabs":
        if (!this.config.elevenlabs?.apiKey) {
          throw new Error("ElevenLabs API key not configured");
        }
        provider = new ElevenLabsTTS({
          apiKey: this.config.elevenlabs.apiKey,
          baseUrl: this.config.elevenlabs.baseUrl,
          timeoutMs: this.config.elevenlabs.timeoutMs,
        });
        break;
      default:
        throw new Error(`Unknown TTS provider type: ${type}`);
    }

    this.instances.tts.set(type, provider);
    logger.info("TTS provider created", { type, name: provider.name });
    return provider;
  }

  /**
   * Checks health of all configured providers.
   */
  async checkAllHealth(): Promise<{
    stt: { [key: string]: { healthy: boolean; latencyMs?: number } };
    translation: { [key: string]: { healthy: boolean; latencyMs?: number } };
    tts: { [key: string]: { healthy: boolean; latencyMs?: number } };
  }> {
    const results = {
      stt: {} as { [key: string]: { healthy: boolean; latencyMs?: number } },
      translation: {} as {
        [key: string]: { healthy: boolean; latencyMs?: number };
      },
      tts: {} as { [key: string]: { healthy: boolean; latencyMs?: number } },
    };

    // STT is streaming now, just assume healthy if connected (or skip check)
    for (const [type, provider] of this.instances.stt) {
      results.stt[type] = { healthy: true };
    }

    // Check Translation providers
    for (const [type, provider] of this.instances.translation) {
      results.translation[type] = await provider.checkHealth();
    }

    // Check TTS providers
    for (const [type, provider] of this.instances.tts) {
      results.tts[type] = await provider.checkHealth();
    }

    return results;
  }

  /**
   * Clears all cached provider instances.
   */
  clearInstances(): void {
    // Disconnect STT before clearing
    for (const provider of this.instances.stt.values()) {
      provider.disconnect();
    }
    this.instances.stt.clear();
    this.instances.translation.clear();
    this.instances.tts.clear();
    logger.info("All provider instances cleared");
  }

  /**
   * Gets all supported languages for STT.
   */
  getSTTSupportedLanguages(): string[] {
    return ["en", "hi", "ur", "ar"]; // Default supported languages
  }

  /**
   * Gets all supported languages for TTS.
   */
  getTTSSupportedLanguages(): string[] {
    try {
      const provider = this.getTTSProvider();
      return provider.supportedLanguages;
    } catch {
      return [];
    }
  }

  /**
   * Gets all supported language pairs for translation.
   */
  getTranslationSupportedPairs(): Array<{ source: string; target: string }> {
    try {
      const provider = this.getTranslationProvider();
      return provider.supportedLanguagePairs;
    } catch {
      return [];
    }
  }
}

/**
 * Singleton factory instance.
 */
let factoryInstance: ProviderFactory | null = null;

/**
 * Initializes the global provider factory.
 */
export function initializeProviderFactory(
  config: ProviderFactoryConfig,
): ProviderFactory {
  factoryInstance = new ProviderFactory(config);
  return factoryInstance;
}

/**
 * Gets the global provider factory instance.
 * Must call initializeProviderFactory first.
 */
export function getProviderFactory(): ProviderFactory {
  if (!factoryInstance) {
    throw new Error(
      "ProviderFactory not initialized. Call initializeProviderFactory first.",
    );
  }
  return factoryInstance;
}
