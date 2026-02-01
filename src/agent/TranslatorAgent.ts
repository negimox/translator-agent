/**
 * Main Translator Agent class.
 * Orchestrates the headless Chrome browser, meeting connection, and audio capture.
 * 
 * NEW ARCHITECTURE (Phase 3 Revised):
 * - Uses full Jitsi Meet UI (not lib-jitsi-meet directly)
 * - Captures audio from PulseAudio virtual sink
 * - Chrome outputs audio → PulseAudio sink → parec capture → processing
 */

import { AgentConfig, getDisplayName, getMeetingUrl } from '../config';
import { createLogger } from '../logger';
import { ChromeInstance, launchChrome, isChromeLive } from './ChromeLauncher';
import { PulseAudioCapture, checkPulseAudioSetup } from '../audio/PulseAudioCapture';
import { ChunkSaver } from '../audio/ChunkSaver';
import { WAVEncoder } from '../audio/WAVEncoder';
import { JitsiConnection } from '../meeting/JitsiConnection';
import { HealthStatus, AgentHealthState } from '../health/HealthChecks';

const logger = createLogger('TranslatorAgent');

/**
 * Agent lifecycle states.
 */
export enum AgentState {
    IDLE = 'idle',
    STARTING = 'starting',
    CONNECTING = 'connecting',
    JOINED = 'joined',
    ERROR = 'error',
    STOPPING = 'stopping',
    STOPPED = 'stopped',
}

/**
 * VAD (Voice Activity Detection) configuration.
 */
interface VADConfig {
    energyThreshold: number;
    silenceTimeoutMs: number;
    minSpeechMs: number;
    maxChunkMs: number;
}

const DEFAULT_VAD: VADConfig = {
    energyThreshold: 0.01,
    silenceTimeoutMs: 500,
    minSpeechMs: 200,
    maxChunkMs: 3000,
};

/**
 * Main Translator Agent class.
 * Manages the lifecycle of a translator agent that joins a Jitsi meeting.
 */
export class TranslatorAgent {
    private config: AgentConfig;
    private chrome: ChromeInstance | null = null;
    private jitsiConnection: JitsiConnection | null = null;
    private audioCapture: PulseAudioCapture | null = null;
    private chunkSaver: ChunkSaver | null = null;
    private state: AgentState = AgentState.IDLE;
    private startTime: Date | null = null;

    // Audio buffering for VAD
    private audioBuffer: Float32Array[] = [];
    private totalSamples: number = 0;
    private isSpeaking: boolean = false;
    private lastSpeechTime: number = 0;
    private chunkId: number = 0;
    private vadConfig: VADConfig = DEFAULT_VAD;

    constructor(config: AgentConfig) {
        this.config = config;
        logger.info('TranslatorAgent created', {
            displayName: getDisplayName(config),
            meetingUrl: getMeetingUrl(config),
        });
    }

    /**
     * Gets the current agent state.
     */
    getState(): AgentState {
        return this.state;
    }

    /**
     * Starts the translator agent.
     * Launches Chrome, connects to the meeting, and starts audio capture.
     */
    async start(): Promise<void> {
        if (this.state !== AgentState.IDLE && this.state !== AgentState.STOPPED) {
            throw new Error(`Cannot start agent in state: ${this.state}`);
        }

        this.state = AgentState.STARTING;
        this.startTime = new Date();
        logger.info('Starting translator agent');

        try {
            // Step 1: Check PulseAudio setup
            logger.info('Step 1: Checking PulseAudio setup');
            const pulseOk = await checkPulseAudioSetup();
            if (!pulseOk) {
                throw new Error('PulseAudio not configured. Run: scripts/setup-pulseaudio.sh');
            }

            // Step 2: Launch Chrome
            logger.info('Step 2: Launching Chrome');
            this.chrome = await launchChrome(this.config);
            
            // Step 3: Connect to meeting via full Jitsi Meet UI
            logger.info('Step 3: Connecting to Jitsi meeting');
            this.state = AgentState.CONNECTING;
            
            this.jitsiConnection = new JitsiConnection(this.config, this.chrome.page);
            await this.jitsiConnection.connect();

            // Step 4: Initialize chunk saver (for debugging)
            this.chunkSaver = new ChunkSaver('./debug_chunks', this.config.sttSampleRate);
            if (this.chunkSaver.isEnabled()) {
                logger.info('Step 4: Chunk saving enabled for debugging');
            }

            // Step 5: Start PulseAudio capture
            logger.info('Step 5: Starting audio capture from PulseAudio');
            this.audioCapture = new PulseAudioCapture({
                sinkName: 'translator_sink',
                sampleRate: this.config.sttSampleRate,
                channels: 1,
                bufferSize: 1600, // 100ms at 16kHz
            });

            this.audioCapture.on('data', (samples: Float32Array) => {
                this.processAudioData(samples);
            });

            this.audioCapture.on('error', (err) => {
                logger.error('Audio capture error', { error: err.message });
            });

            this.audioCapture.start();

            this.state = AgentState.JOINED;
            logger.info('Translator agent successfully started and joined meeting', {
                displayName: getDisplayName(this.config),
                meetingUrl: getMeetingUrl(this.config),
            });

        } catch (error) {
            this.state = AgentState.ERROR;
            logger.error('Failed to start translator agent', { error: String(error) });
            await this.cleanup();
            throw error;
        }
    }

    /**
     * Processes incoming audio data with VAD.
     */
    private processAudioData(samples: Float32Array): void {
        // Calculate energy (RMS)
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        const rms = Math.sqrt(sum / samples.length);
        const isSpeech = rms > this.vadConfig.energyThreshold;

        const now = Date.now();

        if (isSpeech) {
            // Start or continue speech
            if (!this.isSpeaking) {
                logger.debug('Speech started', { rms: rms.toFixed(4) });
            }
            this.isSpeaking = true;
            this.lastSpeechTime = now;
            this.audioBuffer.push(new Float32Array(samples));
            this.totalSamples += samples.length;
        } else if (this.isSpeaking) {
            // During speech, still buffer silence
            this.audioBuffer.push(new Float32Array(samples));
            this.totalSamples += samples.length;

            // Check for end of speech
            const silenceDuration = now - this.lastSpeechTime;
            const chunkDuration = (this.totalSamples / this.config.sttSampleRate) * 1000;

            if (silenceDuration > this.vadConfig.silenceTimeoutMs || 
                chunkDuration > this.vadConfig.maxChunkMs) {
                this.finalizeChunk();
            }
        }
    }

    /**
     * Finalizes the current audio chunk and saves/processes it.
     */
    private finalizeChunk(): void {
        if (this.audioBuffer.length === 0) {
            this.resetBuffer();
            return;
        }

        const durationMs = (this.totalSamples / this.config.sttSampleRate) * 1000;

        // Check minimum duration
        if (durationMs < this.vadConfig.minSpeechMs) {
            logger.debug('Chunk too short, discarding', { durationMs });
            this.resetBuffer();
            return;
        }

        // Merge all buffers
        const merged = new Float32Array(this.totalSamples);
        let offset = 0;
        for (const buf of this.audioBuffer) {
            merged.set(buf, offset);
            offset += buf.length;
        }

        // Generate chunk ID
        const currentChunkId = this.chunkId++;

        logger.info('Audio chunk ready', {
            chunkId: currentChunkId,
            durationMs: durationMs.toFixed(0),
            samples: this.totalSamples,
        });

        // Save to disk if debugging
        if (this.chunkSaver?.isEnabled()) {
            this.chunkSaver.saveChunk(merged, {
                chunkId: currentChunkId,
                durationMs,
            });
        }

        // TODO: Phase 4 - Send to STT pipeline
        // this.sendToSTTPipeline(merged, chunkIdStr);

        this.resetBuffer();
    }

    /**
     * Resets the audio buffer.
     */
    private resetBuffer(): void {
        this.audioBuffer = [];
        this.totalSamples = 0;
        this.isSpeaking = false;
    }

    /**
     * Stops the translator agent and cleans up resources.
     */
    async stop(): Promise<void> {
        if (this.state === AgentState.STOPPED || this.state === AgentState.STOPPING) {
            return;
        }

        this.state = AgentState.STOPPING;
        logger.info('Stopping translator agent');

        await this.cleanup();

        this.state = AgentState.STOPPED;
        logger.info('Translator agent stopped');
    }

    /**
     * Cleans up all resources.
     */
    private async cleanup(): Promise<void> {
        // Stop audio capture
        if (this.audioCapture) {
            this.audioCapture.stop();
            this.audioCapture = null;
        }

        // Disconnect from meeting
        if (this.jitsiConnection) {
            await this.jitsiConnection.disconnect();
            this.jitsiConnection = null;
        }

        // Close Chrome
        if (this.chrome) {
            await this.chrome.close();
            this.chrome = null;
        }

        // Reset buffer
        this.resetBuffer();
    }

    /**
     * Gets the current health status of the agent.
     */
    getHealth(): AgentHealthState {
        const chromeHealthy = this.chrome !== null && isChromeLive(this.chrome);
        const meetingConnected = this.jitsiConnection?.isConnected() ?? false;
        const audioCapturing = this.audioCapture?.isCapturing() ?? false;

        const isHealthy = chromeHealthy && meetingConnected && audioCapturing;

        return {
            state: this.state,
            healthy: isHealthy,
            chrome: chromeHealthy,
            audioContext: audioCapturing ? 'running' : 'closed',
            captureActive: audioCapturing,
            outputActive: false, // TTS not implemented yet
            heartbeatHealthy: audioCapturing,
            meetingConnected,
            uptime: this.startTime 
                ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
                : 0,
        };
    }

}
