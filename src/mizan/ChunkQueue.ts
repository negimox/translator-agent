/**
 * Chunk Queue with Priority Support (Phase 4)
 *
 * Manages a queue of audio chunks waiting for translation processing.
 *
 * Key parameters (from implementation plan):
 * - Max in-flight Mizan requests per agent: 2
 * - Max local queue length per agent: 12
 *
 * Features:
 * - Priority-based processing (active-speaker chunks first)
 * - Backpressure signaling
 * - Queue metrics and monitoring
 */

import { EventEmitter } from "events";
import { createLogger } from "../logger";
import { AudioChunk } from "../audio/ChunkAggregator";

const logger = createLogger("ChunkQueue");

/**
 * Queue item wrapping an audio chunk with metadata.
 */
export interface QueuedChunk {
  chunk: AudioChunk;
  priority: ChunkPriority;
  enqueuedAt: number;
  speakerId?: string;
  isActiveSpeaker: boolean;
}

/**
 * Chunk priority levels.
 */
export enum ChunkPriority {
  HIGH = 1, // Active speaker
  NORMAL = 2, // Regular participants
  LOW = 3, // Background/fallback
}

/**
 * Queue configuration.
 */
export interface ChunkQueueConfig {
  // Maximum chunks in queue
  maxQueueLength: number;

  // Maximum concurrent in-flight requests
  maxInFlight: number;

  // Backpressure threshold (percentage of max queue length)
  backpressureThreshold: number;

  // Time after which queued chunks are dropped (ms)
  maxQueueAgeMs: number;
}

/**
 * Default queue configuration per Phase 4 spec.
 */
export const DEFAULT_QUEUE_CONFIG: ChunkQueueConfig = {
  maxQueueLength: 12,
  maxInFlight: 2,
  backpressureThreshold: 0.5, // 50% = 6 items
  maxQueueAgeMs: 10000, // 10 seconds
};

/**
 * Queue statistics.
 */
export interface QueueStats {
  queueLength: number;
  inFlight: number;
  totalEnqueued: number;
  totalProcessed: number;
  totalDropped: number;
  avgWaitTimeMs: number;
  isBackpressured: boolean;
}

/**
 * Chunk Queue implementation.
 */
export class ChunkQueue extends EventEmitter {
  private config: ChunkQueueConfig;
  private queue: QueuedChunk[] = [];
  private inFlight: number = 0;

  // Metrics
  private totalEnqueued: number = 0;
  private totalProcessed: number = 0;
  private totalDropped: number = 0;
  private totalWaitTimeMs: number = 0;

  // Active speaker tracking
  private activeSpeakerId: string | null = null;

  constructor(config: Partial<ChunkQueueConfig> = {}) {
    super();
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...config };

    logger.info("ChunkQueue initialized", {
      maxQueueLength: this.config.maxQueueLength,
      maxInFlight: this.config.maxInFlight,
    });
  }

  /**
   * Sets the current active speaker ID for prioritization.
   */
  setActiveSpeaker(speakerId: string | null): void {
    if (this.activeSpeakerId !== speakerId) {
      logger.debug("Active speaker changed", {
        previous: this.activeSpeakerId,
        new: speakerId,
      });
      this.activeSpeakerId = speakerId;
    }
  }

  /**
   * Enqueues a chunk for processing.
   * Returns true if enqueued, false if dropped due to backpressure.
   */
  enqueue(chunk: AudioChunk, speakerId?: string): boolean {
    // Clean up stale items first
    this.pruneStale();

    // Check if queue is full
    if (this.queue.length >= this.config.maxQueueLength) {
      this.totalDropped++;
      logger.warn("Chunk dropped - queue full", {
        chunkId: chunk.chunkId,
        queueLength: this.queue.length,
        maxLength: this.config.maxQueueLength,
      });
      this.emit("chunkDropped", { chunk, reason: "queue_full" });
      return false;
    }

    // Determine priority
    const isActiveSpeaker = speakerId === this.activeSpeakerId;
    const priority = isActiveSpeaker
      ? ChunkPriority.HIGH
      : ChunkPriority.NORMAL;

    const queuedChunk: QueuedChunk = {
      chunk,
      priority,
      enqueuedAt: Date.now(),
      speakerId,
      isActiveSpeaker,
    };

    // Insert in priority order
    this.insertByPriority(queuedChunk);

    this.totalEnqueued++;

    logger.debug("Chunk enqueued", {
      chunkId: chunk.chunkId,
      priority: ChunkPriority[priority],
      queueLength: this.queue.length,
      isActiveSpeaker,
    });

    // Check backpressure
    if (this.isBackpressured()) {
      this.emit("backpressure", {
        queueLength: this.queue.length,
        threshold:
          this.config.backpressureThreshold * this.config.maxQueueLength,
      });
    }

    // Signal that a chunk is ready
    this.emit("chunkReady");

    return true;
  }

  /**
   * Inserts a chunk in priority order (lower priority number = higher priority).
   */
  private insertByPriority(item: QueuedChunk): void {
    // Find insertion point
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (item.priority < this.queue[i].priority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, item);
  }

  /**
   * Dequeues the highest priority chunk for processing.
   * Returns null if queue is empty or max in-flight reached.
   */
  dequeue(): QueuedChunk | null {
    // Check in-flight limit
    if (this.inFlight >= this.config.maxInFlight) {
      logger.debug("Dequeue blocked - max in-flight reached", {
        inFlight: this.inFlight,
        maxInFlight: this.config.maxInFlight,
      });
      return null;
    }

    // Clean up stale items
    this.pruneStale();

    if (this.queue.length === 0) {
      return null;
    }

    const item = this.queue.shift()!;
    this.inFlight++;

    const waitTimeMs = Date.now() - item.enqueuedAt;
    this.totalWaitTimeMs += waitTimeMs;

    logger.debug("Chunk dequeued", {
      chunkId: item.chunk.chunkId,
      waitTimeMs,
      inFlight: this.inFlight,
      remaining: this.queue.length,
    });

    return item;
  }

  /**
   * Marks a chunk as processed (completes in-flight tracking).
   */
  markProcessed(chunkId: string): void {
    if (this.inFlight > 0) {
      this.inFlight--;
    }
    this.totalProcessed++;

    logger.debug("Chunk marked processed", {
      chunkId,
      inFlight: this.inFlight,
    });

    // If there are more chunks and capacity, signal readiness
    if (this.queue.length > 0 && this.inFlight < this.config.maxInFlight) {
      this.emit("chunkReady");
    }
  }

  /**
   * Marks a chunk as failed (releases in-flight slot).
   */
  markFailed(chunkId: string, requeue: boolean = false): void {
    if (this.inFlight > 0) {
      this.inFlight--;
    }

    logger.debug("Chunk marked failed", {
      chunkId,
      requeue,
      inFlight: this.inFlight,
    });

    // Optionally requeue at low priority
    if (requeue) {
      // Find the original chunk in dropped history or create placeholder
      logger.warn("Requeue not implemented - chunk dropped");
      this.totalDropped++;
    }
  }

  /**
   * Removes stale chunks that have been waiting too long.
   */
  private pruneStale(): void {
    const now = Date.now();
    const cutoff = now - this.config.maxQueueAgeMs;

    const staleCount = this.queue.filter(
      (item) => item.enqueuedAt < cutoff,
    ).length;

    if (staleCount > 0) {
      this.queue = this.queue.filter((item) => item.enqueuedAt >= cutoff);
      this.totalDropped += staleCount;

      logger.warn("Pruned stale chunks", {
        count: staleCount,
        remaining: this.queue.length,
      });
    }
  }

  /**
   * Checks if the queue is experiencing backpressure.
   */
  isBackpressured(): boolean {
    const threshold =
      this.config.backpressureThreshold * this.config.maxQueueLength;
    return this.queue.length >= threshold;
  }

  /**
   * Gets the current queue length.
   */
  getLength(): number {
    return this.queue.length;
  }

  /**
   * Gets the number of in-flight requests.
   */
  getInFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Checks if there's capacity to process more chunks.
   */
  hasCapacity(): boolean {
    return this.inFlight < this.config.maxInFlight && this.queue.length > 0;
  }

  /**
   * Peeks at the next chunk without dequeuing.
   */
  peek(): QueuedChunk | null {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  /**
   * Gets queue statistics.
   */
  getStats(): QueueStats {
    return {
      queueLength: this.queue.length,
      inFlight: this.inFlight,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalDropped: this.totalDropped,
      avgWaitTimeMs:
        this.totalProcessed > 0
          ? this.totalWaitTimeMs / this.totalProcessed
          : 0,
      isBackpressured: this.isBackpressured(),
    };
  }

  /**
   * Clears the queue (e.g., on shutdown).
   */
  clear(): void {
    const cleared = this.queue.length;
    this.queue = [];
    this.totalDropped += cleared;

    logger.info("Queue cleared", { cleared });
  }

  /**
   * Resets all metrics.
   */
  resetMetrics(): void {
    this.totalEnqueued = 0;
    this.totalProcessed = 0;
    this.totalDropped = 0;
    this.totalWaitTimeMs = 0;
  }

  /**
   * Gets the queue configuration.
   */
  getConfig(): ChunkQueueConfig {
    return { ...this.config };
  }
}
