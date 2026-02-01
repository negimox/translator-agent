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

// Configuration from URL parameters
// Note: Named 'botConfig' to avoid conflict with Jitsi's global 'config' variable
const urlParams = new URLSearchParams(window.location.search);
const botConfig = {
    domain: urlParams.get('domain'),
    roomName: urlParams.get('room'),
    displayName: urlParams.get('displayName') || 'translator-bot',
};

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
    console.log('[Bot]', message);
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.textContent = message;
    }
}

/**
 * Initialize connection to Jitsi server
 */
function initConnection() {
    console.log('[Bot] Creating JitsiConnection with options:', options);
    
    connection = new JitsiMeetJS.JitsiConnection(null, null, options);

    connection.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
        onConnectionSuccess
    );
    connection.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_FAILED,
        onConnectionFailed
    );
    connection.addEventListener(
        JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED,
        onDisconnect
    );

    setStatus('Connecting to server...');
    connection.connect();
}

/**
 * Called when connection is established
 */
function onConnectionSuccess() {
    console.log('[Bot] Connection established');
    connectionEstablished = true;
    setStatus('Connected, joining room...');
    initRoom();
}

/**
 * Called when connection fails
 */
function onConnectionFailed(error) {
    console.error('[Bot] Connection failed:', error);
    setStatus('Connection failed: ' + error);
    window.__jitsiError = { type: 'connection_failed', error };
}

/**
 * Called when disconnected
 */
function onDisconnect() {
    console.log('[Bot] Disconnected');
    connectionEstablished = false;
    roomJoined = false;
    window.__jitsiJoined = false;
    setStatus('Disconnected');
}

/**
 * Initialize and join the conference room
 */
function initRoom() {
    if (!connectionEstablished) {
        console.log('[Bot] Waiting for connection...');
        setTimeout(initRoom, 1000);
        return;
    }

    console.log('[Bot] Initializing conference:', botConfig.roomName);
    room = connection.initJitsiConference(botConfig.roomName, options);

    // Conference events
    room.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, onConferenceJoined);
    room.on(JitsiMeetJS.events.conference.CONFERENCE_LEFT, onConferenceLeft);
    room.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, onConferenceFailed);
    room.on(JitsiMeetJS.events.conference.KICKED, onKicked);
    
    // Participant events
    room.on(JitsiMeetJS.events.conference.USER_JOINED, onUserJoined);
    room.on(JitsiMeetJS.events.conference.USER_LEFT, onUserLeft);
    
    // Track events
    room.on(JitsiMeetJS.events.conference.TRACK_ADDED, onTrackAdded);
    room.on(JitsiMeetJS.events.conference.TRACK_REMOVED, onTrackRemoved);

    // Set display name and join
    room.setDisplayName(botConfig.displayName);
    room.join();
}

/**
 * Called when we've joined the conference
 */
function onConferenceJoined() {
    console.log('[Bot] Conference joined!');
    roomJoined = true;
    setStatus('Joined as ' + botConfig.displayName);
    
    // Set global flags for Puppeteer to check
    window.__jitsiJoined = true;
    window.__jitsiRoomName = botConfig.roomName;
    window.__jitsiParticipantId = room.myUserId();
    
    console.log('[Bot] My participant ID:', room.myUserId());
    console.log('[Bot] Participants:', room.getParticipants().length);
}

/**
 * Called when we leave the conference
 */
function onConferenceLeft() {
    console.log('[Bot] Conference left');
    roomJoined = false;
    window.__jitsiJoined = false;
    setStatus('Left conference');
}

/**
 * Called when conference fails
 */
function onConferenceFailed(error) {
    console.error('[Bot] Conference failed:', error);
    setStatus('Conference failed: ' + error);
    window.__jitsiError = { type: 'conference_failed', error };
}

/**
 * Called when we get kicked
 */
function onKicked(actor, reason) {
    console.log('[Bot] Kicked by:', actor, 'Reason:', reason);
    setStatus('Kicked: ' + reason);
    window.__jitsiError = { type: 'kicked', actor, reason };
}

/**
 * Called when a user joins
 */
function onUserJoined(id, user) {
    const displayName = user.getDisplayName();
    console.log('[Bot] User joined:', id, displayName);
    
    // Check if this is a translator (for loop prevention in Phase 3)
    if (displayName && displayName.startsWith('translator-')) {
        console.log('[Bot] Translator participant detected, will exclude from audio capture');
    }
    
    // Log current participant count
    if (room) {
        console.log('[Bot] Total participants:', room.getParticipants().length + 1); // +1 for self
    }
}

/**
 * Called when a user leaves
 */
function onUserLeft(id, user) {
    console.log('[Bot] User left:', id, user?.getDisplayName());
}

/**
 * Called when a track is added
 */
function onTrackAdded(track) {
    console.log('[Bot] Track added:', track.getType(), 'from', track.getParticipantId());
}

/**
 * Called when a track is removed
 */
function onTrackRemoved(track) {
    console.log('[Bot] Track removed:', track.getType());
}

/**
 * Load config and lib-jitsi-meet from target Jitsi server
 */
function loadJitsiDependencies() {
    if (!botConfig.domain) {
        setStatus('Error: No domain specified');
        window.__jitsiError = { type: 'config', error: 'No domain specified' };
        return;
    }

    setStatus('Loading Jitsi dependencies from ' + botConfig.domain);

    // Load config.js
    const configScript = document.getElementById('jitsiConfig');
    configScript.src = `https://${botConfig.domain}/config.js`;
    
    configScript.onload = () => {
        console.log('[Bot] config.js loaded');
        
        // Merge server config with our options
        if (window.config) {
            options = { ...window.config, ...options };
            console.log('[Bot] Merged config:', options);
        }
        
        // Convert deprecated 'bosh' option to 'serviceUrl' (like jitsi-bot does)
        // Use botConfig.domain because it includes the correct port (e.g., :8443)
        if (options.bosh && !options.serviceUrl) {
            options.serviceUrl = `https://${botConfig.domain}/http-bind?room=${botConfig.roomName}`;
            delete options.bosh;
            console.log('[Bot] Converted bosh to serviceUrl:', options.serviceUrl);
        }
        
        // Ensure serviceUrl uses our domain with port if it doesn't already have it
        if (options.serviceUrl && !options.serviceUrl.includes(botConfig.domain)) {
            // Extract just the path from existing serviceUrl
            try {
                const url = new URL(options.serviceUrl);
                options.serviceUrl = `https://${botConfig.domain}${url.pathname}${url.search || '?room=' + botConfig.roomName}`;
                console.log('[Bot] Fixed serviceUrl with correct domain:', options.serviceUrl);
            } catch (e) {
                console.log('[Bot] Could not parse serviceUrl, using domain directly');
                options.serviceUrl = `https://${botConfig.domain}/http-bind?room=${botConfig.roomName}`;
            }
        }
        
        // Load lib-jitsi-meet
        const libScript = document.getElementById('libJitsiMeet');
        libScript.src = `https://${botConfig.domain}/libs/lib-jitsi-meet.min.js`;
        
        libScript.onload = () => {
            console.log('[Bot] lib-jitsi-meet loaded');
            startBot();
        };
        
        libScript.onerror = (err) => {
            console.error('[Bot] Failed to load lib-jitsi-meet:', err);
            setStatus('Failed to load lib-jitsi-meet');
            window.__jitsiError = { type: 'load', error: 'Failed to load lib-jitsi-meet' };
        };
    };
    
    configScript.onerror = (err) => {
        console.error('[Bot] Failed to load config.js:', err);
        setStatus('Failed to load config.js');
        window.__jitsiError = { type: 'load', error: 'Failed to load config.js' };
    };
}

/**
 * Start the bot after dependencies are loaded
 */
function startBot() {
    if (!window.JitsiMeetJS) {
        console.error('[Bot] JitsiMeetJS not available');
        setStatus('JitsiMeetJS not available');
        window.__jitsiError = { type: 'load', error: 'JitsiMeetJS not available' };
        return;
    }

    console.log('[Bot] Starting bot for room:', botConfig.roomName);
    console.log('[Bot] Display name:', botConfig.displayName);
    
    // Initialize JitsiMeetJS
    JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.WARN);
    JitsiMeetJS.init(options);
    
    setStatus('JitsiMeetJS initialized');
    
    // Start connection
    initConnection();
}

// Mark that bot script is loaded
window.__botLoaded = true;

// Start loading dependencies
loadJitsiDependencies();
