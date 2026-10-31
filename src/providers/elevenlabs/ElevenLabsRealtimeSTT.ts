import {
  ElevenLabsClient,
  RealtimeEvents,
  RealtimeConnection,
  AudioFormat,
  CommitStrategy,
} from "@elevenlabs/elevenlabs-js";
import { EventEmitter } from "events";
import { createLogger } from "../../logger";
import { ProviderError } from "../types";

const logger = createLogger("ElevenLabsRealtimeSTT");

export interface ElevenLabsRealtimeConfig {
  apiKey: string;
  /** STT model — defaults to scribe_v2_realtime */
  modelId?: string;
  /** ISO-639-1 or ISO-639-3 language hint (e.g. "en", "hi") */
  languageCode?: string;
  /**
   * Seconds of silence before server auto-commits. Range: 0.3–3.0.
   * @default 1.0
   */
  vadSilenceThresholdSecs?: number;
  /**
   * Speech detection sensitivity. Range: 0.1–0.9.
   * Lower = more sensitive (picks up quiet speech).
   * @default 0.5
   */
  vadThreshold?: number;
  /**
   * Strip filler words, false starts and disfluencies.
   * @default true
   */
  noVerbatim?: boolean;
  /**
   * Maximum milliseconds between manual commits (safety net when VAD misses a boundary).
   * @default 20000
   */
  maxCommitIntervalMs?: number;
  /** Maximum reconnect attempts before emitting "close". @default 10 */
  maxReconnectAttempts?: number;
  /** Base delay for exponential backoff reconnects. @default 1000 */
  reconnectDelayMs?: number;
  /** Maximum reconnect backoff delay. @default 30000 */
  maxReconnectDelayMs?: number;
  /**
   * A session that stays open at least this long is considered healthy: when it
   * closes, the reconnect attempt counter starts over. Sessions that close sooner
   * (accept-then-drop loops) keep consuming the attempt budget.
   * @default 10000
   */
  stableSessionMs?: number;
  /**
   * How long to hold a plain committed transcript waiting for its
   * timestamped twin (which carries `language_code`). If the twin does not
   * arrive in time, `committed` is emitted with `language: ""`.
   * @default 1000
   */
  timestampedWaitMs?: number;
}

const DEFAULTS = {
  modelId: "scribe_v2_realtime",
  vadSilenceThresholdSecs: 1.0,
  vadThreshold: 0.5,
  noVerbatim: true,
  maxCommitIntervalMs: 20_000,
  maxReconnectAttempts: 10,
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 30_000,
  stableSessionMs: 10_000,
  timestampedWaitMs: 1000,
} as const;

/** How many fallback-emitted segments we remember to drop their late timestamped twin. */
const MAX_REMEMBERED_FALLBACKS = 8;

interface PendingCommit {
  text: string;
  timer: NodeJS.Timeout;
}

export class ElevenLabsRealtimeSTT extends EventEmitter {
  public readonly name = "ElevenLabs-RealtimeSTT";

  private config: Required<ElevenLabsRealtimeConfig>;
  private client: ElevenLabsClient;
  private connection: RealtimeConnection | null = null;

  private isConnecting = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Epoch ms when the current session finished its handshake. */
  private connectedAt = 0;

  /** Safety commit timer — fires every maxCommitIntervalMs if VAD hasn't triggered */
  private commitTimer: NodeJS.Timeout | null = null;

  private audioChunksSent = 0;
  private lastAudioSentAt = 0;

  /**
   * Last committed text — sent as previousText on the first chunk after reconnect
   * to give the model continuity context.
   */
  private lastCommittedText = "";
  private isFirstChunkAfterConnect = true;

  /**
   * Plain COMMITTED_TRANSCRIPT segments waiting for their timestamped twin.
   * Each entry is resolved exactly once: by the twin (language known) or by
   * its fallback timer (language "").
   */
  private pendingCommits: PendingCommit[] = [];
  /** Texts already emitted by the fallback timer; their late twin is ignored. */
  private fallbackEmittedTexts: string[] = [];

  constructor(config: ElevenLabsRealtimeConfig) {
    super();
    this.config = { ...DEFAULTS, ...config } as Required<ElevenLabsRealtimeConfig>;
    this.client = new ElevenLabsClient({ apiKey: this.config.apiKey });
  }

  // ─────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // An explicit connect() after disconnect() must re-enable auto-reconnect.
    this.intentionalClose = false;
    if (this.connection || this.isConnecting) return;
    this.isConnecting = true;

    logger.info("Connecting to ElevenLabs Realtime STT", {
      model: this.config.modelId,
      language: this.config.languageCode,
      vadSilenceThresholdSecs: this.config.vadSilenceThresholdSecs,
      vadThreshold: this.config.vadThreshold,
      noVerbatim: this.config.noVerbatim,
    });

    try {
      this.connection = await this.client.speechToText.realtime.connect({
        modelId: this.config.modelId,
        audioFormat: AudioFormat.PCM_16000,
        sampleRate: 16000,
        // Server-side VAD: auto-commit after configured silence duration
        commitStrategy: CommitStrategy.VAD,
        vadSilenceThresholdSecs: this.config.vadSilenceThresholdSecs,
        vadThreshold: this.config.vadThreshold,
        // Strip fillers, false starts, disfluencies
        noVerbatim: this.config.noVerbatim,
        // Timestamped commits carry the detected language_code
        includeTimestamps: true,
        // Language hint — helps accuracy when primary language is known
        ...(this.config.languageCode ? { languageCode: this.config.languageCode } : {}),
      });

      this.attachEventHandlers();
      this.isConnecting = false;
      // The attempt budget is NOT reset here: a server that accepts and then
      // immediately closes would otherwise reconnect forever. The CLOSE handler
      // resets it only after a session proved stable.
      this.connectedAt = Date.now();
      this.isFirstChunkAfterConnect = true;

      logger.info("Connected to ElevenLabs Realtime STT");
    } catch (err) {
      this.isConnecting = false;
      logger.error("Failed to connect to ElevenLabs Realtime STT", { error: String(err) });
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
      throw err;
    }
  }

  sendAudio(base64Audio: string): void {
    if (!this.connection) {
      logger.debug("Cannot send audio — no active connection");
      return;
    }

    try {
      // On the first chunk after a new/reconnected session, send previousText
      // for conversational continuity (API only accepts it on the first chunk)
      const previousText =
        this.isFirstChunkAfterConnect && this.lastCommittedText
          ? this.lastCommittedText.slice(-50) // max 50 chars per API spec
          : undefined;

      this.connection.send({
        audioBase64: base64Audio,
        sampleRate: 16000,
        ...(previousText ? { previousText } : {}),
      });

      this.isFirstChunkAfterConnect = false;
      this.audioChunksSent++;
      this.lastAudioSentAt = Date.now();

      // Log every 100 chunks to confirm audio flow
      if (this.audioChunksSent % 100 === 0) {
        logger.debug("Audio chunks sent to ElevenLabs STT", {
          totalChunks: this.audioChunksSent,
          chunkSizeBytes: base64Audio.length,
        });
      }

      // Reset the safety commit timer on every audio chunk
      this.resetCommitTimer();
    } catch (err) {
      logger.error("Error sending audio chunk", { error: String(err) });
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearCommitTimer();
    this.clearReconnectTimer();
    this.clearPendingCommits();

    if (this.connection) {
      try {
        this.connection.close();
      } catch {
        // Ignore close errors
      }
      this.connection = null;
    }

    logger.info("STT disconnected intentionally", {
      totalAudioChunksSent: this.audioChunksSent,
    });
  }

  isConnected(): boolean {
    return this.connection !== null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────────────────────────────

  private attachEventHandlers(): void {
    if (!this.connection) return;

    this.connection.on(RealtimeEvents.SESSION_STARTED, (data) => {
      logger.info("STT session started", {
        sessionId: data.session_id,
        config: data.config,
      });
    });

    this.connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
      if (data.text) {
        // @ts-ignore - language_code might exist depending on sdk version/config
        this.emit("partial", { text: data.text, language: data.language_code || "" });
      }
    });

    this.connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
      logger.info("Committed transcript received", { text: data.text });
      if (!data.text) return;
      // Cache for previousText context on reconnect
      this.lastCommittedText = data.text;
      // Hold the segment until its timestamped twin supplies language_code.
      // If the twin never arrives (not guaranteed by the API), emit anyway.
      this.holdPendingCommit(data.text);
    });

    this.connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, (data) => {
      if (!data.text) return;
      const language = data.language_code ?? "";
      logger.debug("Committed transcript with timestamps received", { language });

      const pendingIdx = this.pendingCommits.findIndex((p) => p.text === data.text);
      if (pendingIdx !== -1) {
        clearTimeout(this.pendingCommits[pendingIdx].timer);
        this.pendingCommits.splice(pendingIdx, 1);
        this.emit("committed", { text: data.text, language });
        return;
      }

      const fallbackIdx = this.fallbackEmittedTexts.indexOf(data.text);
      if (fallbackIdx !== -1) {
        // Already emitted by the fallback timer — never emit a segment twice.
        this.fallbackEmittedTexts.splice(fallbackIdx, 1);
        logger.debug("Late timestamped transcript ignored (already emitted)", { language });
        return;
      }

      // Timestamped event without a plain twin: emit it directly.
      this.emit("committed", { text: data.text, language });
    });

    // Granular error events — log with appropriate severity, emit "error" for fatal ones
    this.connection.on(RealtimeEvents.AUTH_ERROR, (data) => {
      logger.error("STT auth error — check API key", { error: data.error });
      this.emit(
        "error",
        new ProviderError(data.error, this.name, 401, false),
      );
    });

    this.connection.on(RealtimeEvents.QUOTA_EXCEEDED, (data) => {
      logger.error("STT quota exceeded", { error: data.error });
      this.emit(
        "error",
        new ProviderError(data.error, this.name, 429, false),
      );
    });

    this.connection.on(RealtimeEvents.RATE_LIMITED, (data) => {
      logger.warn("STT rate limited — backing off", { error: data.error });
      this.emit(
        "error",
        new ProviderError(data.error, this.name, 429, true),
      );
    });

    this.connection.on(RealtimeEvents.COMMIT_THROTTLED, (data) => {
      // Too many manual commits — reduce commit frequency
      logger.warn("STT commit throttled — reduce commit rate", { error: data.error });
    });

    this.connection.on(RealtimeEvents.INSUFFICIENT_AUDIO_ACTIVITY, (data) => {
      // Not speech, just silence — not an error, skip silently
      logger.debug("Insufficient audio activity (silence)", { error: data.error });
    });

    this.connection.on(RealtimeEvents.ERROR, (data) => {
      const msg = data instanceof Error ? data.message : (data as any).error ?? String(data);
      logger.error("STT error", { error: msg });
      this.emit("error", new ProviderError(msg, this.name, 500, true));
    });

    this.connection.on(RealtimeEvents.CLOSE, (_data) => {
      const timeSinceLastAudio = this.lastAudioSentAt
        ? Date.now() - this.lastAudioSentAt
        : 0;

      logger.info("ElevenLabs STT connection closed", {
        audioChunksSent: this.audioChunksSent,
        timeSinceLastAudioMs: timeSinceLastAudio,
        intentional: this.intentionalClose,
      });

      this.connection = null;
      this.clearCommitTimer();

      if (!this.intentionalClose) {
        // A long-lived session proves the server is healthy: start the budget over.
        const sessionMs = Date.now() - this.connectedAt;
        if (sessionMs >= this.config.stableSessionMs) {
          this.reconnectAttempts = 0;
        }
        this.scheduleReconnect();
      } else {
        this.emit("close");
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Safety commit timer
  // ─────────────────────────────────────────────────────────────────

  /**
   * Resets the safety commit timer.
   * If VAD doesn't fire within maxCommitIntervalMs of the last audio chunk,
   * we send a manual commit to prevent unbounded transcript accumulation.
   */
  private resetCommitTimer(): void {
    this.clearCommitTimer();
    this.commitTimer = setTimeout(() => {
      if (this.connection) {
        logger.debug("Safety commit timer fired — sending manual commit", {
          intervalMs: this.config.maxCommitIntervalMs,
        });
        try {
          this.connection.commit();
        } catch (err) {
          logger.debug("Manual commit error (connection may have closed)", {
            error: String(err),
          });
        }
      }
    }, this.config.maxCommitIntervalMs);
  }

  private clearCommitTimer(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Pending committed transcripts (waiting for language_code)
  // ─────────────────────────────────────────────────────────────────

  private holdPendingCommit(text: string): void {
    const entry: PendingCommit = {
      text,
      timer: setTimeout(() => {
        const idx = this.pendingCommits.indexOf(entry);
        if (idx === -1) return;
        this.pendingCommits.splice(idx, 1);
        logger.debug("Timestamped transcript did not arrive — emitting without language", {
          waitMs: this.config.timestampedWaitMs,
        });
        this.fallbackEmittedTexts.push(text);
        if (this.fallbackEmittedTexts.length > MAX_REMEMBERED_FALLBACKS) {
          this.fallbackEmittedTexts.shift();
        }
        this.emit("committed", { text, language: "" });
      }, this.config.timestampedWaitMs),
    };
    this.pendingCommits.push(entry);
  }

  private clearPendingCommits(): void {
    for (const p of this.pendingCommits) clearTimeout(p.timer);
    this.pendingCommits = [];
    this.fallbackEmittedTexts = [];
  }

  // ─────────────────────────────────────────────────────────────────
  // Reconnection
  // ─────────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    // A reconnect is already queued; don't stack a second one.
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error("Max STT reconnect attempts reached — giving up", {
        attempts: this.reconnectAttempts,
      });
      this.emit("close");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.config.maxReconnectDelayMs,
    );

    logger.info("Scheduling STT reconnect", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
      maxAttempts: this.config.maxReconnectAttempts,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        logger.info("STT reconnected successfully", {
          attempt: this.reconnectAttempts,
        });
        this.emit("reconnected");
      } catch (error) {
        logger.error("STT reconnect failed", {
          attempt: this.reconnectAttempts,
          error: String(error),
        });
        // connect() already scheduled the next attempt (or gave up with "close")
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
