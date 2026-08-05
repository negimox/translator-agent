/**
 * Audio Bridge for Node.js ↔ Browser communication (Phase 3)
 *
 * Uses Puppeteer's page.exposeFunction() to receive audio frames
 * from the browser's AudioWorklet and forward them to the ChunkAggregator.
 *
 * Also handles writing debug WAV files to disk for validation.
 */

import { Page } from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../logger";
import {
  ChunkAggregator,
  AudioChunk,
  ChunkAggregatorConfig,
  AudioFrame,
} from "./ChunkAggregator";
import { validateWav, generateTestTone } from "./WavEncoder";

// Re-export AudioChunk for consumers
export { AudioChunk };

const logger = createLogger("AudioBridge");

/**
 * Audio frame data received from the browser.
 * Note: samples are transferred as a regular array, not Float32Array.
 */
interface BrowserAudioFrame {
  samples: number[];
  timestamp: number;
  frameCount: number;
  rms: number;
  isSpeech: boolean;
}

/**
 * Configuration for the audio bridge.
 */
export interface AudioBridgeConfig {
  // Chunk aggregator configuration
  aggregatorConfig: Partial<ChunkAggregatorConfig>;

  // Debug options
  debugMode: boolean;
  debugOutputDir: string;
  maxDebugChunks: number;

  // Callback for completed chunks
  onChunk?: (chunk: AudioChunk) => void;
}

/**
 * Default audio bridge configuration.
 */
export const DEFAULT_BRIDGE_CONFIG: AudioBridgeConfig = {
  aggregatorConfig: {},
  debugMode: false,
  debugOutputDir: "./debug_chunks",
  maxDebugChunks: 100,
  onChunk: undefined,
};

/**
 * Audio Bridge class.
 * Bridges browser audio to Node.js for processing.
 */
export class AudioBridge {
  private config: AudioBridgeConfig;
  private page: Page;
  private aggregator: ChunkAggregator;
  private isRunning: boolean = false;
  private framesReceived: number = 0;
  private debugChunkCount: number = 0;

  // Exposed function name in browser
  private readonly CALLBACK_NAME = "__onTranslatorAudioFrame";

  constructor(page: Page, config: Partial<AudioBridgeConfig> = {}) {
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
    this.page = page;

    // Create chunk aggregator
    this.aggregator = new ChunkAggregator(this.config.aggregatorConfig);

    // Set up chunk event listener
    this.aggregator.on("chunk", (chunk: AudioChunk) => this.handleChunk(chunk));

    logger.info("AudioBridge created", {
      debugMode: this.config.debugMode,
      debugOutputDir: this.config.debugOutputDir,
    });
  }

  /**
   * Starts the audio bridge.
   * Exposes the callback function and registers it with the AudioManager.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("AudioBridge already running");
      return;
    }

    logger.info("Starting AudioBridge");

    // Initialize aggregator (loads Silero VAD)
    await this.aggregator.initialize();

    // Ensure debug directory exists
    if (this.config.debugMode) {
      await this.ensureDebugDirectory();
    }

    // Expose the callback function to the browser
    await this.page.exposeFunction(
      this.CALLBACK_NAME,
      async (frame: BrowserAudioFrame) => {
        await this.handleBrowserFrame(frame);
      },
    );

    logger.info("Exposed audio callback to browser", {
      callbackName: this.CALLBACK_NAME,
    });

    this.isRunning = true;

    // Start periodic status logging in debug mode
    if (this.config.debugMode) {
      this.startStatusLogging();
    }
  }

  /**
   * Starts periodic status logging for debugging.
   */
  private startStatusLogging(): void {
    const statusInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(statusInterval);
        return;
      }

      const metrics = this.aggregator.getMetrics();
      logger.info("Audio bridge status", {
        framesReceived: this.framesReceived,
        chunksGenerated: this.debugChunkCount,
        ...metrics,
      });

      // If no frames received after 10 seconds, log a warning
      if (this.framesReceived === 0) {
        logger.warn(
          "No audio frames received from browser! Check if participants are unmuted and audio is flowing.",
        );
      }
    }, 5000); // Log every 5 seconds
  }

  /**
   * Gets the callback name for registration with AudioManager.
   */
  getCallbackName(): string {
    return this.CALLBACK_NAME;
  }

  /**
   * Handles an incoming audio frame from the browser.
   */
  private async handleBrowserFrame(frame: BrowserAudioFrame): Promise<void> {
    if (!this.isRunning) return;

    this.framesReceived++;

    try {
      // Convert to Float32Array (Puppeteer serialization gives us an object)
      const samplesArray = Object.values(frame.samples) as number[];
      const samples = new Float32Array(samplesArray);

      // Create AudioFrame for aggregator
      const audioFrame: AudioFrame = {
        samples,
        timestamp: frame.timestamp,
        isSpeech: frame.isSpeech,
        rms: frame.rms,
      };

      // Send to aggregator for chunking
      await this.aggregator.processFrame(audioFrame);
    } catch (e) {
      logger.error("Error processing browser frame", { error: (e as Error).message });
    }

    // Log periodically (every ~21 seconds at 48kHz/128 samples)
    if (this.framesReceived % 1000 === 0) {
      logger.debug("Audio frames received", {
        total: this.framesReceived,
        aggregatorMetrics: this.aggregator.getMetrics(),
      });
    }
  }

  /**
   * Handles a completed chunk from the aggregator.
   */
  private handleChunk(chunk: AudioChunk): void {
    logger.info("Chunk ready", {
      chunkId: chunk.chunkId,
      durationMs: chunk.durationMs.toFixed(0),
      wavSize: chunk.wavBuffer.byteLength,
    });

    // Save debug chunk if enabled
    if (this.config.debugMode) {
      this.saveDebugChunk(chunk);
    }

    // Call external handler if provided
    if (this.config.onChunk) {
      try {
        this.config.onChunk(chunk);
      } catch (error) {
        logger.error("Error in onChunk callback", { error: String(error) });
      }
    }
  }

  /**
   * Saves a chunk to the debug directory for validation.
   */
  private async saveDebugChunk(chunk: AudioChunk): Promise<void> {
    if (this.debugChunkCount >= this.config.maxDebugChunks) {
      logger.debug("Max debug chunks reached, skipping save");
      return;
    }

    try {
      const filename = `chunk_${chunk.chunkId}.wav`;
      const filepath = path.join(this.config.debugOutputDir, filename);

      // Write WAV buffer to file
      const buffer = Buffer.from(chunk.wavBuffer);
      fs.writeFileSync(filepath, buffer);

      // Validate the written file
      const validation = validateWav(chunk.wavBuffer);

      this.debugChunkCount++;

      logger.info("Debug chunk saved", {
        filepath,
        chunkId: chunk.chunkId,
        durationMs: chunk.durationMs.toFixed(0),
        fileSize: buffer.length,
        valid: validation.valid,
        wavInfo: validation.info,
      });

      // Write metadata JSON alongside
      const metadataPath = filepath.replace(".wav", ".json");
      const metadata = {
        ...chunk.metadata,
        validation: validation,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (error) {
      logger.error("Failed to save debug chunk", { error: String(error) });
    }
  }

  /**
   * Ensures the debug output directory exists.
   */
  private async ensureDebugDirectory(): Promise<void> {
    const dir = this.config.debugOutputDir;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info("Created debug directory", { dir });
    }
  }

  /**
   * Generates and saves a test tone for WAV validation.
   * This can be used to verify the WAV encoder is working correctly.
   */
  async generateTestToneFile(durationMs: number = 1000): Promise<string> {
    const { wavBuffer } = generateTestTone(durationMs);

    await this.ensureDebugDirectory();

    const filename = `test_tone_${Date.now()}.wav`;
    const filepath = path.join(this.config.debugOutputDir, filename);

    const buffer = Buffer.from(wavBuffer);
    fs.writeFileSync(filepath, buffer);

    // Validate
    const validation = validateWav(wavBuffer);

    logger.info("Test tone generated", {
      filepath,
      durationMs,
      fileSize: buffer.length,
      valid: validation.valid,
      wavInfo: validation.info,
    });

    return filepath;
  }

  /**
   * Stops the audio bridge and flushes any pending audio.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info("Stopping AudioBridge");

    // Flush any pending audio
    this.aggregator.flush();

    this.isRunning = false;

    logger.info("AudioBridge stopped", {
      totalFramesReceived: this.framesReceived,
      metrics: this.aggregator.getMetrics(),
    });
  }

  /**
   * Gets the chunk aggregator for direct access.
   */
  getAggregator(): ChunkAggregator {
    return this.aggregator;
  }

  /**
   * Gets bridge metrics.
   */
  getMetrics(): {
    framesReceived: number;
    debugChunkCount: number;
    isRunning: boolean;
    aggregatorMetrics: ReturnType<ChunkAggregator["getMetrics"]>;
  } {
    return {
      framesReceived: this.framesReceived,
      debugChunkCount: this.debugChunkCount,
      isRunning: this.isRunning,
      aggregatorMetrics: this.aggregator.getMetrics(),
    };
  }
}
