import WebSocket from "ws";
import { EventEmitter } from "events";
import { createLogger } from "../../logger";
import { ProviderError } from "../types";

const logger = createLogger("ElevenLabsRealtimeSTT");

export interface ElevenLabsRealtimeConfig {
  apiKey: string;
  modelId: string;
  languageCode?: string;
}

export const DEFAULT_REALTIME_CONFIG: Partial<ElevenLabsRealtimeConfig> = {
  modelId: "scribe_v2_realtime",
};

export class ElevenLabsRealtimeSTT extends EventEmitter {
  public readonly name = "ElevenLabs-RealtimeSTT";
  private config: ElevenLabsRealtimeConfig;
  private ws: WebSocket | null = null;
  private isConnecting: boolean = false;
  
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
        logger.info("ElevenLabs STT WebSocket closed", { code, reason: reason.toString() });
        this.ws = null;
        this.isConnecting = false;
        this.emit("close");
      });
    });
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
      logger.debug("Cannot send audio, WS not open");
      return;
    }
    const message = {
      message_type: "input_audio_chunk",
      audio_base_64: base64Audio,
    };
    this.ws.send(JSON.stringify(message));
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
