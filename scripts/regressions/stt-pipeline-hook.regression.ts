/**
 * Local Whisper hallucination filter — pipeline hook (gates A+B+C wired together).
 *
 * Uses a stand-in pipeline class shaped like Transformers.js' Callable-based
 * pipelines (a closure delegating to `prototype._call`) so the test needs no
 * model weights. The real @huggingface/transformers class must also pass;
 * missing runtime dependencies and assertion failures are test failures.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Importing the package manager must never touch an operator's DATA_DIR.
const testDataDir = mkdtempSync(join(tmpdir(), "stt-pipeline-hook-regression-"));
process.env.DATA_DIR = testDataDir;
process.env.MARINARA_ENV_FILE = join(testDataDir, ".env");
process.on("exit", () => rmSync(testDataDir, { recursive: true, force: true }));

const { applySttPipelineHook, mergeSttAsrOptions, sanitizeSttAsrOutput, STT_NO_SPEECH_MESSAGE } =
  await import("../../packages/server/src/services/sidecar/stt-pipeline-hook.js");
const { readSttConfig, STT_DEFAULT_CONFIG } = await import("../../packages/server/src/services/sidecar/stt-config.js");
const { compileSttPhraseList } = await import("../../packages/server/src/services/sidecar/stt-sanitize.js");

const RATE = 16_000;
const phrases = compileSttPhraseList({ exact: ["imsorry", "thankyou"], regex: [], tailSuspects: ["sorry"] });
const logs: string[] = [];
const log = {
  info: (message: string, ...args: unknown[]) => logs.push(`info ${message} ${args.join(" ")}`),
  warn: (message: string, ...args: unknown[]) => logs.push(`warn ${message} ${args.join(" ")}`),
  debug: (message: string, ...args: unknown[]) => logs.push(`debug ${message} ${args.join(" ")}`),
};

type Call = { audio: unknown; kwargs: Record<string, unknown> | undefined };

/** Mirrors transformers.js `Callable`: the instance is a closure that forwards to `_call` on the prototype. */
class FakeCallable {
  constructor() {
    const closure = function (this: unknown, ...args: unknown[]) {
      return (closure as unknown as { _call: (...a: unknown[]) => unknown })._call(...args);
    };
    return Object.setPrototypeOf(closure, new.target.prototype) as unknown as FakeCallable;
  }
}

/** Like transformers.js `Pipeline extends Callable`: fields land on the closure that super() returned. */
function makePipelineClass(modelType: string, respond: (audio: unknown) => unknown) {
  const calls: Call[] = [];
  class FakePipeline extends FakeCallable {
    model = { config: { model_type: modelType } };
    processor = { feature_extractor: { config: { sampling_rate: RATE } } };
    async _call(audio: unknown, kwargs?: Record<string, unknown>) {
      calls.push({ audio, kwargs });
      return respond(audio);
    }
  }
  return { FakePipeline, calls };
}

function tone(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let index = 0; index < out.length; index += 1) out[index] = 0.3 * Math.sin((2 * Math.PI * 440 * index) / RATE);
  return out;
}
function withTail(seconds: number, tailSeconds: number): Float32Array {
  const out = new Float32Array(Math.round((seconds + tailSeconds) * RATE));
  out.set(tone(seconds));
  return out;
}

// ── gate B: option merge ─────────────────────────────────────────────
{
  const merged = mergeSttAsrOptions(
    { chunk_length_s: 30, stride_length_s: 5, task: "translate" },
    {
      ...STT_DEFAULT_CONFIG,
      language: "ko",
    },
  );
  assert.deepEqual(merged, {
    chunk_length_s: 30,
    stride_length_s: 5,
    task: "transcribe",
    return_timestamps: true,
    language: "ko",
  });
  const defaults = mergeSttAsrOptions(undefined, STT_DEFAULT_CONFIG);
  assert.equal(defaults.language, "ko", "default explicitly selects Korean");
  assert.equal(defaults.return_timestamps, true);
  assert.equal(
    mergeSttAsrOptions({ language: "en" }, STT_DEFAULT_CONFIG).language,
    "ko",
    "configured language overrides a caller-supplied language",
  );
  for (const language of ["ko", "en", "ja"]) {
    assert.equal(mergeSttAsrOptions(undefined, readSttConfig({ STT_LANGUAGE: language })).language, language);
  }
  for (const language of ["", "auto", "not-a-language"]) {
    assert.equal(mergeSttAsrOptions({ language: "en" }, readSttConfig({ STT_LANGUAGE: language })).language, "ko");
  }
}

// ── gate C adapter keeps the output shape ────────────────────────────
{
  const original = {
    text: " 안녕 I'm sorry.",
    chunks: [
      { timestamp: [0, 1], text: " 안녕" },
      { timestamp: [3, null], text: " I'm sorry." },
    ],
  };
  const cleaned = sanitizeSttAsrOutput(original, phrases, STT_DEFAULT_CONFIG, log) as {
    text: string;
    chunks: unknown[];
  };
  assert.equal(cleaned.text, "안녕");
  assert.deepEqual(cleaned.chunks, [{ text: " 안녕", timestamp: [0, 1] }]);
  assert.ok(logs.some((line) => line.includes('[stt-sanitize] rule=%d dropped="%s" 1 I\'m sorry.')));

  const untouched = { text: " 안녕", chunks: [{ timestamp: [0, 1], text: " 안녕" }] };
  assert.equal(sanitizeSttAsrOutput(untouched, phrases, STT_DEFAULT_CONFIG, log), untouched, "no drop → same object");

  const batched = sanitizeSttAsrOutput(
    [{ text: "thank you" }, { text: "hello" }],
    phrases,
    STT_DEFAULT_CONFIG,
    log,
  ) as {
    text: string;
  }[];
  assert.deepEqual(
    batched.map((item) => item.text),
    ["", "hello"],
  );
  assert.equal(sanitizeSttAsrOutput("weird", phrases, STT_DEFAULT_CONFIG, log), "weird");

  logs.length = 0;
  sanitizeSttAsrOutput(original, phrases, { ...STT_DEFAULT_CONFIG, sanitizeLog: false }, log);
  assert.equal(logs.length, 0, "STT_SANITIZE_LOG=off silences drop logs");
}

// Empty normalized segments are removed even without a numbered drop rule.
{
  for (const original of [
    { text: "...", chunks: [{ text: "...", timestamp: [0, 1] }] },
    { text: "...", chunks: [] },
    { text: "。！？" },
  ]) {
    assert.deepEqual(sanitizeSttAsrOutput(original, phrases, STT_DEFAULT_CONFIG, log), {
      ...original,
      text: "",
      chunks: [],
    });
  }
  const original = {
    text: "안녕 ...",
    chunks: [
      { text: "안녕", timestamp: [0, 1] },
      { text: "...", timestamp: [1, 2] },
    ],
  };
  assert.deepEqual(sanitizeSttAsrOutput(original, phrases, STT_DEFAULT_CONFIG, log), {
    text: "안녕",
    chunks: [{ text: "안녕", timestamp: [0, 1] }],
  });
}

// ── full hook on a Whisper-shaped pipeline ───────────────────────────
{
  const { FakePipeline, calls } = makePipelineClass("whisper", () => ({
    text: " 안녕 잘 지냈어 I'm sorry. I'm sorry.",
    chunks: [
      { timestamp: [0, 1.2], text: " 안녕 잘 지냈어" },
      { timestamp: [1.4, 2.0], text: " I'm sorry." },
      { timestamp: [2.0, 2.6], text: " I'm sorry." },
    ],
  }));
  const deps = { config: () => ({ ...STT_DEFAULT_CONFIG }), phrases: () => phrases, log };
  assert.equal(applySttPipelineHook(FakePipeline, deps), "applied");
  assert.equal(applySttPipelineHook(FakePipeline, deps), "already-applied");

  const pipeline = new FakePipeline() as unknown as (
    audio: unknown,
    kwargs?: Record<string, unknown>,
  ) => Promise<unknown>;
  const output = (await pipeline(withTail(1, 4), { task: "transcribe" })) as { text: string; chunks: unknown[] };
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.ok(call.audio instanceof Float32Array);
  assert.ok(Math.abs((call.audio as Float32Array).length / RATE - 1.3) < 0.05, "gate A trimmed the 4 s tail to 300 ms");
  assert.deepEqual(call.kwargs, { task: "transcribe", return_timestamps: true, language: "ko" });
  assert.equal(output.text, "안녕 잘 지냈어");
  assert.equal(output.chunks.length, 1);

  // Pure silence never reaches the model.
  await assert.rejects(() => pipeline(new Float32Array(RATE * 3)), { message: STT_NO_SPEECH_MESSAGE });
  assert.equal(calls.length, 1, "model was not called for silence");

  // Non-Float32Array input (URL/Buffer) passes through untouched.
  await pipeline("https://example.invalid/audio.wav", { return_timestamps: "word" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.kwargs, { return_timestamps: "word" });
  assert.equal(calls[1]!.audio, "https://example.invalid/audio.wav");

  // Gates can be switched off independently.
  const rawDeps = { ...deps, config: () => ({ ...STT_DEFAULT_CONFIG, trim: false, sanitize: false }) };
  const { FakePipeline: Raw, calls: rawCalls } = makePipelineClass("whisper", () => ({ text: " I'm sorry." }));
  applySttPipelineHook(Raw, rawDeps);
  const raw = new Raw() as unknown as (audio: unknown) => Promise<{ text: string }>;
  const untouched = await raw(withTail(1, 4));
  assert.equal(rawCalls[0]!.audio, rawCalls[0]!.audio as Float32Array, "no trim");
  assert.equal((rawCalls[0]!.audio as Float32Array).length, RATE * 5, "STT_TRIM=off sends the full buffer");
  assert.equal(untouched.text, " I'm sorry.", "STT_SANITIZE=off returns the model text verbatim");
  assert.equal(rawCalls[0]!.kwargs?.return_timestamps, true, "gate B still applies");
  assert.equal(
    rawCalls[0]!.kwargs?.language,
    "ko",
    "turning trim and sanitize off does not remove the language setting",
  );
}

// Recognition failure is an error for the existing Calls toast, never spoken text.
{
  for (const response of [
    { text: "", chunks: [] },
    { text: "   " },
    { text: "...", chunks: [{ text: "...", timestamp: [0, 1] }] },
    { text: "I'm sorry.", chunks: [{ text: "I'm sorry.", timestamp: [0, 1] }] },
    [{ text: "" }, { text: " " }],
  ]) {
    const { FakePipeline } = makePipelineClass("whisper", () => response);
    applySttPipelineHook(FakePipeline, { config: () => ({ ...STT_DEFAULT_CONFIG }), phrases: () => phrases, log });
    const pipeline = new FakePipeline() as unknown as (audio: unknown) => Promise<unknown>;
    await assert.rejects(() => pipeline(tone(1)), { message: "감지 실패" });
  }
}

// The bundled defaults preserve real replies through the complete hook.
{
  const defaults = compileSttPhraseList(
    JSON.parse(
      readFileSync(new URL("../../packages/server/src/assets/stt-hallucination-phrases.json", import.meta.url), "utf8"),
    ),
  );
  for (const text of [
    "네",
    "감사합니다",
    "I'm sorry",
    "Thank you",
    "okay",
    "bye",
    "おやすみなさい",
    "ありがとうございました",
  ]) {
    const response = { text, chunks: [{ text, timestamp: [0, 1] }] };
    const { FakePipeline } = makePipelineClass("whisper", () => response);
    applySttPipelineHook(FakePipeline, { config: () => ({ ...STT_DEFAULT_CONFIG }), phrases: () => defaults, log });
    const pipeline = new FakePipeline() as unknown as (audio: unknown) => Promise<unknown>;
    assert.equal(await pipeline(tone(1)), response, "ordinary speech passes through without a failure notice");
  }
}

// ── non-Whisper ASR models are left alone ────────────────────────────
{
  const { FakePipeline, calls } = makePipelineClass("wav2vec2", () => ({ text: "thank you" }));
  applySttPipelineHook(FakePipeline, { config: () => ({ ...STT_DEFAULT_CONFIG }), phrases: () => phrases, log });
  const pipeline = new FakePipeline() as unknown as (
    audio: unknown,
    kwargs?: Record<string, unknown>,
  ) => Promise<{ text: string }>;
  const output = await pipeline(withTail(1, 4), { task: "transcribe" });
  assert.equal(output.text, "thank you");
  assert.equal((calls[0]!.audio as Float32Array).length, RATE * 5);
  assert.deepEqual(calls[0]!.kwargs, { task: "transcribe" });
}

// ── unsupported class shapes are reported, never thrown ──────────────
{
  assert.equal(
    applySttPipelineHook(undefined, { config: () => STT_DEFAULT_CONFIG, phrases: () => phrases, log }),
    "unsupported",
  );
  assert.equal(
    applySttPipelineHook({ prototype: {} }, { config: () => STT_DEFAULT_CONFIG, phrases: () => phrases, log }),
    "unsupported",
  );
}

// ── real Transformers.js class (required; no weights or network access) ──
{
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const serverRequire = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const transformers = (await import(
    pathToFileURL(serverRequire.resolve("@huggingface/transformers")).href
  )) as unknown as {
    AutomaticSpeechRecognitionPipeline?: new (options: Record<string, unknown>) => unknown;
  };
  const RealPipeline = transformers.AutomaticSpeechRecognitionPipeline;
  assert.ok(RealPipeline, "AutomaticSpeechRecognitionPipeline export exists");
  assert.equal(
    typeof (RealPipeline.prototype as { _call?: unknown })._call,
    "function",
    "real pipeline exposes prototype._call",
  );
  const realDeps = { config: () => ({ ...STT_DEFAULT_CONFIG }), phrases: () => phrases, log };
  assert.equal(applySttPipelineHook(RealPipeline as never, realDeps), "applied");
  assert.equal(applySttPipelineHook(RealPipeline as never, realDeps), "already-applied");

  // A real instance with a Whisper-shaped config: silence must short-circuit inside the wrapper
  // before any model code runs, proving the Callable closure → prototype._call delegation holds.
  const instance = new RealPipeline({
    task: "automatic-speech-recognition",
    model: { config: { model_type: "whisper" } },
    tokenizer: {},
    processor: { feature_extractor: { config: { sampling_rate: RATE } } },
  }) as (audio: unknown) => Promise<{ text: string }>;
  await assert.rejects(() => instance(new Float32Array(RATE * 2)), { message: STT_NO_SPEECH_MESSAGE });
  console.log("stt-pipeline-hook: attached to the real @huggingface/transformers AutomaticSpeechRecognitionPipeline");
}

console.log("stt-pipeline-hook regression passed");
