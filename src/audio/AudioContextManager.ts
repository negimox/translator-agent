/**
 * AudioContext Manager for the Translator Agent.
 * 
 * Handles:
 * - AudioContext creation and state management
 * - AudioWorklet setup with inline code (avoiding file path issues)
 * - GC prevention for both capture and output nodes
 * - MediaStreamDestination for publishing translated audio
 */

import { Page } from 'puppeteer';
import { AgentConfig } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('AudioManager');

/**
 * AudioWorklet processor code as an inline string.
 * This is converted to a data URL to avoid file loading issues in Puppeteer.
 * 
 * The worklet:
 * - Captures audio frames from input
 * - Posts frames to main thread for processing (Phase 3 chunk aggregation)
 * - Sends periodic heartbeat messages for health monitoring
 */
const AUDIO_WORKLET_CODE = `
class TranslatorAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.frameCount = 0;
        this.lastHeartbeat = currentTime;
        this.heartbeatInterval = 0.3; // 300ms
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        
        // Pass through audio (for monitoring/debugging)
        if (input && output) {
            for (let channel = 0; channel < input.length; channel++) {
                if (input[channel] && output[channel]) {
                    output[channel].set(input[channel]);
                }
            }
        }
        
        // Post audio data to main thread if we have input
        if (input && input[0] && input[0].length > 0) {
            this.port.postMessage({
                type: 'audioData',
                data: input[0].slice(), // Copy the Float32Array
                timestamp: currentTime,
                frameCount: this.frameCount++
            });
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
 * AudioWorklet processor for output (TTS playback).
 * Takes audio data from main thread and plays it out.
 */
const OUTPUT_WORKLET_CODE = `
class TranslatorOutputProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = [];
        this.isPlaying = false;
        
        this.port.onmessage = (event) => {
            if (event.data.type === 'audioData') {
                this.buffer.push(...event.data.samples);
            } else if (event.data.type === 'clear') {
                this.buffer = [];
            }
        };
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        
        if (output && output[0]) {
            const outputChannel = output[0];
            const samplesToPlay = Math.min(this.buffer.length, outputChannel.length);
            
            if (samplesToPlay > 0) {
                for (let i = 0; i < samplesToPlay; i++) {
                    outputChannel[i] = this.buffer.shift();
                }
                // Fill the rest with silence
                for (let i = samplesToPlay; i < outputChannel.length; i++) {
                    outputChannel[i] = 0;
                }
            } else {
                // Silence
                outputChannel.fill(0);
            }
        }
        
        return true;
    }
}

registerProcessor('translator-output-processor', TranslatorOutputProcessor);
`;

/**
 * Health status of the audio infrastructure.
 */
export interface AudioHealth {
    contextState: 'suspended' | 'running' | 'closed';
    captureActive: boolean;
    outputActive: boolean;
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
        logger.info('Initializing audio infrastructure');

        await this.page.evaluate(async (workletCode: string, outputWorkletCode: string, heartbeatIntervalMs: number) => {
            // Create global object to hold references (GC prevention)
            (window as any).__translatorAudio = {
                audioContext: null,
                captureWorklet: null,
                outputWorklet: null,
                mediaStreamDestination: null,
                captureSource: null,
                analyser: null,
                lastHeartbeat: Date.now(),
                heartbeatIntervalMs: heartbeatIntervalMs,
            };

            const audio = (window as any).__translatorAudio;

            // Step 1: Create AudioContext
            audio.audioContext = new AudioContext({ sampleRate: 48000 });
            console.log('[AudioManager] AudioContext created, state:', audio.audioContext.state);

            // Step 2: Resume if suspended
            if (audio.audioContext.state === 'suspended') {
                console.log('[AudioManager] Attempting to resume AudioContext');
                await audio.audioContext.resume();
                console.log('[AudioManager] AudioContext resumed, state:', audio.audioContext.state);
            }

            // Step 3: Create MediaStreamDestination for output (agent's "microphone")
            // This is what Jitsi will use as our audio track
            audio.mediaStreamDestination = audio.audioContext.createMediaStreamDestination();
            console.log('[AudioManager] MediaStreamDestination created');

            // Step 4: Load capture worklet (inline via data URL)
            const captureWorkletBlob = new Blob([workletCode], { type: 'application/javascript' });
            const captureWorkletUrl = URL.createObjectURL(captureWorkletBlob);
            await audio.audioContext.audioWorklet.addModule(captureWorkletUrl);
            console.log('[AudioManager] Capture AudioWorklet module loaded');

            // Step 5: Load output worklet
            const outputWorkletBlob = new Blob([outputWorkletCode], { type: 'application/javascript' });
            const outputWorkletUrl = URL.createObjectURL(outputWorkletBlob);
            await audio.audioContext.audioWorklet.addModule(outputWorkletUrl);
            console.log('[AudioManager] Output AudioWorklet module loaded');

            // Step 6: Create capture worklet node
            audio.captureWorklet = new AudioWorkletNode(audio.audioContext, 'translator-audio-processor');
            console.log('[AudioManager] Capture AudioWorkletNode created');

            // Step 7: Create output worklet node and connect to destination
            audio.outputWorklet = new AudioWorkletNode(audio.audioContext, 'translator-output-processor');
            audio.outputWorklet.connect(audio.mediaStreamDestination);
            console.log('[AudioManager] Output AudioWorkletNode created and connected');

            // Step 8: Set up heartbeat listener
            audio.captureWorklet.port.onmessage = (event: MessageEvent) => {
                if (event.data.type === 'heartbeat') {
                    audio.lastHeartbeat = Date.now();
                    // Dispatch custom event for the monitor
                    window.dispatchEvent(new CustomEvent('translatorHeartbeat', {
                        detail: event.data
                    }));
                } else if (event.data.type === 'audioData') {
                    // Audio data for Phase 3 chunk aggregation
                    // For now, just dispatch event
                    window.dispatchEvent(new CustomEvent('translatorAudioData', {
                        detail: event.data
                    }));
                }
            };

            // Step 9: Analyser for monitoring (optional but useful for debugging)
            audio.analyser = audio.audioContext.createAnalyser();
            audio.analyser.fftSize = 256;

            console.log('[AudioManager] Audio infrastructure initialized successfully');

        }, AUDIO_WORKLET_CODE, OUTPUT_WORKLET_CODE, this.config.workletHeartbeatIntervalMs);

        this.initialized = true;
        logger.info('Audio infrastructure initialized');

        // Verify AudioContext state
        await this.verifyAudioContext();
    }

    /**
     * Verifies and potentially resumes the AudioContext.
     */
    private async verifyAudioContext(): Promise<void> {
        const state = await this.page.evaluate(() => {
            const audio = (window as any).__translatorAudio;
            return audio?.audioContext?.state || 'closed';
        });

        logger.info('AudioContext state verified', { state });

        if (state === 'suspended') {
            logger.warn('AudioContext is suspended, attempting resume with backoff');
            
            for (let i = 0; i < this.config.audioContextResumeRetries; i++) {
                await this.page.evaluate(async () => {
                    const audio = (window as any).__translatorAudio;
                    if (audio?.audioContext?.state === 'suspended') {
                        await audio.audioContext.resume();
                    }
                });

                const newState = await this.page.evaluate(() => {
                    return (window as any).__translatorAudio?.audioContext?.state;
                });

                if (newState === 'running') {
                    logger.info('AudioContext resumed successfully', { attempt: i + 1 });
                    return;
                }

                // Exponential backoff
                const delay = this.config.audioContextResumeBackoffMs * Math.pow(2, i);
                logger.debug('Waiting before retry', { delay, attempt: i + 1 });
                await new Promise(r => setTimeout(r, delay));
            }

            logger.error('Failed to resume AudioContext after retries');
        }
    }

    /**
     * Connects to incoming audio from the meeting.
     * Call this after joining the meeting to capture remote participants' audio.
     */
    async connectToMeetingAudio(): Promise<void> {
        logger.info('Connecting to meeting audio');

        await this.page.evaluate(() => {
            const audio = (window as any).__translatorAudio;
            if (!audio || !audio.audioContext || !audio.captureWorklet) {
                throw new Error('Audio infrastructure not initialized');
            }

            // Find all remote audio elements
            const remoteAudioElements = document.querySelectorAll('audio[id^="remoteaudio_"]');
            console.log('[AudioManager] Found remote audio elements:', remoteAudioElements.length);

            // Create MediaStreamSource for each and connect to capture worklet
            audio.remoteSources = [];
            remoteAudioElements.forEach((audioElement) => {
                const stream = (audioElement as HTMLAudioElement).srcObject as MediaStream;
                if (stream) {
                    const source = audio.audioContext.createMediaStreamSource(stream);
                    source.connect(audio.captureWorklet);
                    source.connect(audio.analyser); // For monitoring
                    audio.remoteSources.push(source);
                    console.log('[AudioManager] Connected remote audio source');
                }
            });
        });

        logger.info('Connected to meeting audio');
    }

    /**
     * Gets the audio track that should be published to the meeting.
     */
    async getOutputMediaStream(): Promise<void> {
        // The MediaStreamDestination track is available in the browser
        // Jitsi will need to use this track as the agent's audio
        logger.info('Output MediaStream is available via __translatorAudio.mediaStreamDestination.stream');
    }

    /**
     * Plays audio data through the output worklet.
     * This is used for TTS playback in Phase 5.
     */
    async playAudio(samples: Float32Array): Promise<void> {
        await this.page.evaluate((samplesArray: number[]) => {
            const audio = (window as any).__translatorAudio;
            if (audio?.outputWorklet) {
                audio.outputWorklet.port.postMessage({
                    type: 'audioData',
                    samples: samplesArray
                });
            }
        }, Array.from(samples));
    }

    /**
     * Reinitializes the audio infrastructure (called on heartbeat timeout).
     */
    async reinitialize(): Promise<void> {
        logger.info('Reinitializing audio infrastructure');

        await this.cleanup();
        await this.initialize();

        logger.info('Audio infrastructure reinitialized');
    }

    /**
     * Gets the current health status.
     */
    async getHealth(): Promise<AudioHealth> {
        if (!this.initialized) {
            return {
                contextState: 'closed',
                captureActive: false,
                outputActive: false,
            };
        }

        return await this.page.evaluate(() => {
            const audio = (window as any).__translatorAudio;
            return {
                contextState: audio?.audioContext?.state || 'closed',
                captureActive: audio?.captureWorklet !== null,
                outputActive: audio?.outputWorklet !== null && audio?.mediaStreamDestination !== null,
            };
        });
    }

    /**
     * Cleans up audio resources.
     */
    async cleanup(): Promise<void> {
        logger.info('Cleaning up audio infrastructure');

        await this.page.evaluate(() => {
            const audio = (window as any).__translatorAudio;
            if (audio) {
                if (audio.captureWorklet) {
                    audio.captureWorklet.disconnect();
                }
                if (audio.outputWorklet) {
                    audio.outputWorklet.disconnect();
                }
                if (audio.remoteSources) {
                    audio.remoteSources.forEach((source: AudioNode) => source.disconnect());
                }
                if (audio.audioContext) {
                    audio.audioContext.close();
                }
                (window as any).__translatorAudio = null;
            }
        });

        this.initialized = false;
        logger.info('Audio infrastructure cleaned up');
    }
}
