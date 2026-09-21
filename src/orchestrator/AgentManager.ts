/**
 * Agent Manager (Phase 7)
 *
 * Manages translator agent child processes: spawning, killing,
 * port assignment, and IPC communication for rate limit updates.
 */

import { EventEmitter } from "events";
import { ChildProcess, fork } from "child_process";
import * as path from "path";
import { createLogger } from "../logger";
import { TrackedAgent, AgentState, RateLimitUpdateMessage } from "./types";
import { OrchestratorConfig } from "./OrchestratorConfig";
import { PortAllocator } from "./PortAllocator";
import { TranslationPipeline } from "../mizan/TranslationPipeline";
import { ConferenceTracker } from "./ConferenceTracker";

const logger = createLogger("AgentManager");

export class AgentManager extends EventEmitter {
  private config: OrchestratorConfig;
  private portAllocator: PortAllocator;
  private tracker: ConferenceTracker | null = null;
  private agents: Map<string, TrackedAgent> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private startupTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: OrchestratorConfig, portAllocator: PortAllocator) {
    super();
    this.config = config;
    this.portAllocator = portAllocator;
    logger.info("AgentManager initialized");
  }

  /**
   * Sets the ConferenceTracker reference (set after construction to avoid circular deps).
   */
  setTracker(tracker: ConferenceTracker): void {
    this.tracker = tracker;
  }

  /**
   * Spawns a new translator agent for a room/language pair.
   * @param roomLanguages All languages present in the room. Used to compute
   *   the agent's SOURCE_LANGUAGE. For 2-language rooms (e.g., [en, hi]),
   *   translator-en gets SOURCE_LANGUAGE=hi and vice versa. For 3+ languages,
   *   SOURCE_LANGUAGE is set to 'auto' to let DeepL auto-detect.
   */
  async spawnAgent(
    roomName: string,
    language: string,
    roomLanguages?: string[],
  ): Promise<TrackedAgent> {
    const agentId = `${roomName}:${language}`;

    // Check if already running
    const existing = this.agents.get(agentId);
    if (existing && this.isActiveAgent(existing)) {
      logger.warn("Agent already running", { agentId });
      return existing;
    }

    // Check limits
    if (this.getTotalAgentCount() >= this.config.maxTotalAgents) {
      throw new Error(
        `Total agent limit reached: ${this.config.maxTotalAgents}`,
      );
    }

    const roomAgents = this.getAgentsForRoom(roomName);
    if (roomAgents.length >= this.config.maxAgentsPerRoom) {
      throw new Error(
        `Per-room agent limit reached: ${this.config.maxAgentsPerRoom}`,
      );
    }

    // Allocate ports
    const { botPagePort, healthPort } = this.portAllocator.allocate();

    // Create tracked agent
    const agent: TrackedAgent = {
      id: agentId,
      roomName,
      language,
      state: "spawning",
      pid: null,
      botPagePort,
      healthPort,
      spawnedAt: Date.now(),
      restartCount: existing?.restartCount || 0,
      lastHealthCheck: null,
      consecutiveHealthFailures: 0,
    };

    this.agents.set(agentId, agent);

    // Build environment for child process
    const childEnv = this.buildChildEnv(
      roomName,
      language,
      botPagePort,
      healthPort,
      roomLanguages,
    );

    // Fork the child process
    const agentEntryPoint = path.resolve(__dirname, "../../dist/index.js");
    logger.info("Spawning agent", {
      agentId,
      entryPoint: agentEntryPoint,
      botPagePort,
      healthPort,
    });

    try {
      const child = fork(agentEntryPoint, [], {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        silent: true,
      });

      agent.pid = child.pid || null;
      this.processes.set(agentId, child);

      // Pipe child stdout/stderr with agent prefix
      if (child.stdout) {
        child.stdout.on("data", (data: Buffer) => {
          const lines = data.toString().trim().split("\n");
          for (const line of lines) {
            logger.debug(`[${agentId}] ${line}`);
          }
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          const lines = data.toString().trim().split("\n");
          for (const line of lines) {
            logger.warn(`[${agentId}:stderr] ${line}`);
          }
        });
      }

      // Handle child exit
      child.on("exit", (code, signal) => {
        logger.info("Agent process exited", { agentId, code, signal });
        this.handleAgentExit(agentId, code, signal);
      });

      child.on("error", (err) => {
        logger.error("Agent process error", { agentId, error: err.message });
        this.handleAgentExit(agentId, 1, null);
      });

      // Handle IPC messages from child
      child.on("message", (msg: unknown) => {
        this.handleChildMessage(agentId, msg);
      });

      // Set startup timeout — agent must send "agent-ready" within this period
      const startupTimer = setTimeout(() => {
        this.startupTimers.delete(agentId);
        const currentAgent = this.agents.get(agentId);
        if (currentAgent && currentAgent.state === "spawning") {
          logger.error("Agent startup timeout", { agentId });
          this.killAgent(agentId).catch((err) =>
            logger.error("Failed to kill timed-out agent", {
              agentId,
              error: String(err),
            }),
          );
        }
      }, this.config.agentStartupTimeoutMs);
      this.startupTimers.set(agentId, startupTimer);

      // Broadcast updated rate limits to all agents
      this.broadcastRateLimitUpdate();

      logger.info("Agent spawned", { agentId, pid: agent.pid });
      this.emit("agent-spawned", { agentId, roomName, language });
      return agent;
    } catch (error) {
      // Spawn failed — clean up
      agent.state = "failed";
      this.portAllocator.release(botPagePort, healthPort);
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Failed to spawn agent", { agentId, error: errMsg });
      throw error;
    }
  }

  /**
   * Kills a running agent.
   */
  async killAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      logger.warn("Agent not found for kill", { agentId });
      return;
    }

    if (agent.state === "stopping" || agent.state === "stopped") {
      return;
    }

    agent.state = "stopping";
    const child = this.processes.get(agentId);

    if (child && child.connected) {
      logger.info("Sending SIGTERM to agent", { agentId, pid: agent.pid });
      child.kill("SIGTERM");

      // Force kill after 10 seconds
      const forceKillTimer = setTimeout(() => {
        if (agent.state === "stopping") {
          logger.warn("Force killing agent", { agentId });
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }, 10000);

      // Wait for exit
      await new Promise<void>((resolve) => {
        const onExit = () => {
          clearTimeout(forceKillTimer);
          resolve();
        };
        child.once("exit", onExit);
        // Also resolve if already dead
        if (!child.connected) {
          clearTimeout(forceKillTimer);
          resolve();
        }
      });
    } else {
      // No process or already disconnected
      this.cleanupAgent(agentId);
    }
  }

  /**
   * Kills all agents for a specific room.
   */
  async killAllAgentsForRoom(roomName: string): Promise<void> {
    const agents = this.getAgentsForRoom(roomName);
    await Promise.all(agents.map((a) => this.killAgent(a.id)));
  }

  /**
   * Kills all running agents.
   */
  async killAllAgents(): Promise<void> {
    const allAgents = Array.from(this.agents.values());
    await Promise.all(allAgents.map((a) => this.killAgent(a.id)));
  }

  /**
   * Gets a tracked agent by ID.
   */
  getAgent(agentId: string): TrackedAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Returns true if the agent is in an active state (spawning or running).
   */
  isActiveAgent(agent: TrackedAgent): boolean {
    return agent.state === "spawning" || agent.state === "running";
  }

  /**
   * Gets all agents for a room (any state).
   */
  getAgentsForRoom(roomName: string): TrackedAgent[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.roomName === roomName && this.isActiveAgent(a),
    );
  }

  /**
   * Gets all tracked agents.
   */
  getAllAgents(): TrackedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Gets the count of active (spawning/running) agents.
   */
  getTotalAgentCount(): number {
    return Array.from(this.agents.values()).filter((a) => this.isActiveAgent(a))
      .length;
  }

  /**
   * Broadcasts rate limit update to all running agents via IPC.
   * Each agent gets: globalCapacity / totalActiveAgents
   */
  broadcastRateLimitUpdate(): void {
    const activeCount = this.getTotalAgentCount();
    if (activeCount === 0) return;

    const perAgentCapacity =
      this.config.globalTokenBucketCapacity / activeCount;
    const perAgentRefillRate =
      this.config.globalTokenBucketRefillRate / activeCount;

    const msg: RateLimitUpdateMessage = {
      type: "rate-limit-update",
      capacity: perAgentCapacity,
      refillRate: perAgentRefillRate,
    };

    logger.info("Broadcasting rate limit update", {
      activeCount,
      perAgentCapacity: perAgentCapacity.toFixed(2),
      perAgentRefillRate: perAgentRefillRate.toFixed(2),
    });

    for (const [agentId, child] of this.processes.entries()) {
      const agent = this.agents.get(agentId);
      if (agent && agent.state === "running" && child.connected) {
        try {
          child.send(msg);
        } catch (error) {
          logger.warn("Failed to send IPC to agent", { agentId });
        }
      }
    }
  }

  /**
   * Restarts a failed agent. Used by AgentWatchdog.
   */
  async restartAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const { roomName, language, restartCount } = agent;
    logger.info("Restarting agent", {
      agentId,
      restartCount,
    });

    await this.killAgent(agentId);

    // Look up current room languages from ConferenceTracker for correct
    // SOURCE_LANGUAGE computation on restart.
    let roomLanguages: string[] | undefined;
    if (this.tracker) {
      roomLanguages = Array.from(this.tracker.getRoomLanguages(roomName));
    }

    // spawnAgent picks up restartCount from existing entry, but killAgent
    // now deletes the entry. Pass the incremented count via a temporary entry.
    const newAgent = await this.spawnAgent(roomName, language, roomLanguages);
    newAgent.restartCount = restartCount + 1;
  }

  /**
   * Builds the environment variables for a child agent process.
   *
   * Computes SOURCE_LANGUAGE per-agent based on room languages:
   * - 2-language room (en + hi): translator-hi → SOURCE_LANGUAGE=en, translator-en → SOURCE_LANGUAGE=hi
   * - 3+ language room: SOURCE_LANGUAGE=auto (rely on DeepL auto-detection)
   * - Unknown/missing: SOURCE_LANGUAGE=auto (safe default)
   */
  private buildChildEnv(
    roomName: string,
    language: string,
    botPagePort: number,
    healthPort: number,
    roomLanguages?: string[],
  ): NodeJS.ProcessEnv {
    // Compute the source language for this agent.
    // The agent translates FROM other languages TO its target language.
    let sourceLanguage: string;

    if (roomLanguages && roomLanguages.length > 0) {
      // Filter out this agent's own target language to get "other" languages
      const otherLanguages = roomLanguages.filter((l) => l !== language);

      if (otherLanguages.length === 1) {
        // 2-language room: source is the single other language
        sourceLanguage = otherLanguages[0];
      } else if (otherLanguages.length > 1) {
        // 3+ language room: multiple source languages, use auto-detect
        sourceLanguage = "auto";
      } else {
        // Only this agent's language in the room (shouldn't happen during spawn)
        sourceLanguage = "auto";
      }
    } else {
      // Room languages not available — use auto-detect as safe default
      sourceLanguage = "auto";
    }

    logger.debug("Computed agent source language", {
      agentId: `${roomName}:${language}`,
      targetLanguage: language,
      sourceLanguage,
      roomLanguages: roomLanguages || [],
    });

    return {
      ...process.env,
      JITSI_DOMAIN: this.config.jitsiDomain,
      ROOM_NAME: roomName,
      TARGET_LANGUAGE: language,
      SOURCE_LANGUAGE: sourceLanguage,
      BOT_PAGE_PORT: String(botPagePort),
      HEALTH_PORT: String(healthPort),
      MIZAN_BASE_URL: this.config.mizanBaseUrl,
      MIZAN_USERNAME: this.config.mizanUsername,
      MIZAN_PASSWORD: this.config.mizanPassword,
      AGENT_DISPLAY_NAME_PREFIX: this.config.agentDisplayNamePrefix,
      TTS_VOICE: TranslationPipeline.getVoiceForLanguage(language),
      TTS_SPEED: String(this.config.ttsSpeed),
      TRANSLATION_TEMPLATE_PATTERN: this.config.translationTemplatePattern,
      LOG_LEVEL: this.config.logLevel,
      // Disable debug mode for orchestrated agents
      DEBUG_MODE: "false",
    };
  }

  /**
   * Handles agent process exit.
   */
  private handleAgentExit(
    agentId: string,
    code: number | null,
    signal: string | null,
  ): void {
    this.cleanupAgent(agentId);
    this.emit("agent-exited", { agentId, code, signal });

    // Broadcast updated rate limits after an agent exits
    this.broadcastRateLimitUpdate();
  }

  /**
   * Cleans up agent state after exit.
   */
  private cleanupAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      this.portAllocator.release(agent.botPagePort, agent.healthPort);
    }
    const startupTimer = this.startupTimers.get(agentId);
    if (startupTimer) {
      clearTimeout(startupTimer);
      this.startupTimers.delete(agentId);
    }
    this.processes.delete(agentId);
    this.agents.delete(agentId);
  }

  /**
   * Handles IPC messages from child agents.
   */
  private handleChildMessage(agentId: string, msg: unknown): void {
    if (!msg || typeof msg !== "object") return;

    const message = msg as Record<string, unknown>;

    if (message.type === "agent-ready") {
      const agent = this.agents.get(agentId);
      if (agent && agent.state === "spawning") {
        agent.state = "running";
        logger.info("Agent ready", { agentId });

        // Clear startup timeout
        const timer = this.startupTimers.get(agentId);
        if (timer) {
          clearTimeout(timer);
          this.startupTimers.delete(agentId);
        }

        // Now safe to include in rate distribution
        this.broadcastRateLimitUpdate();
      }
    } else if (message.type === "metrics") {
      this.emit("agent-metrics", { agentId, metrics: message.pipelineMetrics });
    }
  }
}
