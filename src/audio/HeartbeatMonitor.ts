/**
 * Heartbeat Monitor for AudioWorklet health.
 * 
 * Watches for periodic heartbeat messages from the AudioWorklet processor.
 * If heartbeats stop, triggers reinitialization of the audio infrastructure.
 */

import { Page } from 'puppeteer';
import { AgentConfig } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('HeartbeatMonitor');

/**
 * Heartbeat Monitor class.
 * Monitors worklet health via periodic heartbeat messages.
 */
export class HeartbeatMonitor {
    private config: AgentConfig;
    private page: Page;
    private onTimeout: () => void;
    private checkIntervalId: NodeJS.Timeout | null = null;
    private lastHeartbeatTime: number = 0;
    private isRunning: boolean = false;
    private missedCount: number = 0;
    private readonly maxMissedBeforeTimeout: number = 3;

    constructor(config: AgentConfig, page: Page, onTimeout: () => void) {
        this.config = config;
        this.page = page;
        this.onTimeout = onTimeout;
    }

    /**
     * Starts monitoring for heartbeats.
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('HeartbeatMonitor already running');
            return;
        }

        logger.info('Starting heartbeat monitor', {
            timeoutMs: this.config.heartbeatTimeoutMs,
            intervalMs: this.config.workletHeartbeatIntervalMs,
        });

        this.isRunning = true;
        this.lastHeartbeatTime = Date.now();
        this.missedCount = 0;

        // Set up heartbeat listener in the browser
        await this.page.evaluate(() => {
            (window as any).__heartbeatReceived = false;
            window.addEventListener('translatorHeartbeat', () => {
                (window as any).__heartbeatReceived = true;
            });
        });

        // Start checking interval
        this.checkIntervalId = setInterval(
            () => this.checkHeartbeat(),
            this.config.workletHeartbeatIntervalMs * 2 // Check at 2x interval
        );

        logger.info('Heartbeat monitor started');
    }

    /**
     * Checks for recent heartbeat.
     */
    private async checkHeartbeat(): Promise<void> {
        if (!this.isRunning) return;

        try {
            const received = await this.page.evaluate(() => {
                const result = (window as any).__heartbeatReceived;
                (window as any).__heartbeatReceived = false;
                return result;
            });

            if (received) {
                this.lastHeartbeatTime = Date.now();
                this.missedCount = 0;
                logger.debug('Heartbeat received');
            } else {
                this.missedCount++;
                logger.debug('Heartbeat missed', { 
                    missedCount: this.missedCount,
                    maxMissed: this.maxMissedBeforeTimeout 
                });

                if (this.missedCount >= this.maxMissedBeforeTimeout) {
                    const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeatTime;
                    logger.warn('Heartbeat timeout detected', {
                        timeSinceLastHeartbeat,
                        missedCount: this.missedCount,
                    });

                    // Reset missed count and trigger callback
                    this.missedCount = 0;
                    this.onTimeout();
                }
            }
        } catch (error) {
            logger.error('Error checking heartbeat', { error: String(error) });
        }
    }

    /**
     * Stops the heartbeat monitor.
     */
    stop(): void {
        if (!this.isRunning) return;

        logger.info('Stopping heartbeat monitor');
        
        this.isRunning = false;
        
        if (this.checkIntervalId) {
            clearInterval(this.checkIntervalId);
            this.checkIntervalId = null;
        }

        logger.info('Heartbeat monitor stopped');
    }

    /**
     * Checks if heartbeats are currently healthy.
     */
    isHealthy(): boolean {
        if (!this.isRunning) return false;
        
        const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeatTime;
        return timeSinceLastHeartbeat < this.config.heartbeatTimeoutMs;
    }

    /**
     * Gets the time since the last heartbeat.
     */
    getTimeSinceLastHeartbeat(): number {
        return Date.now() - this.lastHeartbeatTime;
    }
}
