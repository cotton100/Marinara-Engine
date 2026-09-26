/** No model/network: exercise the real WAV, model lifecycle and queue with a fake ASR factory. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { SidecarSpeechModelId } from "../../packages/shared/src/types/sidecar.js";

const dataDir = mkdtempSync(join(tmpdir(), "sidecar-speech-concurrency-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.MARINARA_ENV_FILE = join(dataDir, ".env");
writeFileSync(process.env.MARINARA_ENV_FILE, "");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network is forbidden in the speech concurrency regression");
};

const moduleUrl = new URL("../../packages/server/src/services/sidecar/sidecar-speech.service.ts", import.meta.url);
const { SidecarSpeechService } = await import("../../packages/server/src/services/sidecar/sidecar-speech.service.js");
const tinyPath = join(dataDir, "models", "Xenova", "whisper-tiny");
const basePath = join(dataDir, "models", "Xenova", "whisper-base");

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}

function seedModels() {
  for (const path of [tinyPath, basePath]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "fixture.bin"), "fake model; never loaded by ONNX");
  }
  writeFileSync(join(dataDir, "models", "sidecar-speech-config.json"), JSON.stringify({ modelId: "whisper_tiny" }));
}

function wav(): Buffer {
  const frames = 1600;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index += 1) buffer.writeInt16LE(8000, 44 + index * 2);
  return buffer;
}

class FakeSpeechService extends SidecarSpeechService {
  loads = 0;
  active = 0;
  maxActive = 0;
  resident = 0;
  maxResident = 0;
  failLoads = 0;
  failInference = false;
  loadStarted = deferred();
  inferenceStarted = deferred();
  loadGate: ReturnType<typeof deferred> | null = null;
  inferenceGate: ReturnType<typeof deferred> | null = null;
  events: string[] = [];

  protected override async createPipeline(modelId: SidecarSpeechModelId) {
    this.loads += 1;
    this.events.push(`load:${modelId}`);
    this.loadStarted.release();
    await this.loadGate?.promise;
    if (this.failLoads > 0) {
      this.failLoads -= 1;
      throw new Error("fixture model load failure");
    }
    this.resident += 1;
    this.maxResident = Math.max(this.maxResident, this.resident);
    const pipeline = async (_samples: Float32Array) => {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      this.events.push(`infer:${modelId}`);
      this.inferenceStarted.release();
      try {
        await this.inferenceGate?.promise;
        if (this.failInference) {
          this.failInference = false;
          throw new Error("fixture inference failure");
        }
        return { text: "fixture speech" };
      } finally {
        this.active -= 1;
        this.events.push(`finished:${modelId}`);
      }
    };
    pipeline.dispose = async () => {
      assert.equal(this.active, 0, "dispose must wait for inference");
      this.events.push(`dispose:${modelId}`);
      this.resident -= 1;
    };
    return pipeline;
  }
}

try {
  // The second request arrives while model creation is suspended. It must share
  // that model and run after the first utterance; a third buffer is not retained.
  seedModels();
  const concurrent = new FakeSpeechService();
  concurrent.loadGate = deferred();
  concurrent.inferenceGate = deferred();
  const first = concurrent.transcribeWav(wav());
  await concurrent.loadStarted.promise;
  const second = concurrent.transcribeWav(wav());
  await assert.rejects(concurrent.transcribeWav(wav()), /Local Whisper is busy/);
  assert.equal(concurrent.loads, 1);
  assert.equal(concurrent.getStatus().status, "loading", "metadata must not wait for the queue");
  concurrent.loadGate.release();
  await concurrent.inferenceStarted.promise;
  assert.equal(concurrent.active, 1);
  concurrent.inferenceGate.release();
  assert.deepEqual(await Promise.all([first, second]), ["fixture speech", "fixture speech"]);
  assert.equal(concurrent.loads, 1);
  assert.equal(concurrent.maxActive, 1);
  assert.equal(concurrent.maxResident, 1);
  assert.equal(await concurrent.transcribeWav(wav()), "fixture speech", "admission slots are released after success");
  await concurrent.deleteAllModels();

  // Rejected model loads and inference must not poison the queue or its slots.
  seedModels();
  const recovery = new FakeSpeechService();
  recovery.failLoads = 1;
  await assert.rejects(recovery.transcribeWav(wav()), /fixture model load failure/);
  recovery.failInference = true;
  await assert.rejects(recovery.transcribeWav(wav()), /fixture inference failure/);
  assert.equal(await recovery.transcribeWav(wav()), "fixture speech");
  assert.equal(recovery.loads, 2);
  assert.equal(recovery.maxActive, 1);
  await recovery.deleteAllModels();

  // A filesystem failure after native creation must release that session before
  // another load; otherwise a retry leaks the first model outside the cache.
  seedModels();
  const persistence = new FakeSpeechService();
  const configPath = join(dataDir, "models", "sidecar-speech-config.json");
  const savedConfigPath = join(dataDir, "saved-speech-config.json");
  renameSync(configPath, savedConfigPath);
  mkdirSync(configPath);
  await assert.rejects(persistence.transcribeWav(wav()));
  assert.equal(persistence.resident, 0, "configuration write failure must dispose the loaded model");
  assert.equal(persistence.getStatus().status, "error");
  renameSync(configPath, join(dataDir, "unwritable-config-fixture"));
  renameSync(savedConfigPath, configPath);
  assert.equal(await persistence.transcribeWav(wav()), "fixture speech");
  assert.equal(persistence.loads, 2);
  assert.equal(persistence.maxResident, 1);
  await persistence.deleteAllModels();

  // Model switching is also serialized: no second session is created while
  // inference owns the first model, and single-model deletion waits too.
  seedModels();
  const switching = new FakeSpeechService();
  switching.inferenceGate = deferred();
  const oldSpeech = switching.transcribeWav(wav());
  await switching.inferenceStarted.promise;
  const switchModel = switching.download("whisper_base");
  await Promise.resolve();
  assert.equal(switching.loads, 1);
  switching.inferenceGate.release();
  await Promise.all([oldSpeech, switchModel]);
  assert.equal(switching.maxResident, 1);
  assert.deepEqual(switching.events.slice(-2), ["dispose:whisper_tiny", "load:whisper_base"]);
  switching.inferenceStarted = deferred();
  switching.inferenceGate = deferred();
  const newSpeech = switching.transcribeWav(wav());
  await switching.inferenceStarted.promise;
  const deletion = switching.deleteModel("whisper_base");
  await Promise.resolve();
  assert.ok(existsSync(basePath));
  assert.equal(switching.active, 1);
  switching.inferenceGate.release();
  await Promise.all([newSpeech, deletion]);
  assert.equal(existsSync(basePath), false);
  await switching.deleteAllModels();

  // Distinct ESM identities simulate the Engine and bundled Calls copies.
  // Their exported classes are separate, but both exports must use one service.
  seedModels();
  const bridge = new FakeSpeechService();
  const key = Symbol.for("marinara.sidecar-speech-service.v1");
  const registry = globalThis as typeof globalThis & { [key]?: InstanceType<typeof SidecarSpeechService> };
  registry[key] = bridge;
  const engineCopy = await import(`${moduleUrl.href}?engine-copy`);
  const callsCopy = await import(`${moduleUrl.href}?calls-copy`);
  assert.notEqual(engineCopy.SidecarSpeechService, callsCopy.SidecarSpeechService, "both copies must be evaluated");
  assert.equal(engineCopy.sidecarSpeechService, bridge);
  assert.equal(callsCopy.sidecarSpeechService, engineCopy.sidecarSpeechService);
  bridge.loadGate = deferred();
  bridge.inferenceGate = deferred();
  const hostLoad = engineCopy.sidecarSpeechService.download("whisper_tiny");
  await bridge.loadStarted.promise;
  const packageSpeech = callsCopy.sidecarSpeechService.transcribeWav(wav());
  bridge.loadGate.release();
  await bridge.inferenceStarted.promise;
  const removal = engineCopy.sidecarSpeechService.deleteAllModels();
  await assert.rejects(callsCopy.sidecarSpeechService.transcribeWav(wav()), /being removed/);
  await assert.rejects(engineCopy.sidecarSpeechService.download("whisper_base"), /being removed/);
  assert.ok(existsSync(tinyPath), "uninstall must not delete an active model");
  assert.equal(bridge.loads, 1, "host load and Calls ASR share the same model");
  bridge.inferenceGate.release();
  await Promise.all([hostLoad, packageSpeech, removal]);
  assert.equal(bridge.maxActive, 1);
  assert.equal(bridge.resident, 0);
  assert.equal(existsSync(tinyPath), false);
  assert.equal(existsSync(basePath), false);
  assert.equal(bridge.getStatus().status, "not_downloaded");
  delete registry[key];
  console.log("sidecar-speech-concurrency regression passed");
} finally {
  globalThis.fetch = originalFetch;
  const resolvedFixture = resolve(dataDir);
  assert.ok(resolvedFixture.startsWith(resolve(tmpdir()) + sep));
  assert.ok(resolvedFixture.includes("sidecar-speech-concurrency-"));
  rmSync(resolvedFixture, { recursive: true, force: true });
}
