/**
 * Chunk Handler for Translator Agent.
 * 
 * Receives audio chunks from AudioWorklet (already resampled to 16kHz),
 * encodes them to WAV, and invokes callback for Phase 4 STT integration.
 */

import { WAVEncoder } from './WAVEncoder';
import { createLogger } from '../logger';

const logger = createLogger('ChunkHandler');

/**
 * Metadata attached to each audio chunk.
 */
export interface ChunkMetadata {
    chunkId: string;
    timestamp: number;
    agentId: string;
    durationMs: number;
    sampleRate: number;
}

/**
 * Data received from AudioWorklet.
 */
export interface WorkletChunkData {
    type: 'chunk';
    chunkId: number;
    samples: ArrayBuffer;
    sampleRate: number;
    timestamp: number;
    durationMs: number;
}

/**
 * Callback signature for when a WAV chunk is ready.
 */
export type OnChunkReady = (wav: Blob, metadata: ChunkMetadata) => void;

/**
 * Handles audio chunks received from the AudioWorklet.
 */
export class ChunkHandler {
    private agentId: string;
    private encoder: WAVEncoder;
    private onChunkReady: OnChunkReady;
    private chunkCount: number = 0;

    constructor(agentId: string, sampleRate: number, onChunkReady: OnChunkReady) {
        this.agentId = agentId;
        this.encoder = new WAVEncoder(sampleRate);
        this.onChunkReady = onChunkReady;

        logger.info('ChunkHandler initialized', { agentId, sampleRate });
    }

    /**
     * Handles a chunk received from the AudioWorklet.
     * Chunks are already resampled to target rate (16kHz).
     */
    handleChunk(data: WorkletChunkData): void {
        this.chunkCount++;
        
        const samples = new Float32Array(data.samples);
        
        logger.debug('Processing chunk', {
            chunkId: data.chunkId,
            samples: samples.length,
            durationMs: data.durationMs,
        });

        // Encode to WAV
        const wav = this.encoder.encode(samples);

        // Build metadata
        const metadata: ChunkMetadata = {
            chunkId: `${this.agentId}-${data.chunkId}`,
            timestamp: data.timestamp,
            agentId: this.agentId,
            durationMs: data.durationMs,
            sampleRate: data.sampleRate,
        };

        // Check chunk size (must be ≤ 15MB for Mizan STT)
        if (wav.size > 15 * 1024 * 1024) {
            logger.warn('Chunk exceeds 15MB limit', {
                chunkId: metadata.chunkId,
                size: wav.size,
            });
        }

        logger.debug('Chunk ready', {
            chunkId: metadata.chunkId,
            wavSize: wav.size,
            durationMs: metadata.durationMs,
        });

        // Invoke callback
        this.onChunkReady(wav, metadata);
    }

    /**
     * Gets the number of chunks processed.
     */
    getChunkCount(): number {
        return this.chunkCount;
    }
}
