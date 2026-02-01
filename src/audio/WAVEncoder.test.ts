/**
 * WAV Encoder Unit Tests
 * 
 * Validates:
 * - Little Endian byte order in header
 * - Float32 to Int16 conversion
 * - WAV structure validation
 */

import { WAVEncoder } from './WAVEncoder';

describe('WAVEncoder', () => {
    let encoder: WAVEncoder;

    beforeEach(() => {
        encoder = new WAVEncoder(16000);
    });

    describe('encodeToBuffer', () => {
        it('should create valid WAV header', () => {
            const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
            const buffer = encoder.encodeToBuffer(samples);
            
            expect(buffer.byteLength).toBe(44 + samples.length * 2); // header + data
            
            const view = new DataView(buffer);
            
            // RIFF header
            expect(String.fromCharCode(view.getUint8(0))).toBe('R');
            expect(String.fromCharCode(view.getUint8(1))).toBe('I');
            expect(String.fromCharCode(view.getUint8(2))).toBe('F');
            expect(String.fromCharCode(view.getUint8(3))).toBe('F');
            
            // WAVE format
            expect(String.fromCharCode(view.getUint8(8))).toBe('W');
            expect(String.fromCharCode(view.getUint8(9))).toBe('A');
            expect(String.fromCharCode(view.getUint8(10))).toBe('V');
            expect(String.fromCharCode(view.getUint8(11))).toBe('E');
            
            // fmt chunk
            expect(String.fromCharCode(view.getUint8(12))).toBe('f');
            expect(String.fromCharCode(view.getUint8(13))).toBe('m');
            expect(String.fromCharCode(view.getUint8(14))).toBe('t');
            expect(String.fromCharCode(view.getUint8(15))).toBe(' ');
        });

        it('should use Little Endian for numeric fields', () => {
            const samples = new Float32Array(100);
            const buffer = encoder.encodeToBuffer(samples);
            const view = new DataView(buffer);
            
            // Sample rate at offset 24 (Little Endian)
            const sampleRate = view.getUint32(24, true);
            expect(sampleRate).toBe(16000);
            
            // Bits per sample at offset 34 (Little Endian)
            const bitsPerSample = view.getUint16(34, true);
            expect(bitsPerSample).toBe(16);
            
            // Num channels at offset 22 (Little Endian)
            const numChannels = view.getUint16(22, true);
            expect(numChannels).toBe(1); // Mono
        });

        it('should convert Float32 to Int16 correctly', () => {
            // Test boundary values
            const samples = new Float32Array([0, 1, -1, 0.5, -0.5]);
            const buffer = encoder.encodeToBuffer(samples);
            const view = new DataView(buffer);
            
            // Audio data starts at offset 44
            const sample0 = view.getInt16(44, true);
            const sample1 = view.getInt16(46, true);
            const sample2 = view.getInt16(48, true);
            const sample3 = view.getInt16(50, true);
            const sample4 = view.getInt16(52, true);
            
            expect(sample0).toBe(0);           // 0 -> 0
            expect(sample1).toBe(32767);       // 1 -> max positive
            expect(sample2).toBe(-32768);      // -1 -> max negative
            expect(Math.abs(sample3 - 16383)).toBeLessThan(2); // 0.5 -> ~half max
            expect(Math.abs(sample4 + 16384)).toBeLessThan(2); // -0.5 -> ~half min
        });

        it('should clamp out-of-range values', () => {
            const samples = new Float32Array([2, -2, 100, -100]);
            const buffer = encoder.encodeToBuffer(samples);
            const view = new DataView(buffer);
            
            // Should be clamped to max/min Int16
            const sample0 = view.getInt16(44, true);
            const sample1 = view.getInt16(46, true);
            
            expect(sample0).toBe(32767);  // Clamped to max
            expect(sample1).toBe(-32768); // Clamped to min
        });
    });

    describe('encode', () => {
        it('should return a Blob with audio/wav type', () => {
            const samples = new Float32Array([0, 0.5, -0.5]);
            const blob = encoder.encode(samples);
            
            expect(blob).toBeInstanceOf(Blob);
            expect(blob.type).toBe('audio/wav');
            expect(blob.size).toBe(44 + samples.length * 2);
        });
    });

    describe('validate', () => {
        it('should return true for valid WAV', () => {
            const samples = new Float32Array([0, 0.5, -0.5]);
            const buffer = encoder.encodeToBuffer(samples);
            
            expect(WAVEncoder.validate(buffer)).toBe(true);
        });

        it('should return false for invalid buffer', () => {
            const invalidBuffer = new ArrayBuffer(10);
            expect(WAVEncoder.validate(invalidBuffer)).toBe(false);
        });

        it('should return false for non-RIFF header', () => {
            const buffer = new ArrayBuffer(44);
            const view = new DataView(buffer);
            view.setUint8(0, 'X'.charCodeAt(0)); // Not 'R'
            
            expect(WAVEncoder.validate(buffer)).toBe(false);
        });
    });

    describe('known tone test', () => {
        it('should encode 1kHz sine wave correctly', () => {
            // Generate 1 second of 1kHz sine wave at 16kHz
            const sampleRate = 16000;
            const duration = 1; // seconds
            const frequency = 1000; // Hz
            const numSamples = sampleRate * duration;
            const samples = new Float32Array(numSamples);
            
            for (let i = 0; i < numSamples; i++) {
                samples[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate);
            }
            
            const buffer = encoder.encodeToBuffer(samples);
            
            // Verify header
            expect(WAVEncoder.validate(buffer)).toBe(true);
            
            // Verify size
            expect(buffer.byteLength).toBe(44 + numSamples * 2);
            
            // Verify data chunk size
            const view = new DataView(buffer);
            const dataSize = view.getUint32(40, true);
            expect(dataSize).toBe(numSamples * 2);
        });
    });
});
