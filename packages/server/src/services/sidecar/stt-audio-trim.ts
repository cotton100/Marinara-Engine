/**
 * Gate A — PCM silence trim for Local Whisper input.
 *
 * Whisper hallucinates most reliably on trailing silence, and the Calls client
 * keeps recording for ~3 s after the last voiced frame before it stops. This
 * pure function cuts that tail (and optionally the head) before the samples
 * reach the model. It never resamples or decodes; it only picks a sub-range.
 */

export interface SttTrimOptions {
  /** Silence threshold in dBFS. Windows at or above it count as voiced. */
  thresholdDb: number;
  /** Audio kept after the last voiced window (ms). */
  tailPadMs: number;
  /** Audio kept before the first voiced window (ms). Ignored when trimHead is false. */
  headPadMs: number;
  /** Trim leading silence as well. */
  trimHead: boolean;
  /** Results shorter than this (ms) are reported as `skipped` with empty samples. */
  minAudioMs: number;
  /** RMS analysis window (ms). Default 25. */
  windowMs?: number;
}

export interface SttTrimResult {
  samples: Float32Array;
  /** True when the caller should not run the model at all (no voiced audio, or too short). */
  skipped: boolean;
  /** Start of the kept range in the input (ms). */
  startMs: number;
  /** End of the kept range in the input (ms). */
  endMs: number;
  inputMs: number;
  outputMs: number;
}

const EMPTY = new Float32Array(0);

function windowDbfs(samples: Float32Array, start: number, end: number): number {
  let sumSquares = 0;
  for (let index = start; index < end; index += 1) {
    const value = samples[index] ?? 0;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

function msOf(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}

export function trimSilence(samples: Float32Array, sampleRate: number, options: SttTrimOptions): SttTrimResult {
  const inputMs = msOf(samples.length, sampleRate);
  const skipped = (): SttTrimResult => ({ samples: EMPTY, skipped: true, startMs: 0, endMs: 0, inputMs, outputMs: 0 });
  if (!(sampleRate > 0) || samples.length === 0) return skipped();

  const windowSize = Math.max(1, Math.round((sampleRate * (options.windowMs ?? 25)) / 1000));
  const windowCount = Math.ceil(samples.length / windowSize);

  let firstVoiced = -1;
  let lastVoiced = -1;
  for (let window = 0; window < windowCount; window += 1) {
    const start = window * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    if (windowDbfs(samples, start, end) >= options.thresholdDb) {
      if (firstVoiced < 0) firstVoiced = window;
      lastVoiced = window;
    }
  }
  if (firstVoiced < 0) return skipped();

  const tailPad = Math.round((sampleRate * options.tailPadMs) / 1000);
  const headPad = Math.round((sampleRate * options.headPadMs) / 1000);
  const start = options.trimHead ? Math.max(0, firstVoiced * windowSize - headPad) : 0;
  const end = Math.min(samples.length, (lastVoiced + 1) * windowSize + tailPad);
  const outputMs = msOf(end - start, sampleRate);
  if (outputMs < options.minAudioMs) return skipped();

  return {
    samples: start === 0 && end === samples.length ? samples : samples.subarray(start, end),
    skipped: false,
    startMs: msOf(start, sampleRate),
    endMs: msOf(end, sampleRate),
    inputMs,
    outputMs,
  };
}
