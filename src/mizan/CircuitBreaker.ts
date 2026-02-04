/**
 * Circuit Breaker Pattern Implementation (Phase 4)
 *
 * Protects against cascading failures when Mizan API is degraded.
 *
 * Key parameters (from implementation plan):
 * - Open when error rate ≥ 10% over 60s
 * - Open timeout: 10s
 * - Half-open probes after timeout
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Circuit tripped, requests fail fast
 * - HALF_OPEN: Testing if service recovered
 */

import { EventEmitter } from "events";
import { createLogger } from "../logger";

const logger = createLogger("CircuitBreaker");

/**
 * Circuit breaker states.
 */
export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  // Error threshold percentage to open circuit (0-1)
  errorThreshold: number;

  // Time window for error rate calculation (ms)
  errorWindowMs: number;

  // Time to wait before trying half-open (ms)
  openTimeoutMs: number;

  // Number of successful calls needed to close circuit from half-open
  halfOpenSuccessThreshold: number;

  // Number of test calls allowed in half-open state
  halfOpenTestCalls: number;

  // Minimum number of calls before calculating error rate
  minCallsBeforeTripping: number;
}

/**
 * Default circuit breaker configuration per Phase 4 spec.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  errorThreshold: 0.1, // 10% error rate
  errorWindowMs: 60000, // 60 seconds
  openTimeoutMs: 10000, // 10 seconds
  halfOpenSuccessThreshold: 3,
  halfOpenTestCalls: 3,
  minCallsBeforeTripping: 10,
};

/**
 * Call record for tracking success/failure.
 */
interface CallRecord {
  timestamp: number;
  success: boolean;
}

/**
 * Circuit breaker event data.
 */
export interface CircuitBreakerEvent {
  state: CircuitState;
  previousState: CircuitState;
  errorRate?: number;
  reason?: string;
}

/**
 * Circuit Breaker implementation.
 */
export class CircuitBreaker extends EventEmitter {
  private config: CircuitBreakerConfig;
  private state: CircuitState = CircuitState.CLOSED;
  private callHistory: CallRecord[] = [];
  private openedAt: number | null = null;
  private halfOpenSuccessCount: number = 0;
  private halfOpenCallCount: number = 0;

  // Metrics
  private totalCalls: number = 0;
  private totalSuccesses: number = 0;
  private totalFailures: number = 0;
  private totalRejections: number = 0;
  private tripCount: number = 0;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };

    logger.info("CircuitBreaker initialized", {
      errorThreshold: this.config.errorThreshold,
      errorWindowMs: this.config.errorWindowMs,
      openTimeoutMs: this.config.openTimeoutMs,
    });
  }

  /**
   * Gets the current circuit state.
   */
  getState(): CircuitState {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN && this.openedAt) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.openTimeoutMs) {
        this.transitionTo(CircuitState.HALF_OPEN, "Open timeout expired");
      }
    }

    return this.state;
  }

  /**
   * Checks if a request should be allowed through.
   * Returns true if allowed, false if circuit is open.
   */
  allowRequest(): boolean {
    const state = this.getState();

    switch (state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        this.totalRejections++;
        logger.debug("Request rejected - circuit OPEN");
        return false;

      case CircuitState.HALF_OPEN:
        // Allow limited test calls in half-open state
        if (this.halfOpenCallCount < this.config.halfOpenTestCalls) {
          this.halfOpenCallCount++;
          return true;
        }
        this.totalRejections++;
        logger.debug("Request rejected - half-open limit reached");
        return false;

      default:
        return false;
    }
  }

  /**
   * Records a successful call.
   */
  recordSuccess(): void {
    this.totalCalls++;
    this.totalSuccesses++;
    this.addCallRecord(true);

    const state = this.getState();

    if (state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccessCount++;
      logger.debug("Half-open success", {
        count: this.halfOpenSuccessCount,
        threshold: this.config.halfOpenSuccessThreshold,
      });

      if (this.halfOpenSuccessCount >= this.config.halfOpenSuccessThreshold) {
        this.transitionTo(
          CircuitState.CLOSED,
          "Half-open success threshold met",
        );
      }
    }
  }

  /**
   * Records a failed call.
   */
  recordFailure(): void {
    this.totalCalls++;
    this.totalFailures++;
    this.addCallRecord(false);

    const state = this.getState();

    if (state === CircuitState.HALF_OPEN) {
      // Single failure in half-open trips the circuit again
      this.transitionTo(CircuitState.OPEN, "Failure during half-open test");
      return;
    }

    if (state === CircuitState.CLOSED) {
      // Check if we should trip the circuit
      this.checkAndTrip();
    }
  }

  /**
   * Adds a call record to history.
   */
  private addCallRecord(success: boolean): void {
    const now = Date.now();
    this.callHistory.push({ timestamp: now, success });

    // Clean up old records
    this.pruneHistory();
  }

  /**
   * Removes call records outside the error window.
   */
  private pruneHistory(): void {
    const cutoff = Date.now() - this.config.errorWindowMs;
    this.callHistory = this.callHistory.filter(
      (record) => record.timestamp >= cutoff,
    );
  }

  /**
   * Calculates the current error rate within the window.
   */
  getErrorRate(): number {
    this.pruneHistory();

    if (this.callHistory.length === 0) {
      return 0;
    }

    const failures = this.callHistory.filter((r) => !r.success).length;
    return failures / this.callHistory.length;
  }

  /**
   * Checks if the circuit should be tripped based on error rate.
   */
  private checkAndTrip(): void {
    this.pruneHistory();

    // Need minimum calls before tripping
    if (this.callHistory.length < this.config.minCallsBeforeTripping) {
      return;
    }

    const errorRate = this.getErrorRate();

    if (errorRate >= this.config.errorThreshold) {
      this.transitionTo(
        CircuitState.OPEN,
        `Error rate ${(errorRate * 100).toFixed(1)}% exceeded threshold ${(this.config.errorThreshold * 100).toFixed(1)}%`,
      );
    }
  }

  /**
   * Transitions to a new state.
   */
  private transitionTo(newState: CircuitState, reason: string): void {
    const previousState = this.state;
    if (previousState === newState) {
      return;
    }

    this.state = newState;

    logger.info(`Circuit state transition: ${previousState} → ${newState}`, {
      reason,
      errorRate: this.getErrorRate(),
    });

    // Handle state-specific logic
    switch (newState) {
      case CircuitState.OPEN:
        this.openedAt = Date.now();
        this.tripCount++;
        break;

      case CircuitState.HALF_OPEN:
        this.halfOpenSuccessCount = 0;
        this.halfOpenCallCount = 0;
        break;

      case CircuitState.CLOSED:
        this.openedAt = null;
        this.halfOpenSuccessCount = 0;
        this.halfOpenCallCount = 0;
        // Clear history on close to start fresh
        this.callHistory = [];
        break;
    }

    // Emit state change event
    const event: CircuitBreakerEvent = {
      state: newState,
      previousState,
      errorRate: this.getErrorRate(),
      reason,
    };
    this.emit("stateChange", event);
  }

  /**
   * Forces the circuit open (for manual intervention).
   */
  forceOpen(reason: string = "Manual intervention"): void {
    this.transitionTo(CircuitState.OPEN, reason);
  }

  /**
   * Forces the circuit closed (for manual intervention).
   */
  forceClose(reason: string = "Manual intervention"): void {
    this.transitionTo(CircuitState.CLOSED, reason);
  }

  /**
   * Executes a function with circuit breaker protection.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.allowRequest()) {
      throw new CircuitOpenError(
        `Circuit breaker is ${this.state}`,
        this.state,
        this.getRemainingOpenTimeMs(),
      );
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Gets remaining time until circuit attempts half-open.
   */
  getRemainingOpenTimeMs(): number | null {
    if (this.state !== CircuitState.OPEN || !this.openedAt) {
      return null;
    }

    const elapsed = Date.now() - this.openedAt;
    const remaining = this.config.openTimeoutMs - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Gets circuit breaker metrics.
   */
  getMetrics(): {
    state: CircuitState;
    errorRate: number;
    totalCalls: number;
    totalSuccesses: number;
    totalFailures: number;
    totalRejections: number;
    tripCount: number;
    callsInWindow: number;
    remainingOpenTimeMs: number | null;
  } {
    return {
      state: this.getState(),
      errorRate: this.getErrorRate(),
      totalCalls: this.totalCalls,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalRejections: this.totalRejections,
      tripCount: this.tripCount,
      callsInWindow: this.callHistory.length,
      remainingOpenTimeMs: this.getRemainingOpenTimeMs(),
    };
  }

  /**
   * Resets all metrics and state.
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.callHistory = [];
    this.openedAt = null;
    this.halfOpenSuccessCount = 0;
    this.halfOpenCallCount = 0;
    this.totalCalls = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;
    this.totalRejections = 0;
    this.tripCount = 0;
    logger.info("CircuitBreaker reset");
  }
}

/**
 * Error thrown when circuit is open.
 */
export class CircuitOpenError extends Error {
  constructor(
    message: string,
    public circuitState: CircuitState,
    public retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "CircuitOpenError";
  }
}
