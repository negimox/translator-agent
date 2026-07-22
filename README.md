# Jitsi Translator Agent

A headless Chromium-based translator agent for Jitsi Meet live audio translation.

## Overview

This agent joins Jitsi meetings as a special participant (`translator-<lang>`) and provides the infrastructure for capturing audio, processing it through STT/Translation/TTS, and publishing translated audio back to the meeting.

## Features

### Phase 7.1 (Completed) - ElevenLabs Integration

- **Multi-Provider Architecture**: Abstraction layer supporting multiple STT/TTS/Translation providers
- **ElevenLabs STT**: Scribe v2 for speech-to-text (90+ languages including Arabic and Urdu)
- **ElevenLabs TTS**: High-quality text-to-speech with voice selection per language
- **Extended Language Support**: Added Arabic (ar) and Urdu (ur) to existing English/Hindi
- **Hybrid Pipeline**: ElevenLabs for STT/TTS, Mizan for translation
- **Backward Compatibility**: Legacy Mizan-only mode still supported

### Phase 2 (Completed)

- **Headless Chrome**: Puppeteer-controlled Chrome with proper WebRTC support
- **AudioWorklet**: Low-latency audio capture with inline worklet code
- **Health Monitoring**: HTTP endpoints for Kubernetes liveness/readiness probes
- **GC Prevention**: Strong references to audio nodes prevent garbage collection
- **Loop Prevention**: Agents never subscribe to other translator participants

### Phase 3 (Completed)

- **VAD (Voice Activity Detection)**: RMS-based energy detection in AudioWorklet
- **Chunk Aggregation**: VAD-driven chunking with configurable timing
- **WAV Encoding**: Float32 to 16-bit Little Endian WAV encoding
- **Audio Bridge**: Node.js ↔ Browser communication via Puppeteer
- **Debug Mode**: Save chunks to disk for validation testing

## Quick Start

1. **Install dependencies**:

   ```bash
   npm install
   ```

2. **Configure environment**:

   ```bash
   cp .env.example .env
   # Edit .env with your Jitsi server details
   ```

3. **Start the agent**:

   ```bash
   npm start
   ```

## Environment Variables

### Required

| Variable       | Description                                         |
| -------------- | --------------------------------------------------- |
| `JITSI_DOMAIN` | Jitsi server domain (e.g., `meet.zaryans.net:8443`) |
| `ROOM_NAME`    | Meeting room to join                                |

### Optional - General

| Variable          | Default | Description                                                |
| ----------------- | ------- | ---------------------------------------------------------- |
| `TARGET_LANGUAGE` | `en`    | Language code for this agent (`en`, `hi`, `ar`, `ur`)      |
| `SOURCE_LANGUAGE` | `en`    | Source language for STT (auto-detect if not specified)     |
| `HEALTH_PORT`     | `8080`  | Health check server port                                   |
| `CHROME_HEADLESS` | `true`  | Run Chrome in headless mode                                |
| `LOG_LEVEL`       | `info`  | Logging level (`debug`, `info`, `warn`, `error`)           |

### Optional - VAD (Phase 3)

| Variable                  | Default | Description                               |
| ------------------------- | ------- | ----------------------------------------- |
| `VAD_RMS_THRESHOLD`       | `0.01`  | RMS threshold for voice detection (-40dB) |
| `VAD_SMOOTHING_FRAMES`    | `3`     | Frames for VAD smoothing                  |
| `VAD_SILENCE_COALESCE_MS` | `250`   | Max silence to coalesce (ms)              |

### Optional - Chunk Aggregation (Phase 3)

| Variable                   | Default | Description                 |
| -------------------------- | ------- | --------------------------- |
| `TARGET_CHUNK_DURATION_MS` | `900`   | Target chunk duration (ms)  |
| `MIN_CHUNK_DURATION_MS`    | `300`   | Minimum chunk duration (ms) |
| `MAX_CHUNK_DURATION_MS`    | `3000`  | Maximum chunk duration (ms) |
| `AUDIO_SAMPLE_RATE`        | `48000` | Audio sample rate (Hz)      |

### Optional - Debug (Phase 3)

| Variable           | Default          | Description                |
| ------------------ | ---------------- | -------------------------- |
| `DEBUG_MODE`       | `false`          | Enable debug chunk saving  |
| `DEBUG_OUTPUT_DIR` | `./debug_chunks` | Directory for debug chunks |
| `MAX_DEBUG_CHUNKS` | `100`            | Max debug chunks to save   |

### Optional - ElevenLabs API (Phase 7.1)

| Variable                  | Default                           | Description                                  |
| ------------------------- | --------------------------------- | -------------------------------------------- |
| `ELEVENLABS_API_KEY`      | *(required for Phase 7.1)*        | ElevenLabs API key for STT/TTS               |
| `ELEVENLABS_BASE_URL`     | `https://api.elevenlabs.io/v1`    | ElevenLabs API base URL                      |
| `ELEVENLABS_TIMEOUT_MS`   | `30000`                           | API request timeout in milliseconds          |

### Optional - Mizan API (Phase 4, Translation only in Phase 7.1+)

| Variable                        | Default                                    | Description                                  |
| ------------------------------- | ------------------------------------------ | -------------------------------------------- |
| `MIZAN_BASE_URL`                | `https://platform.mizanlabs.com/api/v1`    | Mizan API base URL                           |
| `MIZAN_USERNAME`                | *(required)*                               | Mizan API username (Basic Auth)              |
| `MIZAN_PASSWORD`                | *(required)*                               | Mizan API password (Basic Auth)              |
| `MIZAN_TIMEOUT_MS`              | `30000`                                    | API request timeout in milliseconds          |
| `TRANSLATION_TEMPLATE_PATTERN`  | `translator_{target}`                      | Translation template name pattern            |

## Health Endpoints

- `GET /healthz` - Liveness probe (is Chrome running?)
- `GET /readyz` - Readiness probe (is agent ready to process audio?)
- `GET /status` - Detailed health status including audio metrics

## Multi-Agent Deployment

To run multiple translator agents (one per language):

```bash
# Agent for English
TARGET_LANGUAGE=en ROOM_NAME=test HEALTH_PORT=8080 npm start

# Agent for Hindi (in separate terminal/container)
TARGET_LANGUAGE=hi ROOM_NAME=test HEALTH_PORT=8081 npm start

# Agent for Arabic (Phase 7.1+)
TARGET_LANGUAGE=ar ROOM_NAME=test HEALTH_PORT=8082 npm start

# Agent for Urdu (Phase 7.1+)
TARGET_LANGUAGE=ur ROOM_NAME=test HEALTH_PORT=8083 npm start
```

## Supported Languages (Phase 7.1)

| Language | Code | STT Support | Translation Support | TTS Support | Voice |
|----------|------|-------------|-------------------|-------------|-------|
| English  | `en` | ✅ ElevenLabs | ✅ Mizan | ✅ ElevenLabs | Roger (Flash v2.5) |
| Hindi    | `hi` | ✅ ElevenLabs | ✅ Mizan | ✅ ElevenLabs | Nichalia (Flash v2.5) |
| Arabic   | `ar` | ✅ ElevenLabs | ✅ Mizan | ✅ ElevenLabs | Sarah (Multilingual v2) |
| Urdu     | `ur` | ✅ ElevenLabs | ✅ Mizan | ✅ ElevenLabs | Sarah (eleven_v3) |

**Note:** When `ELEVENLABS_API_KEY` is provided, the agent uses ElevenLabs for STT/TTS and Mizan for translation. Without the key, it falls back to Mizan-only mode (English and Hindi only).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Translator Agent                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Chrome       │  │ Audio        │  │ Health       │              │
│  │ Launcher     │  │ Manager      │  │ Server       │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│         │                  │                  │                     │
│         │           ┌──────┴──────┐           │                     │
│         │           │ Audio Bridge │           │  ◄─── Phase 3      │
│         │           │ (VAD+Chunks) │           │                     │
│         │           └──────┬──────┘           │                     │
│         │                  │                  │                     │
│         ▼                  ▼                  ▼                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     Puppeteer Page                            │  │
│  │  ┌────────────┐  ┌────────────────┐  ┌────────────────┐      │  │
│  │  │ Jitsi Meet │  │ AudioWorklet   │  │ MediaStream    │      │  │
│  │  │ (bot.js)   │  │ (VAD+Capture)  │  │ Destination    │      │  │
│  │  └────────────┘  └────────────────┘  └────────────────┘      │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Phase 3: Audio Capture & Chunk Aggregation

### How it works

1. **AudioWorklet** runs in the browser's audio thread, capturing 128-sample frames at 48kHz
2. **VAD (Voice Activity Detection)** calculates RMS energy and detects speech using configurable threshold
3. **Chunk Aggregator** collects frames during speech, coalescing short silences
4. When speech ends (silence > 250ms) or max duration reached, chunk is emitted
5. **WAV Encoder** converts Float32 samples to 16-bit Little Endian WAV format
6. Chunk is passed to Node.js via `page.exposeFunction()` for further processing

### Loop Prevention

Translator agents exclude each other from audio capture:

- Bot checks participant display names on join
- Participants starting with `translator-` are added to exclusion list
- Audio tracks from excluded participants are never connected to the capture worklet

### Debug Mode

Enable `DEBUG_MODE=true` to save audio chunks to disk:

```bash
DEBUG_MODE=true DEBUG_OUTPUT_DIR=./debug_chunks npm start
```

Each chunk saves as:

- `chunk_<id>.wav` - The audio data
- `chunk_<id>.json` - Metadata including validation results

A test tone file is also generated on startup for WAV format validation.

## Integration with Phase 1

The frontend (jitsi-meet) finds this agent by looking for participants with display name `translator-<lang>` and subscribes to their audio using `setReceiverConstraints()`.

## Chrome Flags

The agent uses these critical Chrome flags:

- `--autoplay-policy=no-user-gesture-required` - Enable AudioContext without user gesture
- `--use-fake-ui-for-media-stream` - Auto-allow getUserMedia in headless mode
- `--use-fake-device-for-media-stream` - Fake devices for headless environment
- `--headless=new` - Headless Chrome mode

## Development

```bash
# Run in development mode (non-headless with debug)
CHROME_HEADLESS=false DEBUG_MODE=true LOG_LEVEL=debug npm run dev

# Build
npm run build

# Lint
npm run lint
```

## Next Steps (Phase 4)

- Mizan API integration (STT → Translation → TTS)
- Rate limiting with token bucket
- Adaptive chunk sizing under load

## License

Apache-2.0
