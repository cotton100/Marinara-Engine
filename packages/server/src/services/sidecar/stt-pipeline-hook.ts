/**
 * Local Whisper hallucination filter — pipeline hook (gates A, B, C).
 *
 * Why a hook and not an edit of `sidecar-speech.service.ts`: the Calls package
 * ships its own bundled copy of that service inside its verified `server.mjs`,
 * and that copy — not the engine's — transcribes call audio. Both copies share
 * the engine's `@huggingface/transformers` module instance, so wrapping
 * `AutomaticSpeechRecognitionPipeline.prototype._call` once covers both without
 * touching either. See HANDOFF_marinara_stt_filter.md §9 P2/P3 and §12.
 *
 * The wrapper only acts for Whisper models fed a Float32Array (the engine's
 * decoded, 16 kHz mono PCM). Everything else passes straight through.
 */
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { capabilityPackageManager } from "../capability-packages/package-manager.service.js";
import { trimSilence } from "./stt-audio-trim.js";
import { readSttConfig, STT_PHRASES_FILE_NAME, type SttConfig } from "./stt-config.js";
import {
  createSttPhraseLoader,
  sanitizeSttSegments,
  splitSttTextIntoSegments,
  sttSegmentsFromAsrOutput,
  type CompiledSttPhraseList,
} from "./stt-sanitize.js";

const HOOK_MARKER = Symbol.for("marinara.stt-hallucination-filter.hooked");
const DEFAULT_SAMPLE_RATE = 16_000;
export const STT_NO_SPEECH_MESSAGE = "감지 실패";
const require = createRequire(import.meta.url);
const isLite = process.env.MARINARA_LITE === "true" || process.env.MARINARA_LITE === "1";

export interface SttHookLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
}

export interface SttHookDeps {
  config: () => SttConfig;
  phrases: () => CompiledSttPhraseList;
  log: SttHookLogger;
}

type AsrPipelineLike = {
  model?: { config?: { model_type?: unknown } };
  processor?: { feature_extractor?: { config?: { sampling_rate?: unknown } } };
};
type AsrCall = (this: AsrPipelineLike, audio: unknown, kwargs?: Record<string, unknown>) => Promise<unknown>;
type HookablePipelinePrototype = { _call?: AsrCall } & Record<symbol, unknown>;
export type HookablePipelineClass = { prototype: HookablePipelinePrototype };

export type SttHookApplyStatus = "applied" | "already-applied" | "unsupported";

function isWhisperModel(pipeline: AsrPipelineLike): boolean {
  return pipeline.model?.config?.model_type === "whisper";
}

function readSampleRate(pipeline: AsrPipelineLike): number {
  const rate = pipeline.processor?.feature_extractor?.config?.sampling_rate;
  return typeof rate === "number" && rate > 0 ? rate : DEFAULT_SAMPLE_RATE;
}

/** Gate B — merge the fixed decoding options over whatever the caller passed. */
export function mergeSttAsrOptions(
  kwargs: Record<string, unknown> | undefined,
  config: SttConfig,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...kwargs, task: "transcribe", return_timestamps: true };
  if (config.language) merged.language = config.language;
  else delete merged.language;
  return merged;
}

/**
 * Gate C adapter — sanitizes a Transformers.js ASR output while preserving its shape
 * (`{ text, chunks }` or an array of them). Returns the input object untouched when
 * no segments were removed so callers never see a rebuilt object without cause.
 */
export function sanitizeSttAsrOutput(
  output: unknown,
  phrases: CompiledSttPhraseList,
  config: SttConfig,
  log: SttHookLogger,
): unknown {
  if (Array.isArray(output)) return output.map((item) => sanitizeSttAsrOutput(item, phrases, config, log));
  if (!output || typeof output !== "object") return output;
  const record = output as { text?: unknown; chunks?: unknown };
  const originalText = typeof record.text === "string" ? record.text : "";
  const segments = sttSegmentsFromAsrOutput(record) ?? splitSttTextIntoSegments(originalText);
  const result = sanitizeSttSegments(segments, phrases, config);
  if (config.sanitizeLog) {
    for (const item of result.dropped) log.info('[stt-sanitize] rule=%d dropped="%s"', item.rule, item.text);
  }
  if (result.kept.length === segments.length) return output;
  return {
    ...record,
    text: result.text,
    chunks: result.kept.map((segment) => ({
      text: segment.text,
      timestamp: [segment.start ?? null, segment.end ?? null],
    })),
  };
}

/**
 * Wraps `PipelineClass.prototype._call` once. Idempotent: a second call reports
 * "already-applied" and changes nothing. Exported for tests, which pass a stand-in class.
 */
export function applySttPipelineHook(
  PipelineClass: HookablePipelineClass | undefined,
  deps: SttHookDeps,
): SttHookApplyStatus {
  const prototype = PipelineClass?.prototype;
  if (!prototype || typeof prototype._call !== "function") return "unsupported";
  if (prototype[HOOK_MARKER] === true) return "already-applied";
  const original = prototype._call;

  prototype._call = async function sttFilteredCall(
    this: AsrPipelineLike,
    audio: unknown,
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!isWhisperModel(this) || !(audio instanceof Float32Array)) return original.call(this, audio, kwargs);
    const config = deps.config();
    let samples = audio;
    if (config.trim) {
      const trimmed = trimSilence(audio, readSampleRate(this), {
        thresholdDb: config.trimThresholdDb,
        tailPadMs: config.trimTailPadMs,
        headPadMs: config.trimHeadPadMs,
        trimHead: config.trimHead,
        minAudioMs: config.minAudioMs,
      });
      if (trimmed.skipped) {
        if (config.sanitizeLog)
          deps.log.info("[stt-trim] Skipped model call: no voiced audio in %dms", Math.round(trimmed.inputMs));
        // Calls returns this message as HTTP 400 and shows a toast before saving
        // a chat message or starting an LLM turn. Never use it as transcript text.
        throw new Error(STT_NO_SPEECH_MESSAGE);
      }
      if (trimmed.samples !== audio) {
        deps.log.debug(
          "[stt-trim] %dms -> %dms (kept %d-%dms)",
          Math.round(trimmed.inputMs),
          Math.round(trimmed.outputMs),
          Math.round(trimmed.startMs),
          Math.round(trimmed.endMs),
        );
      }
      samples = trimmed.samples;
    }
    const output = await original.call(this, samples, mergeSttAsrOptions(kwargs, config));
    const filtered = config.sanitize ? sanitizeSttAsrOutput(output, deps.phrases(), config, deps.log) : output;
    const transcripts = Array.isArray(filtered) ? filtered : [filtered];
    if (
      transcripts.every(
        (item) => item && typeof item === "object" && typeof item.text === "string" && item.text.trim() === "",
      )
    ) {
      throw new Error(STT_NO_SPEECH_MESSAGE);
    }
    return filtered;
  };
  prototype[HOOK_MARKER] = true;
  return "applied";
}

function hasNativeOnnxRuntimeBinding(): boolean {
  try {
    const packageDir = dirname(require.resolve("onnxruntime-node/package.json"));
    return existsSync(join(packageDir, "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node"));
  } catch {
    return false;
  }
}

async function isConversationCallsInstalled(): Promise<boolean> {
  const installed = await capabilityPackageManager.installed();
  return installed.some((item) => item.status !== "error" && item.manifest.kind.includes("conversation-calls"));
}

export function bundledSttPhrasePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../assets", STT_PHRASES_FILE_NAME);
}

async function install(): Promise<boolean> {
  if (isLite) return false;
  const config = readSttConfig();
  if (!config.trim && !config.sanitize && !config.language) {
    logger.info("[stt-hook] All STT gates disabled by environment; Local Whisper output is not filtered");
    return false;
  }
  if (!hasNativeOnnxRuntimeBinding()) return false;
  if (!(await isConversationCallsInstalled())) {
    logger.debug("[stt-hook] Calls package not installed; skipping Local Whisper filter hook");
    return false;
  }

  const transformers = (await import("@huggingface/transformers")) as unknown as {
    AutomaticSpeechRecognitionPipeline?: HookablePipelineClass;
  };
  const phrasePath = config.phrasesPath ?? join(DATA_DIR, STT_PHRASES_FILE_NAME);
  const phrases = createSttPhraseLoader(phrasePath, {
    seedFrom: bundledSttPhrasePath(),
    warn: (message, error) => logger.warn(error, message),
  });
  phrases.get();
  const status = applySttPipelineHook(transformers.AutomaticSpeechRecognitionPipeline, {
    config: () => config,
    phrases: () => phrases.get(),
    log: logger,
  });
  if (status === "unsupported") {
    logger.warn("[stt-hook] AutomaticSpeechRecognitionPipeline._call not found; Local Whisper output is NOT filtered");
    return false;
  }
  logger.info(
    "[stt-hook] Local Whisper filter %s (language=%s trim=%s sanitize=%s phrases=%s)",
    status,
    config.language || "auto",
    config.trim ? "on" : "off",
    config.sanitize ? "on" : "off",
    phrasePath,
  );
  return true;
}

let installPromise: Promise<boolean> | null = null;

/**
 * Installs the hook once per process, in the background. Never rejects: any
 * failure is logged and the server keeps running with unfiltered transcripts.
 */
export function installSttPipelineHook(): Promise<boolean> {
  installPromise ??= install().catch((error: unknown) => {
    logger.warn(error, "[stt-hook] Failed to install Local Whisper filter hook");
    return false;
  });
  return installPromise;
}
