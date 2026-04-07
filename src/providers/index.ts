/**
 * Provider Module Exports (Phase 7.1)
 *
 * Unified exports for STT, Translation, and TTS providers.
 */

// Types
export {
  ISTTProvider,
  ITranslationProvider,
  ITTSProvider,
  STTRequest,
  STTResponse,
  TranslationRequest,
  TranslationResponse,
  TTSRequest,
  TTSResponse,
  ProviderError,
  VoiceConfig,
  ProviderConfig,
} from "./types";

// Factory
export {
  ProviderFactory,
  ProviderFactoryConfig,
  STTProviderType,
  TranslationProviderType,
  TTSProviderType,
  initializeProviderFactory,
  getProviderFactory,
} from "./ProviderFactory";

// ElevenLabs
export { ElevenLabsSTT } from "./elevenlabs/ElevenLabsSTT";
export { ElevenLabsTTS } from "./elevenlabs/ElevenLabsTTS";
export {
  ElevenLabsConfig,
  ELEVENLABS_API,
  ELEVENLABS_MODELS,
  ELEVENLABS_STT_MODELS,
  ELEVENLABS_VOICES,
  ELEVENLABS_STT_LANGUAGES,
  ELEVENLABS_TTS_LANGUAGES,
  ELEVENLABS_RATE_LIMITS,
  getVoiceConfig,
  selectTTSModel,
} from "./elevenlabs/config";

// Mizan
export {
  MizanTranslation,
  MizanTranslationConfig,
  DEFAULT_MIZAN_TRANSLATION_CONFIG,
} from "./mizan/MizanTranslation";
