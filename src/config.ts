/**
 * Configuration module for the Jitsi Translator Agent.
 * Loads settings from environment variables with sensible defaults.
 */

import * as dotenv from "dotenv";
import * as path from "path";

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
  // Mizan API settings (Phase 4)
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
 * Parses a boolean environment variable.
 */
function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

/**
 * Parses an integer environment variable.
 */
function parseInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parses a float environment variable.
 */
function parseFloat(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Validates required environment variables.
 */
function validateRequired(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Loads and validates the agent configuration from environment variables.
 */
export function loadConfig(): AgentConfig {
  return {
    // Jitsi connection
    jitsiDomain: validateRequired("JITSI_DOMAIN", process.env.JITSI_DOMAIN),
    roomName: validateRequired("ROOM_NAME", process.env.ROOM_NAME),
    targetLanguage: process.env.TARGET_LANGUAGE || "en",
    sourceLanguage: process.env.SOURCE_LANGUAGE || "en", // Phase 4
    displayNamePrefix: process.env.AGENT_DISPLAY_NAME_PREFIX || "translator-",

    // Audio/Worklet settings (Phase 2)
    workletHeartbeatIntervalMs: parseInt(
      process.env.WORKLET_HEARTBEAT_INTERVAL_MS,
      300,
    ),
    heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS, 1500),
    audioContextResumeRetries: parseInt(
      process.env.AUDIOCONTEXT_RESUME_RETRIES,
      5,
    ),
    audioContextResumeBackoffMs: parseInt(
      process.env.AUDIOCONTEXT_RESUME_BACKOFF_MS,
      500,
    ),

    // VAD settings (Phase 3)
    vadRmsThreshold: parseFloat(process.env.VAD_RMS_THRESHOLD, 0.01), // -40dB
    vadSmoothingFrames: parseInt(process.env.VAD_SMOOTHING_FRAMES, 3),
    vadSilenceCoalesceMs: parseInt(process.env.VAD_SILENCE_COALESCE_MS, 250),

    // Chunk aggregation settings (Phase 3)
    targetChunkDurationMs: parseInt(process.env.TARGET_CHUNK_DURATION_MS, 900),
    minChunkDurationMs: parseInt(process.env.MIN_CHUNK_DURATION_MS, 300),
    maxChunkDurationMs: parseInt(process.env.MAX_CHUNK_DURATION_MS, 3000),
    sampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE, 48000),

    // Debug settings (Phase 3)
    debugMode: parseBool(process.env.DEBUG_MODE, false),
    debugOutputDir: process.env.DEBUG_OUTPUT_DIR || "./debug_chunks",
    maxDebugChunks: parseInt(process.env.MAX_DEBUG_CHUNKS, 100),

    // Health check
    healthPort: parseInt(process.env.HEALTH_PORT, 8080),

    // Bot page server
    botPagePort: parseInt(process.env.BOT_PAGE_PORT, 3001),

    // Puppeteer settings
    chromeHeadless: parseBool(process.env.CHROME_HEADLESS, true),
    chromeDevtools: parseBool(process.env.CHROME_DEVTOOLS, false),

    // ============================================================================
    // Mizan API settings (Phase 4)
    // ============================================================================
    mizanBaseUrl:
      process.env.MIZAN_BASE_URL || "https://platform.mizanlabs.com/api/v1",
    mizanUsername: process.env.MIZAN_USERNAME || "",
    mizanPassword: process.env.MIZAN_PASSWORD || "",
    mizanTimeoutMs: parseInt(process.env.MIZAN_TIMEOUT_MS, 30000),

    // Translation settings (Phase 4)
    translationTemplatePattern:
      process.env.TRANSLATION_TEMPLATE_PATTERN || "translator_{target}",
    ttsVoice: process.env.TTS_VOICE || "af_heart",
    ttsSpeed: parseFloat(process.env.TTS_SPEED, 1.0),

    // Rate limiting (Phase 4)
    tokenBucketCapacity: parseInt(process.env.TOKEN_BUCKET_CAPACITY, 8),
    tokenBucketRefillRate: parseInt(process.env.TOKEN_BUCKET_REFILL_RATE, 8),

    // Circuit breaker (Phase 4)
    circuitBreakerErrorThreshold: parseFloat(
      process.env.CIRCUIT_BREAKER_ERROR_THRESHOLD,
      0.1,
    ),
    circuitBreakerWindowMs: parseInt(
      process.env.CIRCUIT_BREAKER_WINDOW_MS,
      60000,
    ),
    circuitBreakerOpenTimeoutMs: parseInt(
      process.env.CIRCUIT_BREAKER_OPEN_TIMEOUT_MS,
      10000,
    ),

    // Queue settings (Phase 4)
    maxQueueLength: parseInt(process.env.MAX_QUEUE_LENGTH, 12),
    maxInFlight: parseInt(process.env.MAX_IN_FLIGHT, 2),

    // Retry settings (Phase 4)
    retryInitialDelayMs: parseInt(process.env.RETRY_INITIAL_DELAY_MS, 500),
    retryMaxDelayMs: parseInt(process.env.RETRY_MAX_DELAY_MS, 8000),
    maxRetries: parseInt(process.env.MAX_RETRIES, 3),

    // Adaptive chunking (Phase 4)
    adaptiveChunkingEnabled: parseBool(
      process.env.ADAPTIVE_CHUNKING_ENABLED,
      true,
    ),
    adaptiveUpdateIntervalMs: parseInt(
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
