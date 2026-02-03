/**
 * Main Translator Agent class.
 * Orchestrates the headless Chrome browser, meeting connection, and audio infrastructure.
 *
 * Phase 3 additions:
 * - AudioBridge for chunk aggregation
 * - VAD-driven audio capture
 * - Debug chunk file saving
 */

import { Page } from "puppeteer";
import { AgentConfig, getDisplayName, getMeetingUrl } from "../config";
import { createLogger } from "../logger";
import { ChromeInstance, launchChrome, isChromeLive } from "./ChromeLauncher";
import { AudioManager, AudioHealth } from "../audio/AudioContextManager";
import { HeartbeatMonitor } from "../audio/HeartbeatMonitor";
import { AudioBridge, AudioChunk } from "../audio/AudioBridge";
import { JitsiConnection } from "../meeting/JitsiConnection";
import { BotPageServer } from "../server/BotPageServer";
import { HealthStatus, AgentHealthState } from "../health/HealthChecks";

const logger = createLogger("TranslatorAgent");

/**
 * Bot page server port.
 */
const BOT_PAGE_PORT = 3001;

/**
 * Agent lifecycle states.
 */
export enum AgentState {
  IDLE = "idle",
  STARTING = "starting",
  CONNECTING = "connecting",
  JOINED = "joined",
  CAPTURING = "capturing", // Phase 3: Added state for audio capture
  ERROR = "error",
  STOPPING = "stopping",
  STOPPED = "stopped",
}

/**
 * Main Translator Agent class.
 * Manages the lifecycle of a translator agent that joins a Jitsi meeting.
 */
export class TranslatorAgent {
  private config: AgentConfig;
  private chrome: ChromeInstance | null = null;
  private audioManager: AudioManager | null = null;
  private heartbeatMonitor: HeartbeatMonitor | null = null;
  private audioBridge: AudioBridge | null = null; // Phase 3
  private jitsiConnection: JitsiConnection | null = null;
  private botPageServer: BotPageServer | null = null;
  private state: AgentState = AgentState.IDLE;
  private startTime: Date | null = null;

  // Phase 3: Chunk callback for external processing
  private onChunkCallback: ((chunk: AudioChunk) => void) | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    logger.info("TranslatorAgent created", {
      displayName: getDisplayName(config),
      meetingUrl: getMeetingUrl(config),
    });
  }

  /**
   * Gets the current agent state.
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * Sets a callback for when audio chunks are ready.
   * This is used by the orchestration layer (Phase 4+) to process chunks.
   */
  setOnChunkCallback(callback: (chunk: AudioChunk) => void): void {
    this.onChunkCallback = callback;
    logger.info("Chunk callback registered");
  }

  /**
   * Starts the translator agent.
   * Launches Chrome, connects to the meeting, and initializes audio infrastructure.
   */
  async start(): Promise<void> {
    if (this.state !== AgentState.IDLE && this.state !== AgentState.STOPPED) {
      throw new Error(`Cannot start agent in state: ${this.state}`);
    }

    this.state = AgentState.STARTING;
    this.startTime = new Date();
    logger.info("Starting translator agent");

    try {
      // Step 1: Start bot page server
      logger.info("Step 1: Starting bot page server");
      this.botPageServer = new BotPageServer(BOT_PAGE_PORT);
      await this.botPageServer.start();

      // Step 2: Launch Chrome
      logger.info("Step 2: Launching Chrome");
      this.chrome = await launchChrome(this.config);

      // Step 3: Connect to meeting via bot page
      logger.info("Step 3: Connecting to Jitsi meeting");
      this.state = AgentState.CONNECTING;

      const botPageUrl = this.botPageServer.getBotPageUrl(
        this.config.jitsiDomain,
        this.config.roomName,
        getDisplayName(this.config),
      );
      logger.info("Bot page URL", { botPageUrl });

      this.jitsiConnection = new JitsiConnection(
        this.config,
        this.chrome.page,
        botPageUrl,
      );
      await this.jitsiConnection.connect();

      // Step 4: Initialize audio infrastructure
      logger.info("Step 4: Meeting joined, initializing audio infrastructure");
      this.audioManager = new AudioManager(this.config, this.chrome.page);
      await this.audioManager.initialize();

      // Step 5: Start heartbeat monitoring
      logger.info("Step 5: Starting heartbeat monitor");
      this.heartbeatMonitor = new HeartbeatMonitor(
        this.config,
        this.chrome.page,
        () => this.handleHeartbeatTimeout(),
      );
      await this.heartbeatMonitor.start();

      this.state = AgentState.JOINED;

      // Step 6 (Phase 3): Initialize audio bridge for chunk aggregation
      logger.info("Step 6: Initializing audio bridge for chunk aggregation");
      await this.initializeAudioBridge();

      this.state = AgentState.CAPTURING;
      logger.info("Translator agent successfully started and capturing audio", {
        displayName: getDisplayName(this.config),
        meetingUrl: getMeetingUrl(this.config),
        debugMode: this.config.debugMode,
      });
    } catch (error) {
      this.state = AgentState.ERROR;
      logger.error("Failed to start translator agent", {
        error: String(error),
      });
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Phase 3: Initializes the audio bridge for chunk aggregation.
   */
  private async initializeAudioBridge(): Promise<void> {
    if (!this.chrome?.page) {
      throw new Error("Chrome page not available for audio bridge");
    }

    // Create audio bridge with configuration
    this.audioBridge = new AudioBridge(this.chrome.page, {
      aggregatorConfig: {
        agentId: getDisplayName(this.config),
        sampleRate: this.config.sampleRate,
        vadRmsThreshold: this.config.vadRmsThreshold,
        vadSilenceCoalesceMs: this.config.vadSilenceCoalesceMs,
        targetChunkDurationMs: this.config.targetChunkDurationMs,
        minChunkDurationMs: this.config.minChunkDurationMs,
        maxChunkDurationMs: this.config.maxChunkDurationMs,
        debugMode: this.config.debugMode,
      },
      debugMode: this.config.debugMode,
      debugOutputDir: this.config.debugOutputDir,
      maxDebugChunks: this.config.maxDebugChunks,
      onChunk: (chunk) => this.handleChunk(chunk),
    });

    // Start the bridge (exposes callback to browser)
    await this.audioBridge.start();

    // Register the callback with AudioManager
    await this.audioManager!.registerAudioFrameCallback(
      this.audioBridge.getCallbackName(),
    );

    // Connect existing participants' audio to the capture worklet
    // This must be done AFTER the callback is registered so audio data flows to Node.js
    const connectionResult =
      await this.audioManager!.connectExistingParticipants();
    logger.info("Connected existing participants", connectionResult);

    // Get debug info about audio state
    const debugInfo = await this.chrome!.page.evaluate(() => {
      return (window as any).getAudioDebugInfo
        ? (window as any).getAudioDebugInfo()
        : { error: "Debug function not available" };
    });
    logger.info("Audio debug info after connection", debugInfo);

    // Generate test tone if in debug mode
    if (this.config.debugMode) {
      logger.info("Debug mode enabled, generating test tone");
      await this.audioBridge.generateTestToneFile(1000);
    }

    logger.info("Audio bridge initialized", {
      callbackName: this.audioBridge.getCallbackName(),
    });
  }

  /**
   * Phase 3: Handles a completed audio chunk.
   */
  private handleChunk(chunk: AudioChunk): void {
    logger.debug("Chunk received in agent", {
      chunkId: chunk.chunkId,
      durationMs: chunk.durationMs,
    });

    // Call external callback if registered (for Phase 4+ orchestration)
    if (this.onChunkCallback) {
      this.onChunkCallback(chunk);
    }
  }

  /**
   * Handles heartbeat timeout by reinitializing the audio worklet.
   */
  private async handleHeartbeatTimeout(): Promise<void> {
    logger.warn("Heartbeat timeout detected, attempting recovery");

    if (this.audioManager) {
      try {
        await this.audioManager.reinitialize();

        // Re-register audio bridge callback after reinit
        if (this.audioBridge) {
          await this.audioManager.registerAudioFrameCallback(
            this.audioBridge.getCallbackName(),
          );
        }

        logger.info("Audio infrastructure reinitialized successfully");
      } catch (error) {
        logger.error("Failed to reinitialize audio", { error: String(error) });
        // Consider transitioning to ERROR state if recovery fails repeatedly
      }
    }
  }

  /**
   * Stops the translator agent and cleans up resources.
   */
  async stop(): Promise<void> {
    if (
      this.state === AgentState.STOPPED ||
      this.state === AgentState.STOPPING
    ) {
      return;
    }

    this.state = AgentState.STOPPING;
    logger.info("Stopping translator agent");

    await this.cleanup();

    this.state = AgentState.STOPPED;
    logger.info("Translator agent stopped");
  }

  /**
   * Cleans up all resources.
   */
  private async cleanup(): Promise<void> {
    // Stop audio bridge (Phase 3)
    if (this.audioBridge) {
      await this.audioBridge.stop();
      this.audioBridge = null;
    }

    // Stop heartbeat monitor
    if (this.heartbeatMonitor) {
      this.heartbeatMonitor.stop();
      this.heartbeatMonitor = null;
    }

    // Cleanup audio manager
    if (this.audioManager) {
      await this.audioManager.cleanup();
      this.audioManager = null;
    }

    // Disconnect from meeting
    if (this.jitsiConnection) {
      await this.jitsiConnection.disconnect();
      this.jitsiConnection = null;
    }

    // Close Chrome
    if (this.chrome) {
      await this.chrome.close();
      this.chrome = null;
    }

    // Stop bot page server
    if (this.botPageServer) {
      await this.botPageServer.stop();
      this.botPageServer = null;
    }
  }

  /**
   * Gets the current health status of the agent.
   */
  getHealth(): AgentHealthState {
    const chromeHealthy = this.chrome !== null && isChromeLive(this.chrome);
    // Note: audioManager.getHealth() is async but we use cached values here
    // for sync access. A more robust solution would cache the health state.
    const audioHealth: AudioHealth = {
      contextState: "closed",
      captureActive: false,
      outputActive: false,
    };
    const heartbeatHealthy = this.heartbeatMonitor?.isHealthy() ?? false;
    const meetingConnected = this.jitsiConnection?.isConnected() ?? false;

    // For immediate health checks, we assume audio is healthy if manager exists
    const audioReady = this.audioManager !== null;

    // Phase 3: Check audio bridge health
    const audioBridgeRunning = this.audioBridge !== null;

    const isHealthy =
      chromeHealthy && audioReady && heartbeatHealthy && meetingConnected;

    return {
      state: this.state,
      healthy: isHealthy,
      chrome: chromeHealthy,
      audioContext: audioReady ? "running" : "closed",
      captureActive: audioReady && audioBridgeRunning,
      outputActive: audioReady,
      heartbeatHealthy,
      meetingConnected,
      uptime: this.startTime
        ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
        : 0,
    };
  }

  /**
   * Phase 3: Gets the audio bridge metrics.
   */
  getAudioMetrics(): {
    framesReceived: number;
    chunksEmitted: number;
    isCapturing: boolean;
  } | null {
    if (!this.audioBridge) {
      return null;
    }

    const metrics = this.audioBridge.getMetrics();
    return {
      framesReceived: metrics.framesReceived,
      chunksEmitted: metrics.aggregatorMetrics.totalChunksEmitted,
      isCapturing: metrics.isRunning,
    };
  }

  /**
   * Phase 3: Gets the chunk aggregator for direct access.
   */
  getAggregator() {
    return this.audioBridge?.getAggregator() ?? null;
  }
}
