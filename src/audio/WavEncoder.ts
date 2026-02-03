/**
 * WAV Encoder for Audio Chunks (Phase 3)
 *
 * Encodes Float32 PCM audio data to WAV format with:
 * - Little Endian byte order (explicitly enforced)
 * - 16-bit signed integer samples
 * - Mono channel (1 channel)
 * - Configurable sample rate (default 48000Hz)
 *
 * Maximum file size constraint: 15MB (Mizan API limit)
 */

import { createLogger } from "../logger";

const logger = createLogger("WavEncoder");

/**
 * WAV file metadata embedded in the chunk.
 */
export interface WavMetadata {
  chunkId: string;
  agentId: string;
  timestamp: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Maximum WAV file size (15MB - some buffer for headers)
 */
const MAX_WAV_SIZE_BYTES = 15 * 1024 * 1024 - 1024; // ~15MB with buffer

/**
 * WAV header size in bytes
 */
const WAV_HEADER_SIZE = 44;

/**
 * Encodes Float32 PCM samples to WAV format with Little Endian encoding.
 *
 * @param samples Float32Array of audio samples (-1.0 to 1.0)
 * @param metadata WAV metadata
 * @returns ArrayBuffer containing the WAV file
 */
export function encodeWav(
  samples: Float32Array,
  metadata: WavMetadata,
): ArrayBuffer {
  const { sampleRate, channels, bitsPerSample } = metadata;

  // Validate inputs
  if (bitsPerSample !== 16) {
    throw new Error("Only 16-bit samples are supported");
  }
  if (channels !== 1) {
    throw new Error("Only mono audio is supported");
  }

  // Calculate sizes
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = WAV_HEADER_SIZE + dataSize;

  // Check max size
  if (fileSize > MAX_WAV_SIZE_BYTES) {
    logger.warn("WAV file exceeds max size, truncating", {
      originalSize: fileSize,
      maxSize: MAX_WAV_SIZE_BYTES,
    });
    // Calculate max samples we can include
    const maxSamples = Math.floor(
      (MAX_WAV_SIZE_BYTES - WAV_HEADER_SIZE) / bytesPerSample,
    );
    samples = samples.slice(0, maxSamples);
  }

  // Recalculate after potential truncation
  const actualDataSize = samples.length * bytesPerSample;
  const actualFileSize = WAV_HEADER_SIZE + actualDataSize;

  // Create buffer
  const buffer = new ArrayBuffer(actualFileSize);
  const view = new DataView(buffer);

  // Write WAV header (44 bytes)
  writeWavHeader(view, {
    sampleRate,
    channels,
    bitsPerSample,
    dataSize: actualDataSize,
  });

  // Write audio data as 16-bit signed integers (Little Endian)
  writeAudioData(view, samples, WAV_HEADER_SIZE);

  logger.debug("WAV encoded", {
    chunkId: metadata.chunkId,
    samples: samples.length,
    durationMs: metadata.durationMs.toFixed(0),
    fileSize: actualFileSize,
  });

  return buffer;
}

/**
 * Writes the WAV file header.
 * Uses Little Endian byte order for all multi-byte values.
 */
function writeWavHeader(
  view: DataView,
  params: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    dataSize: number;
  },
): void {
  const { sampleRate, channels, bitsPerSample, dataSize } = params;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  let offset = 0;

  // RIFF header
  // "RIFF" chunk descriptor
  writeString(view, offset, "RIFF");
  offset += 4;

  // File size - 8 (RIFF + size field)
  view.setUint32(offset, 36 + dataSize, true); // Little Endian
  offset += 4;

  // "WAVE" format
  writeString(view, offset, "WAVE");
  offset += 4;

  // "fmt " sub-chunk
  writeString(view, offset, "fmt ");
  offset += 4;

  // Sub-chunk size (16 for PCM)
  view.setUint32(offset, 16, true); // Little Endian
  offset += 4;

  // Audio format (1 = PCM)
  view.setUint16(offset, 1, true); // Little Endian
  offset += 2;

  // Number of channels
  view.setUint16(offset, channels, true); // Little Endian
  offset += 2;

  // Sample rate
  view.setUint32(offset, sampleRate, true); // Little Endian
  offset += 4;

  // Byte rate
  view.setUint32(offset, byteRate, true); // Little Endian
  offset += 4;

  // Block align
  view.setUint16(offset, blockAlign, true); // Little Endian
  offset += 2;

  // Bits per sample
  view.setUint16(offset, bitsPerSample, true); // Little Endian
  offset += 2;

  // "data" sub-chunk
  writeString(view, offset, "data");
  offset += 4;

  // Data size
  view.setUint32(offset, dataSize, true); // Little Endian
}

/**
 * Writes a string to the DataView at the specified offset.
 */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Writes Float32 audio samples as 16-bit signed integers (Little Endian).
 * Clamps values to prevent overflow.
 */
function writeAudioData(
  view: DataView,
  samples: Float32Array,
  offset: number,
): void {
  for (let i = 0; i < samples.length; i++) {
    // Clamp to [-1, 1]
    const sample = Math.max(-1, Math.min(1, samples[i]));

    // Convert to 16-bit signed integer
    // Scale: -1.0 -> -32768, 1.0 -> 32767
    const int16 =
      sample < 0 ? Math.floor(sample * 32768) : Math.floor(sample * 32767);

    // Write as Little Endian
    view.setInt16(offset + i * 2, int16, true);
  }
}

/**
 * Validates a WAV buffer by checking the header.
 * Returns true if the buffer appears to be a valid WAV file.
 */
export function validateWav(buffer: ArrayBuffer): {
  valid: boolean;
  error?: string;
  info?: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    duration: number;
  };
} {
  if (buffer.byteLength < WAV_HEADER_SIZE) {
    return { valid: false, error: "Buffer too small for WAV header" };
  }

  const view = new DataView(buffer);

  // Check RIFF header
  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (riff !== "RIFF") {
    return { valid: false, error: `Invalid RIFF header: ${riff}` };
  }

  // Check WAVE format
  const wave = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11),
  );
  if (wave !== "WAVE") {
    return { valid: false, error: `Invalid WAVE format: ${wave}` };
  }

  // Check fmt chunk
  const fmt = String.fromCharCode(
    view.getUint8(12),
    view.getUint8(13),
    view.getUint8(14),
    view.getUint8(15),
  );
  if (fmt !== "fmt ") {
    return { valid: false, error: `Invalid fmt chunk: ${fmt}` };
  }

  // Read format info
  const audioFormat = view.getUint16(20, true);
  if (audioFormat !== 1) {
    return { valid: false, error: `Unsupported audio format: ${audioFormat}` };
  }

  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);

  const duration = dataSize / (sampleRate * channels * (bitsPerSample / 8));

  return {
    valid: true,
    info: {
      sampleRate,
      channels,
      bitsPerSample,
      duration,
    },
  };
}

/**
 * Generates a test tone WAV for validation purposes.
 * Creates a 440Hz sine wave at the specified duration.
 */
export function generateTestTone(
  durationMs: number,
  sampleRate: number = 48000,
  frequency: number = 440,
): { samples: Float32Array; wavBuffer: ArrayBuffer } {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(numSamples);

  // Generate sine wave
  const angularFreq = 2 * Math.PI * frequency;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    samples[i] = Math.sin(angularFreq * t) * 0.5; // 50% amplitude
  }

  const metadata: WavMetadata = {
    chunkId: "test-tone",
    agentId: "test",
    timestamp: Date.now(),
    durationMs,
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
  };

  const wavBuffer = encodeWav(samples, metadata);

  return { samples, wavBuffer };
}
