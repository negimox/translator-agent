/**
 * WAV Encoder for Translator Agent.
 * 
 * Converts Float32 audio samples to Little Endian WAV format for STT upload.
 * Target: 16kHz mono audio.
 */

/**
 * Encodes Float32 samples to WAV format.
 */
export class WAVEncoder {
    private sampleRate: number;

    constructor(sampleRate: number = 16000) {
        this.sampleRate = sampleRate;
    }

    /**
     * Encodes Float32 samples to WAV Blob.
     * @param samples - Float32Array of audio samples (normalized -1 to 1)
     * @returns Blob containing WAV data
     */
    encode(samples: Float32Array): Blob {
        const buffer = this.encodeToBuffer(samples);
        return new Blob([buffer], { type: 'audio/wav' });
    }

    /**
     * Encodes Float32 samples to WAV ArrayBuffer.
     * @param samples - Float32Array of audio samples (normalized -1 to 1)
     * @returns ArrayBuffer containing WAV data
     */
    encodeToBuffer(samples: Float32Array): ArrayBuffer {
        const numChannels = 1; // Mono
        const bitsPerSample = 16;
        const bytesPerSample = bitsPerSample / 8;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = this.sampleRate * blockAlign;
        const dataSize = samples.length * bytesPerSample;
        const headerSize = 44;
        const totalSize = headerSize + dataSize;

        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);

        // RIFF header
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, totalSize - 8, true); // Little Endian
        this.writeString(view, 8, 'WAVE');

        // fmt chunk
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
        view.setUint16(20, 1, true);  // AudioFormat (1 = PCM)
        view.setUint16(22, numChannels, true);
        view.setUint32(24, this.sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);

        // data chunk
        this.writeString(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        // Audio data: Float32 [-1, 1] -> Int16 [-32768, 32767]
        let offset = 44;
        for (let i = 0; i < samples.length; i++) {
            // Clamp to [-1, 1]
            let sample = Math.max(-1, Math.min(1, samples[i]));
            // Scale to Int16 range
            let int16Sample = sample < 0 
                ? sample * 0x8000 
                : sample * 0x7FFF;
            // Little Endian
            view.setInt16(offset, int16Sample, true);
            offset += 2;
        }

        return buffer;
    }

    /**
     * Writes an ASCII string to the DataView.
     */
    private writeString(view: DataView, offset: number, str: string): void {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    /**
     * Validates a WAV buffer structure.
     * @returns true if valid WAV, false otherwise
     */
    static validate(buffer: ArrayBuffer): boolean {
        if (buffer.byteLength < 44) return false;

        const view = new DataView(buffer);
        
        // Check RIFF header
        const riff = String.fromCharCode(
            view.getUint8(0), view.getUint8(1), 
            view.getUint8(2), view.getUint8(3)
        );
        if (riff !== 'RIFF') return false;

        // Check WAVE format
        const wave = String.fromCharCode(
            view.getUint8(8), view.getUint8(9),
            view.getUint8(10), view.getUint8(11)
        );
        if (wave !== 'WAVE') return false;

        // Check fmt chunk
        const fmt = String.fromCharCode(
            view.getUint8(12), view.getUint8(13),
            view.getUint8(14), view.getUint8(15)
        );
        if (fmt !== 'fmt ') return false;

        return true;
    }
}
