/**
 * Conference Tracker (Phase 7)
 *
 * Tracks rooms, participants, and their spoken languages based on
 * webhook events from Prosody's mod_event_sync_component.
 */

import { EventEmitter } from "events";
import { createLogger } from "../logger";
import {
  TrackedRoom,
  TrackedParticipant,
  RoomCreatedEvent,
  RoomDestroyedEvent,
  OccupantJoinedEvent,
  OccupantLeftEvent,
  OccupantLanguageChangedEvent,
} from "./types";

const logger = createLogger("ConferenceTracker");

export class ConferenceTracker extends EventEmitter {
  private rooms: Map<string, TrackedRoom> = new Map();

  constructor() {
    super();
    logger.info("ConferenceTracker initialized");
  }

  /**
   * Handle room creation.
   */
  onRoomCreated(event: RoomCreatedEvent): void {
    const { room_name, room_jid, is_breakout, created_at } = event;

    if (this.rooms.has(room_name)) {
      logger.warn(
        "Room already tracked, ignoring duplicate room-created event",
        { roomName: room_name },
      );
      return; // preserve existing participant state
    }

    const room: TrackedRoom = {
      roomName: room_name,
      roomJid: room_jid,
      isBreakout: is_breakout || false,
      createdAt: created_at || Date.now(),
      participants: new Map(),
    };

    this.rooms.set(room_name, room);
    logger.info("Room created", { roomName: room_name, roomJid: room_jid });
  }

  /**
   * Handle room destruction.
   */
  onRoomDestroyed(event: RoomDestroyedEvent): void {
    const { room_name } = event;
    this.rooms.delete(room_name);
    logger.info("Room destroyed", { roomName: room_name });
    this.emit("room-destroyed", { roomName: room_name });
  }

  /**
   * Handle occupant joining.
   */
  onOccupantJoined(event: OccupantJoinedEvent): void {
    const { room_name, occupant } = event;

    const room = this.ensureRoom(
      room_name,
      event.room_jid,
      event.is_breakout || false,
    );

    const participant: TrackedParticipant = {
      occupantJid: occupant.occupant_jid,
      displayName: occupant.name,
      spokenLanguage: null,
      joinedAt: occupant.joined_at || Date.now(),
    };

    room.participants.set(occupant.occupant_jid, participant);
    logger.info("Occupant joined", {
      roomName: room_name,
      occupantJid: occupant.occupant_jid,
      participantCount: room.participants.size,
    });

    this.emit("spawn-evaluation-needed", { roomName: room_name });
  }

  /**
   * Handle occupant leaving.
   */
  onOccupantLeft(event: OccupantLeftEvent): void {
    const { room_name, occupant } = event;

    const room = this.rooms.get(room_name);
    if (!room) {
      logger.warn("Room not found for occupant leave", { roomName: room_name });
      return;
    }

    room.participants.delete(occupant.occupant_jid);
    logger.info("Occupant left", {
      roomName: room_name,
      occupantJid: occupant.occupant_jid,
      participantCount: room.participants.size,
    });

    this.emit("termination-evaluation-needed", { roomName: room_name });
  }

  /**
   * Handle occupant language change. This is the primary trigger for spawn decisions.
   */
  onLanguageChanged(event: OccupantLanguageChangedEvent): void {
    const { room_name, occupant } = event;

    const room = this.ensureRoom(
      room_name,
      event.room_jid,
      event.is_breakout || false,
    );

    let participant = room.participants.get(occupant.occupant_jid);
    if (!participant) {
      // Participant not yet tracked (missed join event)
      participant = {
        occupantJid: occupant.occupant_jid,
        displayName: occupant.name,
        spokenLanguage: null,
        joinedAt: Date.now(),
      };
      room.participants.set(occupant.occupant_jid, participant);
    }

    const previousLanguage = participant.spokenLanguage;
    participant.spokenLanguage = occupant.spoken_language;
    if (occupant.name) {
      participant.displayName = occupant.name;
    }

    logger.info("Occupant language changed", {
      roomName: room_name,
      occupantJid: occupant.occupant_jid,
      previousLanguage,
      newLanguage: occupant.spoken_language,
    });

    this.emit("spawn-evaluation-needed", { roomName: room_name });

    // Also evaluate termination — the previous language may now be orphaned
    // (no participant speaks it), so stale agents should be cleaned up.
    this.emit("termination-evaluation-needed", { roomName: room_name });
  }

  /**
   * Ensures a room exists in the tracker. If not found, auto-creates it.
   * Handles cases where webhook events arrive for rooms we missed the
   * room-created event for (e.g., orchestrator restart while conferences are active).
   */
  private ensureRoom(
    roomName: string,
    roomJid: string,
    isBreakout: boolean,
  ): TrackedRoom {
    let room = this.rooms.get(roomName);
    if (!room) {
      logger.warn("Room not found, auto-creating", { roomName });
      room = {
        roomName,
        roomJid,
        isBreakout,
        createdAt: Date.now(),
        participants: new Map(),
      };
      this.rooms.set(roomName, room);
    }
    return room;
  }

  /**
   * Get a tracked room by name.
   */
  getRoom(roomName: string): TrackedRoom | undefined {
    return this.rooms.get(roomName);
  }

  /**
   * Get unique spoken languages in a room (excluding null/empty).
   */
  getRoomLanguages(roomName: string): Set<string> {
    const room = this.rooms.get(roomName);
    if (!room) return new Set();

    const languages = new Set<string>();
    for (const participant of room.participants.values()) {
      if (participant.spokenLanguage) {
        languages.add(participant.spokenLanguage);
      }
    }
    return languages;
  }

  /**
   * Get the total participant count for a room.
   */
  getParticipantCount(roomName: string): number {
    const room = this.rooms.get(roomName);
    return room ? room.participants.size : 0;
  }

  /**
   * Get all tracked rooms.
   */
  getAllRooms(): TrackedRoom[] {
    return Array.from(this.rooms.values());
  }

  /**
   * Serialize all rooms to a plain object for JSON responses.
   */
  toJSON(): Record<string, unknown>[] {
    return this.getAllRooms().map((room) => ({
      roomName: room.roomName,
      roomJid: room.roomJid,
      isBreakout: room.isBreakout,
      createdAt: room.createdAt,
      participantCount: room.participants.size,
      participants: Array.from(room.participants.values()),
      languages: Array.from(this.getRoomLanguages(room.roomName)),
    }));
  }
}
