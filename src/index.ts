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

import { loadConfig, getDisplayName, getMeetingUrl } from './config';
import { createLogger } from './logger';
import { TranslatorAgent } from './agent/TranslatorAgent';
import { HealthServer } from './health/HealthServer';

const logger = createLogger('Main');

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
        logger.info('Shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', { error: String(error) });
        process.exit(1);
    }
}

// Register signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Main entry point.
 */
async function main(): Promise<void> {
    logger.info('Starting Jitsi Translator Agent');

    // Load configuration
    let config;
    try {
        config = loadConfig();
        logger.info('Configuration loaded', {
            displayName: getDisplayName(config),
            meetingUrl: getMeetingUrl(config),
            targetLanguage: config.targetLanguage,
        });
    } catch (error) {
        logger.error('Failed to load configuration', { error: String(error) });
        process.exit(1);
    }

    // Create and start the agent
    agent = new TranslatorAgent(config);

    // Create and start health server
    healthServer = new HealthServer(config, agent);

    try {
        // Start health server first (allows probes during startup)
        await healthServer.start();

        // Start the translator agent
        await agent.start();

        logger.info('Translator agent is running', {
            displayName: getDisplayName(config),
            healthPort: config.healthPort,
        });

        // Keep the process running
        await new Promise(() => {
            // This promise never resolves, keeping the process alive
            // Shutdown is handled by signal handlers
        });

    } catch (error) {
        logger.error('Failed to start translator agent', { error: String(error) });
        await shutdown('ERROR');
    }
}

// Run main
main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
