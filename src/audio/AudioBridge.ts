import { Page } from "puppeteer";
import { EventEmitter } from "events";
import { createLogger } from "../logger";

const logger = createLogger("AudioBridge");

/**
 * Audio frame data received from the browser.
 * Note: samples are transferred as a regular array, not Float32Array.
 */
interface BrowserAudioFrame {
  samples: number[];
  timestamp: number;
  frameCount: number;
}

export interface AudioBridgeConfig {
  debugMode: boolean;
  bufferSizeMs: number;
}

export const DEFAULT_BRIDGE_CONFIG: AudioBridgeConfig = {
  debugMode: false,
  bufferSizeMs: 100, // Buffer 100ms of audio before emitting
};

/**
 * Audio Bridge class.
 * Bridges browser audio to Node.js, buffers it, converts to Int16 PCM,
 * and emits base64-encoded chunks suitable for WebSocket STT.
 */
export class AudioBridge extends EventEmitter {
  private config: AudioBridgeConfig;
  private page: Page;
  private isRunning: boolean = false;
  private framesReceived: number = 0;
  
  // Audio buffering
  private sampleBuffer: number[] = [];
  private readonly SAMPLE_RATE = 16000;
  private samplesPerBuffer: number;

  // Exposed function name in browser
  private readonly CALLBACK_NAME = "__onTranslatorAudioFrame";

  constructor(page: Page, config: Partial<AudioBridgeConfig> = {}) {
    super();
    this.config = { ...DEFAULT_BRIDGE_CONFIG, ...config };
    this.page = page;
    
    // Calculate how many samples we need for the requested buffer duration
    this.samplesPerBuffer = Math.floor(this.SAMPLE_RATE * (this.config.bufferSizeMs / 1000));

    logger.info("AudioBridge created", {
      bufferSizeMs: this.config.bufferSizeMs,
      samplesPerBuffer: this.samplesPerBuffer
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("AudioBridge already running");
      return;
    }

    logger.info("Starting AudioBridge");

    // Expose the callback function to the browser
    await this.page.exposeFunction(
      this.CALLBACK_NAME,
      async (frame: BrowserAudioFrame) => {
        await this.handleBrowserFrame(frame);
      },
    );

    logger.info("Exposed audio callback to browser", {
      callbackName: this.CALLBACK_NAME,
    });

    this.isRunning = true;

    if (this.config.debugMode) {
      this.startStatusLogging();
    }
  }

  private startStatusLogging(): void {
    const statusInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(statusInterval);
        return;
      }
      logger.info("Audio bridge status", {
        framesReceived: this.framesReceived,
        bufferedSamples: this.sampleBuffer.length
      });
      if (this.framesReceived === 0) {
        logger.warn("No audio frames received from browser! Check if participants are unmuted.");
      }
    }, 5000);
  }

  getCallbackName(): string {
    return this.CALLBACK_NAME;
  }

  private async handleBrowserFrame(frame: BrowserAudioFrame): Promise<void> {
    if (!this.isRunning) return;

    this.framesReceived++;

    try {
      // frame.samples is an object that acts like an array from Puppeteer
      const samplesArray = Object.values(frame.samples) as number[];
      
      // Append to our buffer
      for (const sample of samplesArray) {
        this.sampleBuffer.push(sample);
      }
      
      // Check if we have enough samples to emit a chunk
      while (this.sampleBuffer.length >= this.samplesPerBuffer) {
        const chunkSamples = this.sampleBuffer.splice(0, this.samplesPerBuffer);
        
        // Convert Float32 to Int16
        const int16Buffer = new Int16Array(chunkSamples.length);
        for (let i = 0; i < chunkSamples.length; i++) {
          let s = Math.max(-1, Math.min(1, chunkSamples[i]));
          int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Encode to base64
        const buffer = Buffer.from(int16Buffer.buffer);
        const base64Audio = buffer.toString("base64");
        
        this.emit("audio_chunk", {
          audio_base_64: base64Audio,
          timestamp: frame.timestamp
        });
      }
      
    } catch (e) {
      logger.error("Error processing browser frame", { error: (e as Error).message });
    }

    if (this.framesReceived % 1000 === 0) {
      logger.debug("Audio frames received", { total: this.framesReceived });
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info("Stopping AudioBridge");

    // Flush any remaining audio
    if (this.sampleBuffer.length > 0) {
      const int16Buffer = new Int16Array(this.sampleBuffer.length);
      for (let i = 0; i < this.sampleBuffer.length; i++) {
        let s = Math.max(-1, Math.min(1, this.sampleBuffer[i]));
        int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const buffer = Buffer.from(int16Buffer.buffer);
      this.emit("audio_chunk", {
        audio_base_64: buffer.toString("base64"),
        timestamp: Date.now()
      });
      this.sampleBuffer = [];
    }

    this.isRunning = false;

    logger.info("AudioBridge stopped", {
      totalFramesReceived: this.framesReceived,
    });
  }
}
