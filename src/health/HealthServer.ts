/**
 * Health HTTP Server for Kubernetes probes.
 *
 * Exposes:
 * - GET /healthz - Liveness probe
 * - GET /readyz - Readiness probe
 * - GET /status - Detailed status
 */

import express, { Express, Request, Response } from "express";
import { Server } from "http";
import { AgentConfig } from "../config";
import { createLogger } from "../logger";
import { TranslatorAgent } from "../agent/TranslatorAgent";
import { getLivenessStatus, getReadinessStatus } from "./HealthChecks";

const logger = createLogger("HealthServer");

/**
 * Health HTTP server class.
 */
export class HealthServer {
  private config: AgentConfig;
  private agent: TranslatorAgent;
  private app: Express;
  private server: Server | null = null;

  constructor(config: AgentConfig, agent: TranslatorAgent) {
    this.config = config;
    this.agent = agent;
    this.app = express();
    this.setupRoutes();
  }

  /**
   * Sets up the health check routes.
   */
  private setupRoutes(): void {
    // Liveness probe - is the process alive?
    this.app.get("/healthz", (req: Request, res: Response) => {
      const health = this.agent.getHealth();
      const status = getLivenessStatus(health);

      res.status(status.healthy ? 200 : 503).json({
        alive: status.healthy,
        timestamp: new Date().toISOString(),
      });
    });

    // Readiness probe - is the agent ready to process audio?
    this.app.get("/readyz", (req: Request, res: Response) => {
      const health = this.agent.getHealth();
      const status = getReadinessStatus(health);

      res.status(status.ready ? 200 : 503).json({
        ready: status.ready,
        audioContextState: health.audioContext,
        heartbeatsHealthy: health.heartbeatHealthy,
        meetingConnected: health.meetingConnected,
        timestamp: new Date().toISOString(),
      });
    });

    // Detailed status
    this.app.get("/status", async (req: Request, res: Response) => {
      const health = this.agent.getHealth();

      // Phase 5: Get async playback health
      let playbackHealth = null;
      try {
        playbackHealth = await this.agent.getPlaybackHealth();
      } catch {
        // Ignore - browser may not be available
      }

      res.json({
        state: health.state,
        healthy: health.healthy,
        uptime: health.uptime,
        chrome: health.chrome,
        audioContext: health.audioContext,
        captureActive: health.captureActive,
        outputActive: health.outputActive,
        heartbeatHealthy: health.heartbeatHealthy,
        meetingConnected: health.meetingConnected,
        playback: playbackHealth,
        targetLanguage: this.config.targetLanguage,
        timestamp: new Date().toISOString(),
      });
    });
  }

  /**
   * Starts the health server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.healthPort, () => {
          logger.info("Health server started", {
            port: this.config.healthPort,
          });
          resolve();
        });

        this.server.on("error", (error) => {
          logger.error("Health server error", { error: String(error) });
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stops the health server.
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info("Health server stopped");
          this.server = null;
          resolve();
        });
      });
    }
  }
}
