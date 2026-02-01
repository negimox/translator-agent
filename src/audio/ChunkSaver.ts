/**
 * Chunk Saver for debugging.
 * 
 * Saves WAV chunks to disk for testing and validation.
 * Only enabled when DEBUG_SAVE_CHUNKS=true.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WAVEncoder } from './WAVEncoder';
import { createLogger } from '../logger';

const logger = createLogger('ChunkSaver');

export class ChunkSaver {
    private outputDir: string;
    private encoder: WAVEncoder;
    private chunkCount: number = 0;
    private enabled: boolean;

    constructor(outputDir: string = './debug_chunks', sampleRate: number = 16000) {
        this.outputDir = outputDir;
        this.encoder = new WAVEncoder(sampleRate);
        this.enabled = process.env.DEBUG_SAVE_CHUNKS === 'true';

        if (this.enabled) {
            // Create output directory if it doesn't exist
            if (!fs.existsSync(this.outputDir)) {
                fs.mkdirSync(this.outputDir, { recursive: true });
            }
            logger.info('ChunkSaver enabled', { outputDir: this.outputDir });
        }
    }

    /**
     * Saves a chunk to disk as a WAV file.
     * Only saves if DEBUG_SAVE_CHUNKS=true.
     */
    saveChunk(samples: Float32Array, metadata: { chunkId: number; durationMs: number }): void {
        if (!this.enabled) return;

        try {
            const filename = `chunk_${String(metadata.chunkId).padStart(4, '0')}_${metadata.durationMs.toFixed(0)}ms.wav`;
            const filepath = path.join(this.outputDir, filename);
            
            const wavBuffer = this.encoder.encodeToBuffer(samples);
            fs.writeFileSync(filepath, Buffer.from(wavBuffer));
            
            this.chunkCount++;
            logger.info('Chunk saved', { 
                filename, 
                samples: samples.length,
                durationMs: metadata.durationMs.toFixed(0),
                totalChunks: this.chunkCount 
            });
        } catch (error) {
            logger.error('Failed to save chunk', { error });
        }
    }

    /**
     * Clears all saved chunks.
     */
    clearChunks(): void {
        if (!this.enabled) return;

        try {
            const files = fs.readdirSync(this.outputDir);
            for (const file of files) {
                if (file.endsWith('.wav')) {
                    fs.unlinkSync(path.join(this.outputDir, file));
                }
            }
            this.chunkCount = 0;
            logger.info('Cleared all saved chunks');
        } catch (error) {
            logger.error('Failed to clear chunks', { error });
        }
    }

    getChunkCount(): number {
        return this.chunkCount;
    }

    isEnabled(): boolean {
        return this.enabled;
    }
}
