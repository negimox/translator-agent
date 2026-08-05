import WebSocket from "ws";
import { EventEmitter } from "events";
import { createLogger } from "../../logger";
import { ProviderError } from "../types";

const logger = createLogger("ElevenLabsRealtimeSTT");

export interface ElevenLabsRealtimeConfig {
  apiKey: string;
  modelId: string;
  languageCode?: string;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export const DEFAULT_REALTIME_CONFIG: Partial<ElevenLabsRealtimeConfig> = {
  modelId: "scribe_v2_realtime",
  autoReconnect: true,
  maxReconnectAttempts: 10,
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
};

export class ElevenLabsRealtimeSTT extends EventEmitter {
  public readonly name = "ElevenLabs-RealtimeSTT";
  private config: ElevenLabsRealtimeConfig;
  private ws: WebSocket | null = null;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionalClose: boolean = false;
  private audioChunksSent: number = 0;
  private lastAudioSentAt: number = 0;
  
  constructor(config: Partial<ElevenLabsRealtimeConfig> & { apiKey: string }) {
    super();
    this.config = {
      ...DEFAULT_REALTIME_CONFIG,
      ...config,
    } as ElevenLabsRealtimeConfig;
  }

  async connect(): Promise<void> {
    if (this.ws || this.isConnecting) return;
    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      let url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=${this.config.modelId}`;
      if (this.config.languageCode) {
        url += `&language_code=${this.config.languageCode}`;
      }
      
      this.ws = new WebSocket(url, {
        headers: {
          "xi-api-key": this.config.apiKey,
        },
      });

      this.ws.on("open", () => {
        logger.info("Connected to ElevenLabs Realtime STT");
        this.isConnecting = false;
        this.reconnectAttempts = 0; // Reset on successful connection
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          logger.error("Error parsing STT message", { error: String(err) });
        }
      });

      this.ws.on("error", (error) => {
        logger.error("ElevenLabs STT WebSocket error", { error: String(error) });
        if (this.isConnecting) {
          this.isConnecting = false;
          reject(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        const timeSinceLastAudio = this.lastAudioSentAt ? Date.now() - this.lastAudioSentAt : 0;
        logger.info("ElevenLabs STT WebSocket closed", { 
          code, 
          reason: reason.toString(),
          audioChunksSent: this.audioChunksSent,
          timeSinceLastAudio: `${timeSinceLastAudio}ms`,
          intentionalClose: this.intentionalClose
        });
        this.ws = null;
        this.isConnecting = false;
        
        // Only attempt reconnect if:
        // 1. It wasn't an intentional close
        // 2. Auto-reconnect is enabled
        // 3. We haven't exceeded max attempts
        if (!this.intentionalClose && this.config.autoReconnect && 
            this.reconnectAttempts < (this.config.maxReconnectAttempts || 10)) {
          this.scheduleReconnect();
        } else {
          this.emit("close");
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.reconnectDelayMs! * Math.pow(2, this.reconnectAttempts - 1),
      this.config.maxReconnectDelayMs!
    );

    logger.info("Scheduling STT reconnect", { 
      attempt: this.reconnectAttempts,
      delayMs: delay,
      maxAttempts: this.config.maxReconnectAttempts
    });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        logger.info("STT reconnected successfully", { attempt: this.reconnectAttempts });
        this.emit("reconnected");
      } catch (error) {
        logger.error("STT reconnect failed", { 
          attempt: this.reconnectAttempts,
          error: String(error)
        });
        // The close handler will schedule another attempt if we haven't exceeded max
      }
    }, delay);
  }

  private handleMessage(msg: any): void {
    if (msg.message_type === "partial_transcript") {
      this.emit("partial", msg);
    } else if (msg.message_type === "committed_transcript" || msg.message_type === "final_transcript") {
      logger.info("Committed transcript received", { text: msg.text, language: msg.language });
      this.emit("committed", {
        text: msg.text,
        language: msg.language,
      });
    } else if (msg.message_type === "error") {
      logger.error("STT Server Error", { error: msg.error });
      this.emit("error", new ProviderError(msg.error || "Unknown STT error", this.name, 500, false));
    }
  }

  sendAudio(base64Audio: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.debug("Cannot send audio, WS not open", {
        hasWs: !!this.ws,
        readyState: this.ws?.readyState
      });
      return;
    }
    
    const message = {
      message_type: "input_audio_chunk",
      audio_base_64: base64Audio,
    };
    
    this.ws.send(JSON.stringify(message));
    this.audioChunksSent++;
    this.lastAudioSentAt = Date.now();
    
    // Log every 100 chunks to confirm audio flow
    if (this.audioChunksSent % 100 === 0) {
      logger.debug("Audio chunks sent to ElevenLabs STT", { 
        totalChunks: this.audioChunksSent,
        chunkSizeBytes: base64Audio.length
      });
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    logger.info("STT disconnected intentionally", {
      totalAudioChunksSent: this.audioChunksSent
    });
  }
  
  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
