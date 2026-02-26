/**
 * Orchestrator type definitions (Phase 7)
 */

/** Agent lifecycle states */
export type AgentState = 'spawning' | 'running' | 'stopping' | 'stopped' | 'failed';

/** Tracked participant in a conference room */
export interface TrackedParticipant {
  occupantJid: string;
  displayName?: string;
  spokenLanguage: string | null;
  joinedAt: number;
}

/** Tracked conference room */
export interface TrackedRoom {
  roomName: string;
  roomJid: string;
  isBreakout: boolean;
  createdAt: number;
  participants: Map<string, TrackedParticipant>;  // keyed by occupant_jid
}

/** Tracked translator agent */
export interface TrackedAgent {
  id: string;                    // `${roomName}:${language}`
  roomName: string;
  language: string;
  state: AgentState;
  pid: number | null;
  botPagePort: number;
  healthPort: number;
  spawnedAt: number;
  restartCount: number;
  lastHealthCheck: number | null;
  consecutiveHealthFailures: number;
}

/** Webhook event payloads from Prosody event_sync */
export interface RoomCreatedEvent {
  event_name: 'muc-room-created';
  room_name: string;
  room_jid: string;
  is_breakout: boolean;
  created_at: number;
}

export interface RoomDestroyedEvent {
  event_name: 'muc-room-destroyed';
  room_name: string;
  room_jid: string;
  is_breakout: boolean;
  created_at: number;
  destroyed_at: number;
  all_occupants: Array<{
    occupant_jid: string;
    name?: string;
    email?: string;
    id?: string;
    joined_at: number;
    left_at: number;
  }>;
}

export interface OccupantJoinedEvent {
  event_name: 'muc-occupant-joined';
  room_name: string;
  room_jid: string;
  is_breakout: boolean;
  active_occupants_count: number;
  occupant: {
    occupant_jid: string;
    name?: string;
    email?: string;
    id?: string;
    joined_at: number;
  };
}

export interface OccupantLeftEvent {
  event_name: 'muc-occupant-left';
  room_name: string;
  room_jid: string;
  is_breakout: boolean;
  active_occupants_count: number;
  occupant: {
    occupant_jid: string;
    name?: string;
    email?: string;
    id?: string;
    joined_at: number;
    left_at: number;
  };
}

export interface OccupantLanguageChangedEvent {
  event_name: 'muc-occupant-language-changed';
  room_name: string;
  room_jid: string;
  is_breakout: boolean;
  occupant: {
    occupant_jid: string;
    name: string;
    spoken_language: string;
  };
}

export type WebhookEvent =
  | RoomCreatedEvent
  | RoomDestroyedEvent
  | OccupantJoinedEvent
  | OccupantLeftEvent
  | OccupantLanguageChangedEvent;

/** IPC messages between orchestrator and child agents */
export interface RateLimitUpdateMessage {
  type: 'rate-limit-update';
  capacity: number;
  refillRate: number;
}

export interface MetricsMessage {
  type: 'metrics';
  pipelineMetrics: Record<string, unknown>;
}

export type IPCMessage = RateLimitUpdateMessage | MetricsMessage;
