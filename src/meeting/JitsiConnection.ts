/**
 * Jitsi Meeting Connection module.
 * 
 * Navigates to the full Jitsi Meet UI and joins the meeting directly.
 * Uses URL parameters to set display name (prejoin screen disabled on server).
 */

import { Page } from 'puppeteer';
import { AgentConfig, getDisplayName } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('JitsiConnection');

/**
 * Timeout configurations.
 */
const TIMEOUTS = {
    PAGE_LOAD: 60000,      // 60s for page to load
    MEETING_JOIN: 90000,   // 90s for meeting to be joined
    ELEMENT_WAIT: 30000,   // 30s for specific elements
};

/**
 * Jitsi meeting connection manager.
 * Uses the full Jitsi Meet UI (not lib-jitsi-meet directly).
 */
export class JitsiConnection {
    private config: AgentConfig;
    private page: Page;
    private connected: boolean = false;

    constructor(config: AgentConfig, page: Page) {
        this.config = config;
        this.page = page;
    }

    /**
     * Builds the meeting URL with display name as URL fragment.
     */
    private buildMeetingUrl(): string {
        const displayName = getDisplayName(this.config);
        const { jitsiDomain, roomName } = this.config;
        
        // Use URL fragment to pass display name (works with prejoin disabled)
        // Format: https://domain/room#userInfo.displayName=name
        const url = `https://${jitsiDomain}/${roomName}#userInfo.displayName=${encodeURIComponent(displayName)}`;
        
        return url;
    }

    /**
     * Connects to the Jitsi meeting by navigating to the full Jitsi Meet UI.
     */
    async connect(): Promise<void> {
        const meetingUrl = this.buildMeetingUrl();
        const displayName = getDisplayName(this.config);

        logger.info('Connecting to Jitsi meeting via full UI', { 
            meetingUrl,
            displayName 
        });

        // Navigate to the Jitsi Meet page
        await this.page.goto(meetingUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: TIMEOUTS.PAGE_LOAD 
        });

        logger.info('Jitsi Meet page loaded, waiting to join conference');

        // Wait for the meeting to be joined
        await this.waitForMeetingJoined();

        this.connected = true;
        logger.info('Successfully connected to Jitsi meeting', { displayName });
    }

    /**
     * Waits for the meeting to be joined by checking for conference UI elements.
     */
    private async waitForMeetingJoined(): Promise<void> {
        logger.debug('Waiting for meeting to be joined');

        const startTime = Date.now();
        const checkIntervalMs = 2000;

        while (Date.now() - startTime < TIMEOUTS.MEETING_JOIN) {
            try {
                // Check various indicators that we're in the meeting
                const status = await this.page.evaluate(() => {
                    // Check for toolbox (appears when in conference)
                    const toolbox = document.querySelector('.new-toolbox');
                    const hasToolbox = toolbox !== null;
                    
                    // Check for filmstrip (shows participants)
                    const filmstrip = document.querySelector('#filmstripRemoteVideosContainer');
                    const hasFilmstrip = filmstrip !== null;
                    
                    // Check for local video
                    const localVideo = document.querySelector('#localVideoContainer');
                    const hasLocalVideo = localVideo !== null;
                    
                    // Check for any conference error dialog
                    const errorDialog = document.querySelector('.oops-modal');
                    const hasError = errorDialog !== null;
                    
                    // Check APP object (Jitsi internals)
                    const app = (window as any).APP;
                    const inConference = app?.conference?._room !== undefined;
                    const participantId = app?.conference?.getMyUserId?.();
                    
                    return {
                        hasToolbox,
                        hasFilmstrip,
                        hasLocalVideo,
                        hasError,
                        inConference,
                        participantId,
                        url: window.location.href,
                    };
                });

                logger.debug('Meeting join status', status);

                // Check for errors
                if (status.hasError) {
                    throw new Error('Jitsi meeting error - possibly room issue');
                }

                // Check if we're in the conference
                if (status.inConference && status.participantId) {
                    logger.info('Joined conference', { 
                        participantId: status.participantId 
                    });
                    return;
                }

                // Alternative check: toolbox + local video present
                if (status.hasToolbox && status.hasLocalVideo) {
                    logger.info('Joined conference (detected via UI elements)');
                    return;
                }

            } catch (error) {
                logger.warn('Error checking meeting status', { error: String(error) });
            }

            await new Promise(resolve => setTimeout(resolve, checkIntervalMs));

            // Log progress
            const elapsed = Date.now() - startTime;
            if (elapsed % 10000 < checkIntervalMs) {
                logger.debug('Still waiting to join meeting...', { elapsedMs: elapsed });
            }
        }

        // Timeout - capture screenshot for debugging
        try {
            await this.page.screenshot({ 
                path: './debug_join_timeout.png',
                fullPage: true 
            });
            logger.info('Saved debug screenshot to debug_join_timeout.png');
        } catch (e) {
            logger.warn('Could not save debug screenshot');
        }

        throw new Error('Timeout waiting to join meeting');
    }

    /**
     * Checks if connected to the meeting.
     */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Gets the participant ID of this agent.
     */
    async getParticipantId(): Promise<string | null> {
        try {
            return await this.page.evaluate(() => {
                const app = (window as any).APP;
                return app?.conference?.getMyUserId?.() || null;
            });
        } catch {
            return null;
        }
    }

    /**
     * Disconnects from the meeting by clicking the hangup button.
     */
    async disconnect(): Promise<void> {
        if (!this.connected) return;

        logger.info('Disconnecting from meeting');

        try {
            // Try to click the hangup button
            const hangupButton = await this.page.$('[aria-label="Leave"]');
            if (hangupButton) {
                await hangupButton.click();
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            logger.warn('Error during disconnect', { error: String(error) });
        }

        this.connected = false;
        logger.info('Disconnected from meeting');
    }
}
