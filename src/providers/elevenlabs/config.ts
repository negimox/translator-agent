/**
 * ElevenLabs Configuration (Phase 7.1)
 *
 * Voice mappings, model selection, and API configuration
 * for ElevenLabs STT and TTS services.
 */

import { VoiceConfig } from "../types";

/**
 * ElevenLabs API endpoints.
 */
export const ELEVENLABS_API = {
  BASE_URL: "https://api.elevenlabs.io/v1",
  STT_ENDPOINT: "/speech-to-text",
  TTS_ENDPOINT: "/text-to-speech",
  VOICES_ENDPOINT: "/voices",
  USER_ENDPOINT: "/user",
};

/**
 * ElevenLabs TTS models.
 */
export const ELEVENLABS_MODELS = {
  /** Best quality for Urdu and 70+ languages */
  ELEVEN_V3: "eleven_v3",
  /** Low latency (~75ms), 32 languages - NO Urdu */
  ELEVEN_FLASH_V2_5: "eleven_flash_v2_5",
  /** Standard quality, 29 languages - NO Urdu */
  ELEVEN_MULTILINGUAL_V2: "eleven_multilingual_v2",
  /** Fast turbo model */
  ELEVEN_TURBO_V2_5: "eleven_turbo_v2_5",
} as const;

/**
 * ElevenLabs STT models.
 */
export const ELEVENLABS_STT_MODELS = {
  /** Batch STT model - 90+ languages */
  SCRIBE_V2: "scribe_v2",
  /** Realtime WebSocket STT - ~150ms latency */
  SCRIBE_V2_REALTIME: "scribe_v2_realtime",
} as const;

/**
 * Voice configurations per language.
 * Based on elevenlabs_voices.json analysis (April 2026).
 *
 * Key findings:
 * - Sarah (EXAVITQu4vr4xnSDxMaL): Only voice verified for Arabic, also has Hindi
 * - Nichalia (acCWxmzPBgXdHwA63uzP): Best multi-language voice (18 langs), Hindi verified
 * - Roger (CwhRBWXzGAHq8TQ4Fs17): Male English voice with flash support
 * - No Urdu-verified voices - must use eleven_v3 model
 */
export const ELEVENLABS_VOICES: Record<string, VoiceConfig> = {
  // Arabic - George for warm, captivating storytelling tone
  ar: {
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    model: ELEVENLABS_MODELS.ELEVEN_MULTILINGUAL_V2,
    verified: false,
    name: "George",
    gender: "male",
  },

  // Urdu - Reva (gentle, warm narration)
  ur: {
    voiceId: "UT6USLtoAlXHj5k4sOLY",
    model: ELEVENLABS_MODELS.ELEVEN_V3,
    verified: false,
    name: "Reva",
    gender: "female",
  },

  // English - River (relaxed, calm, informative)
  en: {
    voiceId: "SAz9YHcvj6GT2YYXdXww",
    model: ELEVENLABS_MODELS.ELEVEN_FLASH_V2_5,
    verified: true,
    name: "River",
    gender: "neutral",
  },

  // Hindi - Reva (gentle, warm narration)
  hi: {
    voiceId: "UT6USLtoAlXHj5k4sOLY",
    model: ELEVENLABS_MODELS.ELEVEN_FLASH_V2_5,
    verified: true,
    name: "Reva",
    gender: "female",
  },
};

/**
 * Gets the voice configuration for a language.
 * Falls back to eleven_v3 with Sarah voice for unsupported languages.
 */
export function getVoiceConfig(language: string): VoiceConfig {
  const config = ELEVENLABS_VOICES[language];
  if (config) {
    return config;
  }

  // Fallback: Use Sarah with eleven_v3 (broadest language support)
  return {
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    model: ELEVENLABS_MODELS.ELEVEN_V3,
    verified: false,
    name: "Sarah (fallback)",
    gender: "female",
  };
}

/**
 * Selects the TTS model based on target language.
 * - Urdu requires eleven_v3 (only model with Urdu support)
 * - Arabic uses multilingual_v2 (verified quality)
 * - Other languages use flash for lowest latency
 */
export function selectTTSModel(targetLanguage: string): string {
  switch (targetLanguage) {
    case "ur":
      return ELEVENLABS_MODELS.ELEVEN_V3;
    case "ar":
      return ELEVENLABS_MODELS.ELEVEN_MULTILINGUAL_V2;
    default:
      return ELEVENLABS_MODELS.ELEVEN_FLASH_V2_5;
  }
}

/**
 * Supported languages for ElevenLabs STT (Scribe v2).
 * Scribe v2 supports 90+ languages including:
 */
export const ELEVENLABS_STT_LANGUAGES = [
  "en", // English
  "hi", // Hindi
  "ar", // Arabic
  "ur", // Urdu
  "es", // Spanish
  "fr", // French
  "de", // German
  "it", // Italian
  "pt", // Portuguese
  "ru", // Russian
  "ja", // Japanese
  "ko", // Korean
  "zh", // Chinese
  "nl", // Dutch
  "pl", // Polish
  "tr", // Turkish
  "vi", // Vietnamese
  "th", // Thai
  "id", // Indonesian
  "ms", // Malay
  "ta", // Tamil
  "te", // Telugu
  "bn", // Bengali
  "gu", // Gujarati
  "mr", // Marathi
  "pa", // Punjabi
  // ... and many more
];

/**
 * Supported languages for ElevenLabs TTS.
 * eleven_v3 supports 70+ languages.
 * eleven_flash_v2_5 supports 32 languages (NO Urdu).
 */
export const ELEVENLABS_TTS_LANGUAGES = [
  "en", // English
  "hi", // Hindi
  "ar", // Arabic
  "ur", // Urdu (eleven_v3 only)
  "es", // Spanish
  "fr", // French
  "de", // German
  "it", // Italian
  "pt", // Portuguese
  "ru", // Russian
  "ja", // Japanese
  "ko", // Korean
  "zh", // Chinese
  "nl", // Dutch
  "pl", // Polish
  "tr", // Turkish
  "vi", // Vietnamese
  "th", // Thai
  "id", // Indonesian
  "ta", // Tamil
  // ... and many more
];

/**
 * ElevenLabs rate limits (Creator Plan - $22/mo).
 */
export const ELEVENLABS_RATE_LIMITS = {
  /** TTS concurrent requests (v2/v3 models) */
  TTS_CONCURRENCY_V2_V3: 5,
  /** TTS concurrent requests (Flash model) */
  TTS_CONCURRENCY_FLASH: 10,
  /** STT concurrent requests */
  STT_CONCURRENCY: 20,
  /** Monthly credits */
  MONTHLY_CREDITS: 100_000,
};

/**
 * Default ElevenLabs configuration.
 */
export interface ElevenLabsConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export const DEFAULT_ELEVENLABS_CONFIG: Omit<ElevenLabsConfig, "apiKey"> = {
  baseUrl: ELEVENLABS_API.BASE_URL,
  timeoutMs: 30000,
};
