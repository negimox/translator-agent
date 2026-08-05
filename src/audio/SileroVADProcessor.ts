import { RealTimeVAD } from "avr-vad";
import { createLogger } from "../logger";

const logger = createLogger("SileroVADProcessor");

export class SileroVADProcessor {
  private vad: RealTimeVAD | null = null;
  private isSpeechActive = false;
  private sampleRate: number;

  constructor(sampleRate: number = 48000) {
    this.sampleRate = sampleRate;
  }

  async initialize() {
    logger.info("Initializing Silero VAD...");
    this.vad = await RealTimeVAD.new({
      model: "v5",
      sampleRate: this.sampleRate,
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      preSpeechPadFrames: 1,
      redemptionFrames: 8, // ~768ms hangover to prevent mid-word drops
      minSpeechFrames: 3,
      onSpeechStart: () => {
        if (!this.isSpeechActive) {
          logger.debug("VAD: SPEECH_START detected");
          this.isSpeechActive = true;
        }
      },
      onSpeechEnd: () => {
        if (this.isSpeechActive) {
          logger.debug("VAD: SPEECH_END detected");
          this.isSpeechActive = false;
        }
      },
    });
    this.vad.start();
    logger.info("Silero VAD initialized and started");
  }

  /**
   * Processes an incoming chunk of audio (any size/samplerate configured).
   * Returns a boolean indicating if speech is currently active.
   */
  async processAudio(samples: Float32Array, timestamp: number): Promise<boolean> {
    if (!this.vad) {
      return this.isSpeechActive;
    }

    await this.vad.processAudio(samples);
    return this.isSpeechActive;
  }

  destroy() {
    if (this.vad) {
      this.vad.destroy();
      this.vad = null;
    }
  }
}

