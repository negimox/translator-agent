/**
 * PulseAudio Capture Module
 * 
 * Captures audio from PulseAudio virtual sink monitor using `parec`.
 * This provides reliable audio capture from Chrome's audio output.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { createLogger } from '../logger';

const logger = createLogger('PulseAudioCapture');

/**
 * Configuration for PulseAudio capture.
 */
export interface PulseAudioConfig {
    /** PulseAudio sink name to capture from */
    sinkName: string;
    /** Sample rate for capture (default: 16000) */
    sampleRate: number;
    /** Number of channels (default: 1 for mono) */
    channels: number;
    /** Buffer size in bytes before emitting data */
    bufferSize: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: PulseAudioConfig = {
    sinkName: 'translator_sink',
    sampleRate: 16000,
    channels: 1,
    bufferSize: 3200, // 100ms of 16kHz mono 16-bit audio
};

/**
 * PulseAudio capture using parec command.
 * Emits 'data' events with raw PCM Int16 LE audio data.
 */
export class PulseAudioCapture extends EventEmitter {
    private config: PulseAudioConfig;
    private process: ChildProcessWithoutNullStreams | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private isRunning: boolean = false;

    constructor(config: Partial<PulseAudioConfig> = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Starts capturing audio from PulseAudio sink monitor.
     */
    start(): void {
        if (this.isRunning) {
            logger.warn('PulseAudio capture already running');
            return;
        }

        const monitorSource = `${this.config.sinkName}.monitor`;
        
        logger.info('Starting PulseAudio capture', {
            source: monitorSource,
            sampleRate: this.config.sampleRate,
            channels: this.config.channels
        });

        // Spawn parec process
        this.process = spawn('parec', [
            `--device=${monitorSource}`,
            '--format=s16le',  // 16-bit signed little-endian
            `--rate=${this.config.sampleRate}`,
            `--channels=${this.config.channels}`,
            '--latency-msec=50',  // Low latency
        ]);

        this.isRunning = true;

        // Handle stdout (raw PCM data)
        this.process.stdout.on('data', (chunk: Buffer) => {
            this.handleAudioData(chunk);
        });

        // Handle stderr
        this.process.stderr.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
                logger.warn('parec stderr', { message: msg });
            }
        });

        // Handle process exit
        this.process.on('close', (code) => {
            this.isRunning = false;
            if (code !== 0 && code !== null) {
                logger.error('parec process exited with error', { code });
                this.emit('error', new Error(`parec exited with code ${code}`));
            } else {
                logger.info('parec process exited normally');
            }
            this.emit('close');
        });

        // Handle process error
        this.process.on('error', (err) => {
            this.isRunning = false;
            logger.error('parec process error', { error: err.message });
            this.emit('error', err);
        });

        logger.info('PulseAudio capture started');
    }

    /**
     * Handles incoming audio data, buffering and emitting in chunks.
     */
    private handleAudioData(chunk: Buffer): void {
        // Append to buffer
        this.buffer = Buffer.concat([this.buffer, chunk]);

        // Emit when we have enough data
        while (this.buffer.length >= this.config.bufferSize) {
            const audioChunk = this.buffer.subarray(0, this.config.bufferSize);
            this.buffer = this.buffer.subarray(this.config.bufferSize);
            
            // Convert Int16LE buffer to Float32Array for processing
            const float32 = this.int16ToFloat32(audioChunk);
            this.emit('data', float32);
        }
    }

    /**
     * Converts Int16 LE buffer to Float32Array (normalized -1 to 1).
     */
    private int16ToFloat32(buffer: Buffer): Float32Array {
        const samples = buffer.length / 2;
        const float32 = new Float32Array(samples);
        
        for (let i = 0; i < samples; i++) {
            const int16 = buffer.readInt16LE(i * 2);
            float32[i] = int16 / 32768; // Normalize to -1..1
        }
        
        return float32;
    }

    /**
     * Stops the capture process.
     */
    stop(): void {
        if (this.process) {
            logger.info('Stopping PulseAudio capture');
            this.process.kill('SIGTERM');
            this.process = null;
        }
        this.isRunning = false;
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Checks if capture is currently running.
     */
    isCapturing(): boolean {
        return this.isRunning;
    }

    /**
     * Gets the sample rate being used.
     */
    getSampleRate(): number {
        return this.config.sampleRate;
    }
}

/**
 * Checks if PulseAudio is available and the sink exists.
 */
export async function checkPulseAudioSetup(sinkName: string = 'translator_sink'): Promise<boolean> {
    return new Promise((resolve) => {
        const pactl = spawn('pactl', ['list', 'short', 'sinks']);
        let output = '';

        pactl.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });

        pactl.on('close', (code) => {
            if (code !== 0) {
                logger.error('pactl command failed - is PulseAudio installed?');
                resolve(false);
                return;
            }

            if (output.includes(sinkName)) {
                logger.info('PulseAudio sink found', { sinkName });
                resolve(true);
            } else {
                logger.error('PulseAudio sink not found', { sinkName, available: output });
                resolve(false);
            }
        });

        pactl.on('error', () => {
            logger.error('pactl not found - is PulseAudio installed?');
            resolve(false);
        });
    });
}
