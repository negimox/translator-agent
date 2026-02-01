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
 * Phase 3 Optimized:
 * - VAD-driven chunk aggregation inside the worklet (audio thread)
 * - Zero-GC buffer: stores Float32Array refs, merges once at finalization
 * - In-worklet decimation: 48kHz → 16kHz before transfer
 * - Transferable ArrayBuffer for zero-copy message passing
 * - Minimum 200ms speech to prevent sending clicks/pops
 */
const AUDIO_WORKLET_CODE = `
class TranslatorAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = options.processorOptions || {};
        
        // Sample rates
        this.inputRate = sampleRate;  // Will be 48000 or 16000
        this.targetRate = opts.targetRate || 16000;
        this.decimationFactor = Math.round(this.inputRate / this.targetRate);
        
        // Chunk settings (in INPUT samples)
        this.targetDurationSamples = (opts.targetDurationMs || 900) / 1000 * this.inputRate;
        this.maxDurationSamples = (opts.maxDurationMs || 3000) / 1000 * this.inputRate;
        this.silenceCoalesceSamples = (opts.silenceCoalesceMs || 250) / 1000 * this.inputRate;
        this.minSpeechSamples = (opts.minSpeechMs || 200) / 1000 * this.inputRate;
        
        // VAD
        this.vadThreshold = opts.vadThreshold || 0.01;
        
        // State - OPTIMIZATION: Array of chunk references, not spread values
        this.chunks = [];
        this.totalSamples = 0;
        this.speechSamples = 0;
        this.silenceSamples = 0;
        this.isCapturing = false;
        this.chunkId = 0;
        
        // Heartbeat
        this.lastHeartbeat = currentTime;
        this.heartbeatInterval = (opts.heartbeatIntervalMs || 300) / 1000;
        
        console.log('[Worklet] Initialized:', {
            inputRate: this.inputRate,
            targetRate: this.targetRate,
            decimationFactor: this.decimationFactor,
            vadThreshold: this.vadThreshold
        });
    }
    
    computeRMS(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        return Math.sqrt(sum / samples.length);
    }
    
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) return true;
        
        const samples = input[0];
        const rms = this.computeRMS(samples);
        const isSpeech = rms > this.vadThreshold;
        
        if (isSpeech) {
            this.isCapturing = true;
            this.silenceSamples = 0;
            this.speechSamples += samples.length;
            
            // OPTIMIZATION: Store reference, don't spread
            this.chunks.push(new Float32Array(samples));
            this.totalSamples += samples.length;
            
        } else if (this.isCapturing) {
            this.silenceSamples += samples.length;
            
            // Include trailing silence for natural speech
            this.chunks.push(new Float32Array(samples));
            this.totalSamples += samples.length;
            
            // Check finalization conditions
            if (this.silenceSamples >= this.silenceCoalesceSamples) {
                this.finalizeChunk();
            }
        }
        
        // Hard cap
        if (this.totalSamples >= this.maxDurationSamples) {
            this.finalizeChunk();
        }
        
        // Heartbeat
        if (currentTime - this.lastHeartbeat >= this.heartbeatInterval) {
            this.port.postMessage({ type: 'heartbeat', timestamp: currentTime });
            this.lastHeartbeat = currentTime;
        }
        
        return true;
    }
    
    finalizeChunk() {
        // OPTIMIZATION: Minimum speech duration check (200ms)
        if (this.speechSamples < this.minSpeechSamples) {
            this.resetState();
            return;
        }
        
        // OPTIMIZATION: Merge + decimate in single pass
        const outputLength = Math.ceil(this.totalSamples / this.decimationFactor);
        const output = new Float32Array(outputLength);
        
        let readPos = 0;
        let writePos = 0;
        
        for (const chunk of this.chunks) {
            for (let i = 0; i < chunk.length; i++) {
                // Only keep every Nth sample (decimation)
                if ((readPos % this.decimationFactor) === 0 && writePos < outputLength) {
                    output[writePos++] = chunk[i];
                }
                readPos++;
            }
        }
        
        const durationMs = (writePos / this.targetRate) * 1000;
        
        // Send with transferable buffer (zero-copy)
        this.port.postMessage({
            type: 'chunk',
            chunkId: this.chunkId++,
            samples: output.buffer,
            sampleRate: this.targetRate,
            timestamp: currentTime,
            durationMs: durationMs
        }, [output.buffer]);
        
        console.log('[Worklet] Chunk sent:', {
            chunkId: this.chunkId - 1,
            samples: writePos,
            durationMs: durationMs.toFixed(0)
        });
        
        this.resetState();
    }
    
    resetState() {
        this.chunks = [];
        this.totalSamples = 0;
        this.speechSamples = 0;
        this.silenceSamples = 0;
        this.isCapturing = false;
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

        await this.page.evaluate(async (
            workletCode: string, 
            outputWorkletCode: string, 
            processorOptions: {
                targetRate: number;
                targetDurationMs: number;
                maxDurationMs: number;
                silenceCoalesceMs: number;
                minSpeechMs: number;
                vadThreshold: number;
                heartbeatIntervalMs: number;
            }
        ) => {
            // Create global object to hold references (GC prevention)
            (window as any).__translatorAudio = {
                audioContext: null,
                captureWorklet: null,
                outputWorklet: null,
                mediaStreamDestination: null,
                captureSource: null,
                analyser: null,
                lastHeartbeat: Date.now(),
                chunkQueue: [], // Phase 3: Queue of ready chunks
                actualSampleRate: 0, // Will be set after AudioContext creation
            };

            const audio = (window as any).__translatorAudio;

            // Step 1: Create AudioContext - try 16kHz first, fallback to 48kHz
            try {
                audio.audioContext = new AudioContext({ sampleRate: 16000 });
            } catch (e) {
                audio.audioContext = new AudioContext({ sampleRate: 48000 });
            }
            
            // Check actual sample rate (Chrome may override our request)
            audio.actualSampleRate = audio.audioContext.sampleRate;
            console.log('[AudioManager] AudioContext created:', {
                requested: 16000,
                actual: audio.actualSampleRate,
                state: audio.audioContext.state
            });

            // Step 2: Resume if suspended
            if (audio.audioContext.state === 'suspended') {
                console.log('[AudioManager] Attempting to resume AudioContext');
                await audio.audioContext.resume();
                console.log('[AudioManager] AudioContext resumed, state:', audio.audioContext.state);
            }

            // Step 3: Create MediaStreamDestination for output (agent's "microphone")
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

            // Step 6: Create capture worklet node WITH processorOptions
            audio.captureWorklet = new AudioWorkletNode(
                audio.audioContext, 
                'translator-audio-processor',
                { processorOptions }
            );
            console.log('[AudioManager] Capture AudioWorkletNode created with options:', processorOptions);

            // Step 7: Create output worklet node and connect to destination
            audio.outputWorklet = new AudioWorkletNode(audio.audioContext, 'translator-output-processor');
            audio.outputWorklet.connect(audio.mediaStreamDestination);
            console.log('[AudioManager] Output AudioWorkletNode created and connected');

            // Step 8: Set up message handler for chunks and heartbeats
            audio.captureWorklet.port.onmessage = (event: MessageEvent) => {
                if (event.data.type === 'heartbeat') {
                    audio.lastHeartbeat = Date.now();
                    // Dispatch event for HeartbeatMonitor
                    window.dispatchEvent(new CustomEvent('translatorHeartbeat', {
                        detail: event.data
                    }));
                } else if (event.data.type === 'chunk') {
                    // Phase 3: Chunk ready for processing
                    audio.chunkQueue.push(event.data);
                    console.log('[AudioManager] Chunk received:', {
                        chunkId: event.data.chunkId,
                        durationMs: event.data.durationMs?.toFixed(0) || 'unknown'
                    });
                    // Dispatch event for ChunkHandler
                    window.dispatchEvent(new CustomEvent('translatorChunk', {
                        detail: event.data
                    }));
                }
            };

            // Step 9: Analyser for monitoring
            audio.analyser = audio.audioContext.createAnalyser();
            audio.analyser.fftSize = 256;

            // Step 10: Connect silent oscillator to keep worklet's process() running
            // Without audio input, AudioWorklet process() is never called
            audio.silentOscillator = audio.audioContext.createOscillator();
            audio.silentGain = audio.audioContext.createGain();
            audio.silentGain.gain.value = 0; // Silent
            audio.silentOscillator.connect(audio.silentGain);
            audio.silentGain.connect(audio.captureWorklet);
            audio.silentOscillator.start();
            console.log('[AudioManager] Silent oscillator connected to keep worklet alive');

            console.log('[AudioManager] Audio infrastructure initialized successfully');

        }, AUDIO_WORKLET_CODE, OUTPUT_WORKLET_CODE, {
            targetRate: this.config.sttSampleRate,
            targetDurationMs: this.config.chunkTargetDurationMs,
            maxDurationMs: this.config.chunkMaxDurationMs,
            silenceCoalesceMs: this.config.silenceCoalesceMs,
            minSpeechMs: this.config.chunkMinSpeechMs,
            vadThreshold: this.config.vadEnergyThreshold,
            heartbeatIntervalMs: this.config.workletHeartbeatIntervalMs,
        });

        this.initialized = true;
        logger.info('Audio infrastructure initialized');

        // Verify AudioContext state
        await this.verifyAudioContext();

        // Process any pending audio tracks that were queued before audio init
        await this.processPendingTracks();
    }

    /**
     * Processes audio tracks that were queued before audio infrastructure was ready.
     */
    private async processPendingTracks(): Promise<void> {
        await this.page.evaluate(() => {
            // Call the function defined in bot.js
            if (typeof (window as any).processPendingAudioTracks === 'function') {
                (window as any).processPendingAudioTracks();
            } else {
                console.warn('[AudioManager] processPendingAudioTracks not found');
            }
        });
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
     * Phase 3: Polls for ready chunks from the browser.
     * Returns and clears the chunk queue.
     */
    async pollChunks(): Promise<Array<{
        type: 'chunk';
        chunkId: number;
        samples: ArrayBuffer;
        sampleRate: number;
        timestamp: number;
        durationMs: number;
    }>> {
        if (!this.initialized) return [];

        return await this.page.evaluate(() => {
            const audio = (window as any).__translatorAudio;
            if (!audio || !audio.chunkQueue) return [];
            
            const chunks = [...audio.chunkQueue];
            audio.chunkQueue = [];
            return chunks;
        });
    }

    /**
     * Gets the actual sample rate being used by the AudioContext.
     */
    async getActualSampleRate(): Promise<number> {
        if (!this.initialized) return 0;

        return await this.page.evaluate(() => {
            const audio = (window as any).__translatorAudio;
            return audio?.actualSampleRate || audio?.audioContext?.sampleRate || 0;
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
                if (audio.silentOscillator) {
                    audio.silentOscillator.stop();
                    audio.silentOscillator.disconnect();
                }
                if (audio.silentGain) {
                    audio.silentGain.disconnect();
                }
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
