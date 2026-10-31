import { createLogger } from "../logger";
import { TokenBucket } from "./TokenBucket";

const logger = createLogger("TokenWaitQueue");

export interface TokenWaitQueueConfig {
  maxPending: number;
  maxWaitMs: number;
}

interface Entry {
  amount: number;
  deadline: number;
  resolve: (ok: boolean) => void;
}

/**
 * FIFO, bounded wait queue in front of a TokenBucket.
 * acquire() resolves false when the request is dropped (evicted, timed out,
 * oversized, or cancelled).
 */
export class TokenWaitQueue {
  private queue: Entry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private bucket: TokenBucket,
    private config: TokenWaitQueueConfig,
  ) {}

  get pendingCount(): number {
    return this.queue.length;
  }

  acquire(amount: number): Promise<boolean> {
    const capacity = this.bucket.getMetrics().capacity;
    if (amount > capacity) {
      logger.warn("Token request exceeds bucket capacity", { amount, capacity });
      return Promise.resolve(false);
    }
    if (this.queue.length === 0 && this.bucket.tryAcquire(amount).acquired) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.queue.push({
        amount,
        deadline: Date.now() + this.config.maxWaitMs,
        resolve,
      });
      if (this.queue.length > this.config.maxPending) {
        this.queue.shift()!.resolve(false);
      }
      this.schedule(0);
    });
  }

  cancelAll(): void {
    this.clearTimer();
    const pending = this.queue;
    this.queue = [];
    for (const e of pending) e.resolve(false);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delayMs));
  }

  private pump(): void {
    const now = Date.now();
    while (this.queue.length > 0 && this.queue[0].deadline <= now) {
      this.queue.shift()!.resolve(false);
    }
    let waitMs = 0;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const r = this.bucket.tryAcquire(head.amount);
      if (r.acquired) {
        this.queue.shift();
        head.resolve(true);
      } else {
        waitMs = Math.min(r.waitTimeMs ?? 0, head.deadline - now);
        break;
      }
    }
    if (this.queue.length > 0) this.schedule(waitMs);
  }
}
