/**
 * Entry point for the Jitsi Translator Agent.
 *
 * Usage:
 *   npm start
 *
 * Required environment variables:
 *   JITSI_DOMAIN - Jitsi server domain (e.g., meet.zaryans.net:8443)
 *   ROOM_NAME - Meeting room to join (e.g., test)
 *   TARGET_LANGUAGE - Language code for this agent (e.g., en, hi)
 */

import { loadConfig, getDisplayName, getMeetingUrl } from "./config";
import { createLogger } from "./logger";
import { TranslatorAgent } from "./agent/TranslatorAgent";
import { HealthServer } from "./health/HealthServer";
import { initializeProviderFactory } from "./providers";

const logger = createLogger("Main");

// Graceful shutdown handling
let agent: TranslatorAgent | null = null;
let healthServer: HealthServer | null = null;
let isShuttingDown = false;

/**
 * Graceful shutdown handler.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully`);

  try {
    if (healthServer) {
      await healthServer.stop();
    }
    if (agent) {
      await agent.stop();
    }
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", { error: String(error) });
    process.exit(1);
  }
}

// Register signal handlers
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  logger.info("Starting Jitsi Translator Agent");

  // Load configuration
  let config;
  try {
    config = loadConfig();
    logger.info("Configuration loaded", {
      displayName: getDisplayName(config),
      meetingUrl: getMeetingUrl(config),
      targetLanguage: config.targetLanguage,
    });
  } catch (error) {
    logger.error("Failed to load configuration", { error: String(error) });
    process.exit(1);
  }

  // Phase 7.1: Initialize provider factory for ElevenLabs + Mizan
  try {
    const providerFactory = initializeProviderFactory({
      elevenlabs: {
        apiKey: config.elevenLabsApiKey,
        baseUrl: config.elevenLabsBaseUrl,
        timeoutMs: config.elevenLabsTimeoutMs,
      },
      mizan: {
        username: config.mizanUsername,
        password: config.mizanPassword,
        baseUrl: config.mizanBaseUrl,
        timeoutMs: config.mizanTimeoutMs,
        templatePattern: config.translationTemplatePattern,
      },
    });

    logger.info("Provider factory initialized", {
      hasElevenLabs: !!config.elevenLabsApiKey,
      hasMizan: !!(config.mizanUsername && config.mizanPassword),
    });

    // Check provider health on startup
    const health = await providerFactory.checkAllHealth();
    logger.info("Provider health check", { health });
  } catch (error) {
    logger.error("Failed to initialize providers", { error: String(error) });
    // Continue anyway - providers will be created lazily
  }

  // Create and start the agent
  agent = new TranslatorAgent(config);

  // Phase 7: If running as child process (spawned by orchestrator), listen for IPC messages
  if (process.send) {
    logger.info("Running as child process - IPC enabled");
    process.on("message", (msg: unknown) => {
      if (
        msg &&
        typeof msg === "object" &&
        (msg as Record<string, unknown>).type === "rate-limit-update"
      ) {
        const update = msg as {
          type: string;
          capacity: number;
          refillRate: number;
        };
        logger.info("Rate limit update from orchestrator", {
          capacity: update.capacity,
          refillRate: update.refillRate,
        });
        if (agent) {
          agent.updateRateLimit(update.capacity, update.refillRate);
        }
      }
    });

    // Detect orchestrator crash: IPC disconnect means parent is gone
    process.on("disconnect", () => {
      logger.warn("IPC channel disconnected - orchestrator may have crashed");
      logger.info("Will shut down in 30s if not terminated sooner");
      setTimeout(() => {
        if (!isShuttingDown) {
          shutdown("ORCHESTRATOR_DISCONNECT");
        }
      }, 30_000);
    });
  }

  // Create and start health server
  healthServer = new HealthServer(config, agent);

  try {
    // Start health server first (allows probes during startup)
    await healthServer.start();

    // Start the translator agent
    await agent.start();

    // Notify orchestrator that agent is ready (if running as child process)
    if (process.send) {
      process.send({ type: "agent-ready" });
    }

    logger.info("Translator agent is running", {
      displayName: getDisplayName(config),
      healthPort: config.healthPort,
    });

    // Keep the process running
    await new Promise(() => {
      // This promise never resolves, keeping the process alive
      // Shutdown is handled by signal handlers
    });
  } catch (error) {
    logger.error("Failed to start translator agent", { error: String(error) });
    await shutdown("ERROR");
  }
}

// Run main
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
