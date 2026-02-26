/**
 * Orchestrator configuration (Phase 7)
 * Separate from agent config - loaded from environment variables.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface OrchestratorConfig {
  webhookPort: number;
  jitsiDomain: string;

  maxAgentsPerRoom: number;
  maxTotalAgents: number;
  spawnCooldownMs: number;
  terminationGraceMs: number;

  botPagePortBase: number;
  healthPortBase: number;

  healthCheckIntervalMs: number;
  healthCheckMaxFailures: number;
  maxRestartsPerWindow: number;
  restartWindowMs: number;

  globalTokenBucketCapacity: number;
  globalTokenBucketRefillRate: number;

  mizanBaseUrl: string;
  mizanUsername: string;
  mizanPassword: string;

  agentDisplayNamePrefix: string;
  sourceLanguage: string;
  ttsVoice: string;
  ttsSpeed: number;
  translationTemplatePattern: string;

  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseFloatEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function loadOrchestratorConfig(): OrchestratorConfig {
  return {
    webhookPort: parseIntEnv(process.env.ORCHESTRATOR_PORT, 4000),
    jitsiDomain: process.env.JITSI_DOMAIN || 'meet.zaryans.net',

    maxAgentsPerRoom: parseIntEnv(process.env.MAX_AGENTS_PER_ROOM, 4),
    maxTotalAgents: parseIntEnv(process.env.MAX_TOTAL_AGENTS, 20),
    spawnCooldownMs: parseIntEnv(process.env.SPAWN_COOLDOWN_MS, 3000),
    terminationGraceMs: parseIntEnv(process.env.TERMINATION_GRACE_MS, 60000),

    botPagePortBase: parseIntEnv(process.env.BOT_PAGE_PORT_BASE, 3010),
    healthPortBase: parseIntEnv(process.env.HEALTH_PORT_BASE, 8090),

    healthCheckIntervalMs: parseIntEnv(process.env.HEALTH_CHECK_INTERVAL_MS, 10000),
    healthCheckMaxFailures: parseIntEnv(process.env.HEALTH_CHECK_MAX_FAILURES, 3),
    maxRestartsPerWindow: parseIntEnv(process.env.MAX_RESTARTS_PER_WINDOW, 3),
    restartWindowMs: parseIntEnv(process.env.RESTART_WINDOW_MS, 600000),

    globalTokenBucketCapacity: parseIntEnv(process.env.GLOBAL_TOKEN_BUCKET_CAPACITY, 8),
    globalTokenBucketRefillRate: parseIntEnv(process.env.GLOBAL_TOKEN_BUCKET_REFILL_RATE, 8),

    mizanBaseUrl: process.env.MIZAN_BASE_URL || 'https://platform.mizanlabs.com/api/v1',
    mizanUsername: process.env.MIZAN_USERNAME || '',
    mizanPassword: process.env.MIZAN_PASSWORD || '',

    agentDisplayNamePrefix: process.env.AGENT_DISPLAY_NAME_PREFIX || 'translator-',
    sourceLanguage: process.env.SOURCE_LANGUAGE || 'en',
    ttsVoice: process.env.TTS_VOICE || 'af_heart',
    ttsSpeed: parseFloatEnv(process.env.TTS_SPEED, 1.0),
    translationTemplatePattern: process.env.TRANSLATION_TEMPLATE_PATTERN || 'translator_{target}',

    logLevel: (process.env.LOG_LEVEL as OrchestratorConfig['logLevel']) || 'info',
  };
}
