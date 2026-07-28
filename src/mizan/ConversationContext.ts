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
  /** Whether this turn is a dangling fragment (ends mid-sentence) */
  isFragment: boolean;
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
  /** Pending fragment waiting to be merged with the next complete turn */
  private pendingFragment: DialogueTurn | null = null;

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
    const isFragment = this.detectFragment(truncatedTranscription);

    // Check if this turn subsumes a pending fragment (fragment merging)
    // e.g. fragment="How is the" → new turn="How is the weather there?"
    // The new turn already contains the complete sentence, so discard the fragment.
    if (this.pendingFragment) {
      const fragmentText = this.pendingFragment.transcription.trim().toLowerCase();
      const newText = truncatedTranscription.trim().toLowerCase();
      if (newText.startsWith(fragmentText) || newText.includes(fragmentText)) {
        logger.debug("Fragment merged into new turn", {
          fragment: this.pendingFragment.transcription,
          newTurn: truncatedTranscription.substring(0, 50),
        });
      } else {
        logger.debug("Fragment discarded (not subsumed by new turn)", {
          fragment: this.pendingFragment.transcription,
        });
      }
      this.pendingFragment = null;
    }

    const turn: DialogueTurn = {
      transcription: truncatedTranscription,
      translation: truncatedTranslation,
      speakerLabel,
      timestamp: Date.now(),
      isFragment,
    };

    // If this turn is a fragment, store it as pending but don't add to context
    if (isFragment) {
      this.pendingFragment = turn;
      logger.debug("Turn detected as fragment, stored as pending", {
        transcription: truncatedTranscription,
      });
      return;
    }

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
   * Format:
   * ```
   * Recent conversation for reference (use ONLY for resolving pronouns and ambiguity, do NOT translate this):
   * [Speaker-A] "How long have you had this headache?" → "تو یہ سر درد آپکو کب سے ہے؟"
   * [Speaker-B] "It started about 3 days ago" → "یہ تقریباً 3 دن پہلے شروع ہوا"
   * ```
   */
  getContextBlock(): string {
    // Purge stale turns
    this.purgeStale();

    if (this.turns.length === 0) {
      return "";
    }

    const lines = this.turns.map(
      (turn) =>
        `[Speaker-${turn.speakerLabel}] "${turn.transcription}" → "${turn.translation}"`,
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
    this.pendingFragment = null;
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

  /**
   * Detects if a transcription is a dangling fragment that ends mid-sentence.
   *
   * A fragment is a short transcription that ends with a function word
   * (article, preposition, conjunction, auxiliary verb), indicating the
   * speaker was interrupted mid-thought by the chunk boundary.
   *
   * Examples of fragments:
   * - "How is the" (ends with article)
   * - "I want to" (ends with preposition)
   * - "She said that" (ends with conjunction)
   *
   * NOT fragments:
   * - "How are you feeling today?" (complete sentence)
   * - "Take two tablets" (complete instruction)
   * - "Yes" (short but complete)
   */
  private detectFragment(text: string): boolean {
    const trimmed = text.trim();

    // Very short text (< 5 words) ending with a function word is likely a fragment
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return false;

    // If text ends with sentence-ending punctuation, it's not a fragment
    if (/[.!?]\s*$/.test(trimmed)) return false;

    // Function words that indicate a sentence was cut off mid-thought
    const FUNCTION_WORDS = new Set([
      // Articles
      "the", "a", "an",
      // Prepositions
      "to", "of", "in", "on", "at", "for", "with", "from", "by", "about",
      // Conjunctions
      "and", "or", "but", "that", "because", "since", "although", "while",
      // Auxiliary verbs (when sentence-final, they indicate continuation)
      "is", "are", "was", "were", "will", "would", "can", "could",
      "should", "shall", "do", "does", "did", "has", "have", "had",
      // Pronouns (when sentence-final)
      "I", "my", "your", "his", "her", "its", "our", "their",
      // Other
      "very", "really", "also", "just", "not",
    ]);

    const lastWord = words[words.length - 1].toLowerCase().replace(/[.,;:!?]$/, "");

    // Fragment = ends with function word AND is short (< 5 words)
    if (words.length < 5 && FUNCTION_WORDS.has(lastWord)) {
      return true;
    }

    return false;
  }

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
