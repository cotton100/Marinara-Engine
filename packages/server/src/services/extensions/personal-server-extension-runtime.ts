import type { ChildProcess } from "node:child_process";
import { appendFile, open, readFile, stat } from "node:fs/promises";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { createPersonalExtensionSettingsStorage } from "./personal-extension-settings.service.js";
import { getPersonalExtensionCoordinationService } from "./personal-extension-coordination.service.js";
import { createPersonalExtensionsStorage } from "./personal-extension-storage.service.js";
import {
  canExecutePersonalExtension,
  getPersonalExtensionPolicy,
  isExternalPersonalExtensionSource,
} from "./personal-extension-policy.service.js";
import {
  spawnSandboxedPersonalExtension,
  type SandboxedPersonalExtensionProcess,
} from "./personal-extension-sandbox.js";
import type { PersonalExtension } from "@marinara-engine/shared";

type ActiveExtension = {
  id: string;
  contentHash: string;
  name: string;
  child: ChildProcess;
  sandbox: SandboxedPersonalExtensionProcess;
  expectedStop: boolean;
  watchdog: NodeJS.Timeout | null;
  outputPoller: NodeJS.Timeout | null;
  inputQueue: Promise<void>;
};
type RuntimeStatus = { status: "running" | "stopped" | "error"; error: string | null };
type RunnerMessage = {
  type?: string;
  requestId?: string;
  action?: "get" | "patch" | "delete";
  payload?: unknown;
  level?: "debug" | "info" | "warn" | "error";
  args?: unknown[];
  message?: string;
};

const LOG_LEVELS = new Set<NonNullable<RunnerMessage["level"]>>(["debug", "info", "warn", "error"]);
const STARTUP_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 3_000;
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_LOG_BYTES = 2 * 1024 * 1024;
const MAX_HEARTBEAT_BYTES = 128;

function describeError(error: unknown) {
  return error instanceof Error ? error.message || error.name : String(error);
}

export class PersonalServerExtensionRuntime {
  private db: DB | null = null;
  private active = new Map<string, ActiveExtension>();
  private statuses = new Map<string, RuntimeStatus>();
  private queue: Promise<void> = Promise.resolve();

  // Kept as an optional argument for compatibility with callers that used to
  // supply a module directory. Sandboxed extensions no longer write modules.
  constructor(_legacyRuntimeDir?: string) {}

  async start(db: DB) {
    this.db = db;
    await this.reloadAll();
  }

  async stop() {
    await this.stopAll();
    this.db = null;
  }

  withRuntimeStatus(extension: PersonalExtension): PersonalExtension {
    if (extension.runtime !== "server") return extension;
    const status = this.statuses.get(extension.id);
    return {
      ...extension,
      serverStatus: extension.enabled ? (status?.status ?? "stopped") : "stopped",
      serverError: status?.error ?? null,
    };
  }

  reloadAll() {
    this.queue = this.queue
      .then(() => this.reloadAllNow())
      .catch((error) => {
        logger.error(error, "[personal-extensions] Server sandbox reload failed");
      });
    return this.queue;
  }

  enforceExternalPolicy() {
    this.queue = this.queue
      .then(() => this.enforceExternalPolicyNow())
      .catch((error) => {
        logger.error(error, "[personal-extensions] Failed to enforce the External Extensions gate");
      });
    return this.queue;
  }

  reloadExtension(id: string) {
    this.queue = this.queue
      .then(() => this.reloadExtensionNow(id))
      .catch((error) => {
        logger.error(error, "[personal-extensions] Server extension reload failed for %s", id);
      });
    return this.queue;
  }

  unloadExtension(id: string) {
    this.queue = this.queue
      .then(() => this.unloadExtensionNow(id))
      .catch((error) => {
        logger.error(error, "[personal-extensions] Server extension unload failed for %s", id);
      });
    return this.queue;
  }

  private async enforceExternalPolicyNow() {
    if (!this.db) return;
    const policy = await getPersonalExtensionPolicy(this.db);
    if (!policy.externalExtensionsEnabled) {
      await createPersonalExtensionsStorage(this.db).disableExternal();
    }
    await this.reloadAllNow();
  }

  private async reloadAllNow() {
    if (!this.db) return;
    await this.stopAll();
    this.statuses.clear();
    const storage = createPersonalExtensionsStorage(this.db);
    const policy = await getPersonalExtensionPolicy(this.db);
    if (!policy.externalExtensionsEnabled) await storage.disableExternal();
    const extensions = await storage.list();
    for (const extension of extensions.filter((candidate) => candidate.runtime === "server")) {
      if (!extension.enabled || !canExecutePersonalExtension(extension, policy)) {
        if (extension.enabled && isExternalPersonalExtensionSource(extension.source)) {
          await storage.disable(extension.id);
        }
        this.statuses.set(extension.id, { status: "stopped", error: null });
        continue;
      }
      if (!policy.serverSandboxAvailable) {
        this.statuses.set(extension.id, { status: "error", error: policy.serverSandboxReason });
        await storage.disable(extension.id);
        continue;
      }
      await this.tryLoad(extension);
    }
  }

  private async reloadExtensionNow(id: string) {
    if (!this.db) return;
    await this.unloadExtensionNow(id);
    const extension = await createPersonalExtensionsStorage(this.db).getById(id);
    if (!extension || extension.runtime !== "server") return;
    const policy = await getPersonalExtensionPolicy(this.db);
    if (!extension.enabled || !canExecutePersonalExtension(extension, policy)) {
      this.statuses.set(id, { status: "stopped", error: null });
      return;
    }
    if (!policy.serverSandboxAvailable) {
      await createPersonalExtensionsStorage(this.db).disable(id);
      this.statuses.set(id, { status: "error", error: policy.serverSandboxReason });
      return;
    }
    await this.tryLoad(extension);
  }

  private async tryLoad(extension: PersonalExtension) {
    try {
      await this.load(extension);
      this.statuses.set(extension.id, { status: "running", error: null });
    } catch (error) {
      const message = describeError(error);
      this.statuses.set(extension.id, { status: "error", error: message });
      logger.error(error, "[personal-extensions] Failed to sandbox %s (%s)", extension.name, extension.id);
    }
  }

  private async unloadExtensionNow(id: string) {
    const active = this.active.get(id);
    this.active.delete(id);
    this.statuses.delete(id);
    if (active) await this.stopExtension(active);
  }

  private async stopAll() {
    const active = [...this.active.values()];
    this.active.clear();
    for (const extension of active) await this.stopExtension(extension);
  }

  private async stopExtension(extension: ActiveExtension) {
    extension.expectedStop = true;
    if (extension.watchdog) clearInterval(extension.watchdog);
    await this.send(extension, { type: "stop" });
    await Promise.race([
      new Promise<void>((resolve) => extension.child.once("close", () => resolve())),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (extension.child.exitCode === null && extension.child.signalCode === null) extension.child.kill("SIGKILL");
    await extension.sandbox.cleanup();
  }

  private async handleStorageMessage(extension: PersonalExtension, active: ActiveExtension, message: RunnerMessage) {
    if (!this.db || !message.requestId) return;
    const settings = createPersonalExtensionSettingsStorage(createAppSettingsStorage(this.db), {
      db: this.db,
      coordination: getPersonalExtensionCoordinationService(this.db),
    });
    try {
      let value: unknown;
      if (message.action === "get") value = await settings.get(extension.id);
      else if (message.action === "patch") {
        value = await settings.patchLegacy(extension.id, message.payload as Record<string, unknown>);
      } else if (message.action === "delete") {
        await settings.removeLegacy(extension.id);
        value = {};
      } else {
        throw new Error("Unknown storage action");
      }
      await this.send(active, { type: "storage-result", requestId: message.requestId, ok: true, value });
    } catch (error) {
      await this.send(active, {
        type: "storage-result",
        requestId: message.requestId,
        ok: false,
        error: describeError(error),
      });
    }
  }

  private send(active: ActiveExtension, message: unknown) {
    const serialized = `${JSON.stringify(message)}\n`;
    active.inputQueue = active.inputQueue.then(() => appendFile(active.sandbox.protocol.inputPath, serialized, "utf8"));
    return active.inputQueue;
  }

  private async load(extension: PersonalExtension) {
    if (!this.db) throw new Error("Personal extension runtime is not connected to storage");
    if (!extension.enabled || extension.approvedHash !== extension.contentHash) {
      throw new Error("Personal extension is not approved for its current content");
    }
    if (!extension.serverJs?.trim()) throw new Error("Server JavaScript is empty");

    const sandbox = await spawnSandboxedPersonalExtension();
    const { child } = sandbox;
    // Attach lifecycle listeners before the first setup await. A ChildProcess
    // that fails during `open` below would otherwise emit "error" with no
    // listener, which throws and crashes the main server process; a "close"
    // in the same window would be missed and leak the sandbox.
    let earlyExit: { code: number | null; signal: string | null; error?: Error } | null = null;
    const earlyErrorHandler = (error: Error) => {
      earlyExit = { code: null, signal: null, error };
    };
    const earlyCloseHandler = (code: number | null, signal: string | null) => {
      earlyExit = { code, signal };
    };
    child.once("error", earlyErrorHandler);
    child.once("close", earlyCloseHandler);

    const active: ActiveExtension = {
      id: extension.id,
      contentHash: extension.contentHash,
      name: extension.name,
      child,
      sandbox,
      expectedStop: false,
      watchdog: null,
      outputPoller: null,
      inputQueue: Promise.resolve(),
    };
    let outputBuffer = Buffer.alloc(0);
    let outputOffset = 0;
    let pollingOutput = false;
    let settled = false;
    let lastHeartbeat = Date.now();
    let messageWindowStartedAt = Date.now();
    let messageCount = 0;
    let outputHandle: Awaited<ReturnType<typeof open>>;
    try {
      outputHandle = await open(sandbox.protocol.outputPath, "r");
    } catch (error) {
      child.off("error", earlyErrorHandler);
      child.off("close", earlyCloseHandler);
      active.expectedStop = true;
      child.kill("SIGKILL");
      await sandbox.cleanup();
      throw error;
    }
    active.watchdog = setInterval(() => {
      if (active.expectedStop) return;
      void Promise.all([stat(sandbox.protocol.heartbeatPath), stat(sandbox.protocol.errorPath)])
        .then(([heartbeatStats, errorStats]) => {
          if (heartbeatStats.size > MAX_HEARTBEAT_BYTES || errorStats.size > MAX_ERROR_LOG_BYTES) {
            active.expectedStop = true;
            this.statuses.set(extension.id, {
              status: "error",
              error: "Server extension was stopped for exceeding a sandbox file limit",
            });
            child.kill("SIGKILL");
            return;
          }
          if (heartbeatStats.mtimeMs > lastHeartbeat) lastHeartbeat = heartbeatStats.mtimeMs;
          if (Date.now() - lastHeartbeat <= 5_000) return;
          active.expectedStop = true;
          this.statuses.set(extension.id, {
            status: "error",
            error: "Server extension was stopped because its sandbox became unresponsive",
          });
          child.kill("SIGKILL");
        })
        .catch(() => undefined);
    }, 250);
    active.watchdog.unref?.();

    const startup = new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
          return;
        }
        this.statuses.set(extension.id, { status: "error", error: message });
      };
      const pollOutput = async () => {
        if (pollingOutput) return;
        pollingOutput = true;
        try {
          const outputStats = await outputHandle.stat();
          if (outputStats.size > 64 * 1024 * 1024) {
            fail("Extension protocol output exceeded its lifetime quota");
            child.kill("SIGKILL");
            return;
          }
          const available = outputStats.size - outputOffset;
          if (available <= 0) return;
          const chunk = Buffer.alloc(available);
          const { bytesRead } = await outputHandle.read(chunk, 0, available, outputOffset);
          outputOffset += bytesRead;
          outputBuffer = Buffer.concat([outputBuffer, chunk.subarray(0, bytesRead)]);
          if (outputBuffer.byteLength > MAX_PROTOCOL_BYTES) {
            fail("Extension protocol message exceeded the size limit");
            child.kill("SIGKILL");
            return;
          }
          while (outputBuffer.includes(0x0a)) {
            const newline = outputBuffer.indexOf(0x0a);
            const line = outputBuffer.subarray(0, newline).toString("utf8");
            outputBuffer = outputBuffer.subarray(newline + 1);
            if (!line) continue;
            let message: RunnerMessage;
            try {
              message = JSON.parse(line) as RunnerMessage;
            } catch {
              fail("Extension emitted an invalid sandbox protocol message");
              child.kill("SIGKILL");
              return;
            }
            if (Date.now() - messageWindowStartedAt > 10_000) {
              messageWindowStartedAt = Date.now();
              messageCount = 0;
            }
            messageCount += 1;
            if (messageCount > 300) {
              fail("Extension exceeded the sandbox message limit");
              child.kill("SIGKILL");
              return;
            }
            if (message.type === "ready") {
              if (!settled) {
                settled = true;
                resolve();
              }
            } else if (message.type === "fatal" || message.type === "runtime-error") {
              fail(message.message || "Extension sandbox failed");
              active.expectedStop = true;
              child.kill("SIGKILL");
            } else if (message.type === "storage") {
              void this.handleStorageMessage(extension, active, message);
            } else if (message.type === "log" && message.level && LOG_LEVELS.has(message.level)) {
              logger[message.level](
                {
                  extensionId: extension.id,
                  extensionName: extension.name,
                  args: Array.isArray(message.args) ? message.args : [],
                },
                "[personal-extension] %s",
                extension.name,
              );
            }
          }
        } catch (error) {
          fail(describeError(error));
          child.kill("SIGKILL");
        } finally {
          pollingOutput = false;
        }
      };
      active.outputPoller = setInterval(() => void pollOutput(), 25);
      active.outputPoller.unref?.();
      void pollOutput();
      const handleClose = (code: number | null, signal: string | null) => {
        if (active.watchdog) clearInterval(active.watchdog);
        if (active.outputPoller) clearInterval(active.outputPoller);
        void outputHandle.close();
        this.active.delete(extension.id);
        void (async () => {
          if (!active.expectedStop) {
            const diagnostics = await readFile(sandbox.protocol.errorPath, "utf8").catch(() => "");
            const detail = diagnostics.trim() || `Sandbox exited with ${signal ?? code ?? "unknown status"}`;
            fail(detail);
          }
          await sandbox.cleanup();
        })();
      };
      // Hand off from the early setup-phase listeners, replaying an exit that
      // already happened while `open` was pending.
      child.off("error", earlyErrorHandler);
      child.off("close", earlyCloseHandler);
      child.once("error", (error) => fail(describeError(error)));
      child.once("close", handleClose);
      if (earlyExit) {
        if (earlyExit.error) fail(describeError(earlyExit.error));
        else handleClose(earlyExit.code, earlyExit.signal);
      }
    });

    await this.send(active, {
      type: "start",
      id: extension.id,
      name: extension.name,
      contentHash: extension.contentHash,
      source: extension.serverJs,
    });
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Personal extension sandbox startup timed out")),
        STARTUP_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([startup, timeout]);
      this.active.set(extension.id, active);
      logger.info(
        "[personal-extensions] Sandboxed %s (%s) at %s with %s",
        extension.name,
        extension.id,
        extension.contentHash,
        sandbox.backend,
      );
    } catch (error) {
      active.expectedStop = true;
      child.kill("SIGKILL");
      await sandbox.cleanup();
      throw error;
    }
  }
}

export const personalServerExtensionRuntime = new PersonalServerExtensionRuntime();
