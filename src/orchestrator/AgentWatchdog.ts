/**
 * Agent Watchdog (Phase 7)
 *
 * Periodically polls each running agent's /healthz endpoint.
 * Restarts agents that fail consecutive health checks.
 */

import * as http from "http";
import { createLogger } from "../logger";
import { OrchestratorConfig } from "./OrchestratorConfig";
import { AgentManager } from "./AgentManager";
import { TrackedAgent } from "./types";

const logger = createLogger("AgentWatchdog");

export class AgentWatchdog {
  private config: OrchestratorConfig;
  private agentManager: AgentManager;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(config: OrchestratorConfig, agentManager: AgentManager) {
    this.config = config;
    this.agentManager = agentManager;
    logger.info("AgentWatchdog initialized");
  }

  /**
   * Start periodic health checking.
   */
  start(): void {
    if (this.checkInterval) return;

    this.checkInterval = setInterval(() => {
      this.checkAllAgents();
    }, this.config.healthCheckIntervalMs);

    logger.info("AgentWatchdog started", {
      intervalMs: this.config.healthCheckIntervalMs,
    });
  }

  /**
   * Stop health checking.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info("AgentWatchdog stopped");
  }

  /**
   * Check health of all running agents.
   */
  private async checkAllAgents(): Promise<void> {
    const agents = this.agentManager
      .getAllAgents()
      .filter((a) => a.state === "running");

    for (const agent of agents) {
      await this.checkAgent(agent);
    }
  }

  /**
   * Check health of a single agent.
   */
  private async checkAgent(agent: TrackedAgent): Promise<void> {
    try {
      const healthy = await this.httpHealthCheck(agent.healthPort);
      agent.lastHealthCheck = Date.now();

      if (healthy) {
        // Reset failure counter on success
        if (agent.consecutiveHealthFailures > 0) {
          logger.debug("Agent health restored", { agentId: agent.id });
        }
        agent.consecutiveHealthFailures = 0;
      } else {
        agent.consecutiveHealthFailures++;
        logger.warn("Agent health check failed", {
          agentId: agent.id,
          consecutiveFailures: agent.consecutiveHealthFailures,
        });
        await this.handleFailure(agent);
      }
    } catch (error) {
      agent.consecutiveHealthFailures++;
      agent.lastHealthCheck = Date.now();
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn("Agent health check error", {
        agentId: agent.id,
        error: errMsg,
        consecutiveFailures: agent.consecutiveHealthFailures,
      });
      await this.handleFailure(agent);
    }
  }

  /**
   * Handle a health check failure.
   */
  private async handleFailure(agent: TrackedAgent): Promise<void> {
    if (agent.consecutiveHealthFailures < this.config.healthCheckMaxFailures) {
      return; // Not enough failures yet
    }

    // Check restart limits
    if (this.isRestartLimitExceeded(agent)) {
      logger.error("Agent restart limit exceeded, marking as failed", {
        agentId: agent.id,
        restartCount: agent.restartCount,
        maxRestarts: this.config.maxRestartsPerWindow,
      });
      agent.state = "failed";
      return;
    }

    // Restart the agent
    logger.info("Restarting unhealthy agent", {
      agentId: agent.id,
      consecutiveFailures: agent.consecutiveHealthFailures,
    });

    try {
      await this.agentManager.restartAgent(agent.id);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to restart agent", {
        agentId: agent.id,
        error: errMsg,
      });
    }
  }

  /**
   * Check if agent has exceeded restart limits within the window.
   */
  private isRestartLimitExceeded(agent: TrackedAgent): boolean {
    const windowStart = Date.now() - this.config.restartWindowMs;
    // Simple check: if spawnedAt is within the window and restartCount >= max
    if (
      agent.spawnedAt > windowStart &&
      agent.restartCount >= this.config.maxRestartsPerWindow
    ) {
      return true;
    }
    return false;
  }

  /**
   * Perform an HTTP health check on an agent's /healthz endpoint.
   */
  private httpHealthCheck(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${port}/healthz`,
        { timeout: 5000 },
        (res) => {
          resolve(res.statusCode === 200);
          res.resume(); // Consume response data to free memory
        },
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }
}
