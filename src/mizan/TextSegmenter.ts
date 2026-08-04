import { createLogger } from "../logger";

const logger = createLogger("TextSegmenter");

/**
 * Text Segmenter for Translation Pipeline.
 * 
 * Replaces brittle audio-silence chunking with robust text-level segmentation.
 * Accumulates incoming transcription streams per speaker and splits them strictly 
 * on terminal punctuation boundaries.
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
    
    // Normalize spacing when appending
    if (buffer && text && !buffer.endsWith(" ") && !text.startsWith(" ")) {
      buffer += " " + text;
    } else {
      buffer += text;
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

    // Split logic modeled after live-translation's split_complete_sentences
    // We look for the LAST terminal punctuation to slice the buffer.
    const sentences: string[] = [];
    
    // Find all indices of terminal punctuation
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
      // We can optionally split by sentence here, but LLMs translate paragraphs well.
      // We'll just return the entire block of complete sentences as a single item.
      sentences.push(completeText);
    }

    this.buffers.set(speakerId, remainingText);

    if (sentences.length > 0) {
      logger.debug("Segmented complete sentences", {
        speakerId,
        sentences,
        remainingBuffered: remainingText
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
