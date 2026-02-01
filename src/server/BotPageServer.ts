/**
 * Bot Page Server - serves the static bot HTML page.
 * 
 * Puppeteer navigates to this local server to load the bot page
 * which then uses lib-jitsi-meet to connect to Jitsi.
 */

import express, { Express } from 'express';
import { Server } from 'http';
import path from 'path';
import { createLogger } from '../logger';

const logger = createLogger('BotPageServer');

/**
 * Bot Page Server that serves static files for the translator bot.
 */
export class BotPageServer {
    private app: Express;
    private server: Server | null = null;
    private port: number;

    constructor(port: number = 3001) {
        this.port = port;
        this.app = express();
        this.setupRoutes();
    }

    /**
     * Set up routes for serving static files.
     */
    private setupRoutes(): void {
        // Serve static files from the 'static' directory
        const staticPath = path.join(__dirname, '../../static');
        logger.debug('Serving static files from', { path: staticPath });
        
        this.app.use(express.static(staticPath));

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok' });
        });
    }

    /**
     * Start the server.
     */
    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.server = this.app.listen(this.port, () => {
                    logger.info('Bot page server started', { port: this.port });
                    resolve();
                });

                this.server.on('error', (error) => {
                    logger.error('Bot page server error', { error: String(error) });
                    reject(error);
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Stop the server.
     */
    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    logger.info('Bot page server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Get the URL for the bot page with parameters.
     */
    getBotPageUrl(domain: string, roomName: string, displayName: string): string {
        const params = new URLSearchParams({
            domain,
            room: roomName,
            displayName,
        });
        return `http://localhost:${this.port}/bot.html?${params.toString()}`;
    }

    /**
     * Get the server port.
     */
    getPort(): number {
        return this.port;
    }
}
