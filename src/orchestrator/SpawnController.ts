/**
 * Spawn Controller (Phase 7)
 *
 * Decision engine for spawning/terminating translator agents based on
 * conference state (participants, languages). Listens to ConferenceTracker
 * events and delegates to AgentManager.
 */

import { createLogger } from "../logger";
import { OrchestratorConfig } from "./OrchestratorConfig";
import { ConferenceTracker } from "./ConferenceTracker";
import { AgentManager } from "./AgentManager";

const logger = createLogger("SpawnController");

export class SpawnController {
  private config: OrchestratorConfig;
  private tracker: ConferenceTracker;
  private agentManager: AgentManager;

  private spawnCooldowns: Map<string, number> = new Map(); // roomName → last spawn timestamp
  private terminationTimers: Map<string, NodeJS.Timeout> = new Map(); // agentId → grace period timer
  private roomLocks: Map<string, Promise<void>> = new Map(); // roomName → serialization chain

  // Bound event handlers (for cleanup)
  private boundOnSpawnEval: (data: { roomName: string }) => void;
  private boundOnTermEval: (data: { roomName: string }) => void;
  private boundOnRoomDestroyed: (data: { roomName: string }) => void;

  constructor(
    config: OrchestratorConfig,
    tracker: ConferenceTracker,
    agentManager: AgentManager,
  ) {
    this.config = config;
    this.tracker = tracker;
    this.agentManager = agentManager;

    this.boundOnSpawnEval = (data) => {
      this.withRoomLock(data.roomName, () =>
        this.evaluateSpawn(data.roomName),
      ).catch((err) =>
        logger.error("Unhandled error in spawn evaluation", {
          roomName: data.roomName,
          error: String(err),
        }),
      );
    };
    this.boundOnTermEval = (data) => {
      this.withRoomLock(data.roomName, () =>
        this.evaluateTermination(data.roomName),
      ).catch((err) =>
        logger.error("Unhandled error in termination evaluation", {
          roomName: data.roomName,
          error: String(err),
        }),
      );
    };
    this.boundOnRoomDestroyed = (data) => {
      this.onRoomDestroyed(data.roomName).catch((err) =>
        logger.error("Unhandled error in room destroyed handler", {
          roomName: data.roomName,
          error: String(err),
        }),
      );
    };

    logger.info("SpawnController initialized");
  }

  /**
   * Start listening to tracker events.
   */
  start(): void {
    this.tracker.on("spawn-evaluation-needed", this.boundOnSpawnEval);
    this.tracker.on("termination-evaluation-needed", this.boundOnTermEval);
    this.tracker.on("room-destroyed", this.boundOnRoomDestroyed);
    logger.info("SpawnController started");
  }

  /**
   * Stop listening and clear all timers.
   */
  stop(): void {
    this.tracker.removeListener(
      "spawn-evaluation-needed",
      this.boundOnSpawnEval,
    );
    this.tracker.removeListener(
      "termination-evaluation-needed",
      this.boundOnTermEval,
    );
    this.tracker.removeListener("room-destroyed", this.boundOnRoomDestroyed);

    for (const timer of this.terminationTimers.values()) {
      clearTimeout(timer);
    }
    this.terminationTimers.clear();
    this.spawnCooldowns.clear();
    this.roomLocks.clear();
    logger.info("SpawnController stopped");
  }

  /**
   * Serializes async operations per room to prevent race conditions.
   */
  private async withRoomLock(
    roomName: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev = this.roomLocks.get(roomName) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.roomLocks.set(roomName, next);
    next.finally(() => {
      if (this.roomLocks.get(roomName) === next) {
        this.roomLocks.delete(roomName);
      }
    });
    return next;
  }

  /**
   * Evaluate whether to spawn agents for a room.
   * Called on language-changed and occupant-joined events.
   */
  private async evaluateSpawn(roomName: string): Promise<void> {
    try {
      const languages = this.tracker.getRoomLanguages(roomName);
      const totalParticipants = this.tracker.getParticipantCount(roomName);
      const existingAgents = this.agentManager.getAgentsForRoom(roomName);
      const realParticipants = totalParticipants - existingAgents.length;

      logger.debug("Evaluating spawn", {
        roomName,
        languages: Array.from(languages),
        totalParticipants,
        realParticipants,
        existingAgents: existingAgents.length,
      });

      // Need at least 2 real participants and 2+ languages for translation to be useful
      if (this.shouldHaveNoAgents(realParticipants, languages)) {
        // Conditions not met — evaluate if we should terminate existing agents
        if (existingAgents.length > 0) {
          this.evaluateTermination(roomName);
        }
        return;
      }

      // Check spawn cooldown per room
      const lastSpawn = this.spawnCooldowns.get(roomName) || 0;
      const now = Date.now();
      if (now - lastSpawn < this.config.spawnCooldownMs) {
        logger.debug("Spawn cooldown active", {
          roomName,
          remainingMs: this.config.spawnCooldownMs - (now - lastSpawn),
        });
        return;
      }

      // For each language, check if we need an agent
      for (const language of languages) {
        const agentId = `${roomName}:${language}`;

        // Cancel any pending termination for this agent
        this.cancelTermination(agentId);

        // Check if agent already exists
        const existing = this.agentManager.getAgent(agentId);
        if (existing && this.agentManager.isActiveAgent(existing)) {
          continue;
        }

        // Check limits
        if (
          this.agentManager.getTotalAgentCount() >= this.config.maxTotalAgents
        ) {
          logger.warn("Total agent limit reached, skipping spawn", { agentId });
          break;
        }

        if (existingAgents.length >= this.config.maxAgentsPerRoom) {
          logger.warn("Per-room agent limit reached, skipping spawn", {
            agentId,
            roomName,
          });
          break;
        }

        // Spawn the agent
        logger.info("Spawning agent for language", { roomName, language });
        try {
          await this.agentManager.spawnAgent(roomName, language);
          this.spawnCooldowns.set(roomName, Date.now());
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.error("Failed to spawn agent", { agentId, error: errMsg });
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Error in evaluateSpawn", { roomName, error: errMsg });
    }
  }

  /**
   * Evaluate whether to terminate agents for a room.
   * Called on occupant-left events and when spawn conditions are not met.
   */
  private async evaluateTermination(roomName: string): Promise<void> {
    try {
      const languages = this.tracker.getRoomLanguages(roomName);
      const totalParticipants = this.tracker.getParticipantCount(roomName);
      const existingAgents = this.agentManager.getAgentsForRoom(roomName);
      const realParticipants = totalParticipants - existingAgents.length;

      logger.debug("Evaluating termination", {
        roomName,
        languages: Array.from(languages),
        realParticipants,
        existingAgents: existingAgents.length,
      });

      for (const agent of existingAgents) {
        const shouldTerminate = this.shouldHaveNoAgents(
          realParticipants,
          languages,
          agent.language,
        );

        if (shouldTerminate) {
          this.scheduleTermination(agent.id, roomName);
        } else {
          // Conditions restored — cancel pending termination
          this.cancelTermination(agent.id);
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Error in evaluateTermination", { roomName, error: errMsg });
    }
  }

  /**
   * Handle room destruction — immediate kill all agents (no grace period).
   */
  private async onRoomDestroyed(roomName: string): Promise<void> {
    logger.info("Room destroyed, killing all agents", { roomName });

    // Cancel any pending termination timers for this room
    for (const [agentId, timer] of this.terminationTimers.entries()) {
      if (agentId.startsWith(`${roomName}:`)) {
        clearTimeout(timer);
        this.terminationTimers.delete(agentId);
      }
    }

    await this.agentManager.killAllAgentsForRoom(roomName);
  }

  /**
   * Schedule agent termination after grace period.
   */
  private scheduleTermination(agentId: string, roomName: string): void {
    // Don't schedule if already scheduled
    if (this.terminationTimers.has(agentId)) {
      return;
    }

    logger.info("Scheduling agent termination", {
      agentId,
      graceMs: this.config.terminationGraceMs,
    });

    const timer = setTimeout(async () => {
      this.terminationTimers.delete(agentId);

      // Re-check conditions before actually killing
      const languages = this.tracker.getRoomLanguages(roomName);
      const totalParticipants = this.tracker.getParticipantCount(roomName);
      const existingAgents = this.agentManager.getAgentsForRoom(roomName);
      const realParticipants = totalParticipants - existingAgents.length;

      const agent = this.agentManager.getAgent(agentId);
      if (!agent || agent.state !== "running") return;

      const stillShouldTerminate = this.shouldHaveNoAgents(
        realParticipants,
        languages,
        agent.language,
      );

      if (stillShouldTerminate) {
        logger.info("Terminating agent after grace period", { agentId });
        await this.agentManager.killAgent(agentId);
      } else {
        logger.info("Termination cancelled — conditions restored", { agentId });
      }
    }, this.config.terminationGraceMs);

    this.terminationTimers.set(agentId, timer);
  }

  /**
   * Returns true if conditions require no agents in the room
   * (fewer than 2 real participants or fewer than 2 languages).
   * If agentLanguage is provided, also checks whether that specific
   * language is still spoken by any participant.
   */
  private shouldHaveNoAgents(
    realParticipants: number,
    languages: Set<string>,
    agentLanguage?: string,
  ): boolean {
    if (realParticipants < 2 || languages.size < 2) {
      return true;
    }
    if (agentLanguage && !languages.has(agentLanguage)) {
      return true;
    }
    return false;
  }

  /**
   * Cancel a pending termination.
   */
  private cancelTermination(agentId: string): void {
    const timer = this.terminationTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.terminationTimers.delete(agentId);
      logger.debug("Termination cancelled", { agentId });
    }
  }
}
