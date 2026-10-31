/**
 * AudioContext Manager for the Translator Agent.
 *
 * Handles:
 * - AudioContext creation and state management
 * - AudioWorklet setup with inline code (avoiding file path issues)
 * - GC prevention for both capture and output nodes
 * - MediaStreamDestination for publishing translated audio
 * - VAD (Voice Activity Detection) via RMS energy threshold (Phase 3)
 */

import { Page } from "puppeteer";
import { AgentConfig } from "../config";
import { createLogger } from "../logger";

const logger = createLogger("AudioManager");

/**
 * AudioWorklet processor code as an inline string.
 * This is converted to a data URL to avoid file loading issues in Puppeteer.
 *
 * Phase 3 Updates:
 * - Added RMS-based VAD (Voice Activity Detection)
 * - Posts audio frames with VAD info to main thread for chunk aggregation
 * - Excludes translator-* participants from capture (loop prevention)
 * - Sends periodic heartbeat messages for health monitoring
 *
 * VAD Parameters (configurable via constructor options):
 * - rmsThreshold: 0.01 (-40dB) - threshold for voice activity
 * - Smoothing window for stable VAD decisions
 */
const AUDIO_WORKLET_CODE = `
class TranslatorAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.frameCount = 0;
        this.lastHeartbeat = currentTime;
        this.heartbeatInterval = 0.3; // 300ms
        this.lastDebugLog = currentTime;
        this.debugLogInterval = 1.0; // Log every 1 second for debugging
        this.totalSamplesReceived = 0;
        this.nonZeroSamplesReceived = 0;
        this.inputChannelCount = 0;
        
        // VAD configuration (Phase 3)
        const processorOptions = options.processorOptions || {};
        this.rmsThreshold = processorOptions.rmsThreshold || 0.01; // -40dB default
        
        console.log('[Worklet] TranslatorAudioProcessor created with options:', processorOptions);
    }

    /**
     * Calculates RMS (Root Mean Square) of audio samples.
     * RMS is a good measure of signal energy/loudness.
     */
    calculateRMS(samples) {
        if (!samples || samples.length === 0) return 0;
        
        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) {
            sumSquares += samples[i] * samples[i];
        }
        return Math.sqrt(sumSquares / samples.length);
    }



    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        
        // Track input channel count for debugging
        if (input) {
            this.inputChannelCount = input.length;
        }
        
        // Pass through audio (for monitoring/debugging)
        if (input && output) {
            for (let channel = 0; channel < input.length; channel++) {
                if (input[channel] && output[channel]) {
                    output[channel].set(input[channel]);
                }
            }
        }
        
        // Process audio data if we have input
        if (input && input[0] && input[0].length > 0) {
            const samples = input[0];
            this.totalSamplesReceived += samples.length;
            
            // Count non-zero samples for debugging
            for (let i = 0; i < samples.length; i++) {
                if (Math.abs(samples[i]) > 0.00001) {
                    this.nonZeroSamplesReceived++;
                }
            }
            
            // Calculate RMS for debugging
            const rms = this.calculateRMS(samples);
            
            // Post audio data to main thread
            this.port.postMessage({
                type: 'audioData',
                data: samples.slice(), // Copy the Float32Array
                timestamp: currentTime,
                frameCount: this.frameCount++,
                rms: rms,
                isSpeech: false // Deprecated: VAD is now handled on the backend via SileroVADProcessor
            });
        }
        
        // Periodic debug log
        if (currentTime - this.lastDebugLog >= this.debugLogInterval) {
            console.log('[Worklet] Audio stats:', {
                totalSamples: this.totalSamplesReceived,
                nonZeroSamples: this.nonZeroSamplesReceived,
                inputChannels: this.inputChannelCount,
                frames: this.frameCount,
                hasInput: !!(input && input[0]),
                inputLength: input && input[0] ? input[0].length : 0
            });
            this.lastDebugLog = currentTime;
        }
        
        // Periodic heartbeat
        if (currentTime - this.lastHeartbeat >= this.heartbeatInterval) {
            this.port.postMessage({
                type: 'heartbeat',
                timestamp: currentTime,
                frameCount: this.frameCount
            });
            this.lastHeartbeat = currentTime;
        }
        
        return true; // Keep processor alive
    }
}

registerProcessor('translator-audio-processor', TranslatorAudioProcessor);
`;

/**
 * Health status of the audio infrastructure.
 */
export interface AudioHealth {
  contextState: "suspended" | "running" | "closed";
  captureActive: boolean;
  outputActive: boolean;
  playback: {
    trackPublished: boolean;
    trackMuted: boolean;
    destinationActive: boolean;
    queueLength: number;
    isPlaying: boolean;
  };
}

/**
 * Audio Manager class.
 * Manages AudioContext, worklets, and MediaStream nodes in the browser.
 */
export class AudioManager {
  private config: AgentConfig;
  private page: Page;
  private initialized: boolean = false;

  constructor(config: AgentConfig, page: Page) {
    this.config = config;
    this.page = page;
  }

  /**
   * Initializes the audio infrastructure in the browser.
   */
  async initialize(): Promise<void> {
    logger.info("Initializing audio infrastructure");

    // Pass VAD configuration to the browser
    const vadConfig = {
      rmsThreshold: this.config.vadRmsThreshold || 0.01,
      vadSmoothingFrames: this.config.vadSmoothingFrames || 3,
    };

    await this.page.evaluate(
      async (
        workletCode: string,
        heartbeatIntervalMs: number,
        vadOptions: { rmsThreshold: number; vadSmoothingFrames: number },
      ) => {
        // Create global object to hold references (GC prevention)
        (window as any).__translatorAudio = {
          audioContext: null,
          captureWorklet: null,
          mediaStreamDestination: null,
          captureSource: null,
          analyser: null,
          lastHeartbeat: Date.now(),
          heartbeatIntervalMs: heartbeatIntervalMs,
          // Phase 3: Audio frame callback for chunk aggregation
          audioFrameCallback: null,
        };

        const audio = (window as any).__translatorAudio;

        // Step 1: Create AudioContext
        audio.audioContext = new AudioContext({ sampleRate: 16000 });
        console.log(
          "[AudioManager] AudioContext created, state:",
          audio.audioContext.state,
        );

        // Step 2: Resume if suspended
        if (audio.audioContext.state === "suspended") {
          console.log("[AudioManager] Attempting to resume AudioContext");
          await audio.audioContext.resume();
          console.log(
            "[AudioManager] AudioContext resumed, state:",
            audio.audioContext.state,
          );
        }

        // Step 3: Create MediaStreamDestination for output (agent's "microphone")
        // This is what Jitsi will use as our audio track
        audio.mediaStreamDestination =
          audio.audioContext.createMediaStreamDestination();
        console.log("[AudioManager] MediaStreamDestination created");

        // Step 4: Load capture worklet (inline via data URL)
        const captureWorkletBlob = new Blob([workletCode], {
          type: "application/javascript",
        });
        const captureWorkletUrl = URL.createObjectURL(captureWorkletBlob);
        await audio.audioContext.audioWorklet.addModule(captureWorkletUrl);
        console.log("[AudioManager] Capture AudioWorklet module loaded");

        // Step 5: Create capture worklet node with VAD parameters (Phase 3)
        audio.captureWorklet = new AudioWorkletNode(
          audio.audioContext,
          "translator-audio-processor",
          {
            processorOptions: vadOptions,
          },
        );
        console.log(
          "[AudioManager] Capture AudioWorkletNode created with VAD",
          vadOptions,
        );

        // Step 6: Set up message listener for heartbeat and audio data
        audio.captureWorklet.port.onmessage = (event: MessageEvent) => {
          if (event.data.type === "heartbeat") {
            audio.lastHeartbeat = Date.now();
            // Dispatch custom event for the monitor
            window.dispatchEvent(
              new CustomEvent("translatorHeartbeat", {
                detail: event.data,
              }),
            );
          } else if (event.data.type === "audioData") {
            // Phase 3: Call the audio frame callback if registered
            if (audio.audioFrameCallback) {
              audio.audioFrameCallback({
                samples: Array.from(event.data.data), // Convert Float32Array to regular array for transfer
                timestamp: event.data.timestamp,
                frameCount: event.data.frameCount,
                rms: event.data.rms,
                isSpeech: event.data.isSpeech,
              });
            }
            // Also dispatch event for backward compatibility
            window.dispatchEvent(
              new CustomEvent("translatorAudioData", {
                detail: event.data,
              }),
            );
          }
        };

        // Step 7: Analyser for monitoring (optional but useful for debugging)
        audio.analyser = audio.audioContext.createAnalyser();
        audio.analyser.fftSize = 256;

        console.log(
          "[AudioManager] Audio infrastructure initialized successfully",
        );
      },
      AUDIO_WORKLET_CODE,
      this.config.workletHeartbeatIntervalMs,
      vadConfig,
    );

    this.initialized = true;
    logger.info("Audio infrastructure initialized");

    // Verify AudioContext state
    await this.verifyAudioContext();
  }

  /**
   * Registers a callback function for audio frames (Phase 3).
   * The callback is called in the browser context via page.exposeFunction().
   */
  async registerAudioFrameCallback(callbackName: string): Promise<void> {
    logger.info("Registering audio frame callback", { callbackName });

    await this.page.evaluate((cbName: string) => {
      const audio = (window as any).__translatorAudio;
      if (audio) {
        // The callback function is exposed by Node.js via page.exposeFunction()
        audio.audioFrameCallback = (window as any)[cbName];
        console.log("[AudioManager] Audio frame callback registered:", cbName);
      }
    }, callbackName);
  }

  /**
   * Connects all existing participants' audio to the capture worklet.
   * This should be called AFTER registerAudioFrameCallback() to ensure
   * all audio data is properly forwarded to Node.js.
   */
  async connectExistingParticipants(): Promise<{
    connected: number;
    skipped: number;
    errors: number;
  }> {
    logger.info("Connecting existing participants audio");

    const result = await this.page.evaluate(() => {
      // Call the function exposed by bot.js
      if (typeof (window as any).connectAllParticipantAudio === "function") {
        return (window as any).connectAllParticipantAudio();
      } else {
        console.error(
          "[AudioManager] connectAllParticipantAudio not available",
        );
        return {
          success: false,
          error: "Function not available",
          connected: 0,
          skipped: 0,
          errors: 0,
        };
      }
    });

    logger.info("Existing participants connected", result);
    return result;
  }

  /**
   * Verifies and potentially resumes the AudioContext.
   */
  private async verifyAudioContext(): Promise<void> {
    const state = await this.page.evaluate(() => {
      const audio = (window as any).__translatorAudio;
      return audio?.audioContext?.state || "closed";
    });

    logger.info("AudioContext state verified", { state });

    if (state === "suspended") {
      logger.warn("AudioContext is suspended, attempting resume with backoff");

      for (let i = 0; i < this.config.audioContextResumeRetries; i++) {
        await this.page.evaluate(async () => {
          const audio = (window as any).__translatorAudio;
          if (audio?.audioContext?.state === "suspended") {
            await audio.audioContext.resume();
          }
        });

        const newState = await this.page.evaluate(() => {
          return (window as any).__translatorAudio?.audioContext?.state;
        });

        if (newState === "running") {
          logger.info("AudioContext resumed successfully", { attempt: i + 1 });
          return;
        }

        // Exponential backoff
        const delay = this.config.audioContextResumeBackoffMs * Math.pow(2, i);
        logger.debug("Waiting before retry", { delay, attempt: i + 1 });
        await new Promise((r) => setTimeout(r, delay));
      }

      logger.error("Failed to resume AudioContext after retries");
    }
  }

  /**
   * Publishes the translated audio track to the Jitsi conference (Phase 5).
   *
   * Calls the browser-side publishTranslatedAudioTrack() which:
   * 1. Overrides getUserMedia to return MediaStreamDestination's stream
   * 2. Creates a JitsiLocalTrack via JitsiMeetJS.createLocalTracks()
   * 3. Adds the track to the room via room.addTrack()
   *
   * Must be called after initialize() and after the room is joined.
   */
  async publishLocalTrack(): Promise<void> {
    logger.info("Publishing local audio track for translated audio");

    const result = await this.page.evaluate(async () => {
      if (typeof (window as any).publishTranslatedAudioTrack === "function") {
        return await (window as any).publishTranslatedAudioTrack();
      }
      return {
        success: false,
        error: "publishTranslatedAudioTrack not available",
      };
    });

    if (result.success) {
      logger.info("Local audio track published successfully");
    } else {
      logger.error("Failed to publish local audio track", {
        error: result.error,
      });
      throw new Error(`Failed to publish local audio track: ${result.error}`);
    }
  }

  /**
   * Plays TTS MP3 audio by passing a URL to the browser (Phase 5).
   *
   * Instead of base64-encoding the audio and sending it over CDP,
   * the audio is pre-stored in BotPageServer and the browser fetches
   * the binary MP3 directly via HTTP from localhost.
   */
  async playMp3AudioFromUrl(audioUrl: string): Promise<void> {
    logger.debug("Sending audio URL to browser for playback", { audioUrl });

    const result = await this.page.evaluate(async (url: string) => {
      if (typeof (window as any).playTranslatedAudioFromUrl === "function") {
        return await (window as any).playTranslatedAudioFromUrl(url);
      }
      return {
        success: false,
        error: "playTranslatedAudioFromUrl not available",
      };
    }, audioUrl);

    if (result.success) {
      logger.info("MP3 audio fetched and queued for playback", {
        duration: result.duration?.toFixed(2) + "s",
      });
    } else {
      logger.error("Failed to play MP3 audio from URL", {
        error: result.error,
      });
      throw new Error(`Failed to play MP3 audio: ${result.error}`);
    }
  }

  /**
   * Gets the playback health status from the browser (Phase 5).
   */
  async getPlaybackHealth(): Promise<AudioHealth["playback"]> {
    if (!this.initialized) {
      return {
        trackPublished: false,
        trackMuted: true,
        destinationActive: false,
        queueLength: 0,
        isPlaying: false,
      };
    }

    return await this.page.evaluate(() => {
      if (typeof (window as any).getPlaybackHealth === "function") {
        return (window as any).getPlaybackHealth();
      }
      return {
        trackPublished: false,
        trackMuted: true,
        destinationActive: false,
        queueLength: 0,
        isPlaying: false,
      };
    });
  }

  /**
   * Reinitializes the audio infrastructure (called on heartbeat timeout).
   */
  async reinitialize(): Promise<void> {
    logger.info("Reinitializing audio infrastructure");

    await this.cleanup();
    await this.initialize();

    logger.info("Audio infrastructure reinitialized");
  }

  /**
   * Gets the current health status.
   */
  async getHealth(): Promise<AudioHealth> {
    if (!this.initialized) {
      return {
        contextState: "closed",
        captureActive: false,
        outputActive: false,
        playback: {
          trackPublished: false,
          trackMuted: true,
          destinationActive: false,
          queueLength: 0,
          isPlaying: false,
        },
      };
    }

    const [audioState, playbackHealth] = await Promise.all([
      this.page.evaluate(() => {
        const audio = (window as any).__translatorAudio;
        return {
          contextState: audio?.audioContext?.state || "closed",
          captureActive: audio?.captureWorklet !== null,
          outputActive: audio?.mediaStreamDestination !== null,
        };
      }),
      this.getPlaybackHealth(),
    ]);

    return {
      ...audioState,
      playback: playbackHealth,
    };
  }

  /**
   * Cleans up audio resources.
   */
  async cleanup(): Promise<void> {
    logger.info("Cleaning up audio infrastructure");

    await this.page.evaluate(() => {
      const audio = (window as any).__translatorAudio;
      if (audio) {
        if (audio.captureWorklet) {
          audio.captureWorklet.disconnect();
        }
        if (audio.remoteSources) {
          audio.remoteSources.forEach((source: AudioNode) =>
            source.disconnect(),
          );
        }
        if (audio.audioContext) {
          audio.audioContext.close();
        }
        (window as any).__translatorAudio = null;
      }
    });

    this.initialized = false;
    logger.info("Audio infrastructure cleaned up");
  }
}
