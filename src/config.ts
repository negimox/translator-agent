/**
 * Configuration module for the Jitsi Translator Agent.
 * Loads settings from environment variables with sensible defaults.
 */

import * as dotenv from "dotenv";
import * as path from "path";
import {
  parseBoolEnv,
  parseIntEnv,
  parseFloatEnv,
  validateRequiredEnv,
} from "./utils/envParsing";

// Load .env file if present
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/**
 * Agent configuration interface.
 */
export interface AgentConfig {
  // Jitsi connection
  jitsiDomain: string;
  roomName: string;
  targetLanguage: string;
  sourceLanguage: string; // Phase 4: Source language for STT
  displayNamePrefix: string;

  // Audio/Worklet settings (Phase 2)
  workletHeartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  audioContextResumeRetries: number;
  audioContextResumeBackoffMs: number;

  // VAD settings (Phase 3)
  vadRmsThreshold: number; // RMS threshold for voice activity (0.01 = -40dB)
  vadSmoothingFrames: number; // Number of frames for VAD smoothing
  vadSilenceCoalesceMs: number; // Max silence to coalesce between utterances

  // Chunk aggregation settings (Phase 3)
  targetChunkDurationMs: number; // Default target chunk duration
  minChunkDurationMs: number; // Minimum chunk duration
  maxChunkDurationMs: number; // Maximum chunk duration
  sampleRate: number; // Audio sample rate (48000 for Jitsi)

  // Debug settings (Phase 3)
  debugMode: boolean;
  debugOutputDir: string;
  maxDebugChunks: number;

  // Health check
  healthPort: number;

  // Bot page server
  botPagePort: number;

  // Puppeteer settings
  chromeHeadless: boolean;
  chromeDevtools: boolean;

  // ============================================================================
  // ElevenLabs API settings (Phase 7.1)
  // ============================================================================
  elevenLabsApiKey: string;
  elevenLabsBaseUrl: string;
  elevenLabsTimeoutMs: number;

  // ============================================================================
  // Mizan API settings (Phase 4, Translation only in Phase 7.1+)
  // ============================================================================
  mizanBaseUrl: string;
  mizanUsername: string;
  mizanPassword: string;
  mizanTimeoutMs: number;

  // Translation settings (Phase 4)
  translationTemplatePattern: string; // e.g., 'translator_{source}_to_{target}'
  ttsVoice: string;
  ttsSpeed: number;

  // Rate limiting (Phase 4)
  tokenBucketCapacity: number;
  tokenBucketRefillRate: number;

  // Circuit breaker (Phase 4)
  circuitBreakerErrorThreshold: number;
  circuitBreakerWindowMs: number;
  circuitBreakerOpenTimeoutMs: number;

  // Queue settings (Phase 4)
  maxQueueLength: number;
  maxInFlight: number;

  // Retry settings (Phase 4)
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  maxRetries: number;

  // Adaptive chunking (Phase 4)
  adaptiveChunkingEnabled: boolean;
  adaptiveUpdateIntervalMs: number;

  // Logging
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * Loads and validates the agent configuration from environment variables.
 */
export function loadConfig(): AgentConfig {
  return {
    // Jitsi connection
    jitsiDomain: validateRequiredEnv("JITSI_DOMAIN", process.env.JITSI_DOMAIN),
    roomName: validateRequiredEnv("ROOM_NAME", process.env.ROOM_NAME),
    targetLanguage: process.env.TARGET_LANGUAGE || "en",
    sourceLanguage: process.env.SOURCE_LANGUAGE || "en", // Phase 4
    displayNamePrefix: process.env.AGENT_DISPLAY_NAME_PREFIX || "translator-",

    // Audio/Worklet settings (Phase 2)
    workletHeartbeatIntervalMs: parseIntEnv(
      process.env.WORKLET_HEARTBEAT_INTERVAL_MS,
      300,
    ),
    heartbeatTimeoutMs: parseIntEnv(process.env.HEARTBEAT_TIMEOUT_MS, 1500),
    audioContextResumeRetries: parseIntEnv(
      process.env.AUDIOCONTEXT_RESUME_RETRIES,
      5,
    ),
    audioContextResumeBackoffMs: parseIntEnv(
      process.env.AUDIOCONTEXT_RESUME_BACKOFF_MS,
      500,
    ),

    // VAD settings (Phase 3)
    vadRmsThreshold: parseFloatEnv(process.env.VAD_RMS_THRESHOLD, 0.01), // -40dB
    vadSmoothingFrames: parseIntEnv(process.env.VAD_SMOOTHING_FRAMES, 3),
    vadSilenceCoalesceMs: parseIntEnv(process.env.VAD_SILENCE_COALESCE_MS, 250),

    // Chunk aggregation settings (Phase 3)
    targetChunkDurationMs: parseIntEnv(
      process.env.TARGET_CHUNK_DURATION_MS,
      900,
    ),
    minChunkDurationMs: parseIntEnv(process.env.MIN_CHUNK_DURATION_MS, 300),
    maxChunkDurationMs: parseIntEnv(process.env.MAX_CHUNK_DURATION_MS, 3000),
    sampleRate: parseIntEnv(process.env.AUDIO_SAMPLE_RATE, 48000),

    // Debug settings (Phase 3)
    debugMode: parseBoolEnv(process.env.DEBUG_MODE, false),
    debugOutputDir: process.env.DEBUG_OUTPUT_DIR || "./debug_chunks",
    maxDebugChunks: parseIntEnv(process.env.MAX_DEBUG_CHUNKS, 100),

    // Health check
    healthPort: parseIntEnv(process.env.HEALTH_PORT, 8080),

    // Bot page server
    botPagePort: parseIntEnv(process.env.BOT_PAGE_PORT, 3001),

    // Puppeteer settings
    chromeHeadless: parseBoolEnv(process.env.CHROME_HEADLESS, true),
    chromeDevtools: parseBoolEnv(process.env.CHROME_DEVTOOLS, false),

    // ============================================================================
    // ElevenLabs API settings (Phase 7.1)
    // ============================================================================
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "",
    elevenLabsBaseUrl:
      process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1",
    elevenLabsTimeoutMs: parseIntEnv(process.env.ELEVENLABS_TIMEOUT_MS, 30000),

    // ============================================================================
    // Mizan API settings (Phase 4, Translation only in Phase 7.1+)
    // ============================================================================
    mizanBaseUrl:
      process.env.MIZAN_BASE_URL || "https://platform.mizanlabs.com/api/v1",
    mizanUsername: process.env.MIZAN_USERNAME || "",
    mizanPassword: process.env.MIZAN_PASSWORD || "",
    mizanTimeoutMs: parseIntEnv(process.env.MIZAN_TIMEOUT_MS, 30000),

    // Translation settings (Phase 4)
    translationTemplatePattern:
      process.env.TRANSLATION_TEMPLATE_PATTERN || "translator_{target}",
    ttsVoice: process.env.TTS_VOICE || "af_heart",
    ttsSpeed: parseFloatEnv(process.env.TTS_SPEED, 1.0),

    // Rate limiting (Phase 4)
    tokenBucketCapacity: parseIntEnv(process.env.TOKEN_BUCKET_CAPACITY, 8),
    tokenBucketRefillRate: parseIntEnv(process.env.TOKEN_BUCKET_REFILL_RATE, 8),

    // Circuit breaker (Phase 4)
    circuitBreakerErrorThreshold: parseFloatEnv(
      process.env.CIRCUIT_BREAKER_ERROR_THRESHOLD,
      0.1,
    ),
    circuitBreakerWindowMs: parseIntEnv(
      process.env.CIRCUIT_BREAKER_WINDOW_MS,
      60000,
    ),
    circuitBreakerOpenTimeoutMs: parseIntEnv(
      process.env.CIRCUIT_BREAKER_OPEN_TIMEOUT_MS,
      10000,
    ),

    // Queue settings (Phase 4)
    maxQueueLength: parseIntEnv(process.env.MAX_QUEUE_LENGTH, 12),
    maxInFlight: parseIntEnv(process.env.MAX_IN_FLIGHT, 2),

    // Retry settings (Phase 4)
    retryInitialDelayMs: parseIntEnv(process.env.RETRY_INITIAL_DELAY_MS, 500),
    retryMaxDelayMs: parseIntEnv(process.env.RETRY_MAX_DELAY_MS, 8000),
    maxRetries: parseIntEnv(process.env.MAX_RETRIES, 3),

    // Adaptive chunking (Phase 4)
    adaptiveChunkingEnabled: parseBoolEnv(
      process.env.ADAPTIVE_CHUNKING_ENABLED,
      true,
    ),
    adaptiveUpdateIntervalMs: parseIntEnv(
      process.env.ADAPTIVE_UPDATE_INTERVAL_MS,
      1000,
    ),

    // Logging
    logLevel: (process.env.LOG_LEVEL as AgentConfig["logLevel"]) || "info",
  };
}

/**
 * Returns the display name for this translator agent.
 * Format: translator-<lang> (e.g., translator-en, translator-hi)
 */
export function getDisplayName(config: AgentConfig): string {
  return `${config.displayNamePrefix}${config.targetLanguage}`;
}

/**
 * Returns the full Jitsi meeting URL.
 * Note: This is used for logging. Actual connection uses JitsiMeetExternalAPI.
 */
export function getMeetingUrl(config: AgentConfig): string {
  const domain = config.jitsiDomain.replace(/\/$/, ""); // Remove trailing slash
  return `https://${domain}/${config.roomName}`;
}
