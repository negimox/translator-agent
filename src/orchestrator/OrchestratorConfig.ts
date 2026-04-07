/**
 * Orchestrator configuration (Phase 7)
 * Separate from agent config - loaded from environment variables.
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { parseIntEnv, parseFloatEnv } from "../utils/envParsing";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

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

  shutdownTimeoutMs: number;
  agentStartupTimeoutMs: number;

  webhookAuthToken: string;
  apiAuthToken: string;

  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadOrchestratorConfig(): OrchestratorConfig {
  return {
    webhookPort: parseIntEnv(process.env.ORCHESTRATOR_PORT, 4000),
    jitsiDomain: process.env.JITSI_DOMAIN || "meet.zaryans.net",

    maxAgentsPerRoom: parseIntEnv(process.env.MAX_AGENTS_PER_ROOM, 4),
    maxTotalAgents: parseIntEnv(process.env.MAX_TOTAL_AGENTS, 20),
    spawnCooldownMs: parseIntEnv(process.env.SPAWN_COOLDOWN_MS, 3000),
    terminationGraceMs: parseIntEnv(process.env.TERMINATION_GRACE_MS, 60000),

    botPagePortBase: parseIntEnv(process.env.BOT_PAGE_PORT_BASE, 3010),
    healthPortBase: parseIntEnv(process.env.HEALTH_PORT_BASE, 8090),

    healthCheckIntervalMs: parseIntEnv(
      process.env.HEALTH_CHECK_INTERVAL_MS,
      10000,
    ),
    healthCheckMaxFailures: parseIntEnv(
      process.env.HEALTH_CHECK_MAX_FAILURES,
      3,
    ),
    maxRestartsPerWindow: parseIntEnv(process.env.MAX_RESTARTS_PER_WINDOW, 3),
    restartWindowMs: parseIntEnv(process.env.RESTART_WINDOW_MS, 600000),

    // Global token bucket shared across all agents
    // Each agent needs 3 tokens for FULL_PIPELINE (STT + Translation + TTS)
    // Default capacity of 12 supports up to 4 concurrent agents (12/4 = 3 tokens each)
    globalTokenBucketCapacity: parseIntEnv(
      process.env.GLOBAL_TOKEN_BUCKET_CAPACITY,
      12,
    ),
    globalTokenBucketRefillRate: parseIntEnv(
      process.env.GLOBAL_TOKEN_BUCKET_REFILL_RATE,
      12,
    ),

    mizanBaseUrl:
      process.env.MIZAN_BASE_URL || "https://platform.mizanlabs.com/api/v1",
    mizanUsername: process.env.MIZAN_USERNAME || "",
    mizanPassword: process.env.MIZAN_PASSWORD || "",

    agentDisplayNamePrefix:
      process.env.AGENT_DISPLAY_NAME_PREFIX || "translator-",
    sourceLanguage: process.env.SOURCE_LANGUAGE || "en",
    ttsVoice: process.env.TTS_VOICE || "af_heart",
    ttsSpeed: parseFloatEnv(process.env.TTS_SPEED, 1.0),
    translationTemplatePattern:
      process.env.TRANSLATION_TEMPLATE_PATTERN || "translator_{target}",

    shutdownTimeoutMs: parseIntEnv(process.env.SHUTDOWN_TIMEOUT_MS, 30000),
    agentStartupTimeoutMs: parseIntEnv(
      process.env.AGENT_STARTUP_TIMEOUT_MS,
      120000,
    ),

    webhookAuthToken: process.env.WEBHOOK_AUTH_TOKEN || "",
    apiAuthToken: process.env.API_AUTH_TOKEN || "",

    logLevel:
      (process.env.LOG_LEVEL as OrchestratorConfig["logLevel"]) || "info",
  };
}
