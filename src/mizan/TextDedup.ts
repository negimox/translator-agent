/**
 * Text-Level Overlap Deduplication (Fix 2 — ported from live-translation/text_pipeline.py)
 *
 * The audio chunker prepends an overlap tail from the previous chunk so that
 * words straddling a chunk boundary aren't lost. The STT engine re-transcribes
 * those overlap frames, producing duplicated words at the start of the new
 * transcription. These functions detect and strip that duplication at the
 * text level — this is a robust fallback that works even when time-based
 * dedup fails (e.g. timestamp domain mismatch, missing word timestamps).
 *
 * Ported from: live-translation/live_translation/text_pipeline.py
 * Functions: merge_overlap_text, merge_partial_buffer, _same_token,
 *            _normalized_words, _common_prefix_len, _drop_prefix_words
 */

/**
 * Extracts an array of normalized (lowercased, de-hyphenated) words from text.
 * Equivalent to _normalized_words() in text_pipeline.py.
 */
export function normalizedWords(text: string): string[] {
  const matches = text.match(/[\w''\u0900-\u097F\u0600-\u06FF\u4E00-\u9FFF-]+/gu) || [];
  return matches.map((w) => w.toLowerCase().replace(/^[''\\-]+|[''\\-]+$/g, ""));
}

/**
 * Returns word match objects (with their start/end indices) for overlap trimming.
 */
function wordMatches(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/[\w''\u0900-\u097F\u0600-\u06FF\u4E00-\u9FFF-]+/gu)];
}

/**
 * Returns the length of the common prefix between two word arrays.
 */
function commonPrefixLen(a: string[], b: string[]): number {
  let n = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) break;
    n++;
  }
  return n;
}

/**
 * Whether two normalized words are the "same" word, allowing for re-transcribed
 * inflection changes at chunk boundaries (e.g. "energy" / "energies",
 * "took" / "take"). Requires a strong shared stem so distinct words
 * ("table"/"chair", "big"/"beautiful") are never collapsed.
 *
 * Equivalent to _same_token() in text_pipeline.py.
 */
export function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  return commonPrefixLen(a.split(""), b.split("")) >= Math.max(4, Math.floor(shorter * 0.6) + 1);
}

/**
 * Drops the first `wordCount` words (and any adjacent punctuation) from text.
 * Equivalent to _drop_prefix_words() in text_pipeline.py.
 */
function dropPrefixWords(text: string, wordCount: number): string {
  const matches = wordMatches(text);
  if (wordCount >= matches.length) return "";
  const target = matches[wordCount - 1];
  if (!target) return text;
  const end = (target.index ?? 0) + target[0].length;
  return text.slice(end).replace(/^[\s,.;:!?…\-—]+/, "");
}

/**
 * Removes overlapping text from the start of `incoming` that was already present
 * at the end of `previousTail`. This is the primary defence against audio-overlap
 * duplicates: when the chunker prepends a ~750ms tail from the previous chunk,
 * the STT re-transcribes those words; this function finds and strips them.
 *
 * Works at word-level (allowing inflection variants) and falls back to character-
 * level for robustness. Returns the de-duplicated text from `incoming`, or the
 * full `incoming` string if no overlap is found.
 *
 * Equivalent to merge_overlap_text() in text_pipeline.py.
 *
 * @param previousTail - The tail of the committed transcript (last ~200 chars).
 * @param incoming - The new STT transcription to dedup.
 * @param minOverlap - Minimum chars overlap to act on (avoids false positives).
 * @param maxOverlap - Maximum chars to scan for overlap.
 */
export function mergeOverlapText(
  previousTail: string,
  incoming: string,
  minOverlap = 12,
  maxOverlap = 120,
): string {
  incoming = incoming.replace(/\s+/g, " ").trim();
  previousTail = previousTail.replace(/\s+/g, " ").trim();

  if (!previousTail || !incoming) return incoming;

  const prevWords = normalizedWords(previousTail);
  const incomingWords = normalizedWords(incoming);

  // If the entire incoming is contained in the previous tail, it's fully duplicate.
  if (
    incomingWords.length > 0 &&
    prevWords.join(" ").includes(incomingWords.join(" "))
  ) {
    return "";
  }

  // Find the largest word overlap where leading words match exactly and the
  // boundary (last) word may be a re-transcribed stem variant — the common
  // chunk-seam duplication.
  const maxWords = Math.min(prevWords.length, incomingWords.length, 28);
  for (let size = maxWords; size >= 1; size--) {
    const prevSlice = prevWords.slice(prevWords.length - size);
    const incSlice = incomingWords.slice(0, size);

    // All words except the last must match exactly
    const innerMatch =
      size === 1 || prevSlice.slice(0, -1).join(" ") === incSlice.slice(0, -1).join(" ");
    if (!innerMatch) continue;

    // Last word may be a stem variant
    if (!sameToken(prevSlice[prevSlice.length - 1], incSlice[incSlice.length - 1])) continue;

    // A lone boundary word with no preceding anchor is only safe to drop when
    // it's a solid word (≥4 chars); otherwise short coincidental repeats would be eaten.
    if (size === 1) {
      const minLen = Math.min(prevSlice[0].length, incSlice[0].length);
      if (minLen < 4) continue;
    }

    return dropPrefixWords(incoming, size);
  }

  // Fallback: character-level overlap scan
  const prevLower = previousTail.toLowerCase();
  const incomingLower = incoming.toLowerCase();
  const maxLen = Math.min(prevLower.length, incomingLower.length, maxOverlap);
  for (let size = maxLen; size >= minOverlap; size--) {
    if (prevLower.slice(-size) === incomingLower.slice(0, size)) {
      return incoming.slice(size).replace(/^\s+/, "");
    }
  }

  return incoming;
}

/**
 * Merges a new STT transcription into an existing pending text buffer, handling
 * the case where the incoming text is a re-transcription of (part of) the buffer.
 *
 * When the TextSegmenter has partial text buffered and the next chunk arrives,
 * the new transcription may repeat the buffered fragment (because the overlap
 * audio includes it). This function detects and removes that duplication so
 * the buffer grows cleanly with only new words.
 *
 * Equivalent to merge_partial_buffer() in text_pipeline.py.
 *
 * @param buffer - The current pending text buffer for this speaker.
 * @param incoming - The new STT transcription to merge in.
 */
export function mergePartialBuffer(buffer: string, incoming: string): string {
  buffer = buffer.replace(/\s+/g, " ").trim();
  incoming = incoming.replace(/\s+/g, " ").trim();

  if (!buffer) return incoming;
  if (!incoming) return buffer;

  const bufferWords = normalizedWords(buffer);
  const incomingWords = normalizedWords(incoming);

  // If incoming starts with a run of words already in the buffer, find where the
  // buffer should be cut and splice in the incoming text.
  if (incomingWords.length >= 8) {
    const window = incomingWords.slice(0, Math.min(10, incomingWords.length)).join(" ");
    const joinedBuffer = bufferWords.join(" ");
    if (window && joinedBuffer.includes(window)) {
      const prefixWords = joinedBuffer.split(window)[0].split(" ").filter(Boolean);
      const keepWordCount = prefixWords.length;
      const matches = wordMatches(buffer);
      const cut =
        keepWordCount < matches.length
          ? (matches[keepWordCount]?.index ?? buffer.length)
          : buffer.length;
      return `${buffer.slice(0, cut).trim()} ${incoming}`.trim();
    }
  }

  // Fallback: text-level overlap merge
  const merged = mergeOverlapText(buffer.slice(-500), incoming, 8, 160);
  if (!merged) return buffer;
  return `${buffer} ${merged}`.trim();
}

/**
 * Trims a string to a maximum character count to prevent unbounded buffer growth.
 * Tries to cut at a word boundary to avoid breaking mid-word.
 */
export function trimBuffer(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Try to cut at a space boundary
  const cut = text.lastIndexOf(" ", maxChars);
  return cut > maxChars * 0.8 ? text.slice(0, cut) : text.slice(0, maxChars);
}
