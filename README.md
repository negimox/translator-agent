# Jitsi Translator Agent

A headless Chromium-based translator agent for Jitsi Meet live audio translation.

## Overview

This agent joins Jitsi meetings as a special participant (`translator-<lang>`) and provides the infrastructure for capturing audio, processing it through STT/Translation/TTS (Phase 4-5), and publishing translated audio back to the meeting.

## Features

- **Headless Chrome**: Puppeteer-controlled Chrome with proper WebRTC support
- **AudioWorklet**: Low-latency audio capture with inline worklet code
- **Health Monitoring**: HTTP endpoints for Kubernetes liveness/readiness probes
- **GC Prevention**: Strong references to audio nodes prevent garbage collection
- **Loop Prevention**: Agents never subscribe to other translator participants

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

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JITSI_DOMAIN` | Yes | - | Jitsi server domain (e.g., `meet.zaryans.net:8443`) |
| `ROOM_NAME` | Yes | - | Meeting room to join |
| `TARGET_LANGUAGE` | No | `en` | Language code for this agent (`en`, `hi`) |
| `HEALTH_PORT` | No | `8080` | Health check server port |
| `CHROME_HEADLESS` | No | `true` | Run Chrome in headless mode |
| `LOG_LEVEL` | No | `info` | Logging level (`debug`, `info`, `warn`, `error`) |

## Health Endpoints

- `GET /healthz` - Liveness probe (is Chrome running?)
- `GET /readyz` - Readiness probe (is agent ready to process audio?)
- `GET /status` - Detailed health status

## Multi-Agent Deployment

To run multiple translator agents (one per language):

```bash
# Agent for English
TARGET_LANGUAGE=en ROOM_NAME=test HEALTH_PORT=8080 npm start

# Agent for Hindi (in separate terminal/container)
TARGET_LANGUAGE=hi ROOM_NAME=test HEALTH_PORT=8081 npm start
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Translator Agent                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Chrome       │  │ Audio        │  │ Health       │      │
│  │ Launcher     │  │ Manager      │  │ Server       │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                  │                  │             │
│         ▼                  ▼                  ▼             │
│  ┌──────────────────────────────────────────────────┐      │
│  │                 Puppeteer Page                    │      │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  │      │
│  │  │ Jitsi Meet │  │ Audio      │  │ MediaStream│  │      │
│  │  │ App        │  │ Worklets   │  │ Destination│  │      │
│  │  └────────────┘  └────────────┘  └────────────┘  │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## Integration with Phase 1

The frontend (jitsi-meet) finds this agent by looking for participants with display name `translator-<lang>` and subscribes to their audio using `setReceiverConstraints()`.

## Chrome Flags

The agent uses these critical Chrome flags:

- `--autoplay-policy=no-user-gesture-required` - Enable AudioContext without user gesture
- `--use-fake-ui-for-media-stream` - Auto-allow getUserMedia in headless mode
- `--headless=new` - Headless Chrome mode

## Development

```bash
# Run in development mode (non-headless)
CHROME_HEADLESS=false npm run dev

# Build
npm run build

# Lint
npm run lint
```

## License

Apache-2.0
