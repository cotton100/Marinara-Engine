/**
 * Gate C — text-level hallucination filter for Local Whisper output.
 *
 * Works on segments (Whisper `chunks` with timestamps, or a punctuation split
 * fallback without them) and applies, in order:
 *   rule 1  known hallucination phrase, whole-segment match only
 *   rule 2  repetition collapse (N identical segments in a row keep one)
 *   rule 3  short final segment after a long gap that contains a tail suspect
 * The phrase list is a user-edited JSON data file; nothing is hardcoded here.
 * Pure functions except `createSttPhraseLoader`, which reads that file.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname } from "path";

export interface SttSegment {
  text: string;
  /** Segment start in seconds. Missing/null disables rule 3 for this position. */
  start?: number | null;
  /** Segment end in seconds. Whisper reports null for an unterminated last chunk. */
  end?: number | null;
}

export type SttDropRule = 1 | 2 | 3;

export interface SttDroppedSegment {
  rule: SttDropRule;
  text: string;
}

export interface SttSanitizeResult {
  text: string;
  dropped: SttDroppedSegment[];
  /** Segments that survived, in order. Lets adapters rebuild timestamped chunks. */
  kept: SttSegment[];
}

export interface SttSanitizeOptions {
  repeatThreshold: number;
  tailGapSeconds: number;
  tailMaxChars: number;
}

export interface SttPhraseList {
  exact: string[];
  regex: string[];
  tailSuspects: string[];
}

export interface CompiledSttPhraseList {
  exact: ReadonlySet<string>;
  regex: readonly RegExp[];
  tailSuspects: readonly string[];
}

export const EMPTY_STT_PHRASE_LIST: CompiledSttPhraseList = Object.freeze({
  exact: new Set<string>(),
  regex: [],
  tailSuspects: [],
});

/**
 * NFKC → lower-case → drop everything that is not a letter or digit.
 * Hangul syllables are letters, so they survive intact (no jamo decomposition).
 * "I'm sorry." → "imsorry", "시청해 주셔서 감사합니다." → "시청해주셔서감사합니다".
 */
export function normalizeSttText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/**
 * Validates and compiles a raw phrase list. Exact and tail entries are normalized
 * the same way as transcripts, so a list author may write them with spaces or
 * punctuation. Regex entries are anchored to the whole normalized segment; an
 * invalid pattern is skipped and reported via `onInvalidRegex`.
 */
export function compileSttPhraseList(
  raw: unknown,
  onInvalidRegex?: (pattern: string, error: unknown) => void,
): CompiledSttPhraseList {
  const source = raw && typeof raw === "object" ? (raw as Partial<SttPhraseList>) : {};
  const exact = new Set(stringArray(source.exact).map(normalizeSttText).filter(Boolean));
  const regex: RegExp[] = [];
  for (const pattern of stringArray(source.regex)) {
    try {
      regex.push(new RegExp(`^(?:${pattern})$`, "u"));
    } catch (error) {
      onInvalidRegex?.(pattern, error);
    }
  }
  const tailSuspects = stringArray(source.tailSuspects).map(normalizeSttText).filter(Boolean);
  return { exact, regex, tailSuspects };
}

function isKnownHallucination(normalized: string, phrases: CompiledSttPhraseList): boolean {
  if (phrases.exact.has(normalized)) return true;
  return phrases.regex.some((pattern) => pattern.test(normalized));
}

function joinSegments(segments: readonly SttSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sanitizeSttSegments(
  segments: readonly SttSegment[],
  phrases: CompiledSttPhraseList,
  options: SttSanitizeOptions,
): SttSanitizeResult {
  const dropped: SttDroppedSegment[] = [];
  type Tagged = { segment: SttSegment; normalized: string };

  // Rule 1 — whole-segment match against the known list. Empty segments ("...") vanish silently.
  const afterRule1: Tagged[] = [];
  for (const segment of segments) {
    const normalized = normalizeSttText(segment.text);
    if (!normalized) continue;
    if (isKnownHallucination(normalized, phrases)) {
      dropped.push({ rule: 1, text: segment.text.trim() });
      continue;
    }
    afterRule1.push({ segment, normalized });
  }

  // Rule 2 — a run of identical segments at or above the threshold keeps its first member only.
  const threshold = Math.max(2, Math.floor(options.repeatThreshold));
  const afterRule2: Tagged[] = [];
  let index = 0;
  while (index < afterRule1.length) {
    const head = afterRule1[index]!;
    let runEnd = index + 1;
    while (runEnd < afterRule1.length && afterRule1[runEnd]!.normalized === head.normalized) runEnd += 1;
    const runLength = runEnd - index;
    if (runLength >= threshold) {
      afterRule2.push(head);
      for (let extra = index + 1; extra < runEnd; extra += 1) {
        dropped.push({ rule: 2, text: afterRule1[extra]!.segment.text.trim() });
      }
    } else {
      afterRule2.push(...afterRule1.slice(index, runEnd));
    }
    index = runEnd;
  }

  // Rule 3 — short final segment, long gap before it, contains a tail suspect. Needs timestamps.
  const kept = afterRule2;
  if (kept.length >= 2 && phrases.tailSuspects.length > 0) {
    const last = kept[kept.length - 1]!;
    const previous = kept[kept.length - 2]!;
    if (hasNumber(last.segment.start) && hasNumber(previous.segment.end)) {
      const gap = last.segment.start - previous.segment.end;
      const shortEnough = last.normalized.length <= options.tailMaxChars;
      const suspicious = phrases.tailSuspects.some((suspect) => last.normalized.includes(suspect));
      if (gap >= options.tailGapSeconds && shortEnough && suspicious) {
        kept.pop();
        dropped.push({ rule: 3, text: last.segment.text.trim() });
      }
    }
  }

  const keptSegments = kept.map((item) => item.segment);
  return { text: joinSegments(keptSegments), dropped, kept: keptSegments };
}

/** Fallback segmentation when the pipeline returned no timestamps: split on sentence punctuation / newlines. */
export function splitSttTextIntoSegments(text: string): SttSegment[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ text: part }));
}

type WhisperChunkLike = { text?: unknown; timestamp?: unknown };

/**
 * Adapter for the Transformers.js ASR output `{ text, chunks: [{ timestamp: [start, end|null], text }] }`.
 * Returns null when the output carries no usable chunks so the caller can fall back to text splitting.
 */
export function sttSegmentsFromAsrOutput(output: unknown): SttSegment[] | null {
  if (!output || typeof output !== "object") return null;
  const chunks = (output as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const segments: SttSegment[] = [];
  for (const chunk of chunks as WhisperChunkLike[]) {
    if (!chunk || typeof chunk.text !== "string") continue;
    const timestamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
    const start = timestamp[0];
    const end = timestamp[1];
    segments.push({
      text: chunk.text,
      start: hasNumber(start) ? start : null,
      end: hasNumber(end) ? end : null,
    });
  }
  return segments.length > 0 ? segments : null;
}

export interface SttPhraseLoader {
  /** Returns the current compiled list, reloading when the file's mtime changed. Never throws. */
  get(): CompiledSttPhraseList;
  readonly path: string;
}

/**
 * Creates a loader for the user-editable phrase file. If `path` does not exist yet
 * and `seedFrom` does, the bundled default is copied there once so the operator
 * has something to edit. A malformed file keeps the last good list.
 */
export function createSttPhraseLoader(
  path: string,
  options: { seedFrom?: string; warn?: (message: string, error?: unknown) => void } = {},
): SttPhraseLoader {
  const warn = options.warn ?? (() => undefined);
  let cached: CompiledSttPhraseList = EMPTY_STT_PHRASE_LIST;
  let cachedMtimeMs: number | null = null;

  if (!existsSync(path) && options.seedFrom && existsSync(options.seedFrom)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(options.seedFrom, path);
    } catch (error) {
      warn(`[stt-sanitize] Could not seed phrase list at ${path}`, error);
    }
  }

  const reload = (): void => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (error) {
      if (cachedMtimeMs !== null || cached !== EMPTY_STT_PHRASE_LIST) return; // keep last good copy
      warn(`[stt-sanitize] Phrase list not readable at ${path}; filter runs with an empty list`, error);
      cachedMtimeMs = Number.NaN; // do not repeat the warning every call
      return;
    }
    if (mtimeMs === cachedMtimeMs) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
      cached = compileSttPhraseList(raw, (pattern, error) =>
        warn(`[stt-sanitize] Ignoring invalid regex ${JSON.stringify(pattern)} in ${path}`, error),
      );
      cachedMtimeMs = mtimeMs;
    } catch (error) {
      warn(`[stt-sanitize] Could not parse ${path}; keeping the previous list`, error);
      cachedMtimeMs = mtimeMs;
    }
  };

  return {
    path,
    get() {
      reload();
      return cached;
    },
  };
}
