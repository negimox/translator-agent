/**
 * Chunk Aggregator for Audio Processing (Phase 3)
 *
 * Receives audio frames from the browser AudioWorklet, applies VAD gating,
 * and assembles audio chunks for STT processing.
 *
 * Features:
 * - VAD-driven chunking with configurable RMS threshold
 * - Coalesces utterances separated by < 250ms silence
 * - Default chunk target: 900ms, adaptive up to 3000ms under load
 * - Generates WAV files with Little Endian encoding
 * - Metadata: chunkId, timestamp, agentId
 */

import { EventEmitter } from "events";
import { createLogger } from "../logger";
import { encodeWav, WavMetadata } from "./WavEncoder";

const logger = createLogger("ChunkAggregator");

/**
 * Configuration for the chunk aggregator.
 */
export interface ChunkAggregatorConfig {
  // Agent identification
  agentId: string;

  // Sample rate (should match AudioContext)
  sampleRate: number;

  // VAD settings
  vadRmsThreshold: number; // RMS threshold for voice activity (0.01 = -40dB)
  vadSilenceCoalesceMs: number; // Max silence duration to coalesce (250ms)

  // Chunk timing
  targetChunkDurationMs: number; // Soft ceiling for chunk size (3000ms default)
  minChunkDurationMs: number; // Minimum chunk to send: 800ms
  maxChunkDurationMs: number; // Safety cap for continuous speech: 5000ms

  // Adaptive chunking (mechanism built in Phase 3, logic in Phase 4)
  adaptiveChunkingEnabled: boolean;

  // Debug
  debugMode: boolean;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CHUNK_CONFIG: ChunkAggregatorConfig = {
  agentId: "translator-unknown",
  sampleRate: 48000,
  vadRmsThreshold: 0.015, // ~-36dB, slightly less sensitive to filter ambient noise
  vadSilenceCoalesceMs: 600, // Coalesce utterances < 600ms apart (allows for thinking pauses)
  targetChunkDurationMs: 3000, // 3s target — soft ceiling for chunk size
  minChunkDurationMs: 800, // Allow natural short utterances ("yes", "okay thank you")
  maxChunkDurationMs: 5000, // Max 5 seconds — safety cap for continuous speech
  adaptiveChunkingEnabled: false, // Disabled until Phase 4
  debugMode: false,
};

/**
 * Audio frame received from the AudioWorklet.
 */
export interface AudioFrame {
  samples: Float32Array;
  timestamp: number;
  isSpeech: boolean;
  rms: number;
}

/**
 * Completed audio chunk ready for STT.
 */
export interface AudioChunk {
  chunkId: string;
  agentId: string;
  timestamp: number;
  durationMs: number;
  sampleRate: number;
  samples: Float32Array;
  wavBuffer: ArrayBuffer;
  metadata: WavMetadata;
}

/**
 * Aggregator state for tracking speech segments.
 */
interface AggregatorState {
  isCollecting: boolean;
  speechStartTime: number | null;
  lastSpeechTime: number | null;
  silenceDurationMs: number;
  collectedSamples: Float32Array[];
  totalSamplesCollected: number;
}

/**
 * Chunk Aggregator class.
 * Collects audio frames, applies VAD, and emits completed chunks.
 */
export class ChunkAggregator extends EventEmitter {
  private config: ChunkAggregatorConfig;
  private state: AggregatorState;
  private chunkCounter: number = 0;
  private currentTargetDurationMs: number;

  // Metrics
  private totalFramesReceived: number = 0;
  private totalChunksEmitted: number = 0;
  private droppedFrames: number = 0;

  constructor(config: Partial<ChunkAggregatorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CHUNK_CONFIG, ...config };
    this.currentTargetDurationMs = this.config.targetChunkDurationMs;
    this.state = this.createInitialState();

    logger.info("ChunkAggregator initialized", {
      agentId: this.config.agentId,
      sampleRate: this.config.sampleRate,
      targetChunkDurationMs: this.config.targetChunkDurationMs,
      vadRmsThreshold: this.config.vadRmsThreshold,
    });
  }

  /**
   * Creates the initial aggregator state.
   */
  private createInitialState(): AggregatorState {
    return {
      isCollecting: false,
      speechStartTime: null,
      lastSpeechTime: null,
      silenceDurationMs: 0,
      collectedSamples: [],
      totalSamplesCollected: 0,
    };
  }

  /**
   * Processes an incoming audio frame from the AudioWorklet.
   * This is the main entry point called from the Node.js bridge.
   */
  processFrame(frame: AudioFrame): void {
    this.totalFramesReceived++;

    const now = Date.now();
    const frameDurationMs =
      (frame.samples.length / this.config.sampleRate) * 1000;

    if (frame.isSpeech) {
      this.handleSpeechFrame(frame, now, frameDurationMs);
    } else {
      this.handleSilenceFrame(frame, now, frameDurationMs);
    }

    // Check if we should emit a chunk
    this.checkAndEmitChunk(now);
  }

  /**
   * Handles a frame containing speech.
   */
  private handleSpeechFrame(
    frame: AudioFrame,
    now: number,
    frameDurationMs: number,
  ): void {
    if (!this.state.isCollecting) {
      // Start new collection
      this.state.isCollecting = true;
      this.state.speechStartTime = now;
      this.state.collectedSamples = [];
      this.state.totalSamplesCollected = 0;

      logger.debug("Started collecting speech", {
        timestamp: now,
        rms: frame.rms.toFixed(4),
      });
    }

    // Add samples to collection
    this.state.collectedSamples.push(frame.samples);
    this.state.totalSamplesCollected += frame.samples.length;
    this.state.lastSpeechTime = now;
    this.state.silenceDurationMs = 0;
  }

  /**
   * Handles a frame containing silence.
   */
  private handleSilenceFrame(
    frame: AudioFrame,
    now: number,
    frameDurationMs: number,
  ): void {
    if (!this.state.isCollecting) {
      // Not collecting, ignore silence
      return;
    }

    // Update silence duration
    this.state.silenceDurationMs += frameDurationMs;

    // Still add samples if within coalesce window (to maintain continuity)
    if (this.state.silenceDurationMs <= this.config.vadSilenceCoalesceMs) {
      this.state.collectedSamples.push(frame.samples);
      this.state.totalSamplesCollected += frame.samples.length;
    }
  }

  /**
   * Checks if conditions are met to emit a chunk.
   */
  private checkAndEmitChunk(now: number): void {
    if (!this.state.isCollecting || !this.state.speechStartTime) {
      return;
    }

    const collectionDurationMs = now - this.state.speechStartTime;
    const hasSpeech = this.state.totalSamplesCollected > 0;

    // Emit conditions (priority order):
    // 1. PRIMARY: VAD silence exceeded coalesce window AND chunk meets minimum duration
    //    → This is the natural speech boundary detector. Emits as soon as the speaker
    //      pauses, preventing mid-word/mid-sentence splits.
    // 2. SAFETY: Reached maximum duration (force emit for continuous speakers)
    //    → Prevents unbounded buffering when someone talks without pausing.
    //
    // NOTE: targetChunkDurationMs is NOT used as a gate here. It exists only for
    // the AdaptiveChunkController to signal rate-limit-aware preferences, but
    // natural speech boundaries always take priority over timers.

    const silenceExceeded =
      this.state.silenceDurationMs > this.config.vadSilenceCoalesceMs;
    const meetsMinDuration =
      collectionDurationMs >= this.config.minChunkDurationMs;
    const reachedMax = collectionDurationMs >= this.config.maxChunkDurationMs;

    const shouldEmit =
      hasSpeech &&
      ((silenceExceeded && meetsMinDuration) || // Natural speech boundary
        reachedMax); // Safety cap for continuous speech

    if (shouldEmit) {
      this.emitChunk();
    }
  }

  /**
   * Emits the current collected audio as a chunk.
   */
  private emitChunk(): void {
    if (this.state.collectedSamples.length === 0) {
      this.resetState();
      return;
    }

    // Merge all collected samples
    const mergedSamples = this.mergeSamples(this.state.collectedSamples);

    // Check minimum duration
    const durationMs = (mergedSamples.length / this.config.sampleRate) * 1000;
    if (durationMs < this.config.minChunkDurationMs) {
      logger.debug("Chunk too short, discarding", { durationMs });
      this.resetState();
      return;
    }

    // Generate chunk ID
    const chunkId = this.generateChunkId();
    const timestamp = Date.now();

    // Create WAV metadata
    const metadata: WavMetadata = {
      chunkId,
      agentId: this.config.agentId,
      timestamp,
      durationMs,
      sampleRate: this.config.sampleRate,
      channels: 1,
      bitsPerSample: 16,
    };

    // Encode to WAV
    const wavBuffer = encodeWav(mergedSamples, metadata);

    // Create chunk object
    const chunk: AudioChunk = {
      chunkId,
      agentId: this.config.agentId,
      timestamp,
      durationMs,
      sampleRate: this.config.sampleRate,
      samples: mergedSamples,
      wavBuffer,
      metadata,
    };

    this.totalChunksEmitted++;

    logger.info("Chunk emitted", {
      chunkId,
      durationMs: durationMs.toFixed(0),
      samples: mergedSamples.length,
      wavSize: wavBuffer.byteLength,
      totalChunks: this.totalChunksEmitted,
    });

    // Emit event for consumers
    this.emit("chunk", chunk);

    // Reset state for next chunk
    this.resetState();
  }

  /**
   * Merges multiple Float32Arrays into one.
   */
  private mergeSamples(arrays: Float32Array[]): Float32Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const merged = new Float32Array(totalLength);

    let offset = 0;
    for (const arr of arrays) {
      merged.set(arr, offset);
      offset += arr.length;
    }

    return merged;
  }

  /**
   * Generates a unique chunk ID.
   */
  private generateChunkId(): string {
    this.chunkCounter++;
    const timestamp = Date.now().toString(36);
    const counter = this.chunkCounter.toString(36).padStart(4, "0");
    return `${this.config.agentId}-${timestamp}-${counter}`;
  }

  /**
   * Resets the aggregator state for next collection.
   */
  private resetState(): void {
    this.state = this.createInitialState();
  }

  /**
   * Forces emission of any pending audio (e.g., on shutdown).
   */
  flush(): void {
    if (this.state.isCollecting && this.state.collectedSamples.length > 0) {
      logger.info("Flushing pending audio");
      this.emitChunk();
    }
  }

  /**
   * Updates the target chunk duration (soft ceiling, not a gate).
   * This value is informational — checkAndEmitChunk does NOT gate on it.
   * Kept for metrics/compatibility with AdaptiveChunkController.
   */
  setTargetDuration(durationMs: number): void {
    const clamped = Math.max(
      this.config.minChunkDurationMs,
      Math.min(this.config.maxChunkDurationMs, durationMs),
    );

    if (clamped !== this.currentTargetDurationMs) {
      logger.info("Target duration updated", {
        previous: this.currentTargetDurationMs,
        new: clamped,
      });
      this.currentTargetDurationMs = clamped;
    }
  }

  /**
   * Updates the maximum chunk duration (safety cap for continuous speech).
   * Called by the AdaptiveChunkController under load to allow longer chunks
   * (fewer API calls) when the system is under pressure.
   */
  setMaxDuration(durationMs: number): void {
    const clamped = Math.max(
      this.config.minChunkDurationMs,
      Math.min(10000, durationMs), // Hard upper limit of 10s
    );

    if (clamped !== this.config.maxChunkDurationMs) {
      logger.info("Max duration updated", {
        previous: this.config.maxChunkDurationMs,
        new: clamped,
      });
      this.config.maxChunkDurationMs = clamped;
    }
  }

  /**
   * Gets current max duration.
   */
  getMaxDuration(): number {
    return this.config.maxChunkDurationMs;
  }

  /**
   * Gets current target duration.
   */
  getTargetDuration(): number {
    return this.currentTargetDurationMs;
  }

  /**
   * Gets aggregator metrics.
   */
  getMetrics(): {
    totalFramesReceived: number;
    totalChunksEmitted: number;
    droppedFrames: number;
    currentTargetDurationMs: number;
    isCollecting: boolean;
  } {
    return {
      totalFramesReceived: this.totalFramesReceived,
      totalChunksEmitted: this.totalChunksEmitted,
      droppedFrames: this.droppedFrames,
      currentTargetDurationMs: this.currentTargetDurationMs,
      isCollecting: this.state.isCollecting,
    };
  }

  /**
   * Resets all metrics.
   */
  resetMetrics(): void {
    this.totalFramesReceived = 0;
    this.totalChunksEmitted = 0;
    this.droppedFrames = 0;
  }
}
