/**
 * Bot Page Server - serves the static bot HTML page.
 *
 * Puppeteer navigates to this local server to load the bot page
 * which then uses lib-jitsi-meet to connect to Jitsi.
 *
 * Phase 5: Also serves TTS audio buffers via /tts/:id endpoint,
 * allowing the browser to fetch binary audio directly instead of
 * receiving base64-encoded data over CDP.
 */

import express, { Express } from "express";
import { Server } from "http";
import path from "path";
import { createLogger } from "../logger";

const logger = createLogger("BotPageServer");

/** How long to keep unretrieved TTS audio before cleanup (ms). */
const TTS_BUFFER_TTL_MS = 30_000;

/**
 * Bot Page Server that serves static files for the translator bot.
 */
export class BotPageServer {
  private app: Express;
  private server: Server | null = null;
  private port: number;

  /** Phase 5: In-memory store for TTS audio buffers, keyed by chunk ID. */
  private ttsBuffers: Map<string, { buffer: Buffer; timeout: NodeJS.Timeout }> =
    new Map();

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
    const staticPath = path.join(__dirname, "../../static");
    logger.debug("Serving static files from", { path: staticPath });

    this.app.use(express.static(staticPath));

    // Health check endpoint
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok" });
    });

    // Phase 5: Serve TTS audio buffers for browser-side playback.
    // The browser fetches this URL to get binary MP3 directly,
    // avoiding base64 encode/decode over the CDP WebSocket.
    this.app.get("/tts/:id", (req, res) => {
      const entry = this.ttsBuffers.get(req.params.id);
      if (!entry) {
        res.status(404).send("Not found");
        return;
      }
      // Clean up immediately after serving (one-time fetch)
      clearTimeout(entry.timeout);
      this.ttsBuffers.delete(req.params.id);

      res.set("Content-Type", "audio/mpeg");
      res.send(entry.buffer);
    });
  }

  /**
   * Phase 5: Stores TTS audio for the browser to fetch via /tts/:id.
   * Returns the localhost URL the browser should fetch.
   * Audio is automatically cleaned up after TTL if not fetched.
   */
  storeTtsAudio(id: string, buffer: Buffer): string {
    // Clean up previous entry with same ID if exists
    const existing = this.ttsBuffers.get(id);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      this.ttsBuffers.delete(id);
    }, TTS_BUFFER_TTL_MS);

    this.ttsBuffers.set(id, { buffer, timeout });
    return `http://localhost:${this.port}/tts/${id}`;
  }

  /**
   * Start the server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          logger.info("Bot page server started", { port: this.port });
          resolve();
        });

        this.server.on("error", (error) => {
          logger.error("Bot page server error", { error: String(error) });
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
    // Clear all pending TTS buffer timeouts
    for (const [, entry] of this.ttsBuffers) {
      clearTimeout(entry.timeout);
    }
    this.ttsBuffers.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info("Bot page server stopped");
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
