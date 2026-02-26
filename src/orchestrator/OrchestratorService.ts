/**
 * Orchestrator Service (Phase 7)
 *
 * Main orchestrator class that wires together all components:
 * WebhookServer, ConferenceTracker, SpawnController, AgentManager,
 * AgentWatchdog, PortAllocator.
 */

import { createLogger } from '../logger';
import { OrchestratorConfig } from './OrchestratorConfig';
import { PortAllocator } from './PortAllocator';
import { ConferenceTracker } from './ConferenceTracker';
import { AgentManager } from './AgentManager';
import { SpawnController } from './SpawnController';
import { AgentWatchdog } from './AgentWatchdog';
import { WebhookServer } from './WebhookServer';

const logger = createLogger('OrchestratorService');

export class OrchestratorService {
  private config: OrchestratorConfig;
  private portAllocator: PortAllocator;
  private tracker: ConferenceTracker;
  private agentManager: AgentManager;
  private spawnController: SpawnController;
  private watchdog: AgentWatchdog;
  private webhookServer: WebhookServer;

  constructor(config: OrchestratorConfig) {
    this.config = config;

    // Create components in dependency order
    this.portAllocator = new PortAllocator(config.botPagePortBase, config.healthPortBase);
    this.tracker = new ConferenceTracker();
    this.agentManager = new AgentManager(config, this.portAllocator);
    this.spawnController = new SpawnController(config, this.tracker, this.agentManager);
    this.watchdog = new AgentWatchdog(config, this.agentManager);
    this.webhookServer = new WebhookServer(config, this.tracker, this.agentManager);

    logger.info('OrchestratorService created');
  }

  /**
   * Start all orchestrator components.
   */
  async start(): Promise<void> {
    logger.info('Starting OrchestratorService');

    // Start the webhook server (receives Prosody events)
    await this.webhookServer.start();

    // Start the spawn controller (listens to tracker events)
    this.spawnController.start();

    // Start the watchdog (health monitoring)
    this.watchdog.start();

    logger.info('OrchestratorService started', {
      webhookPort: this.config.webhookPort,
      maxAgentsPerRoom: this.config.maxAgentsPerRoom,
      maxTotalAgents: this.config.maxTotalAgents,
    });
  }

  /**
   * Stop all orchestrator components and clean up.
   */
  async stop(): Promise<void> {
    logger.info('Stopping OrchestratorService');

    // Stop watchdog first (no more health checks)
    this.watchdog.stop();

    // Stop spawn controller (no more spawn/kill decisions)
    this.spawnController.stop();

    // Kill all running agents
    await this.agentManager.killAllAgents();

    // Stop webhook server last
    await this.webhookServer.stop();

    logger.info('OrchestratorService stopped');
  }
}
