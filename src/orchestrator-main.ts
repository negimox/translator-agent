/**
 * Orchestrator Entry Point (Phase 7)
 *
 * Starts the autonomous orchestrator service that manages
 * translator agents based on Prosody webhook events.
 *
 * Usage:
 *   npm run start:orchestrator
 */

import { loadOrchestratorConfig } from './orchestrator/OrchestratorConfig';
import { OrchestratorService } from './orchestrator/OrchestratorService';
import { createLogger } from './logger';

const logger = createLogger('OrchestratorMain');

let service: OrchestratorService | null = null;
let isShuttingDown = false;

/**
 * Graceful shutdown handler.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down orchestrator`);

  try {
    if (service) {
      await service.stop();
    }
    logger.info('Orchestrator shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during orchestrator shutdown', { error: String(error) });
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
  logger.info('Starting Jitsi Translator Orchestrator');

  let config;
  try {
    config = loadOrchestratorConfig();
    logger.info('Orchestrator configuration loaded', {
      webhookPort: config.webhookPort,
      jitsiDomain: config.jitsiDomain,
      maxAgentsPerRoom: config.maxAgentsPerRoom,
      maxTotalAgents: config.maxTotalAgents,
    });
  } catch (error) {
    logger.error('Failed to load orchestrator configuration', { error: String(error) });
    process.exit(1);
  }

  service = new OrchestratorService(config);

  try {
    await service.start();

    logger.info('Orchestrator is running', {
      webhookPort: config.webhookPort,
      healthCheckInterval: config.healthCheckIntervalMs,
    });

    // Keep the process running
    await new Promise(() => {
      // This promise never resolves, keeping the process alive
      // Shutdown is handled by signal handlers
    });
  } catch (error) {
    logger.error('Failed to start orchestrator', { error: String(error) });
    await shutdown('ERROR');
  }
}

// Run main
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
