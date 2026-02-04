/**
 * Token Bucket Rate Limiter (Phase 4)
 *
 * Implements a token bucket algorithm for rate limiting Mizan API requests.
 *
 * Key parameters (from implementation plan):
 * - Provider quota: 10 req/s; conservative config: 8 tokens/sec
 * - Bucket capacity: 8 tokens
 * - Token cost per chunk pipeline: 3 tokens (STT, Translation, TTS)
 *
 * Features:
 * - Automatic token refill based on refill rate
 * - Wait-based and tryAcquire-based token acquisition
 * - Metrics for monitoring bucket state
 * - Events for low token warnings
 */

import { EventEmitter } from "events";
import { createLogger } from "../logger";

const logger = createLogger("TokenBucket");

/**
 * Token bucket configuration.
 */
export interface TokenBucketConfig {
  // Maximum tokens in the bucket
  capacity: number;

  // Tokens added per second
  refillRate: number;

  // Initial tokens (defaults to capacity)
  initialTokens?: number;

  // Low token warning threshold (percentage)
  lowTokenWarningThreshold: number;
}

/**
 * Default token bucket configuration per Phase 4 spec.
 */
export const DEFAULT_TOKEN_BUCKET_CONFIG: TokenBucketConfig = {
  capacity: 8,
  refillRate: 8, // 8 tokens/sec
  lowTokenWarningThreshold: 0.4, // Warn when < 40% tokens
};

/**
 * Token acquisition result.
 */
export interface TokenAcquisitionResult {
  acquired: boolean;
  tokensAvailable: number;
  waitTimeMs?: number;
}

/**
 * Token Bucket implementation.
 */
export class TokenBucket extends EventEmitter {
  private config: TokenBucketConfig;
  private tokens: number;
  private lastRefillTime: number;

  // Metrics
  private totalAcquisitions: number = 0;
  private totalRejections: number = 0;
  private totalWaitTimeMs: number = 0;

  // Warning state
  private lowTokenWarningFired: boolean = false;

  constructor(config: Partial<TokenBucketConfig> = {}) {
    super();
    this.config = { ...DEFAULT_TOKEN_BUCKET_CONFIG, ...config };
    this.tokens = this.config.initialTokens ?? this.config.capacity;
    this.lastRefillTime = Date.now();

    logger.info("TokenBucket initialized", {
      capacity: this.config.capacity,
      refillRate: this.config.refillRate,
      initialTokens: this.tokens,
    });
  }

  /**
   * Refills tokens based on elapsed time since last refill.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTime;
    const elapsedSec = elapsedMs / 1000;

    // Calculate tokens to add
    const tokensToAdd = elapsedSec * this.config.refillRate;

    if (tokensToAdd >= 1) {
      const previousTokens = this.tokens;
      this.tokens = Math.min(this.config.capacity, this.tokens + tokensToAdd);
      this.lastRefillTime = now;

      // Check if we've recovered from low tokens
      if (
        this.lowTokenWarningFired &&
        this.getTokenPercentage() >= this.config.lowTokenWarningThreshold
      ) {
        this.lowTokenWarningFired = false;
        this.emit("tokensRecovered", {
          tokens: this.tokens,
          percentage: this.getTokenPercentage(),
        });
        logger.info("Token bucket recovered", {
          tokens: this.tokens,
          percentage: (this.getTokenPercentage() * 100).toFixed(1) + "%",
        });
      }

      logger.debug("Tokens refilled", {
        added: (this.tokens - previousTokens).toFixed(2),
        current: this.tokens.toFixed(2),
      });
    }
  }

  /**
   * Gets the current token percentage (0-1).
   */
  getTokenPercentage(): number {
    this.refill();
    return this.tokens / this.config.capacity;
  }

  /**
   * Tries to acquire tokens without waiting.
   * Returns immediately with the result.
   */
  tryAcquire(count: number = 1): TokenAcquisitionResult {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      this.totalAcquisitions++;
      this.checkLowTokens();

      return {
        acquired: true,
        tokensAvailable: this.tokens,
      };
    }

    this.totalRejections++;

    // Calculate wait time needed
    const tokensNeeded = count - this.tokens;
    const waitTimeMs = (tokensNeeded / this.config.refillRate) * 1000;

    return {
      acquired: false,
      tokensAvailable: this.tokens,
      waitTimeMs,
    };
  }

  /**
   * Acquires tokens, waiting if necessary.
   * Returns a promise that resolves when tokens are acquired.
   */
  async acquire(count: number = 1): Promise<TokenAcquisitionResult> {
    // First try without waiting
    const tryResult = this.tryAcquire(count);
    if (tryResult.acquired) {
      return tryResult;
    }

    // Need to wait
    const waitTimeMs = tryResult.waitTimeMs || 0;

    logger.debug("Waiting for tokens", {
      requested: count,
      available: this.tokens,
      waitTimeMs,
    });

    const waitStart = Date.now();

    await this.sleep(waitTimeMs);

    // Try again after waiting
    const result = this.tryAcquire(count);

    if (result.acquired) {
      const actualWaitMs = Date.now() - waitStart;
      this.totalWaitTimeMs += actualWaitMs;
      return {
        ...result,
        waitTimeMs: actualWaitMs,
      };
    }

    // Still couldn't acquire - return with calculated wait time
    return result;
  }

  /**
   * Checks if we should fire a low token warning.
   */
  private checkLowTokens(): void {
    const percentage = this.getTokenPercentage();

    if (
      !this.lowTokenWarningFired &&
      percentage < this.config.lowTokenWarningThreshold
    ) {
      this.lowTokenWarningFired = true;
      this.emit("lowTokens", {
        tokens: this.tokens,
        percentage,
        threshold: this.config.lowTokenWarningThreshold,
      });
      logger.warn("Token bucket low", {
        tokens: this.tokens.toFixed(2),
        percentage: (percentage * 100).toFixed(1) + "%",
        threshold:
          (this.config.lowTokenWarningThreshold * 100).toFixed(1) + "%",
      });
    }
  }

  /**
   * Peeks at current token count without modifying state.
   */
  peek(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Returns tokens to the bucket (e.g., when an operation is cancelled).
   */
  release(count: number = 1): void {
    this.tokens = Math.min(this.config.capacity, this.tokens + count);
    logger.debug("Tokens released", {
      released: count,
      current: this.tokens.toFixed(2),
    });
  }

  /**
   * Gets bucket metrics.
   */
  getMetrics(): {
    currentTokens: number;
    capacity: number;
    percentage: number;
    totalAcquisitions: number;
    totalRejections: number;
    totalWaitTimeMs: number;
    avgWaitTimeMs: number;
  } {
    this.refill();

    return {
      currentTokens: this.tokens,
      capacity: this.config.capacity,
      percentage: this.tokens / this.config.capacity,
      totalAcquisitions: this.totalAcquisitions,
      totalRejections: this.totalRejections,
      totalWaitTimeMs: this.totalWaitTimeMs,
      avgWaitTimeMs:
        this.totalAcquisitions > 0
          ? this.totalWaitTimeMs / this.totalAcquisitions
          : 0,
    };
  }

  /**
   * Resets the bucket to full capacity.
   */
  reset(): void {
    this.tokens = this.config.capacity;
    this.lastRefillTime = Date.now();
    this.totalAcquisitions = 0;
    this.totalRejections = 0;
    this.totalWaitTimeMs = 0;
    this.lowTokenWarningFired = false;
    logger.info("TokenBucket reset to full capacity");
  }

  /**
   * Gets the configuration.
   */
  getConfig(): TokenBucketConfig {
    return { ...this.config };
  }

  /**
   * Sleep utility.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Token costs for different Mizan operations.
 * Per Phase 4 spec: Token cost per chunk pipeline = 3 (STT, Translation, TTS)
 */
export const MIZAN_TOKEN_COSTS = {
  STT: 1,
  TRANSLATION: 1,
  TTS: 1,
  FULL_PIPELINE: 3, // STT + Translation + TTS
} as const;
