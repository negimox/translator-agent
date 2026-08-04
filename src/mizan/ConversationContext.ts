/**
 * Conversation Context Manager
 *
 * Maintains a sliding window of recent dialogue turns to provide
 * conversational context for translation. This helps the LLM:
 * - Resolve pronouns (he, she, it, that)
 * - Maintain consistent terminology across chunks
 * - Understand discourse connectors (so, also, but)
 * - Translate ambiguous fragments with awareness of what came before
 *
 * Design decisions:
 * - Sliding window of N raw turns (no summarization — avoids extra API calls)
 * - Speaker labels for multi-participant disambiguation
 * - Staleness timeout to clear context after long pauses
 * - Context formatted for system-prompt-append injection
 */

import { createLogger } from "../logger";

const logger = createLogger("ConversationContext");

/**
 * A single dialogue turn: source transcription + translated output.
 */
export interface DialogueTurn {
  /** Original transcription (source language) */
  transcription: string;
  /** Translated text (target language) */
  translation: string;
  /** Short speaker label (e.g., "A", "B") */
  speakerLabel: string;
  /** Timestamp when this turn was added */
  timestamp: number;
}

/**
 * Configuration for the conversation context manager.
 */
export interface ConversationContextConfig {
  /** Number of recent turns to keep in the sliding window (default: 5) */
  windowSize: number;
  /** Milliseconds after which context is considered stale and cleared (default: 30000) */
  stalenessMs: number;
  /** Maximum characters per turn to store (truncates long transcriptions) */
  maxTurnChars: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_CONTEXT_CONFIG: ConversationContextConfig = {
  windowSize: 5,
  stalenessMs: 30000,
  maxTurnChars: 200,
};

/**
 * Conversation Context Manager.
 *
 * Maintains a sliding window of recent dialogue turns and formats
 * them for injection into the translation system prompt.
 */
export class ConversationContext {
  private config: ConversationContextConfig;
  private turns: DialogueTurn[] = [];
  private speakerMap: Map<string, string> = new Map();
  private speakerCounter = 0;

  constructor(config: Partial<ConversationContextConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };

    logger.info("ConversationContext initialized", {
      windowSize: this.config.windowSize,
      stalenessMs: this.config.stalenessMs,
    });
  }

  /**
   * Adds a completed dialogue turn to the context.
   *
   * @param transcription - Source language transcription
   * @param translation - Target language translation
   * @param speakerId - Optional speaker identifier (e.g., Jitsi participant ID)
   */
  addTurn(
    transcription: string,
    translation: string,
    speakerId?: string,
  ): void {
    // Truncate long text to stay within token budget
    const truncatedTranscription = this.truncate(
      transcription,
      this.config.maxTurnChars,
    );
    const truncatedTranslation = this.truncate(
      translation,
      this.config.maxTurnChars,
    );

    const speakerLabel = this.getSpeakerLabel(speakerId);

    const turn: DialogueTurn = {
      transcription: truncatedTranscription,
      translation: truncatedTranslation,
      speakerLabel,
      timestamp: Date.now(),
    };

    this.turns.push(turn);

    // Trim to window size
    if (this.turns.length > this.config.windowSize) {
      this.turns.shift();
    }

    logger.debug("Turn added to context", {
      speakerLabel,
      transcriptionLength: truncatedTranscription.length,
      translationLength: truncatedTranslation.length,
      windowSize: this.turns.length,
    });
  }

  /**
   * Returns a formatted context block for appending to the system prompt.
   *
   * Returns an empty string if:
   * - No turns are available (first chunk)
   * - All turns are stale (long pause in conversation)
   *
   * IMPORTANT: Only includes source-side transcriptions (not prior model
   * translations) to prevent error propagation. If a previous translation
   * was wrong (e.g., "weather" → "जल्दी"), including that translation in
   * context would cause the model to copy the error verbatim.
   *
   * Format:
   * \`\`\`
   * Recent conversation for reference (use ONLY for resolving pronouns and ambiguity, do NOT translate this):
   * [Speaker-A] "How long have you had this headache?"
   * [Speaker-B] "It started about 3 days ago"
   * \`\`\`
   */
  getContextBlock(): string {
    // Purge stale turns
    this.purgeStale();

    if (this.turns.length === 0) {
      return "";
    }

    const lines = this.turns.map(
      (turn) =>
        `[Speaker-${turn.speakerLabel}] "${turn.transcription}"`,
    );

    return [
      "",
      "Recent conversation for reference (use ONLY for resolving pronouns and ambiguity, do NOT translate this):",
      ...lines,
      "",
    ].join("\n");
  }

  /**
   * Returns the number of turns currently in the window.
   */
  get size(): number {
    return this.turns.length;
  }

  /**
   * Checks if context is available (non-empty and non-stale).
   */
  hasContext(): boolean {
    this.purgeStale();
    return this.turns.length > 0;
  }

  /**
   * Clears all context and resets speaker mapping.
   * Called when the pipeline stops or conversation resets.
   */
  reset(): void {
    const previousSize = this.turns.length;
    this.turns = [];
    this.speakerMap.clear();
    this.speakerCounter = 0;

    logger.info("ConversationContext reset", { previousSize });
  }

  /**
   * Gets a short, stable speaker label for a given speaker ID.
   *
   * Maps long Jitsi participant IDs (e.g., "a3f8d2e1-b4c5-...")
   * to short labels ("A", "B", "C", ...).
   *
   * If no speakerId is provided, uses a default label.
   */
  private getSpeakerLabel(speakerId?: string): string {
    if (!speakerId) {
      return "?";
    }

    const existing = this.speakerMap.get(speakerId);
    if (existing) {
      return existing;
    }

    // Assign next letter (A, B, C, ..., Z, AA, AB, ...)
    const label = this.indexToLabel(this.speakerCounter);
    this.speakerCounter++;
    this.speakerMap.set(speakerId, label);

    logger.debug("New speaker mapped", {
      speakerId: speakerId.substring(0, 8) + "...",
      label,
    });

    return label;
  }

  /**
   * Converts a numeric index to an alphabetic label.
   * 0 → "A", 1 → "B", ..., 25 → "Z", 26 → "AA", etc.
   */
  private indexToLabel(index: number): string {
    let label = "";
    let n = index;
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  }

  /**
   * Removes turns older than the staleness threshold.
   */
  private purgeStale(): void {
    if (this.turns.length === 0) {
      return;
    }

    const now = Date.now();
    const cutoff = now - this.config.stalenessMs;

    // Check if the most recent turn is stale — if so, clear everything
    const lastTurn = this.turns[this.turns.length - 1];
    if (lastTurn.timestamp < cutoff) {
      logger.debug("All context stale, clearing", {
        lastTurnAge: now - lastTurn.timestamp,
        stalenessMs: this.config.stalenessMs,
      });
      this.turns = [];
      return;
    }

    // Remove only individually stale turns from the front
    const originalLength = this.turns.length;
    while (this.turns.length > 0 && this.turns[0].timestamp < cutoff) {
      this.turns.shift();
    }

    if (this.turns.length < originalLength) {
      logger.debug("Purged stale turns", {
        removed: originalLength - this.turns.length,
        remaining: this.turns.length,
      });
    }
  }

  /**
   * Truncates text to a maximum character length, adding ellipsis if needed.
   */
  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }
    return text.substring(0, maxChars - 3) + "...";
  }

  // Removed detectFragment method (replaced by robust TextSegmenter logic)

  /**
   * Gets context metrics for monitoring.
   */
  getMetrics(): {
    turnsInWindow: number;
    uniqueSpeakers: number;
    oldestTurnAgeMs: number | null;
  } {
    return {
      turnsInWindow: this.turns.length,
      uniqueSpeakers: this.speakerMap.size,
      oldestTurnAgeMs:
        this.turns.length > 0 ? Date.now() - this.turns[0].timestamp : null,
    };
  }
}
