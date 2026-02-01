/**
 * Configuration module for the Jitsi Translator Agent.
 * Loads settings from environment variables with sensible defaults.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file if present
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Agent configuration interface.
 */
export interface AgentConfig {
    // Jitsi connection
    jitsiDomain: string;
    roomName: string;
    targetLanguage: string;
    displayNamePrefix: string;

    // Audio/Worklet settings
    workletHeartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    audioContextResumeRetries: number;
    audioContextResumeBackoffMs: number;

    // Health check
    healthPort: number;

    // Puppeteer settings
    chromeHeadless: boolean;
    chromeDevtools: boolean;

    // Logging
    logLevel: 'debug' | 'info' | 'warn' | 'error';

    // Phase 3: Chunk aggregation
    chunkTargetDurationMs: number;
    chunkMaxDurationMs: number;
    chunkMinSpeechMs: number;
    silenceCoalesceMs: number;

    // Phase 3: VAD
    vadEnergyThreshold: number;

    // Phase 3: STT
    sttSampleRate: number;
}

/**
 * Parses a boolean environment variable.
 */
function parseBool(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
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
function parseFloat(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number.parseFloat(value);
    return isNaN(parsed) ? undefined : parsed;
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
        jitsiDomain: validateRequired('JITSI_DOMAIN', process.env.JITSI_DOMAIN),
        roomName: validateRequired('ROOM_NAME', process.env.ROOM_NAME),
        targetLanguage: process.env.TARGET_LANGUAGE || 'en',
        displayNamePrefix: process.env.AGENT_DISPLAY_NAME_PREFIX || 'translator-',

        // Audio/Worklet settings
        workletHeartbeatIntervalMs: parseInt(process.env.WORKLET_HEARTBEAT_INTERVAL_MS, 300),
        heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS, 1500),
        audioContextResumeRetries: parseInt(process.env.AUDIOCONTEXT_RESUME_RETRIES, 5),
        audioContextResumeBackoffMs: parseInt(process.env.AUDIOCONTEXT_RESUME_BACKOFF_MS, 500),

        // Health check
        healthPort: parseInt(process.env.HEALTH_PORT, 8080),

        // Puppeteer settings
        chromeHeadless: parseBool(process.env.CHROME_HEADLESS, true),
        chromeDevtools: parseBool(process.env.CHROME_DEVTOOLS, false),

        // Logging
        logLevel: (process.env.LOG_LEVEL as AgentConfig['logLevel']) || 'info',

        // Phase 3: Chunk aggregation
        chunkTargetDurationMs: parseInt(process.env.CHUNK_TARGET_DURATION_MS, 900),
        chunkMaxDurationMs: parseInt(process.env.CHUNK_MAX_DURATION_MS, 3000),
        chunkMinSpeechMs: parseInt(process.env.CHUNK_MIN_SPEECH_MS, 200),
        silenceCoalesceMs: parseInt(process.env.SILENCE_COALESCE_MS, 250),

        // Phase 3: VAD
        vadEnergyThreshold: parseFloat(process.env.VAD_ENERGY_THRESHOLD) || 0.01,

        // Phase 3: STT
        sttSampleRate: parseInt(process.env.STT_SAMPLE_RATE, 16000),
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
    const domain = config.jitsiDomain.replace(/\/$/, ''); // Remove trailing slash
    return `https://${domain}/${config.roomName}`;
}


