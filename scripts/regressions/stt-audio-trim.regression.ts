/**
 * Local Whisper hallucination filter — gate A (PCM silence trim).
 *
 * §7: 1 s sine + 5 s silence trims to ≈1.3 s; pure silence yields an empty result.
 * Also checks head trimming, the head switch, the minimum-length guard and that
 * the function never allocates when nothing needs cutting.
 */
import assert from "node:assert/strict";

const { trimSilence } = await import("../../packages/server/src/services/sidecar/stt-audio-trim.js");
const { STT_DEFAULT_CONFIG } = await import("../../packages/server/src/services/sidecar/stt-config.js");

const RATE = 16_000;
const defaults = {
  thresholdDb: STT_DEFAULT_CONFIG.trimThresholdDb,
  tailPadMs: STT_DEFAULT_CONFIG.trimTailPadMs,
  headPadMs: STT_DEFAULT_CONFIG.trimHeadPadMs,
  trimHead: STT_DEFAULT_CONFIG.trimHead,
  minAudioMs: STT_DEFAULT_CONFIG.minAudioMs,
};

function sine(seconds: number, amplitude = 0.3, hz = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let index = 0; index < out.length; index += 1)
    out[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / RATE);
  return out;
}
function silence(seconds: number, noise = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  if (noise > 0) for (let index = 0; index < out.length; index += 1) out[index] = (Math.random() * 2 - 1) * noise;
  return out;
}
function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ── §7: 1 s tone + 5 s silence → ≈1.3 s ─────────────────────────────
{
  const result = trimSilence(concat(sine(1), silence(5)), RATE, defaults);
  assert.equal(result.skipped, false);
  assert.ok(Math.abs(result.outputMs - 1300) <= 30, `expected ≈1300ms, got ${result.outputMs}`);
  assert.equal(result.startMs, 0);
  assert.equal(result.inputMs, 6000);
  assert.equal(result.samples.length, Math.round((result.outputMs * RATE) / 1000));
}

// ── §7: pure silence → empty, model call skipped ─────────────────────
{
  const result = trimSilence(silence(10), RATE, defaults);
  assert.equal(result.skipped, true);
  assert.equal(result.samples.length, 0);
  // Low-level noise floor (≈ -60 dBFS) is still silence at the -45 dBFS default.
  const noisy = trimSilence(silence(4, 0.001), RATE, defaults);
  assert.equal(noisy.skipped, true);
  assert.equal(trimSilence(new Float32Array(0), RATE, defaults).skipped, true);
}

// ── head trim keeps 500 ms before the first voiced window ────────────
{
  const result = trimSilence(concat(silence(2), sine(1), silence(3)), RATE, defaults);
  assert.equal(result.skipped, false);
  assert.ok(Math.abs(result.startMs - 1500) <= 30, `start ${result.startMs}`);
  assert.ok(Math.abs(result.endMs - 3300) <= 30, `end ${result.endMs}`);
  assert.ok(Math.abs(result.outputMs - 1800) <= 60, `output ${result.outputMs}`);

  const headOff = trimSilence(concat(silence(2), sine(1), silence(3)), RATE, { ...defaults, trimHead: false });
  assert.equal(headOff.startMs, 0, "STT_TRIM_HEAD=off leaves the head alone");
  assert.ok(Math.abs(headOff.outputMs - 3300) <= 30);
}

// ── minimum-length guard ─────────────────────────────────────────────
{
  // A 100 ms blip + 300 ms pad = 400 ms ≥ 300 ms default → kept.
  assert.equal(trimSilence(concat(sine(0.1), silence(2)), RATE, defaults).skipped, false);
  // Raise the minimum and the same blip is skipped.
  assert.equal(trimSilence(concat(sine(0.1), silence(2)), RATE, { ...defaults, minAudioMs: 600 }).skipped, true);
}

// ── nothing to trim → the input array itself is returned ─────────────
{
  const tone = sine(1);
  const result = trimSilence(tone, RATE, defaults);
  assert.equal(result.samples, tone);
  assert.equal(result.outputMs, 1000);
}

// ── threshold is honoured ────────────────────────────────────────────
{
  // -20 dBFS tone at amplitude 0.1 (≈ -23 dBFS RMS) is below a -20 dBFS threshold → skipped.
  assert.equal(trimSilence(sine(1, 0.1), RATE, { ...defaults, thresholdDb: -20 }).skipped, true);
  assert.equal(trimSilence(sine(1, 0.1), RATE, { ...defaults, thresholdDb: -30 }).skipped, false);
}

console.log("stt-audio-trim regression passed");
