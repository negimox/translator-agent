/**
 * Index exports for the audio module.
 *
 * Phase 3 additions:
 * - ChunkAggregator: VAD-driven audio chunking
 * - WavEncoder: Float32 to WAV encoding
 * - AudioBridge: Node.js ↔ Browser audio bridge
 */

// Phase 2 components
export { AudioManager, AudioHealth } from "./AudioContextManager";
export { HeartbeatMonitor } from "./HeartbeatMonitor";

// Phase 3 components
export {
  ChunkAggregator,
  AudioChunk,
  AudioFrame,
  ChunkAggregatorConfig,
  DEFAULT_CHUNK_CONFIG,
} from "./ChunkAggregator";
export {
  encodeWav,
  validateWav,
  generateTestTone,
  WavMetadata,
} from "./WavEncoder";
export {
  AudioBridge,
  AudioBridgeConfig,
  DEFAULT_BRIDGE_CONFIG,
} from "./AudioBridge";
