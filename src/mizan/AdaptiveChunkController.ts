/**
 * Adaptive Chunk Controller (Phase 4)
 *
 * Dynamically adjusts chunk duration based on system load to optimize
 * throughput while respecting rate limits.
 *
 * Key parameters (from implementation plan):
 * - Default chunk: 900ms
 * - Under load chunk: 1400-2000ms
 * - Max chunk: 3000ms
 * - Trigger: global tokens < 40% or local queue > 6
 *
 * The controller monitors:
 * - Token bucket fill level
 * - Queue depth
 * - Processing latency
 * - Error rate
 */

import { EventEmitter } from "events";
import { createLogger } from "../logger";
import { TokenBucket } from "./TokenBucket";
import { ChunkQueue } from "./ChunkQueue";
import { ChunkAggregator } from "../audio/ChunkAggregator";

const logger = createLogger("AdaptiveChunkController");

/**
 * Adaptive chunk configuration.
 */
export interface AdaptiveChunkConfig {
  // Chunk duration settings
  defaultChunkDurationMs: number;
  minChunkDurationMs: number;
  maxChunkDurationMs: number;

  // Load thresholds
  tokenLowThreshold: number; // Percentage (0-1)
  queueHighThreshold: number; // Number of items

  // Scaling factors
  underLoadChunkDurationMs: number;
  highLoadChunkDurationMs: number;

  // Update interval
  updateIntervalMs: number;

  // Smoothing (prevents rapid oscillation)
  smoothingFactor: number; // 0-1, higher = more smoothing
}

/**
 * Default adaptive chunk configuration per Phase 4 spec.
 */
export const DEFAULT_ADAPTIVE_CHUNK_CONFIG: AdaptiveChunkConfig = {
  defaultChunkDurationMs: 900,
  minChunkDurationMs: 500,
  maxChunkDurationMs: 3000,
  tokenLowThreshold: 0.4, // 40%
  queueHighThreshold: 6,
  underLoadChunkDurationMs: 1400,
  highLoadChunkDurationMs: 2000,
  updateIntervalMs: 1000,
  smoothingFactor: 0.3,
};

/**
 * Load level classification.
 */
export enum LoadLevel {
  NORMAL = "normal",
  ELEVATED = "elevated",
  HIGH = "high",
  CRITICAL = "critical",
}

/**
 * Adaptive chunk controller state.
 */
export interface AdaptiveState {
  loadLevel: LoadLevel;
  currentTargetDurationMs: number;
  tokenPercentage: number;
  queueDepth: number;
  recommendedDurationMs: number;
}

/**
 * Adaptive Chunk Controller.
 */
export class AdaptiveChunkController extends EventEmitter {
  private config: AdaptiveChunkConfig;
  private tokenBucket: TokenBucket | null = null;
  private queue: ChunkQueue | null = null;
  private aggregator: ChunkAggregator | null = null;

  private isRunning: boolean = false;
  private updateInterval: NodeJS.Timeout | null = null;

  private currentTargetDurationMs: number;
  private smoothedTargetDurationMs: number;
  private lastLoadLevel: LoadLevel = LoadLevel.NORMAL;

  // Metrics
  private adjustmentCount: number = 0;
  private lastAdjustmentTime: number = 0;

  constructor(config: Partial<AdaptiveChunkConfig> = {}) {
    super();
    this.config = { ...DEFAULT_ADAPTIVE_CHUNK_CONFIG, ...config };
    this.currentTargetDurationMs = this.config.defaultChunkDurationMs;
    this.smoothedTargetDurationMs = this.config.defaultChunkDurationMs;

    logger.info("AdaptiveChunkController initialized", {
      defaultDuration: this.config.defaultChunkDurationMs,
      minDuration: this.config.minChunkDurationMs,
      maxDuration: this.config.maxChunkDurationMs,
    });
  }

  /**
   * Connects the controller to pipeline components.
   */
  connect(
    tokenBucket: TokenBucket,
    queue: ChunkQueue,
    aggregator: ChunkAggregator,
  ): void {
    this.tokenBucket = tokenBucket;
    this.queue = queue;
    this.aggregator = aggregator;

    logger.info("AdaptiveChunkController connected to components");
  }

  /**
   * Starts the adaptive controller.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn("AdaptiveChunkController already running");
      return;
    }

    if (!this.tokenBucket || !this.queue || !this.aggregator) {
      throw new Error(
        "AdaptiveChunkController not connected - call connect() first",
      );
    }

    this.isRunning = true;

    // Start update loop
    this.updateInterval = setInterval(() => {
      this.update();
    }, this.config.updateIntervalMs);

    logger.info("AdaptiveChunkController started");
  }

  /**
   * Stops the adaptive controller.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    logger.info("AdaptiveChunkController stopped", {
      totalAdjustments: this.adjustmentCount,
    });
  }

  /**
   * Updates the chunk duration based on current system state.
   */
  private update(): void {
    if (!this.tokenBucket || !this.queue || !this.aggregator) {
      return;
    }

    const state = this.assessState();

    // Apply smoothing to prevent rapid oscillation
    this.smoothedTargetDurationMs =
      this.smoothedTargetDurationMs * this.config.smoothingFactor +
      state.recommendedDurationMs * (1 - this.config.smoothingFactor);

    // Round to nearest 100ms
    const newTarget = Math.round(this.smoothedTargetDurationMs / 100) * 100;

    // Clamp to valid range
    const clampedTarget = Math.max(
      this.config.minChunkDurationMs,
      Math.min(this.config.maxChunkDurationMs, newTarget),
    );

    // Check if we need to adjust
    if (clampedTarget !== this.currentTargetDurationMs) {
      const previousTarget = this.currentTargetDurationMs;
      this.currentTargetDurationMs = clampedTarget;
      this.lastAdjustmentTime = Date.now();
      this.adjustmentCount++;

      // Update the aggregator
      this.aggregator.setTargetDuration(clampedTarget);

      logger.info("Chunk duration adjusted", {
        previous: previousTarget,
        new: clampedTarget,
        loadLevel: state.loadLevel,
        tokenPercentage: (state.tokenPercentage * 100).toFixed(1) + "%",
        queueDepth: state.queueDepth,
      });

      this.emit("durationAdjusted", {
        previousDuration: previousTarget,
        newDuration: clampedTarget,
        loadLevel: state.loadLevel,
      });
    }

    // Check for load level changes
    if (state.loadLevel !== this.lastLoadLevel) {
      this.emit("loadLevelChanged", {
        previous: this.lastLoadLevel,
        current: state.loadLevel,
      });
      this.lastLoadLevel = state.loadLevel;
    }
  }

  /**
   * Assesses the current system state and determines recommended duration.
   */
  private assessState(): AdaptiveState {
    const tokenPercentage = this.tokenBucket!.getTokenPercentage();
    const queueDepth = this.queue!.getLength();
    const queueStats = this.queue!.getStats();

    // Determine load level
    let loadLevel = LoadLevel.NORMAL;
    let recommendedDurationMs = this.config.defaultChunkDurationMs;

    // Check for critical conditions
    const tokenCritical = tokenPercentage < 0.2;
    const queueCritical = queueDepth >= this.config.queueHighThreshold * 1.5;

    if (tokenCritical || queueCritical) {
      loadLevel = LoadLevel.CRITICAL;
      recommendedDurationMs = this.config.maxChunkDurationMs;
    }
    // Check for high load
    else if (
      tokenPercentage < this.config.tokenLowThreshold ||
      queueDepth >= this.config.queueHighThreshold
    ) {
      loadLevel = LoadLevel.HIGH;
      recommendedDurationMs = this.config.highLoadChunkDurationMs;
    }
    // Check for elevated load
    else if (
      tokenPercentage < 0.6 ||
      queueDepth >= this.config.queueHighThreshold * 0.5
    ) {
      loadLevel = LoadLevel.ELEVATED;
      recommendedDurationMs = this.config.underLoadChunkDurationMs;
    }

    // Factor in processing latency if available
    if (queueStats.avgWaitTimeMs > 2000) {
      // Chunks waiting too long, increase duration
      recommendedDurationMs = Math.max(
        recommendedDurationMs,
        this.config.underLoadChunkDurationMs,
      );
    }

    return {
      loadLevel,
      currentTargetDurationMs: this.currentTargetDurationMs,
      tokenPercentage,
      queueDepth,
      recommendedDurationMs,
    };
  }

  /**
   * Gets the current state.
   */
  getState(): AdaptiveState | null {
    if (!this.tokenBucket || !this.queue) {
      return null;
    }

    return this.assessState();
  }

  /**
   * Gets the current target duration.
   */
  getCurrentTargetDuration(): number {
    return this.currentTargetDurationMs;
  }

  /**
   * Forces a specific duration (for testing or manual override).
   */
  forceTargetDuration(durationMs: number): void {
    const clamped = Math.max(
      this.config.minChunkDurationMs,
      Math.min(this.config.maxChunkDurationMs, durationMs),
    );

    this.currentTargetDurationMs = clamped;
    this.smoothedTargetDurationMs = clamped;

    if (this.aggregator) {
      this.aggregator.setTargetDuration(clamped);
    }

    logger.info("Target duration forced", { duration: clamped });
  }

  /**
   * Resets to default duration.
   */
  reset(): void {
    this.currentTargetDurationMs = this.config.defaultChunkDurationMs;
    this.smoothedTargetDurationMs = this.config.defaultChunkDurationMs;
    this.lastLoadLevel = LoadLevel.NORMAL;
    this.adjustmentCount = 0;

    if (this.aggregator) {
      this.aggregator.setTargetDuration(this.config.defaultChunkDurationMs);
    }

    logger.info("AdaptiveChunkController reset");
  }

  /**
   * Gets metrics.
   */
  getMetrics(): {
    currentTargetDurationMs: number;
    smoothedTargetDurationMs: number;
    loadLevel: LoadLevel;
    adjustmentCount: number;
    lastAdjustmentTime: number;
    isRunning: boolean;
  } {
    return {
      currentTargetDurationMs: this.currentTargetDurationMs,
      smoothedTargetDurationMs: this.smoothedTargetDurationMs,
      loadLevel: this.lastLoadLevel,
      adjustmentCount: this.adjustmentCount,
      lastAdjustmentTime: this.lastAdjustmentTime,
      isRunning: this.isRunning,
    };
  }

  /**
   * Gets the configuration.
   */
  getConfig(): AdaptiveChunkConfig {
    return { ...this.config };
  }
}
