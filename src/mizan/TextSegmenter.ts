import { createLogger } from "../logger";
import { mergePartialBuffer, trimBuffer } from "./TextDedup";

const logger = createLogger("TextSegmenter");

/**
 * Maximum character length for a speaker's pending text buffer.
 * Prevents unbounded growth if all dedup safety nets fail.
 */
const MAX_BUFFER_CHARS = 600;

/**
 * Text Segmenter for Translation Pipeline.
 *
 * Accumulates incoming transcription streams per speaker and splits them strictly
 * on terminal punctuation boundaries.
 *
 * Key improvement over the original: uses mergePartialBuffer() instead of blind
 * concatenation, so re-transcribed overlap words from the previous chunk are
 * detected and stripped before being added to the buffer.
 */
export class TextSegmenter {
  // Pending buffers per speaker: Map<speakerId, string>
  private buffers: Map<string, string> = new Map();

  // Terminal punctuation marks across languages (English, Hindi, Arabic, Urdu)
  private terminalPunctuation = /[.!?…۔؟।]/;

  /**
   * Processes incoming text, returning any complete sentences.
   * Trailing incomplete fragments are buffered for the next call.
   *
   * Uses overlap-aware merging: if incoming text re-transcribes words already
   * buffered (due to audio chunk overlap), they are detected and deduplicated
   * before appending — preventing the cascading duplication bug.
   *
   * @param text The new transcription text
   * @param speakerId The speaker identifier
   * @param forceFlush If true, forces the buffer to flush even if incomplete
   * @returns An array of complete sentences ready for translation
   */
  process(text: string, speakerId: string, forceFlush: boolean = false): string[] {
    if (!text && !forceFlush) {
      return [];
    }

    let buffer = this.buffers.get(speakerId) || "";

    if (text) {
      if (buffer) {
        // Use overlap-aware merge instead of blind concatenation.
        // mergePartialBuffer detects if `text` re-transcribes content already
        // in the buffer and splices it in cleanly instead of duplicating.
        buffer = mergePartialBuffer(buffer, text);
      } else {
        buffer = text.trim();
      }

      // Safety cap: prevent unbounded buffer growth
      buffer = trimBuffer(buffer, MAX_BUFFER_CHARS);
    }

    // Trim leading whitespace
    buffer = buffer.trimStart();

    if (!buffer) {
      this.buffers.set(speakerId, "");
      return [];
    }

    if (forceFlush) {
      this.buffers.set(speakerId, "");
      return [buffer.trim()];
    }

    // Split logic: find the LAST terminal punctuation to slice the buffer.
    const sentences: string[] = [];

    let lastTerminalIndex = -1;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (this.terminalPunctuation.test(buffer[i])) {
        lastTerminalIndex = i;
        break;
      }
    }

    if (lastTerminalIndex === -1) {
      // No complete sentences, keep in buffer
      this.buffers.set(speakerId, buffer);
      return [];
    }

    // We have at least one complete sentence
    const completeText = buffer.slice(0, lastTerminalIndex + 1).trim();
    const remainingText = buffer.slice(lastTerminalIndex + 1).trimStart();

    if (completeText) {
      sentences.push(completeText);
    }

    this.buffers.set(speakerId, remainingText);

    if (sentences.length > 0) {
      logger.debug("Segmented complete sentences", {
        speakerId,
        sentences,
        remainingBuffered: remainingText,
      });
    }

    return sentences;
  }

  /**
   * Clears the buffer for a specific speaker
   */
  clear(speakerId: string): void {
    this.buffers.delete(speakerId);
  }

  /**
   * Clears all buffers
   */
  clearAll(): void {
    this.buffers.clear();
  }
}
