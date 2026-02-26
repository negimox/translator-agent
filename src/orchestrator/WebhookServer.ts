/**
 * Webhook Server + REST API (Phase 7)
 *
 * Express server that:
 * 1. Receives webhook events from Prosody's mod_event_sync_component
 * 2. Provides REST API for manual control and monitoring
 */

import express, { Express, Request, Response } from 'express';
import { Server } from 'http';
import { createLogger } from '../logger';
import { OrchestratorConfig } from './OrchestratorConfig';
import { ConferenceTracker } from './ConferenceTracker';
import { AgentManager } from './AgentManager';
import {
  RoomCreatedEvent,
  RoomDestroyedEvent,
  OccupantJoinedEvent,
  OccupantLeftEvent,
  OccupantLanguageChangedEvent,
} from './types';

const logger = createLogger('WebhookServer');

export class WebhookServer {
  private config: OrchestratorConfig;
  private tracker: ConferenceTracker;
  private agentManager: AgentManager;
  private app: Express;
  private server: Server | null = null;
  private startedAt: number = Date.now();

  constructor(
    config: OrchestratorConfig,
    tracker: ConferenceTracker,
    agentManager: AgentManager
  ) {
    this.config = config;
    this.tracker = tracker;
    this.agentManager = agentManager;
    this.app = express();
    this.app.use(express.json());
    this.setupWebhookRoutes();
    this.setupRestApiRoutes();
  }

  /**
   * Set up webhook routes for Prosody events.
   */
  private setupWebhookRoutes(): void {
    this.app.post('/api/events/room/created', (req: Request, res: Response) => {
      try {
        const event = req.body as RoomCreatedEvent;
        logger.info('Webhook: room created', { roomName: event.room_name });
        this.tracker.onRoomCreated(event);
        res.status(200).json({ ok: true });
      } catch (error) {
        this.handleError(res, 'room/created', error);
      }
    });

    this.app.post('/api/events/room/destroyed', (req: Request, res: Response) => {
      try {
        const event = req.body as RoomDestroyedEvent;
        logger.info('Webhook: room destroyed', { roomName: event.room_name });
        this.tracker.onRoomDestroyed(event);
        res.status(200).json({ ok: true });
      } catch (error) {
        this.handleError(res, 'room/destroyed', error);
      }
    });

    this.app.post('/api/events/occupant/joined', (req: Request, res: Response) => {
      try {
        const event = req.body as OccupantJoinedEvent;
        logger.info('Webhook: occupant joined', {
          roomName: event.room_name,
          occupantJid: event.occupant?.occupant_jid,
        });
        this.tracker.onOccupantJoined(event);
        res.status(200).json({ ok: true });
      } catch (error) {
        this.handleError(res, 'occupant/joined', error);
      }
    });

    this.app.post('/api/events/occupant/left', (req: Request, res: Response) => {
      try {
        const event = req.body as OccupantLeftEvent;
        logger.info('Webhook: occupant left', {
          roomName: event.room_name,
          occupantJid: event.occupant?.occupant_jid,
        });
        this.tracker.onOccupantLeft(event);
        res.status(200).json({ ok: true });
      } catch (error) {
        this.handleError(res, 'occupant/left', error);
      }
    });

    this.app.post('/api/events/occupant/language-changed', (req: Request, res: Response) => {
      try {
        const event = req.body as OccupantLanguageChangedEvent;
        logger.info('Webhook: language changed', {
          roomName: event.room_name,
          occupantJid: event.occupant?.occupant_jid,
          language: event.occupant?.spoken_language,
        });
        this.tracker.onLanguageChanged(event);
        res.status(200).json({ ok: true });
      } catch (error) {
        this.handleError(res, 'occupant/language-changed', error);
      }
    });
  }

  /**
   * Set up REST API routes for monitoring and manual control.
   */
  private setupRestApiRoutes(): void {
    // System health
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        healthy: true,
        uptime: Date.now() - this.startedAt,
        timestamp: new Date().toISOString(),
      });
    });

    // Full system status
    this.app.get('/api/status', (_req: Request, res: Response) => {
      const agents = this.agentManager.getAllAgents();
      const rooms = this.tracker.toJSON();
      res.json({
        uptime: Date.now() - this.startedAt,
        totalAgents: agents.length,
        activeAgents: agents.filter(a => a.state === 'running').length,
        totalRooms: rooms.length,
        rooms,
        agents,
        timestamp: new Date().toISOString(),
      });
    });

    // List agents
    this.app.get('/api/agents', (_req: Request, res: Response) => {
      res.json(this.agentManager.getAllAgents());
    });

    // List rooms
    this.app.get('/api/rooms', (_req: Request, res: Response) => {
      res.json(this.tracker.toJSON());
    });

    // Manual spawn
    this.app.post('/api/spawn', async (req: Request, res: Response) => {
      try {
        const { roomName, language } = req.body;
        if (!roomName || !language) {
          res.status(400).json({ error: 'roomName and language required' });
          return;
        }
        const agent = await this.agentManager.spawnAgent(roomName, language);
        res.json({ ok: true, agent });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: errMsg });
      }
    });

    // Manual kill
    this.app.post('/api/kill', async (req: Request, res: Response) => {
      try {
        const { agentId } = req.body;
        if (!agentId) {
          res.status(400).json({ error: 'agentId required' });
          return;
        }
        await this.agentManager.killAgent(agentId);
        res.json({ ok: true });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: errMsg });
      }
    });
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.webhookPort, () => {
          this.startedAt = Date.now();
          logger.info('WebhookServer started', { port: this.config.webhookPort });
          resolve();
        });
        this.server.on('error', (error) => {
          logger.error('WebhookServer error', { error: String(error) });
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('WebhookServer stopped');
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * Handle webhook processing errors.
   */
  private handleError(res: Response, route: string, error: unknown): void {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Webhook handler error: ${route}`, { error: errMsg });
    res.status(500).json({ error: errMsg });
  }
}
