# ElevenLabs WebSocket STT Connection Fix

## Problem Identified

The ElevenLabs Realtime STT WebSocket was closing after ~15 seconds with code 1000 (normal closure) due to **inactivity timeout**. Analysis of logs revealed:

- WebSocket connected successfully at 16:17:10.544Z
- AudioBridge was receiving audio frames (1000 frames by 16:17:19.269Z)
- WebSocket closed at 16:17:25.570Z (~15 seconds after connection)
- **NO evidence of audio being sent to the WebSocket**

### Root Cause

The WebSocket wasn't broken - it was closing because **no audio data was being sent to ElevenLabs**, triggering their inactivity timeout (typically 20 seconds for similar endpoints).

The audio pipeline had a silent failure somewhere in the chain:
```
AudioBridge → TranslatorAgent.handleAudioChunk() → TranslationPipeline.submitAudio() → ElevenLabsRealtimeSTT.sendAudio() → WebSocket
```

## Solution Implemented

### 1. Enhanced Logging & Diagnostics (`ElevenLabsRealtimeSTT.ts`)

**Added:**
- Audio chunk counter (`audioChunksSent`)
- Last audio sent timestamp tracking (`lastAudioSentAt`)
- Detailed logging in `sendAudio()` method:
  - Logs every 100 chunks sent (appears ~every 10 seconds with 100ms buffers)
  - Shows chunk size and total count
  - Logs WebSocket state when audio cannot be sent

**Why:** This will immediately reveal if audio is flowing through the pipeline or where it stops.

### 2. Automatic Reconnection with Exponential Backoff

**Added:**
- `autoReconnect` configuration (default: true)
- `maxReconnectAttempts` (default: 10)
- `reconnectDelayMs` (default: 1000ms, increases exponentially)
- `maxReconnectDelayMs` (default: 30000ms cap)

**Behavior:**
- When WebSocket closes unexpectedly, automatically attempts to reconnect
- Delay pattern: 1s → 2s → 4s → 8s → 16s → 30s (capped)
- Stops after 10 failed attempts to prevent infinite loops
- Emits `reconnected` event when successful

**Why:** Provides resilience against temporary network issues or server-side closures while preventing translation loss during conferences.

### 3. Connection State Management

**Added:**
- `intentionalClose` flag to distinguish user-initiated vs unexpected closures
- Enhanced close event logging showing:
  - Total audio chunks sent
  - Time since last audio
  - Whether close was intentional
  - Close code and reason

**Added Method:**
- `isConnected()` - Check current WebSocket state

**Why:** Enables proper debugging and prevents reconnection loops on intentional shutdowns.

### 4. TranslationPipeline Integration (`TranslationPipeline.ts`)

**Added Event Handlers:**
- `sttProvider.on("close")` → `handleSTTClose()`
- `sttProvider.on("reconnected")` → `handleSTTReconnected()`

**Behavior:**
- Logs STT disconnection/reconnection with pipeline metrics
- Emits `stt_disconnected` and `stt_reconnected` events for TranslatorAgent
- Maintains conversation context and state during reconnections

**Why:** Ensures the translation pipeline gracefully handles WebSocket reconnections without losing translation state or conversation context.

## Expected Behavior After Fix

### Scenario 1: Audio is Flowing (Normal Operation)
```
16:17:10.544Z - Connected to ElevenLabs Realtime STT
16:17:16.XXX - Audio chunks sent to ElevenLabs STT (totalChunks: 100)
16:17:22.XXX - Audio chunks sent to ElevenLabs STT (totalChunks: 200)
...continuous operation...
```

### Scenario 2: No Audio Being Sent (Diagnosis)
```
16:17:10.544Z - Connected to ElevenLabs Realtime STT
...no "Audio chunks sent" messages...
16:17:25.570Z - WebSocket closed (audioChunksSent: 0, timeSinceLastAudio: 0ms)
16:17:26.570Z - Scheduling STT reconnect (attempt: 1, delayMs: 1000)
16:17:27.570Z - STT reconnected successfully
```

This pattern immediately reveals: **Audio is not reaching the STT WebSocket** - investigate AudioBridge or submitAudio() call chain.

### Scenario 3: Network Issue / Server-Side Close
```
16:17:25.570Z - WebSocket closed (audioChunksSent: 150, intentionalClose: false)
16:17:26.570Z - Scheduling STT reconnect (attempt: 1)
16:17:27.570Z - STT reconnected successfully
16:17:27.571Z - STT connection restored
...translation resumes without loss...
```

## Diagnostic Commands

### Check if audio is flowing:
```bash
# Look for "Audio chunks sent" messages every ~10 seconds
grep "Audio chunks sent to ElevenLabs STT" logs/meeting_*.log
```

### Check WebSocket close reasons:
```bash
# See why WebSocket closed and if audio was being sent
grep "ElevenLabs STT WebSocket closed" logs/meeting_*.log
```

### Check reconnection attempts:
```bash
# Monitor automatic reconnection behavior
grep "STT reconnect" logs/meeting_*.log
```

## Testing the Fix

1. **Start a meeting** with 2+ participants
2. **Monitor logs** for "Audio chunks sent" messages
3. **If no audio chunks appear within 10 seconds:**
   - Audio pipeline is broken upstream
   - Check AudioBridge is receiving frames
   - Check submitAudio() is being called
4. **If audio chunks appear regularly:**
   - WebSocket should stay connected indefinitely
   - Any unexpected closes will auto-reconnect

## Configuration Options

To adjust reconnection behavior in agent config:

```typescript
// In ProviderFactory when creating STT provider
getSTTProvider('elevenlabs', {
  languageCode: 'en',
  autoReconnect: true,        // Enable/disable reconnection
  maxReconnectAttempts: 10,   // Maximum retry attempts
  reconnectDelayMs: 1000,     // Initial delay (exponential)
  maxReconnectDelayMs: 30000  // Maximum delay cap
})
```

## Files Modified

1. `src/providers/elevenlabs/ElevenLabsRealtimeSTT.ts`
   - Added audio flow tracking
   - Implemented automatic reconnection
   - Enhanced logging and diagnostics

2. `src/mizan/TranslationPipeline.ts`
   - Added STT event handlers
   - Graceful reconnection handling
   - State preservation during reconnects

3. `src/providers/types.ts`
   - Added `reconnected` event to `IRealtimeSTTProvider` interface
   - Ensures type safety for the new reconnection event

## Next Steps

1. **Deploy and test** in a live meeting
2. **Monitor logs** for "Audio chunks sent" messages
3. **If chunks appear regularly:** ✅ Problem solved
4. **If no chunks appear:** 🔍 Investigate AudioBridge → submitAudio() chain
   - Add logging in `TranslatorAgent.handleAudioChunk()`
   - Add logging in `TranslationPipeline.submitAudio()`
   - Check AudioBridge event emission

## Additional Notes

- The fix is **defensive** - it handles both the symptom (disconnection) and provides diagnostics for the root cause (audio flow)
- Reconnection preserves conversation context and translation state
- The pipeline remains operational during brief connection interruptions
- Excessive reconnection attempts eventually give up to prevent resource waste
