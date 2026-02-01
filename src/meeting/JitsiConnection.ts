/**
 * Jitsi Meeting Connection module.
 * 
 * Simplified: navigates Puppeteer to the local bot page
 * and waits for the lib-jitsi-meet connection to establish.
 */

import { Page } from 'puppeteer';
import { AgentConfig, getDisplayName } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('JitsiConnection');

/**
 * Jitsi meeting connection manager.
 * Uses the local bot page which connects via lib-jitsi-meet.
 */
export class JitsiConnection {
    private config: AgentConfig;
    private page: Page;
    private connected: boolean = false;
    private botPageUrl: string;

    constructor(config: AgentConfig, page: Page, botPageUrl: string) {
        this.config = config;
        this.page = page;
        this.botPageUrl = botPageUrl;
    }

    /**
     * Connects to the Jitsi meeting by navigating to the bot page.
     */
    async connect(): Promise<void> {
        const displayName = getDisplayName(this.config);

        logger.info('Connecting to Jitsi meeting via bot page', { 
            botPageUrl: this.botPageUrl,
            displayName 
        });

        // Navigate to the bot page
        // Use 'load' instead of 'networkidle0' because WebRTC traffic never goes idle
        await this.page.goto(this.botPageUrl, { 
            waitUntil: 'load',
            timeout: 30000 
        });

        logger.info('Bot page loaded, waiting for conference join');

        // Wait for the bot to load dependencies and connect
        await this.waitForConferenceJoined();

        this.connected = true;
        logger.info('Successfully connected to Jitsi meeting', { displayName });
    }

    /**
     * Waits for the conference to be joined.
     */
    private async waitForConferenceJoined(): Promise<void> {
        logger.debug('Waiting for conference to be joined');

        const maxWaitMs = 90000; // 90 seconds (config + lib load + connect)
        const checkIntervalMs = 1000;
        let elapsed = 0;

        while (elapsed < maxWaitMs) {
            const status = await this.page.evaluate(() => {
                return {
                    botLoaded: (window as any).__botLoaded === true,
                    joined: (window as any).__jitsiJoined === true,
                    error: (window as any).__jitsiError,
                    participantId: (window as any).__jitsiParticipantId,
                };
            });

            // Check for errors
            if (status.error) {
                logger.error('Jitsi connection error', { error: status.error });
                throw new Error(`Jitsi error: ${JSON.stringify(status.error)}`);
            }

            // Check if joined
            if (status.joined) {
                logger.info('Conference joined successfully', { 
                    participantId: status.participantId 
                });
                return;
            }

            await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
            elapsed += checkIntervalMs;

            // Log progress every 10 seconds
            if (elapsed % 10000 === 0) {
                logger.debug('Still waiting for conference join...', { 
                    elapsedMs: elapsed,
                    botLoaded: status.botLoaded
                });
            }
        }

        // Timeout - get final state for debugging
        const finalState = await this.page.evaluate(() => {
            return {
                botLoaded: (window as any).__botLoaded,
                joined: (window as any).__jitsiJoined,
                error: (window as any).__jitsiError,
                statusText: document.getElementById('status')?.textContent,
            };
        });

        logger.error('Conference join timeout', { finalState });
        throw new Error(`Timeout waiting for conference to join. Status: ${finalState.statusText}`);
    }

    /**
     * Checks if connected to the meeting.
     */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Disconnects from the meeting.
     */
    async disconnect(): Promise<void> {
        if (!this.connected) return;

        logger.info('Disconnecting from meeting');

        try {
            await this.page.evaluate(() => {
                const room = (window as any).room;
                const connection = (window as any).connection;
                if (room) {
                    room.leave();
                }
                if (connection) {
                    connection.disconnect();
                }
            });
        } catch (error) {
            logger.warn('Error during disconnect', { error: String(error) });
        }

        this.connected = false;
        logger.info('Disconnected from meeting');
    }
}
