/**
 * Local Whisper hallucination filter — environment configuration.
 *
 * All STT_* parsing lives here so the existing settings loader stays untouched.
 * Every value has a safe default; malformed input falls back to the default
 * instead of throwing, because a typo in .env must never take the server down.
 */

export interface SttConfig {
  /**
   * Whisper language passed to the pipeline: a code such as "ko", "en", "ja".
   * Empty string = auto-detect (Whisper picks one language per utterance).
   * STT_LANGUAGE accepts "auto" as an alias for the empty string.
   */
  language: string;
  /** Gate C (text hallucination filter) on/off. */
  sanitize: boolean;
  /** Log dropped segments at info level. */
  sanitizeLog: boolean;
  /** Rule 2: consecutive identical segments at or above this count keep only the first. */
  repeatThreshold: number;
  /** Rule 3: minimum silence gap (seconds) before the final segment. */
  tailGapSeconds: number;
  /** Rule 3: maximum normalized length of the final segment. */
  tailMaxChars: number;
  /** Gate A (PCM silence trim) on/off. */
  trim: boolean;
  /** Gate A: also trim leading silence. */
  trimHead: boolean;
  /** Gate A: silence threshold in dBFS (negative). */
  trimThresholdDb: number;
  /** Gate A: audio kept after the last voiced window (ms). */
  trimTailPadMs: number;
  /** Gate A: audio kept before the first voiced window (ms). */
  trimHeadPadMs: number;
  /** Gate A: trimmed audio shorter than this skips the model entirely (ms). */
  minAudioMs: number;
  /** Override path of the user-editable phrase list. null = <DATA_DIR>/stt-hallucination-phrases.json. */
  phrasesPath: string | null;
}

export const STT_DEFAULT_CONFIG: Readonly<SttConfig> = Object.freeze({
  language: "",
  sanitize: true,
  sanitizeLog: true,
  repeatThreshold: 3,
  tailGapSeconds: 1.5,
  tailMaxChars: 12,
  trim: true,
  trimHead: true,
  trimThresholdDb: -45,
  trimTailPadMs: 300,
  trimHeadPadMs: 500,
  minAudioMs: 300,
  phrasesPath: null,
});

export const STT_PHRASES_FILE_NAME = "stt-hallucination-phrases.json";

type EnvLike = Record<string, string | undefined>;

const ON_VALUES = new Set(["on", "true", "1", "yes"]);
const OFF_VALUES = new Set(["off", "false", "0", "no"]);

function parseSwitch(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (ON_VALUES.has(normalized)) return true;
  if (OFF_VALUES.has(normalized)) return false;
  return fallback;
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  bounds: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (bounds.integer && !Number.isInteger(parsed)) return fallback;
  if (bounds.min !== undefined && parsed < bounds.min) return fallback;
  if (bounds.max !== undefined && parsed > bounds.max) return fallback;
  return parsed;
}

/** Reads STT_* variables from `env` (defaults to process.env). Pure: no caching, no side effects. */
export function readSttConfig(env: EnvLike = process.env): SttConfig {
  const defaults = STT_DEFAULT_CONFIG;
  const rawLanguage = env.STT_LANGUAGE === undefined ? defaults.language : env.STT_LANGUAGE.trim().toLowerCase();
  const language = rawLanguage === "auto" ? "" : rawLanguage;
  const phrasesPath = env.STT_PHRASES_PATH?.trim();
  return {
    language,
    sanitize: parseSwitch(env.STT_SANITIZE, defaults.sanitize),
    sanitizeLog: parseSwitch(env.STT_SANITIZE_LOG, defaults.sanitizeLog),
    repeatThreshold: parseNumber(env.STT_REPEAT_THRESHOLD, defaults.repeatThreshold, { min: 2, integer: true }),
    tailGapSeconds: parseNumber(env.STT_TAIL_GAP_S, defaults.tailGapSeconds, { min: 0 }),
    tailMaxChars: parseNumber(env.STT_TAIL_MAX_CHARS, defaults.tailMaxChars, { min: 1, integer: true }),
    trim: parseSwitch(env.STT_TRIM, defaults.trim),
    trimHead: parseSwitch(env.STT_TRIM_HEAD, defaults.trimHead),
    trimThresholdDb: parseNumber(env.STT_TRIM_THRESHOLD_DB, defaults.trimThresholdDb, { min: -120, max: 0 }),
    trimTailPadMs: parseNumber(env.STT_TRIM_TAIL_PAD_MS, defaults.trimTailPadMs, { min: 0 }),
    trimHeadPadMs: parseNumber(env.STT_TRIM_HEAD_PAD_MS, defaults.trimHeadPadMs, { min: 0 }),
    minAudioMs: parseNumber(env.STT_MIN_AUDIO_MS, defaults.minAudioMs, { min: 0 }),
    phrasesPath: phrasesPath ? phrasesPath : null,
  };
}
