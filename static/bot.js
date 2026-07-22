/**
 * Translator Bot - lib-jitsi-meet integration
 *
 * Based on jitsi-bot conferenceInit.js approach.
 * Connects to Jitsi using low-level JitsiMeetJS API.
 */

// Global state
let connection = null;
let room = null;
let connectionEstablished = false;
let roomJoined = false;

// Phase 5: Playback state
let localAudioTrack = null;
let playbackQueue = [];
let isPlaying = false;
const MAX_PLAYBACK_QUEUE = 3;

// Configuration from URL parameters
// Note: Named 'botConfig' to avoid conflict with Jitsi's global 'config' variable
const urlParams = new URLSearchParams(window.location.search);
const botConfig = {
  domain: urlParams.get("domain"),
  roomName: urlParams.get("room"),
  displayName: urlParams.get("displayName") || "translator-bot",
};

// Parse the target language from the display name (e.g., "translator-hi" -> "hi")
// This is the language the bot translates TO. Used for self-echo prevention:
// participants who speak this language should be excluded from audio capture.
const botTargetLanguage = botConfig.displayName.startsWith("translator-")
  ? botConfig.displayName.replace("translator-", "")
  : null;

// Options merged with server config
// Note: p2p disabled to force all traffic through JVB (avoids STUN/TURN issues)
let options = {
  displayName: botConfig.displayName,
  startAudioMuted: false,
  startWithAudioMuted: false,
  startVideoMuted: true,
  startWithVideoMuted: true,
  // Disable P2P to force routing through JVB (avoids TURN credential issues)
  p2p: {
    enabled: false,
  },
  // Disable features that bots don't need
  enableNoAudioDetection: false,
  enableNoisyMicDetection: false,
};

/**
 * Update status display and log
 */
function setStatus(message) {
  console.log("[Bot]", message);
  const statusEl = document.getElementById("status");
  if (statusEl) {
    statusEl.textContent = message;
  }
}

/**
 * Initialize connection to Jitsi server
 */
function initConnection() {
  console.log("[Bot] Creating JitsiConnection with options:", options);

  connection = new JitsiMeetJS.JitsiConnection(null, null, options);
  window.connection = connection;

  connection.addEventListener(
    JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
    onConnectionSuccess,
  );
  connection.addEventListener(
    JitsiMeetJS.events.connection.CONNECTION_FAILED,
    onConnectionFailed,
  );
  connection.addEventListener(
    JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED,
    onDisconnect,
  );

  setStatus("Connecting to server...");
  connection.connect();
}

/**
 * Called when connection is established
 */
function onConnectionSuccess() {
  console.log("[Bot] Connection established");
  connectionEstablished = true;
  setStatus("Connected, joining room...");
  initRoom();
}

/**
 * Called when connection fails
 */
function onConnectionFailed(error) {
  console.error("[Bot] Connection failed:", error);
  setStatus("Connection failed: " + error);
  window.__jitsiError = { type: "connection_failed", error };
}

/**
 * Called when disconnected
 */
function onDisconnect() {
  console.log("[Bot] Disconnected");
  connectionEstablished = false;
  roomJoined = false;
  window.__jitsiJoined = false;
  setStatus("Disconnected");
}

/**
 * Initialize and join the conference room
 */
function initRoom() {
  if (!connectionEstablished) {
    console.log("[Bot] Waiting for connection...");
    setTimeout(initRoom, 1000);
    return;
  }

  console.log("[Bot] Initializing conference:", botConfig.roomName);
  room = connection.initJitsiConference(botConfig.roomName, options);
  window.room = room;

  // Initialize audio capture maps BEFORE registering event handlers.
  // PARTICIPANT_PROPERTY_CHANGED and USER_JOINED fire during the join
  // handshake (before CONFERENCE_JOINED), so these must exist early.
  if (!window.__audioSources) {
    window.__audioSources = new Map();
  }
  if (!window.__excludedParticipants) {
    window.__excludedParticipants = new Set();
  }
  if (!window.__participantLanguages) {
    window.__participantLanguages = new Map();
  }

  // Conference events
  room.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, onConferenceJoined);
  room.on(JitsiMeetJS.events.conference.CONFERENCE_LEFT, onConferenceLeft);
  room.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, onConferenceFailed);
  room.on(JitsiMeetJS.events.conference.KICKED, onKicked);

  // Participant events
  room.on(JitsiMeetJS.events.conference.USER_JOINED, onUserJoined);
  room.on(JitsiMeetJS.events.conference.USER_LEFT, onUserLeft);

  // Track events - add detailed logging
  room.on(JitsiMeetJS.events.conference.TRACK_ADDED, (track) => {
    console.log("[Bot] *** TRACK_ADDED event fired ***");
    console.log("[Bot] Track info:", {
      type: track.getType(),
      participantId: track.getParticipantId(),
      isLocal: track.isLocal(),
      isMuted: track.isMuted(),
      hasStream: !!track.getOriginalStream(),
    });
    onTrackAdded(track);
  });
  room.on(JitsiMeetJS.events.conference.TRACK_REMOVED, onTrackRemoved);

  // Add listener for TRACK_MUTE_CHANGED to debug muting issues
  room.on(JitsiMeetJS.events.conference.TRACK_MUTE_CHANGED, (track) => {
    console.log("[Bot] Track mute changed:", {
      type: track.getType(),
      participantId: track.getParticipantId(),
      isMuted: track.isMuted(),
    });
  });

  // Add listener for REMOTE_STATS_UPDATED to see if we're receiving any remote data
  room.on(
    JitsiMeetJS.events.conference.TRACK_AUDIO_LEVEL_CHANGED,
    (participantId, audioLevel) => {
      // Only log occasionally to avoid spam
      if (audioLevel > 0.01) {
        console.log(
          "[Bot] Audio level from participant:",
          participantId,
          "level:",
          audioLevel.toFixed(3),
        );
      }
    },
  );

  // Self-echo prevention: Listen for participant property changes to track spoken languages.
  // When a participant sets their spokenLanguage (via the frontend's Spoken Language selector),
  // the bot updates its audio subscription to exclude participants whose language matches
  // the bot's target language (no point translating X->X, and prevents self-echo).
  //
  // Defense-in-depth: Also disconnects/reconnects the WebAudio capture source when
  // a participant's language changes, so even if JVB subscription filtering fails,
  // the capture worklet won't receive audio from same-language participants.
  room.on(
    JitsiMeetJS.events.conference.PARTICIPANT_PROPERTY_CHANGED,
    (participant, propertyName, oldValue, newValue) => {
      if (propertyName === "spokenLanguage") {
        const participantId = participant.getId();
        const displayName = participant.getDisplayName();
        console.log(
          "[Bot] PARTICIPANT_PROPERTY_CHANGED: spokenLanguage for",
          displayName || participantId,
          "changed from",
          oldValue,
          "to",
          newValue,
        );
        if (newValue) {
          window.__participantLanguages.set(participantId, newValue);
        } else {
          window.__participantLanguages.delete(participantId);
        }

        // Defense-in-depth: Manage WebAudio capture connections based on language.
        // If participant's language now matches bot's target, disconnect their audio.
        // If it no longer matches (changed language), reconnect their audio.
        if (botTargetLanguage && !isTranslatorParticipant(displayName)) {
          const nowSameLanguage = newValue === botTargetLanguage;
          const wasSameLanguage = oldValue === botTargetLanguage;
          const isConnected =
            window.__audioSources && window.__audioSources.has(participantId);

          if (nowSameLanguage && isConnected) {
            console.log(
              "[Bot] Disconnecting same-language participant from capture:",
              displayName || participantId,
              "(lang:",
              newValue,
              "= botTarget:",
              botTargetLanguage,
              ")",
            );
            disconnectParticipantAudio(participantId);
          } else if (!nowSameLanguage && wasSameLanguage && !isConnected) {
            console.log(
              "[Bot] Reconnecting participant after language change:",
              displayName || participantId,
              "(lang:",
              newValue,
              "!= botTarget:",
              botTargetLanguage,
              ")",
            );
            connectParticipantAudio(participant);
          }
        }

        updateBotAudioSubscription();
      }
    },
  );

  // Re-send audio subscription when data channel opens, in case the initial
  // call during CONFERENCE_JOINED was silently dropped (channel not yet open).
  room.on(JitsiMeetJS.events.conference.DATA_CHANNEL_OPENED, () => {
    console.log("[Bot] DATA_CHANNEL_OPENED, re-sending audio subscription");
    updateBotAudioSubscription();
  });

  // Set display name and join
  room.setDisplayName(botConfig.displayName);
  room.join();
}

/**
 * Called when we've joined the conference
 */
function onConferenceJoined() {
  console.log("[Bot] Conference joined!");
  roomJoined = true;
  setStatus("Joined as " + botConfig.displayName);

  // Set global flags for Puppeteer to check
  window.__jitsiJoined = true;
  window.__jitsiRoomName = botConfig.roomName;
  window.__jitsiParticipantId = room.myUserId();

  console.log("[Bot] My participant ID:", room.myUserId());
  console.log("[Bot] Participants:", room.getParticipants().length);

  // Mark excluded participants (translators) and read spoken language properties
  room.getParticipants().forEach((participant) => {
    const displayName = participant.getDisplayName();
    const participantId = participant.getId();

    if (isTranslatorParticipant(displayName)) {
      console.log("[Bot] Marking translator for exclusion:", displayName);
      window.__excludedParticipants.add(participantId);
    }

    // Read initial spokenLanguage property (set before bot joined)
    const spokenLang = participant.getProperty
      ? participant.getProperty("spokenLanguage")
      : null;
    if (spokenLang) {
      console.log(
        "[Bot] Initial spokenLanguage for",
        displayName || participantId,
        ":",
        spokenLang,
      );
      window.__participantLanguages.set(participantId, spokenLang);
    }
  });

  // Apply initial audio subscription based on known participant languages
  updateBotAudioSubscription();

  console.log(
    "[Bot] Conference joined, waiting for audio infrastructure from Node.js...",
  );
}

/**
 * Called when we leave the conference
 */
function onConferenceLeft() {
  console.log("[Bot] Conference left");
  roomJoined = false;
  window.__jitsiJoined = false;
  setStatus("Left conference");
}

/**
 * Called when conference fails
 */
function onConferenceFailed(error) {
  console.error("[Bot] Conference failed:", error);
  setStatus("Conference failed: " + error);
  window.__jitsiError = { type: "conference_failed", error };
}

/**
 * Called when we get kicked
 */
function onKicked(actor, reason) {
  console.log("[Bot] Kicked by:", actor, "Reason:", reason);
  setStatus("Kicked: " + reason);
  window.__jitsiError = { type: "kicked", actor, reason };
}

/**
 * Called when a user joins
 */
function onUserJoined(id, user) {
  const displayName = user.getDisplayName();
  console.log("[Bot] User joined:", id, displayName);

  // Phase 3: Loop prevention - check if this is a translator bot
  if (isTranslatorParticipant(displayName)) {
    console.log(
      "[Bot] Translator participant detected, will EXCLUDE from audio capture:",
      displayName,
    );
    // Add to exclusion list
    if (!window.__excludedParticipants) {
      window.__excludedParticipants = new Set();
    }
    window.__excludedParticipants.add(id);
  } else {
    // Read spoken language property if available
    const spokenLang = user.getProperty
      ? user.getProperty("spokenLanguage")
      : null;
    if (spokenLang) {
      console.log(
        "[Bot] New participant spokenLanguage:",
        displayName || id,
        ":",
        spokenLang,
      );
      if (!window.__participantLanguages) {
        window.__participantLanguages = new Map();
      }
      window.__participantLanguages.set(id, spokenLang);
    }

    // Defense-in-depth: Don't connect audio if participant's language matches bot's target
    if (isSameLanguageParticipant(id)) {
      console.log(
        "[Bot] Skipping audio connection for same-language participant:",
        displayName || id,
        "lang:",
        spokenLang,
        "botTarget:",
        botTargetLanguage,
      );
    } else {
      // Connect to this participant's audio
      connectParticipantAudio(user);
    }
  }

  // Update audio subscription (new participant may affect exclusion list)
  updateBotAudioSubscription();

  // Log current participant count
  if (room) {
    console.log("[Bot] Total participants:", room.getParticipants().length + 1); // +1 for self
  }
}

/**
 * Called when a user leaves
 */
function onUserLeft(id, user) {
  console.log("[Bot] User left:", id, user?.getDisplayName());

  // Remove from exclusion list if present
  if (window.__excludedParticipants) {
    window.__excludedParticipants.delete(id);
  }

  // Remove from language tracking
  if (window.__participantLanguages) {
    window.__participantLanguages.delete(id);
  }

  // Disconnect their audio
  disconnectParticipantAudio(id);

  // Update audio subscription (removed participant may change exclusion list)
  updateBotAudioSubscription();
}

/**
 * Called when a track is added
 */
function onTrackAdded(track) {
  const participantId = track.getParticipantId();
  const trackType = track.getType();
  const isLocal = track.isLocal();

  console.log(
    "[Bot] Track added:",
    trackType,
    "from",
    participantId,
    isLocal ? "(LOCAL - ignoring)" : "(REMOTE)",
  );

  // Skip local tracks - we only want remote participant audio
  if (isLocal) {
    console.log("[Bot] Skipping local track");
    return;
  }

  // Phase 3: Handle audio tracks for capture
  if (trackType === "audio" && participantId) {
    console.log("[Bot] Processing remote audio track from:", participantId);
    handleAudioTrackAdded(track, participantId);
  }
}

/**
 * Called when a track is removed
 */
function onTrackRemoved(track) {
  const participantId = track.getParticipantId();
  const trackType = track.getType();
  console.log("[Bot] Track removed:", trackType, "from", participantId);

  // Phase 3: Handle audio track removal
  if (trackType === "audio" && participantId) {
    handleAudioTrackRemoved(track, participantId);
  }
}

// ============================================================================
// Phase 3: Audio Capture Infrastructure
// ============================================================================

/**
 * Checks if a participant is a translator bot (for loop prevention)
 */
function isTranslatorParticipant(displayName) {
  if (!displayName) return false;
  return displayName.startsWith("translator-");
}

/**
 * Checks if a participant should be excluded from audio capture based on their
 * spoken language matching the bot's target language.
 *
 * Defense-in-depth: This supplements JVB-level exclusion (updateBotAudioSubscription)
 * with WebAudio-level exclusion. Even if JVB subscription filtering fails or hasn't
 * been applied yet, same-language participants won't be connected to the capture worklet.
 *
 * @returns {boolean} true if participant should be excluded
 */
function isSameLanguageParticipant(participantId) {
  if (!botTargetLanguage || !window.__participantLanguages) return false;
  const lang = window.__participantLanguages.get(participantId);
  return lang === botTargetLanguage;
}

/**
 * Updates the bot's audio subscription via JVB Receiver Audio Subscriptions API.
 *
 * Self-echo prevention: Excludes participants whose spokenLanguage matches
 * the bot's target language. For example, translator-hi (translates TO Hindi)
 * excludes Hindi speakers because:
 * 1. Translating Hindi->Hindi is wasteful
 * 2. Hindi speakers are the subscribers of this translator and would hear self-echo
 *
 * Also continues to exclude all translator-* participants (loop prevention).
 */
function updateBotAudioSubscription() {
  if (!room || !roomJoined) {
    return;
  }

  // Guard: setAudioSubscriptionMode may not be available
  if (typeof room.setAudioSubscriptionMode !== "function") {
    console.log(
      "[Bot] setAudioSubscriptionMode not available on room object, skipping",
    );
    return;
  }

  const excludeIds = new Set();
  const exclusionReasons = {};

  // 1. Exclude all translator participants (existing loop prevention)
  if (window.__excludedParticipants) {
    window.__excludedParticipants.forEach((id) => {
      excludeIds.add(id);
      exclusionReasons[id] = "translator-bot";
    });
  }

  // 2. Exclude participants whose spokenLanguage matches bot's target language
  if (botTargetLanguage && window.__participantLanguages) {
    window.__participantLanguages.forEach((lang, participantId) => {
      if (lang === botTargetLanguage) {
        excludeIds.add(participantId);
        exclusionReasons[participantId] =
          (exclusionReasons[participantId]
            ? exclusionReasons[participantId] + " + "
            : "") +
          "same-language (" +
          lang +
          "=" +
          botTargetLanguage +
          ")";
      }
    });
  }

  // Build source name list ({endpointId}-a0 format required by JVB AudioSubscription)
  const excludeSources = Array.from(excludeIds).map((id) => `${id}-a0`);

  console.log("[Bot] Audio subscription update details:", {
    botTargetLanguage,
    participantLanguages: window.__participantLanguages
      ? Object.fromEntries(window.__participantLanguages)
      : {},
    excludedTranslators: window.__excludedParticipants
      ? Array.from(window.__excludedParticipants)
      : [],
    exclusionReasons,
    totalExcluded: excludeSources.length,
  });

  if (excludeSources.length === 0) {
    console.log("[Bot] Updating audio subscription: mode=All (no exclusions)");
    room.setAudioSubscriptionMode({ mode: "All" });
  } else {
    console.log(
      "[Bot] Updating audio subscription: mode=Exclude,",
      excludeSources.length,
      "source(s):",
      excludeSources,
    );
    room.setAudioSubscriptionMode({
      mode: "Exclude",
      list: excludeSources,
    });
  }
}

/**
 * Connects all existing participants' audio tracks.
 * This is called from Node.js AFTER the audio infrastructure is ready.
 * Exposed as window.connectAllParticipantAudio for Puppeteer to call.
 */
window.connectAllParticipantAudio = function () {
  console.log("[Bot] connectAllParticipantAudio called from Node.js");

  const audio = window.__translatorAudio;
  if (!audio || !audio.audioContext || !audio.captureWorklet) {
    console.error("[Bot] Audio infrastructure not ready!");
    return { success: false, error: "Audio infrastructure not ready" };
  }

  if (!room) {
    console.error("[Bot] Room not available!");
    return { success: false, error: "Room not available" };
  }

  const participants = room.getParticipants();
  console.log(
    "[Bot] Connecting audio for",
    participants.length,
    "existing participants",
  );

  let connected = 0;
  let skipped = 0;
  let errors = 0;

  participants.forEach((participant) => {
    const participantId = participant.getId();
    const displayName = participant.getDisplayName();

    // Skip translators
    if (isTranslatorParticipant(displayName)) {
      console.log("[Bot] Skipping translator:", displayName);
      skipped++;
      return;
    }

    // Defense-in-depth: Skip same-language participants at WebAudio level
    if (isSameLanguageParticipant(participantId)) {
      console.log(
        "[Bot] Skipping same-language participant (WebAudio filter):",
        displayName || participantId,
        "lang:",
        window.__participantLanguages?.get(participantId),
        "botTarget:",
        botTargetLanguage,
      );
      skipped++;
      return;
    }

    // Get their tracks
    const tracks = participant.getTracks ? participant.getTracks() : [];
    const audioTracks = tracks.filter((t) => t.getType() === "audio");

    console.log(
      "[Bot] Participant",
      displayName || participantId,
      "has",
      audioTracks.length,
      "audio tracks",
    );

    audioTracks.forEach((track) => {
      try {
        // Check if already connected
        if (window.__audioSources && window.__audioSources.has(participantId)) {
          console.log("[Bot] Already connected:", participantId);
          return;
        }

        // Use the same handleAudioTrackAdded function which properly
        // attaches to an audio element for WebRTC decoding
        handleAudioTrackAdded(track, participantId);

        console.log(
          "[Bot] Initiated audio connection for:",
          displayName || participantId,
        );
        connected++;
      } catch (e) {
        console.error(
          "[Bot] Error connecting audio from",
          participantId,
          ":",
          e,
        );
        errors++;
      }
    });
  });

  console.log("[Bot] Audio connection initiated for:", {
    connected,
    skipped,
    errors,
  });
  return { success: true, connected, skipped, errors };
};

/**
 * Debug function to check audio state - can be called from Node.js or console
 */
window.getAudioDebugInfo = function () {
  const audio = window.__translatorAudio;
  const info = {
    hasAudioInfra: !!audio,
    audioContextState: audio?.audioContext?.state,
    hasCaptureWorklet: !!audio?.captureWorklet,
    connectedSources: window.__audioSources?.size || 0,
    excludedParticipants: window.__excludedParticipants?.size || 0,
    botTargetLanguage: botTargetLanguage,
    participantLanguages: window.__participantLanguages
      ? Object.fromEntries(window.__participantLanguages)
      : {},
    roomJoined: roomJoined,
    participantCount: room?.getParticipants()?.length || 0,
  };

  // List all participants with their audio track status
  if (room) {
    info.participants = room.getParticipants().map((p) => {
      const tracks = p.getTracks ? p.getTracks() : [];
      const audioTracks = tracks.filter((t) => t.getType() === "audio");
      return {
        id: p.getId(),
        displayName: p.getDisplayName(),
        audioTrackCount: audioTracks.length,
        audioTracks: audioTracks.map((t) => ({
          hasStream: !!t.getOriginalStream(),
          isMuted: t.isMuted(),
          streamActive: t.getOriginalStream()?.active,
        })),
      };
    });
  }

  console.log("[Bot] Audio Debug Info:", JSON.stringify(info, null, 2));
  return info;
};

/**
 * Initializes the audio capture infrastructure
 * Note: This is now only used for track events, not initial connection
 */
function initializeAudioCapture() {
  console.log("[Bot] Initializing audio capture infrastructure");

  // Track connected audio sources
  window.__audioSources = new Map();
  window.__excludedParticipants = new Set();

  // Get audio infrastructure from AudioManager
  const audio = window.__translatorAudio;
  if (!audio) {
    console.warn("[Bot] Audio infrastructure not yet initialized");
    return;
  }

  console.log("[Bot] Audio capture infrastructure initialized");
}

/**
 * Connects to a participant's audio
 */
function connectParticipantAudio(participant) {
  const participantId = participant.getId ? participant.getId() : participant;
  const displayName = participant.getDisplayName
    ? participant.getDisplayName()
    : "unknown";

  // Loop prevention: skip translator bots
  if (isTranslatorParticipant(displayName)) {
    console.log("[Bot] Skipping translator participant:", displayName);
    return;
  }

  console.log(
    "[Bot] Connecting to participant audio:",
    participantId,
    displayName,
  );

  // Get their audio tracks
  const tracks = participant.getTracks ? participant.getTracks() : [];
  const audioTracks = tracks.filter((t) => t.getType() === "audio");

  audioTracks.forEach((track) => {
    handleAudioTrackAdded(track, participantId);
  });
}

/**
 * Disconnects a participant's audio
 */
function disconnectParticipantAudio(participantId) {
  const sources = window.__audioSources;
  if (sources) {
    const source = sources.get(participantId);
    if (source) {
      try {
        source.disconnect();
        console.log("[Bot] Disconnected audio source for:", participantId);
      } catch (e) {
        console.warn("[Bot] Error disconnecting audio source:", e);
      }
      sources.delete(participantId);
    }
  }

  // Also clean up audio element
  const audioElements = window.__audioElements;
  if (audioElements) {
    const audioElement = audioElements.get(participantId);
    if (audioElement) {
      try {
        audioElement.pause();
        audioElement.srcObject = null;
        audioElement.remove();
        console.log("[Bot] Removed audio element for:", participantId);
      } catch (e) {
        console.warn("[Bot] Error removing audio element:", e);
      }
      audioElements.delete(participantId);
    }
  }
}

/**
 * Handles when an audio track is added
 *
 * CRITICAL CHROME BUG WORKAROUND (https://issues.chromium.org/40094084):
 * MediaStream from WebRTC is silent in WebAudio if not attached to a media element.
 *
 * The Chrome WebRTC audio pipeline uses a PULL model:
 * - WebRTCAudioRenderer pulls audio from WebRTC audio mixer
 * - This only happens if the stream is attached to an <audio> element that's playing
 * - Once pulling happens, the audio is also PUSHED to any WebAudio nodes
 *
 * WORKAROUND: Attach stream to an Audio element (can be muted) to trigger decoding,
 * then use createMediaStreamSource() separately to capture the decoded audio.
 *
 * DO NOT use createMediaElementSource() - it takes over the audio element's output
 * and breaks the pull mechanism.
 */
function handleAudioTrackAdded(track, participantId) {
  console.log("[Bot] handleAudioTrackAdded called for:", participantId);

  // Loop prevention: check exclusion list
  if (
    window.__excludedParticipants &&
    window.__excludedParticipants.has(participantId)
  ) {
    console.log(
      "[Bot] Excluding audio from translator participant:",
      participantId,
    );
    return;
  }

  // Defense-in-depth: check if participant's spoken language matches bot's target language.
  // This prevents self-echo at the WebAudio capture level, even if JVB subscription
  // filtering hasn't been applied yet or failed.
  if (isSameLanguageParticipant(participantId)) {
    console.log(
      "[Bot] Excluding same-language participant from audio capture:",
      participantId,
      "lang:",
      window.__participantLanguages?.get(participantId),
      "botTarget:",
      botTargetLanguage,
    );
    return;
  }

  const audio = window.__translatorAudio;
  console.log("[Bot] Audio infrastructure status:", {
    exists: !!audio,
    hasContext: !!(audio && audio.audioContext),
    hasWorklet: !!(audio && audio.captureWorklet),
    contextState: audio?.audioContext?.state,
  });

  if (!audio || !audio.audioContext || !audio.captureWorklet) {
    console.warn("[Bot] Audio infrastructure not ready, cannot connect track");
    return;
  }

  try {
    // Get the underlying MediaStreamTrack directly from the JitsiTrack
    console.log("[Bot] Getting MediaStreamTrack from JitsiTrack...");

    const mediaTrack = track.getTrack ? track.getTrack() : track.track;

    console.log("[Bot] MediaStreamTrack obtained:", {
      hasTrack: !!mediaTrack,
      kind: mediaTrack?.kind,
      id: mediaTrack?.id,
      enabled: mediaTrack?.enabled,
      muted: mediaTrack?.muted,
      readyState: mediaTrack?.readyState,
      label: mediaTrack?.label,
    });

    if (!mediaTrack) {
      console.warn("[Bot] No MediaStreamTrack available from JitsiTrack");
      return;
    }

    if (mediaTrack.kind !== "audio") {
      console.warn("[Bot] Track is not an audio track:", mediaTrack.kind);
      return;
    }

    // Create a MediaStream from the track
    const stream = new MediaStream([mediaTrack]);
    console.log("[Bot] MediaStream created:", {
      streamId: stream.id,
      audioTracks: stream.getAudioTracks().length,
      active: stream.active,
    });

    // CRITICAL WORKAROUND FOR CHROME BUG:
    // Create an <audio> element and attach the stream to trigger WebRTC decoding
    // The audio element MUST play (even if muted) to drive the WebRTC audio pull mechanism
    console.log("[Bot] Creating audio element to trigger WebRTC decoding...");

    const audioElement = document.createElement("audio");
    audioElement.id = `audio-participant-${participantId}`;
    audioElement.srcObject = stream;
    audioElement.autoplay = true;

    // IMPORTANT: Muting the audio element is OK - the decoding still happens
    // The mute only affects speaker output, not the internal pull mechanism
    audioElement.muted = true; // Mute to avoid echo/feedback
    audioElement.volume = 1.0; // Volume doesn't matter when muted, but set it anyway

    // Some browsers need the element in the DOM for autoplay
    document.body.appendChild(audioElement);

    console.log(
      "[Bot] Audio element created (MUTED - decoding trigger only):",
      {
        id: audioElement.id,
        autoplay: audioElement.autoplay,
        muted: audioElement.muted,
      },
    );

    // Store audio element for cleanup
    if (!window.__audioElements) {
      window.__audioElements = new Map();
    }
    window.__audioElements.set(participantId, audioElement);

    // Function to connect the stream to our capture worklet
    // IMPORTANT: Use createMediaStreamSource() NOT createMediaElementSource()
    // createMediaElementSource would take over the audio element and break the pull mechanism
    const connectToWorklet = () => {
      try {
        // Check if already connected
        if (window.__audioSources?.has(participantId)) {
          console.log("[Bot] Already connected:", participantId);
          return;
        }

        console.log(
          "[Bot] Connecting stream to capture worklet via createMediaStreamSource...",
        );

        // Create source from the MediaStream (NOT from the audio element!)
        // This captures the decoded audio that's now being pulled by the audio element
        const source = audio.audioContext.createMediaStreamSource(stream);

        // Connect to our capture worklet
        source.connect(audio.captureWorklet);
        console.log("[Bot] Connected to capture worklet");

        // Also connect to analyser for monitoring
        if (audio.analyser) {
          source.connect(audio.analyser);
        }

        // Store source for later disconnection
        if (!window.__audioSources) {
          window.__audioSources = new Map();
        }
        window.__audioSources.set(participantId, source);

        console.log(
          "[Bot] ✓ Successfully connected audio from:",
          participantId,
        );
        console.log(
          "[Bot] Total connected sources:",
          window.__audioSources.size,
        );

        // Update stats
        window.__audioStats = window.__audioStats || { connectedSources: 0 };
        window.__audioStats.connectedSources = window.__audioSources.size;

        // Start audio level monitoring using the SAME source node (avoids duplicate MediaStreamSource leak)
        startAudioLevelMonitoringFromSource(participantId, source);
      } catch (e) {
        console.error("[Bot] Error connecting to worklet:", e);
      }
    };

    // Handle track mute/unmute events
    if (mediaTrack.muted) {
      console.log(
        "[Bot] ⚠️ Track is initially MUTED - will connect when unmuted",
      );

      mediaTrack.addEventListener(
        "unmute",
        () => {
          console.log("[Bot] 🎤 Track UNMUTED for:", participantId);
          console.log("[Bot] Track state:", {
            enabled: mediaTrack.enabled,
            muted: mediaTrack.muted,
            readyState: mediaTrack.readyState,
          });

          connectToWorklet();
        },
        { once: true },
      );
    }

    // Start the audio element playing - this triggers the WebRTC pull mechanism
    audioElement
      .play()
      .then(() => {
        console.log(
          "[Bot] Audio element playing (triggers WebRTC decoding) for:",
          participantId,
        );

        // Give a small delay for the audio pipeline to stabilize
        setTimeout(() => {
          connectToWorklet();
        }, 200);
      })
      .catch((e) => {
        console.warn("[Bot] Audio element play failed:", e.message);
        // Try connecting anyway
        connectToWorklet();
      });
  } catch (error) {
    console.error("[Bot] Error connecting audio track:", error);
    console.error("[Bot] Error stack:", error.stack);
  }
}

/**
 * Monitors audio levels from an existing source node to debug if audio is actually flowing.
 * Uses the already-created MediaStreamAudioSourceNode to avoid creating a duplicate (memory leak).
 */
function startAudioLevelMonitoringFromSource(participantId, source) {
  const audio = window.__translatorAudio;
  if (!audio || !audio.audioContext) return;

  try {
    // Create a separate analyser for this participant
    const analyser = audio.audioContext.createAnalyser();
    analyser.fftSize = 256;

    // Connect the existing source to the analyser (no duplicate createMediaStreamSource)
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let silentFrames = 0;
    let hasLoggedAudio = false;

    const checkLevel = () => {
      if (!window.__audioSources || !window.__audioSources.has(participantId)) {
        console.log(
          "[Bot] Stopping audio monitor for disconnected participant:",
          participantId,
        );
        return;
      }

      analyser.getByteTimeDomainData(dataArray);

      // Calculate RMS
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const sample = (dataArray[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      if (rms > 0.01) {
        if (!hasLoggedAudio) {
          console.log(
            "[Bot] AUDIO DETECTED from",
            participantId,
            "RMS:",
            rms.toFixed(4),
          );
          hasLoggedAudio = true;
        }
        silentFrames = 0;
      } else {
        silentFrames++;
        // Log every 10 seconds of silence
        if (silentFrames % 100 === 0 && silentFrames <= 300) {
          console.log(
            "[Bot] Still silent from",
            participantId,
            "for",
            (silentFrames / 10).toFixed(0),
            "seconds",
          );
        }
      }

      // Check every 100ms
      setTimeout(checkLevel, 100);
    };

    console.log("[Bot] Started audio level monitoring for:", participantId);
    checkLevel();
  } catch (e) {
    console.warn("[Bot] Could not start audio level monitoring:", e);
  }
}

/**
 * Handles when an audio track is removed
 */
function handleAudioTrackRemoved(track, participantId) {
  disconnectParticipantAudio(participantId);
}

/**
 * Load config and lib-jitsi-meet from target Jitsi server
 */
function loadJitsiDependencies() {
  if (!botConfig.domain) {
    setStatus("Error: No domain specified");
    window.__jitsiError = { type: "config", error: "No domain specified" };
    return;
  }

  setStatus("Loading Jitsi dependencies from " + botConfig.domain);

  // Load config.js
  const configScript = document.getElementById("jitsiConfig");
  configScript.src = `https://${botConfig.domain}/config.js`;

  configScript.onload = () => {
    console.log("[Bot] config.js loaded");

    // Merge server config with our options
    if (window.config) {
      options = { ...window.config, ...options };
      console.log("[Bot] Merged config:", options);
    }

    // Convert deprecated 'bosh' option to 'serviceUrl' (like jitsi-bot does)
    // Use botConfig.domain because it includes the correct port (e.g., :8443)
    if (options.bosh && !options.serviceUrl) {
      options.serviceUrl = `https://${botConfig.domain}/http-bind?room=${botConfig.roomName}`;
      delete options.bosh;
      console.log("[Bot] Converted bosh to serviceUrl:", options.serviceUrl);
    }

    // Ensure serviceUrl uses our domain with port if it doesn't already have it
    if (options.serviceUrl && !options.serviceUrl.includes(botConfig.domain)) {
      // Extract just the path from existing serviceUrl
      try {
        const url = new URL(options.serviceUrl);
        options.serviceUrl = `https://${botConfig.domain}${url.pathname}${url.search || "?room=" + botConfig.roomName}`;
        console.log(
          "[Bot] Fixed serviceUrl with correct domain:",
          options.serviceUrl,
        );
      } catch (e) {
        console.log("[Bot] Could not parse serviceUrl, using domain directly");
        options.serviceUrl = `https://${botConfig.domain}/http-bind?room=${botConfig.roomName}`;
      }
    }

    // Load lib-jitsi-meet
    const libScript = document.getElementById("libJitsiMeet");
    libScript.src = `https://${botConfig.domain}/libs/lib-jitsi-meet.min.js`;

    libScript.onload = () => {
      console.log("[Bot] lib-jitsi-meet loaded");
      startBot();
    };

    libScript.onerror = (err) => {
      console.error("[Bot] Failed to load lib-jitsi-meet:", err);
      setStatus("Failed to load lib-jitsi-meet");
      window.__jitsiError = {
        type: "load",
        error: "Failed to load lib-jitsi-meet",
      };
    };
  };

  configScript.onerror = (err) => {
    console.error("[Bot] Failed to load config.js:", err);
    setStatus("Failed to load config.js");
    window.__jitsiError = { type: "load", error: "Failed to load config.js" };
  };
}

/**
 * Start the bot after dependencies are loaded
 */
function startBot() {
  if (!window.JitsiMeetJS) {
    console.error("[Bot] JitsiMeetJS not available");
    setStatus("JitsiMeetJS not available");
    window.__jitsiError = { type: "load", error: "JitsiMeetJS not available" };
    return;
  }

  console.log("[Bot] Starting bot for room:", botConfig.roomName);
  console.log("[Bot] Display name:", botConfig.displayName);

  // Initialize JitsiMeetJS
  JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.WARN);
  JitsiMeetJS.init(options);

  setStatus("JitsiMeetJS initialized");

  // Start connection
  initConnection();
}

// Mark that bot script is loaded
window.__botLoaded = true;

// Start loading dependencies
loadJitsiDependencies();

// ============================================================================
// Phase 5: Audio Track Publishing & TTS Playback
// ============================================================================

/**
 * Overrides navigator.mediaDevices.getUserMedia to return our
 * MediaStreamDestination stream instead of a real microphone.
 *
 * Pattern from jitsi-bot/soundboard: when JitsiMeetJS.createLocalTracks()
 * internally calls getUserMedia for audio, it receives our translated
 * audio stream instead.
 */
function overrideGetUserMedia() {
  const audio = window.__translatorAudio;
  if (!audio || !audio.mediaStreamDestination) {
    console.error(
      "[Bot] Cannot override getUserMedia - MediaStreamDestination not ready",
    );
    return false;
  }

  const destStream = audio.mediaStreamDestination;
  console.log(
    "[Bot] Overriding getUserMedia to return MediaStreamDestination stream",
    {
      streamId: destStream.stream.id,
      active: destStream.stream.active,
      audioTracks: destStream.stream.getAudioTracks().length,
    },
  );

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    console.log("[Bot] getUserMedia called with constraints:", constraints);
    if (constraints && constraints.audio) {
      console.log("[Bot] Returning MediaStreamDestination stream for audio");
      return destStream.stream;
    }
    // For video or other constraints, return empty stream
    return new MediaStream();
  };

  return true;
}

/**
 * Creates a local audio track from MediaStreamDestination and publishes it
 * to the Jitsi conference. Other participants will receive this audio.
 *
 * Must be called AFTER:
 * - AudioManager has initialized (MediaStreamDestination exists)
 * - Conference room is joined
 */
window.publishTranslatedAudioTrack = async function () {
  console.log("[Bot] publishTranslatedAudioTrack called");

  if (!room || !roomJoined) {
    console.error("[Bot] Cannot publish track - room not joined");
    return { success: false, error: "Room not joined" };
  }

  const audio = window.__translatorAudio;
  if (!audio || !audio.mediaStreamDestination) {
    console.error(
      "[Bot] Cannot publish track - MediaStreamDestination not ready",
    );
    return { success: false, error: "MediaStreamDestination not ready" };
  }

  // Step 1: Override getUserMedia
  if (!overrideGetUserMedia()) {
    return { success: false, error: "Failed to override getUserMedia" };
  }

  try {
    // Step 2: Create local tracks via JitsiMeetJS (uses overridden getUserMedia)
    console.log("[Bot] Creating local audio tracks via JitsiMeetJS...");
    const tracks = await JitsiMeetJS.createLocalTracks({ devices: ["audio"] });

    const audioTrack = tracks.find(function (t) {
      return t.getType() === "audio";
    });

    if (!audioTrack) {
      console.error("[Bot] No audio track created by JitsiMeetJS");
      return { success: false, error: "No audio track created" };
    }

    console.log("[Bot] Local audio track created:", {
      type: audioTrack.getType(),
      id: audioTrack.getId ? audioTrack.getId() : "unknown",
    });

    // Step 3: Add track to room
    await room.addTrack(audioTrack);
    localAudioTrack = audioTrack;

    // Add lifecycle event listeners
    audioTrack.addEventListener(
      JitsiMeetJS.events.track.TRACK_MUTE_CHANGED,
      function () {
        console.log(
          "[Bot] Local audio track mute changed:",
          audioTrack.isMuted(),
        );
      },
    );

    audioTrack.addEventListener(
      JitsiMeetJS.events.track.LOCAL_TRACK_STOPPED,
      function () {
        console.log("[Bot] Local audio track stopped");
        localAudioTrack = null;
      },
    );

    console.log("[Bot] Local audio track published to room successfully");

    // Step 4: Handle JVB workaround - re-add track on media session change
    room.on(
      JitsiMeetJS.events.conference._MEDIA_SESSION_ACTIVE_CHANGED,
      function (jingleSession) {
        if (
          localAudioTrack &&
          jingleSession.peerconnection &&
          jingleSession.peerconnection.localTracks &&
          jingleSession.peerconnection.localTracks.size === 0
        ) {
          console.log("[Bot] JVB workaround: re-adding local audio track");
          room.addTrack(localAudioTrack);
        }
      },
    );

    return { success: true };
  } catch (error) {
    console.error("[Bot] Failed to publish audio track:", error);
    return { success: false, error: error.message || String(error) };
  }
};

/**
 * Plays translated MP3 audio by fetching it from a local HTTP URL.
 *
 * This avoids the "Base64 Puppeteer Tax" — instead of receiving base64-encoded
 * audio over CDP WebSocket and decoding in the browser, the browser fetches
 * the binary MP3 directly from BotPageServer (http://localhost:3001/tts/:id).
 *
 * @param {string} audioUrl - Local HTTP URL to fetch the MP3 from
 * @returns {Promise<{success: boolean, duration?: number, error?: string}>}
 */
window.playTranslatedAudioFromUrl = async function (audioUrl) {
  const audio = window.__translatorAudio;
  if (!audio || !audio.audioContext || !audio.mediaStreamDestination) {
    return { success: false, error: "Audio infrastructure not ready" };
  }

  try {
    const response = await fetch(audioUrl);
    if (!response.ok) {
      return { success: false, error: "Fetch failed: " + response.status };
    }
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audio.audioContext.decodeAudioData(arrayBuffer);

    console.log("[Bot] MP3 fetched and decoded from URL:", {
      url: audioUrl,
      duration: audioBuffer.duration.toFixed(2) + "s",
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
    });

    queueAudioPlayback(audioBuffer);
    return { success: true, duration: audioBuffer.duration };
  } catch (error) {
    console.error("[Bot] Failed to fetch/decode translated audio:", error);
    return { success: false, error: error.message || String(error) };
  }
};

/**
 * Queues an AudioBuffer for sequential playback.
 * Drops oldest item if queue exceeds MAX_PLAYBACK_QUEUE.
 */
function queueAudioPlayback(audioBuffer) {
  // Drop oldest if queue is full
  if (playbackQueue.length >= MAX_PLAYBACK_QUEUE) {
    const dropped = playbackQueue.shift();
    console.log(
      "[Bot] Playback queue full, dropped oldest item. Duration:",
      dropped.duration.toFixed(2) + "s",
    );
  }

  playbackQueue.push(audioBuffer);
  console.log(
    "[Bot] Queued audio for playback. Queue length:",
    playbackQueue.length,
  );

  // Start playback if not already playing
  if (!isPlaying) {
    playNext();
  }
}

/**
 * Plays the next AudioBuffer in the queue.
 * Uses AudioBufferSourceNode connected to MediaStreamDestination.
 */
function playNext() {
  if (playbackQueue.length === 0) {
    isPlaying = false;
    console.log("[Bot] Playback queue empty, stopping");
    return;
  }

  isPlaying = true;
  const audioBuffer = playbackQueue.shift();

  const audio = window.__translatorAudio;
  if (!audio || !audio.audioContext || !audio.mediaStreamDestination) {
    console.error("[Bot] Audio infrastructure gone during playback");
    isPlaying = false;
    return;
  }

  try {
    const source = audio.audioContext.createBufferSource();
    source.buffer = audioBuffer;

    // Connect to MediaStreamDestination (NOT to speakers)
    // This feeds audio into the local track that subscribers receive
    source.connect(audio.mediaStreamDestination);

    source.onended = function () {
      console.log(
        "[Bot] Playback chunk finished. Remaining in queue:",
        playbackQueue.length,
      );
      playNext();
    };

    source.start(0);
    console.log(
      "[Bot] Playing translated audio chunk. Duration:",
      audioBuffer.duration.toFixed(2) + "s",
    );
  } catch (error) {
    console.error("[Bot] Error during audio playback:", error);
    isPlaying = false;
    // Try next item
    if (playbackQueue.length > 0) {
      playNext();
    }
  }
}

/**
 * Returns playback health information for Node.js health checks.
 */
window.getPlaybackHealth = function () {
  const audio = window.__translatorAudio;
  const destStream =
    audio && audio.mediaStreamDestination
      ? audio.mediaStreamDestination.stream
      : null;

  return {
    trackPublished: localAudioTrack !== null,
    trackMuted: localAudioTrack ? localAudioTrack.isMuted() : true,
    destinationActive: destStream ? destStream.active : false,
    destinationTrackCount: destStream ? destStream.getAudioTracks().length : 0,
    queueLength: playbackQueue.length,
    isPlaying: isPlaying,
  };
};
