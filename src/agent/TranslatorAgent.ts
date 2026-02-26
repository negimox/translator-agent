/**
 * Main Translator Agent class.
 * Orchestrates the headless Chrome browser, meeting connection, and audio infrastructure.
 *
 * Phase 3 additions:
 * - AudioBridge for chunk aggregation
 * - VAD-driven audio capture
 * - Debug chunk file saving
 *
 * Phase 4 additions:
 * - TranslationPipeline integration
 * - Mizan API orchestration
 * - Rate limiting and circuit breaker
 * - Adaptive chunking
 */

import { Page } from "puppeteer";
import { AgentConfig, getDisplayName, getMeetingUrl } from "../config";
import { createLogger } from "../logger";
import { ChromeInstance, launchChrome, isChromeLive } from "./ChromeLauncher";
import { AudioManager } from "../audio/AudioContextManager";
import { HeartbeatMonitor } from "../audio/HeartbeatMonitor";
import { AudioBridge, AudioChunk } from "../audio/AudioBridge";
import { JitsiConnection } from "../meeting/JitsiConnection";
import { BotPageServer } from "../server/BotPageServer";
import { HealthStatus, AgentHealthState } from "../health/HealthChecks";
import {
  TranslationPipeline,
  AdaptiveChunkController,
  PipelineResult,
  CircuitState,
} from "../mizan";

const logger = createLogger("TranslatorAgent");

/**
 * Agent lifecycle states.
 */
export enum AgentState {
  IDLE = "idle",
  STARTING = "starting",
  CONNECTING = "connecting",
  JOINED = "joined",
  CAPTURING = "capturing", // Phase 3: Added state for audio capture
  TRANSLATING = "translating", // Phase 4: Translation pipeline active
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

  // Phase 4: Translation pipeline
  private translationPipeline: TranslationPipeline | null = null;
  private adaptiveChunkController: AdaptiveChunkController | null = null;

  // Phase 3: Chunk callback for external processing
  private onChunkCallback: ((chunk: AudioChunk) => void) | null = null;

  // Phase 4: Audio output callback
  private onAudioOutputCallback:
    | ((audio: ArrayBuffer, chunkId: string) => void)
    | null = null;

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
      this.botPageServer = new BotPageServer(this.config.botPagePort);
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

      // Step 6.5 (Phase 5): Publish local audio track for translated audio
      logger.info(
        "Step 6.5: Publishing local audio track for translated audio",
      );
      try {
        await this.audioManager!.publishLocalTrack();
      } catch (error) {
        logger.error(
          "Failed to publish local audio track - playback will be unavailable",
          { error: String(error) },
        );
        // Non-fatal: continue with capture and translation even if playback fails
      }

      // Step 7 (Phase 4): Initialize translation pipeline
      logger.info("Step 7: Initializing translation pipeline");
      await this.initializeTranslationPipeline();

      this.state = AgentState.TRANSLATING;
      logger.info("Translator agent successfully started and translating", {
        displayName: getDisplayName(this.config),
        meetingUrl: getMeetingUrl(this.config),
        debugMode: this.config.debugMode,
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
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

    // Phase 4: Submit chunk to translation pipeline
    if (this.translationPipeline) {
      const submitted = this.translationPipeline.submitChunk(chunk);
      if (!submitted) {
        logger.warn("Chunk not submitted to pipeline (queue full)", {
          chunkId: chunk.chunkId,
        });
      }
    }

    // Call external callback if registered (for Phase 4+ orchestration)
    if (this.onChunkCallback) {
      this.onChunkCallback(chunk);
    }
  }

  /**
   * Phase 4: Initializes the translation pipeline.
   */
  private async initializeTranslationPipeline(): Promise<void> {
    // Validate Mizan credentials
    if (!this.config.mizanUsername || !this.config.mizanPassword) {
      logger.warn(
        "Mizan credentials not configured - translation pipeline disabled",
      );
      return;
    }

    // Create translation pipeline
    this.translationPipeline = new TranslationPipeline({
      mizan: {
        baseUrl: this.config.mizanBaseUrl,
        username: this.config.mizanUsername,
        password: this.config.mizanPassword,
        timeoutMs: this.config.mizanTimeoutMs,
      },
      sourceLanguage: this.config.sourceLanguage,
      targetLanguage: this.config.targetLanguage,
      translationTemplatePattern: this.config.translationTemplatePattern,
      ttsVoice: this.config.ttsVoice,
      ttsSpeed: this.config.ttsSpeed,
      retryInitialDelayMs: this.config.retryInitialDelayMs,
      retryMaxDelayMs: this.config.retryMaxDelayMs,
      maxRetries: this.config.maxRetries,
      tokenBucketCapacity: this.config.tokenBucketCapacity,
      tokenBucketRefillRate: this.config.tokenBucketRefillRate,
      circuitBreakerErrorThreshold: this.config.circuitBreakerErrorThreshold,
      circuitBreakerWindowMs: this.config.circuitBreakerWindowMs,
      circuitBreakerOpenTimeoutMs: this.config.circuitBreakerOpenTimeoutMs,
      maxQueueLength: this.config.maxQueueLength,
      maxInFlight: this.config.maxInFlight,
      debugMode: this.config.debugMode,
      debugOutputDir: this.config.debugOutputDir,
    });

    // Set up event handlers
    this.translationPipeline.on("chunkProcessed", (result: PipelineResult) => {
      logger.info("Translation completed", {
        chunkId: result.chunkId,
        latencyMs: result.latencyMs,
        transcriptionLength: result.transcription?.length || 0,
        translationLength: result.translation?.length || 0,
      });
    });

    this.translationPipeline.on("chunkFailed", (result: PipelineResult) => {
      logger.error("Translation failed", {
        chunkId: result.chunkId,
        error: result.error,
        retries: result.retries,
      });
    });

    this.translationPipeline.on("circuitStateChange", (event) => {
      logger.warn("Circuit breaker state changed", event);
    });

    this.translationPipeline.on("backpressure", (data) => {
      logger.warn("Pipeline backpressure detected", data);
    });

    // Set audio output callback (Phase 5: Play translated audio)
    this.translationPipeline.setOnAudioReady(async (audio, chunkId) => {
      logger.info("Playing translated audio", {
        chunkId,
        audioSize: audio.byteLength,
      });

      // Play the MP3 audio via local HTTP (avoids base64 over CDP)
      if (this.audioManager && this.botPageServer) {
        try {
          const audioUrl = this.botPageServer.storeTtsAudio(
            chunkId,
            Buffer.from(audio),
          );
          await this.audioManager.playMp3AudioFromUrl(audioUrl);
          logger.info("Translated audio playback started", { chunkId });
        } catch (error) {
          logger.error("Failed to play translated audio", {
            chunkId,
            error: String(error),
          });
        }
      }

      // Call external callback if registered
      if (this.onAudioOutputCallback) {
        this.onAudioOutputCallback(audio, chunkId);
      }
    });

    // Initialize adaptive chunk controller if enabled
    if (this.config.adaptiveChunkingEnabled && this.audioBridge) {
      this.adaptiveChunkController = new AdaptiveChunkController({
        defaultChunkDurationMs: this.config.targetChunkDurationMs,
        minChunkDurationMs: this.config.minChunkDurationMs,
        maxChunkDurationMs: this.config.maxChunkDurationMs,
        updateIntervalMs: this.config.adaptiveUpdateIntervalMs,
      });

      // Connect to pipeline components
      this.adaptiveChunkController.connect(
        this.translationPipeline.getTokenBucket(),
        this.translationPipeline.getQueue(),
        this.audioBridge.getAggregator(),
      );

      this.adaptiveChunkController.start();
      logger.info("Adaptive chunk controller started");
    }

    // Start the pipeline
    this.translationPipeline.start();

    logger.info("Translation pipeline initialized", {
      sourceLanguage: this.config.sourceLanguage,
      targetLanguage: this.config.targetLanguage,
      adaptiveChunking: this.config.adaptiveChunkingEnabled,
    });
  }

  /**
   * Sets a callback for when translated audio is ready (Phase 4+).
   */
  setOnAudioOutputCallback(
    callback: (audio: ArrayBuffer, chunkId: string) => void,
  ): void {
    this.onAudioOutputCallback = callback;
    logger.info("Audio output callback registered");
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

        // Reconnect existing participants' audio to the new worklet
        const connectionResult =
          await this.audioManager.connectExistingParticipants();
        logger.info(
          "Reconnected existing participants after heartbeat recovery",
          connectionResult,
        );

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
    // Stop adaptive chunk controller (Phase 4)
    if (this.adaptiveChunkController) {
      this.adaptiveChunkController.stop();
      this.adaptiveChunkController = null;
    }

    // Stop translation pipeline (Phase 4)
    if (this.translationPipeline) {
      this.translationPipeline.stop();
      this.translationPipeline = null;
    }

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
  async getHealth(): Promise<AgentHealthState> {
    const chromeHealthy = this.chrome !== null && isChromeLive(this.chrome);
    const heartbeatHealthy = this.heartbeatMonitor?.isHealthy() ?? false;
    const meetingConnected = this.jitsiConnection?.isConnected() ?? false;

    // Phase 3: Check audio bridge health
    const audioBridgeRunning = this.audioBridge !== null;

    // Phase 4: Check pipeline health
    const pipelineHealthy = this.translationPipeline?.isHealthy() ?? true;

    // Query real audio state from browser (async)
    let audioContextState: "suspended" | "running" | "closed" = "closed";
    let captureActive = false;
    let outputActive = false;

    if (this.audioManager) {
      try {
        const audioHealth = await this.audioManager.getHealth();
        audioContextState = audioHealth.contextState;
        captureActive = audioHealth.captureActive && audioBridgeRunning;
        outputActive = audioHealth.outputActive;
      } catch {
        // Browser may not be available — use fallback
        audioContextState = this.audioManager !== null ? "running" : "closed";
        captureActive = this.audioManager !== null && audioBridgeRunning;
        outputActive = this.audioManager !== null;
      }
    }

    const isHealthy =
      chromeHealthy &&
      audioContextState === "running" &&
      heartbeatHealthy &&
      meetingConnected &&
      pipelineHealthy;

    return {
      state: this.state,
      healthy: isHealthy,
      chrome: chromeHealthy,
      audioContext: audioContextState,
      captureActive,
      outputActive,
      heartbeatHealthy,
      meetingConnected,
      pipelineHealthy,
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
   * Phase 4: Gets the translation pipeline metrics.
   */
  getPipelineMetrics() {
    return this.translationPipeline?.getMetrics() ?? null;
  }

  /**
   * Phase 4: Gets the translation pipeline.
   */
  getTranslationPipeline() {
    return this.translationPipeline;
  }

  /**
   * Phase 7: Updates the rate limit for the translation pipeline's token bucket.
   * Called when the orchestrator adjusts fractional rate limits via IPC.
   */
  updateRateLimit(capacity: number, refillRate: number): void {
    if (this.translationPipeline) {
      this.translationPipeline
        .getTokenBucket()
        .updateConfig(capacity, refillRate);
      logger.info("Rate limit updated", { capacity, refillRate });
    } else {
      logger.warn("Cannot update rate limit - pipeline not initialized");
    }
  }

  /**
   * Phase 3: Gets the chunk aggregator for direct access.
   */
  getAggregator() {
    return this.audioBridge?.getAggregator() ?? null;
  }

  /**
   * Phase 5: Gets async playback health from the browser.
   */
  async getPlaybackHealth(): Promise<{
    trackPublished: boolean;
    trackMuted: boolean;
    destinationActive: boolean;
    queueLength: number;
    isPlaying: boolean;
  } | null> {
    if (!this.audioManager) {
      return null;
    }
    return await this.audioManager.getPlaybackHealth();
  }
}
