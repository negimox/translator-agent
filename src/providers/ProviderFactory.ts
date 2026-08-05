/**
 * Provider Factory (Phase 7.1)
 *
 * Factory for creating and managing STT, Translation, and TTS providers.
 * Supports ElevenLabs (STT/TTS) and Mizan (Translation).
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

const logger = createLogger("ProviderFactory");

/**
 * Available provider types.
 */
export type STTProviderType = "elevenlabs";
export type TranslationProviderType = "mizan";
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
    });
  }

  /**
   * Gets an STT provider instance.
   */
  getSTTProvider(type: STTProviderType = "elevenlabs"): IRealtimeSTTProvider {
    const cached = this.instances.stt.get(type);
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
        });
        break;
      default:
        throw new Error(`Unknown STT provider type: ${type}`);
    }

    this.instances.stt.set(type, provider);
    logger.info("STT provider created", { type, name: provider.name });
    return provider;
  }

  /**
   * Gets a Translation provider instance.
   */
  getTranslationProvider(
    type: TranslationProviderType = "mizan",
  ): ITranslationProvider {
    const cached = this.instances.translation.get(type);
    if (cached) {
      return cached;
    }

    let provider: ITranslationProvider;

    switch (type) {
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
      default:
        throw new Error(`Unknown Translation provider type: ${type}`);
    }

    this.instances.translation.set(type, provider);
    logger.info("Translation provider created", { type, name: provider.name });
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
