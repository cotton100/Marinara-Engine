// A profile restore rewrites CMB config (app_settings) and protected lorebook
// rows outside the coordination guard. It must therefore refuse to run while any
// coordination row is non-inactive, and it must invalidate pre-restore authority
// afterwards. This regression pins both the behaviour and the wiring, so a mutant
// that drops the admission check or the fence bump fails.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB, encodeShardKey } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  appSettings,
  personalExtensionCoordination,
  personalExtensionOperationJournal,
} from "../../packages/server/src/db/schema/index.js";
import { personalExtensionsRoutes } from "../../packages/server/src/routes/personal-extensions.routes.js";
import {
  assertCoordinationIdleForRestore,
  backupRoutes,
  ProfileImportCoordinationBlockedError,
  PROFILE_FILE_BACKED_TABLES,
} from "../../packages/server/src/routes/backup.routes.js";
import { getPersonalExtensionCoordinationEventService } from "../../packages/server/src/services/extensions/personal-extension-coordination-events.service.js";
import { getPersonalExtensionCoordinationService } from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";
import { createPersonalExtensionsStorage } from "../../packages/server/src/services/extensions/personal-extension-storage.service.js";
import {
  getActivityState,
  recordUserActivity,
} from "../../packages/server/src/services/conversation/autonomous.service.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-coordination-restore-"));
const ADMIN_SECRET = "coordination-restore-regression-secret";
const previousEnv = new Map(
  [
    "ADMIN_SECRET",
    "DATA_DIR",
    "BYPASS_AUTH_TAILSCALE",
    "BYPASS_AUTH_DOCKER",
    "IP_ALLOWLIST",
    "ENABLE_EXTERNAL_EXTENSIONS",
  ].map((name) => [name, process.env[name]]),
);
process.env.ADMIN_SECRET = ADMIN_SECRET;
process.env.DATA_DIR = storageDir;
process.env.ENABLE_EXTERNAL_EXTENSIONS = "true";
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;

const isTableShardTempPath = (path: unknown, table: string) =>
  String(path).includes(join("tables", table)) && String(path).includes(".json.tmp-");
const coordinationShardPath = (root: string, extensionId: string) =>
  join(root, "tables", "personal_extension_coordination", `${encodeShardKey(extensionId)}.json`);

function cmbStorageValue(manualRecoveryReasons: string[], label: string) {
  return JSON.stringify({
    convoMemoryBridgeV1: {
      schemaVersion: 1,
      ensembles: [
        {
          ensembleId: "restore-ensemble",
          name: `Restore ${label}`,
          rpChatId: "restore-rp-chat",
          groupConvoChatIds: [],
          lorebookId: "restore-lorebook",
          autoSync: true,
          embedding: { connectionId: "__local_sidecar__", model: "local-sidecar" },
          runtime: {
            semanticStatus: "ready",
            lastSuccessfulEmbeddingProfile: null,
            pendingEmbeddingProfile: null,
            manualRecoveryReasons,
            lastSuccessfulSyncAt: null,
          },
          members: [{ castId: "alpha", characterId: "restore-character", dmChatId: "restore-dm-chat" }],
        },
      ],
    },
  });
}

// Upstream 2.4.2+ validates avatar-directory profile assets as images, so a
// restore fixture must carry a real image signature. Distinct trailing bytes
// keep each fixture distinguishable on disk.
function pngAsset(label: string) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label)]);
}

function profileEnvelope(
  storageKey: string,
  value: string,
  files: Array<{ path: string; size: number; data: string }> = [],
) {
  return {
    type: "marinara_profile",
    version: 1,
    data: {
      fileStorage: {
        version: 1,
        tables: { app_settings: [{ key: storageKey, value, updatedAt: new Date().toISOString() }] },
        ...(files.length > 0 ? { files } : {}),
      },
    },
  };
}

function importHeaders(secret?: string) {
  return {
    host: "127.0.0.1:7860",
    origin: "http://127.0.0.1:7860",
    "content-type": "application/json",
    ...(secret ? { "x-admin-secret": secret } : {}),
  };
}

async function settingValue(db: DB, key: string) {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return (rows as unknown as Array<{ value?: string }>)[0]?.value ?? null;
}

async function inspectCrashSnapshot(sourceDir: string, inspect: (db: DB) => Promise<void>) {
  const snapshotDir = mkdtempSync(join(tmpdir(), "marinara-restore-crash-snapshot-"));
  rmSync(snapshotDir, { recursive: true, force: true });
  cpSync(sourceDir, snapshotDir, { recursive: true });
  // The copy carries the live store's writer lease (upstream 2.4.3), whose PID
  // is this very process, so a second open would be refused. A real crash
  // snapshot is opened after its holder died; model that by dropping the lease.
  rmSync(join(snapshotDir, ".writer-lease"), { recursive: true, force: true });
  const previousDir = process.env.FILE_STORAGE_DIR;
  process.env.FILE_STORAGE_DIR = snapshotDir;
  let snapshotStore: Awaited<ReturnType<typeof createFileNativeDB>> | null = null;
  try {
    snapshotStore = await createFileNativeDB({
      fileOperations: { flushFile: async () => {}, flushDirectory: async () => {} },
    });
    await inspect(snapshotStore as unknown as DB);
  } finally {
    if (snapshotStore) await snapshotStore._fileStore.close();
    if (previousDir === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousDir;
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

async function coordinationState(db: DB, extensionId: string) {
  const rows = await db
    .select()
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, extensionId));
  const row = (
    rows as unknown as Array<{
      mode: string;
      fence: number;
      serverBootId: string;
      leaseTokenDigest: string | null;
      holderSessionId: string | null;
      activeOperations: string;
    }>
  )[0];
  assert.ok(row, `missing coordination row for ${extensionId}`);
  return row;
}

function assertFailedRestoreAuthoritySafe(
  before: Awaited<ReturnType<typeof coordinationState>>,
  after: Awaited<ReturnType<typeof coordinationState>>,
  label: string,
) {
  const unchanged =
    after.mode === before.mode && after.fence === before.fence && after.serverBootId === before.serverBootId;
  const durablyQuarantined =
    (after.mode === "blocked" || after.mode === "restoring") &&
    after.fence >= before.fence &&
    after.leaseTokenDigest === null &&
    after.holderSessionId === null &&
    after.activeOperations === "[]";
  assert.ok(unchanged || durablyQuarantined, `${label}: authority must roll back or remain fail-closed`);
}

async function runStrictRestoreFailureScenario(
  failurePoint:
    | "file-fsync"
    | "directory-fsync"
    | "asset-backup-file-fsync"
    | "asset-backup-directory-fsync"
    | "asset-file-fsync"
    | "asset-directory-fsync",
) {
  const scenarioDir = mkdtempSync(join(tmpdir(), `marinara-restore-${failurePoint}-`));
  const previousDir = process.env.FILE_STORAGE_DIR;
  const previousDataDir = process.env.DATA_DIR;
  process.env.FILE_STORAGE_DIR = scenarioDir;
  process.env.DATA_DIR = scenarioDir;
  const extensionId = `restore-${failurePoint}`;
  const storageKey = `extension-storage:${extensionId}`;
  const liveValue = cmbStorageValue([], `${failurePoint}-live`);
  const backupValue = cmbStorageValue([], `${failurePoint}-backup`);
  const expectedFailure = new Error(`simulated restore ${failurePoint} failure`);
  const assetPath = "avatars/restore-durability-proof.png";
  const assetOutputPath = join(scenarioDir, "avatars", "restore-durability-proof.png");
  const assetRollbackPathSuffix = join("rollback", "avatars", "restore-durability-proof.png");
  const assetRollbackDirectorySuffix = join("rollback", "avatars");
  const liveAsset = pngAsset("live-profile-asset");
  const backupAsset = pngAsset("backup-profile-asset");
  const assetFailure = failurePoint.startsWith("asset-");
  let armed = false;
  let sawRestoredPayload = false;
  let failureInjected = false;
  let assetOutputFlushes = 0;
  let assetRollbackFlushes = 0;
  let app: any = null;
  let fileDb: Awaited<ReturnType<typeof createFileNativeDB>> | null = null;

  try {
    fileDb = await createFileNativeDB({
      fileOperations: {
        writeFile: async (path, content) => {
          if (isTableShardTempPath(path, "app_settings") && String(content).includes(`${failurePoint}-backup`)) {
            sawRestoredPayload = true;
          }
          await writeFile(path, content);
        },
        flushFile: async (path) => {
          if (assetFailure && String(path) === assetOutputPath) assetOutputFlushes += 1;
          if (assetFailure && String(path).endsWith(assetRollbackPathSuffix)) assetRollbackFlushes += 1;
          if (
            armed &&
            failurePoint === "asset-backup-file-fsync" &&
            String(path).endsWith(assetRollbackPathSuffix) &&
            !failureInjected
          ) {
            failureInjected = true;
            throw expectedFailure;
          }
          if (armed && failurePoint === "asset-file-fsync" && String(path) === assetOutputPath && !failureInjected) {
            failureInjected = true;
            throw expectedFailure;
          }
          if (
            armed &&
            sawRestoredPayload &&
            failurePoint === "file-fsync" &&
            isTableShardTempPath(path, "app_settings") &&
            !failureInjected
          ) {
            failureInjected = true;
            throw expectedFailure;
          }
        },
        flushDirectory: async (path) => {
          if (
            armed &&
            failurePoint === "asset-backup-directory-fsync" &&
            String(path).endsWith(assetRollbackDirectorySuffix) &&
            !failureInjected
          ) {
            failureInjected = true;
            throw expectedFailure;
          }
          if (
            armed &&
            failurePoint === "asset-directory-fsync" &&
            String(path) === dirname(assetOutputPath) &&
            !failureInjected
          ) {
            failureInjected = true;
            throw expectedFailure;
          }
          if (armed && sawRestoredPayload && failurePoint === "directory-fsync" && !failureInjected) {
            failureInjected = true;
            throw expectedFailure;
          }
        },
      },
    });
    const db = fileDb as unknown as DB;
    const timestamp = new Date().toISOString();
    await db.insert(personalExtensionCoordination).values({
      extensionId,
      contentHash: `sha256:${extensionId}`,
      mode: "inactive",
      serverBootId: `${extensionId}-boot`,
      fence: 11,
      protectedLorebookRegistry: "{}",
      activeOperations: "[]",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(appSettings).values({ key: storageKey, value: liveValue, updatedAt: timestamp });
    if (assetFailure) {
      await mkdir(dirname(assetOutputPath), { recursive: true });
      await writeFile(assetOutputPath, liveAsset);
    }
    await fileDb._fileStore.flushStrict();
    const before = await coordinationState(db, extensionId);

    const Fastify = (await import("../../packages/server/node_modules/fastify/fastify.js")).default;
    app = Fastify();
    app.decorate("db", db);
    await app.register(backupRoutes, { prefix: "/api/backup" });
    await app.ready();

    armed = true;
    const response = await app.inject({
      method: "POST",
      url: "/api/backup/import-profile",
      headers: importHeaders(ADMIN_SECRET),
      payload: profileEnvelope(
        storageKey,
        backupValue,
        assetFailure ? [{ path: assetPath, size: backupAsset.byteLength, data: backupAsset.toString("base64") }] : [],
      ),
    });
    armed = false;
    assert.equal(failureInjected, true, `${failurePoint}: the actual route must reach the decorated strict barrier`);
    assert.ok(response.statusCode >= 400, `${failurePoint}: failed durability must not report restore success`);
    assert.equal(
      await settingValue(db, storageKey),
      liveValue,
      `${failurePoint}: in-memory profile data must roll back`,
    );
    assertFailedRestoreAuthoritySafe(before, await coordinationState(db, extensionId), `${failurePoint} in memory`);
    if (assetFailure) {
      if (failurePoint.startsWith("asset-backup-")) {
        assert.equal(
          assetOutputFlushes,
          0,
          `${failurePoint}: a failed rollback-copy barrier must precede every destructive output mutation`,
        );
        assert.ok(assetRollbackFlushes >= 1, `${failurePoint}: the rollback copy must reach its strict barrier`);
      } else {
        assert.ok(
          assetOutputFlushes >= 2,
          `${failurePoint}: the promoted asset and its restored rollback image must each reach a strict file barrier`,
        );
      }
      assert.deepEqual(
        await readFile(assetOutputPath),
        liveAsset,
        `${failurePoint}: failed asset durability must roll the promoted file back before returning`,
      );
    }

    await inspectCrashSnapshot(scenarioDir, async (reopenedDb) => {
      assert.equal(
        await settingValue(reopenedDb, storageKey),
        liveValue,
        `${failurePoint}: a crash snapshot must not reveal a restore that the route reported as failed`,
      );
      assertFailedRestoreAuthoritySafe(
        before,
        await coordinationState(reopenedDb, extensionId),
        `${failurePoint} crash snapshot`,
      );
    });
  } finally {
    armed = false;
    if (app) await app.close();
    if (fileDb) await fileDb._fileStore.close();
    if (previousDir === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousDir;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(scenarioDir, { recursive: true, force: true });
  }
}

async function runRestoreAuthorityPhaseFailureScenario(phase: "A" | "C") {
  const scenarioDir = mkdtempSync(join(tmpdir(), `marinara-restore-phase-${phase.toLowerCase()}-`));
  const previousDir = process.env.FILE_STORAGE_DIR;
  process.env.FILE_STORAGE_DIR = scenarioDir;
  const extensionId = `restore-phase-${phase.toLowerCase()}`;
  const storageKey = `extension-storage:${extensionId}`;
  const liveValue = cmbStorageValue([], `phase-${phase}-live`);
  const backupValue = cmbStorageValue([], `phase-${phase}-backup`);
  const originalFence = 23;
  const expectedFailure = new Error(`simulated restore Phase ${phase} strict failure`);
  let armed = false;
  let targetWriteSeen = false;
  let failureInjected = false;
  let app: any = null;
  let fileDb: Awaited<ReturnType<typeof createFileNativeDB>> | null = null;

  const assertPhaseAuthority = (
    before: Awaited<ReturnType<typeof coordinationState>>,
    after: Awaited<ReturnType<typeof coordinationState>>,
    label: string,
  ) => {
    if (phase === "A") {
      assert.deepEqual(
        { mode: after.mode, fence: after.fence, serverBootId: after.serverBootId },
        { mode: before.mode, fence: before.fence, serverBootId: before.serverBootId },
        `${label}: failed Phase A must leave the pre-restore authority image unchanged`,
      );
      return;
    }
    const failClosed =
      (after.mode === "blocked" || after.mode === "restoring") &&
      after.fence > before.fence &&
      after.leaseTokenDigest === null &&
      after.holderSessionId === null &&
      after.activeOperations === "[]";
    const completelyReleased =
      after.mode === "inactive" &&
      after.fence > before.fence &&
      after.serverBootId !== before.serverBootId &&
      after.leaseTokenDigest === null &&
      after.holderSessionId === null &&
      after.activeOperations === "[]";
    assert.ok(failClosed || completelyReleased, `${label}: failed Phase C must preserve a safe authority boundary`);
  };

  try {
    fileDb = await createFileNativeDB({
      fileOperations: {
        writeFile: async (path, content) => {
          if (armed && isTableShardTempPath(path, "personal_extension_coordination")) {
            const rows = JSON.parse(String(content)) as Array<{ extensionId?: string; mode?: string; fence?: number }>;
            const row = rows.find((candidate) => candidate.extensionId === extensionId);
            if (
              row &&
              Number(row.fence) > originalFence &&
              ((phase === "A" && row.mode === "restoring") || (phase === "C" && row.mode === "inactive"))
            ) {
              targetWriteSeen = true;
            }
          }
          await writeFile(path, content);
        },
        flushFile: async (path) => {
          if (
            armed &&
            targetWriteSeen &&
            isTableShardTempPath(path, "personal_extension_coordination") &&
            !failureInjected
          ) {
            failureInjected = true;
            throw expectedFailure;
          }
        },
        flushDirectory: async () => {},
      },
    });
    const db = fileDb as unknown as DB;
    const timestamp = new Date().toISOString();
    await db.insert(personalExtensionCoordination).values({
      extensionId,
      contentHash: `sha256:${extensionId}`,
      mode: "inactive",
      serverBootId: `${extensionId}-boot`,
      fence: originalFence,
      protectedLorebookRegistry: "{}",
      activeOperations: "[]",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(appSettings).values({ key: storageKey, value: liveValue, updatedAt: timestamp });
    await fileDb._fileStore.flushStrict();
    const before = await coordinationState(db, extensionId);

    const Fastify = (await import("../../packages/server/node_modules/fastify/fastify.js")).default;
    app = Fastify();
    app.decorate("db", db);
    await app.register(backupRoutes, { prefix: "/api/backup" });
    await app.ready();

    const activityChatId = `same-chat-id-before-phase-${phase.toLowerCase()}-failure`;
    recordUserActivity(activityChatId);
    assert.ok(getActivityState(activityChatId));
    armed = true;
    const response = await app.inject({
      method: "POST",
      url: "/api/backup/import-profile",
      headers: importHeaders(ADMIN_SECRET),
      payload: profileEnvelope(storageKey, backupValue),
    });
    armed = false;
    assert.equal(failureInjected, true, `Phase ${phase}: the intended strict authority write must be reached`);
    assert.ok(response.statusCode >= 400, `Phase ${phase}: strict failure must not report success`);
    assert.equal(
      getActivityState(activityChatId),
      undefined,
      `Phase ${phase}: every restore exit must invalidate pre-restore process-memory activity`,
    );
    assert.equal(
      await settingValue(db, storageKey),
      phase === "A" ? liveValue : backupValue,
      `Phase ${phase}: profile data must match the last completed durable phase`,
    );
    assertPhaseAuthority(before, await coordinationState(db, extensionId), `Phase ${phase} in memory`);

    await inspectCrashSnapshot(scenarioDir, async (reopenedDb) => {
      assert.equal(
        await settingValue(reopenedDb, storageKey),
        phase === "A" ? liveValue : backupValue,
        `Phase ${phase}: crash snapshot data must match the last completed durable phase`,
      );
      assertPhaseAuthority(before, await coordinationState(reopenedDb, extensionId), `Phase ${phase} crash snapshot`);
    });
  } finally {
    armed = false;
    if (app) await app.close();
    if (fileDb) await fileDb._fileStore.close();
    if (previousDir === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousDir;
    rmSync(scenarioDir, { recursive: true, force: true });
  }
}

async function runUnsupportedStrictRouteScenario() {
  const scenarioDir = mkdtempSync(join(tmpdir(), "marinara-restore-strict-unsupported-"));
  const previousDir = process.env.FILE_STORAGE_DIR;
  process.env.FILE_STORAGE_DIR = scenarioDir;
  const extensionId = "restore-strict-unsupported";
  const storageKey = `extension-storage:${extensionId}`;
  const liveValue = cmbStorageValue([], "strict-unsupported-live");
  const backupValue = cmbStorageValue([], "strict-unsupported-backup");
  let app: any = null;
  let fileDb: Awaited<ReturnType<typeof createFileNativeDB>> | null = null;
  let originalCapability: (() => boolean) | null = null;

  try {
    fileDb = await createFileNativeDB({
      fileOperations: { flushFile: async () => {}, flushDirectory: async () => {} },
    });
    const db = fileDb as unknown as DB;
    const timestamp = new Date().toISOString();
    await db.insert(personalExtensionCoordination).values({
      extensionId,
      contentHash: `sha256:${extensionId}`,
      mode: "inactive",
      serverBootId: `${extensionId}-boot`,
      fence: 13,
      protectedLorebookRegistry: "{}",
      activeOperations: "[]",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(appSettings).values({ key: storageKey, value: liveValue, updatedAt: timestamp });
    await fileDb._fileStore.flushStrict();
    const before = await coordinationState(db, extensionId);

    originalCapability = fileDb._fileStore.isStrictDurabilitySupported;
    fileDb._fileStore.isStrictDurabilitySupported = () => false;
    const Fastify = (await import("../../packages/server/node_modules/fastify/fastify.js")).default;
    app = Fastify();
    app.decorate("db", db);
    await app.register(backupRoutes, { prefix: "/api/backup" });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/backup/import-profile",
      headers: importHeaders(ADMIN_SECRET),
      payload: profileEnvelope(storageKey, backupValue),
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().code, "coordination-unavailable");
    assert.equal(
      await settingValue(db, storageKey),
      liveValue,
      "unsupported strict restore must write no profile data",
    );

    const streamedResponse = await app.inject({
      method: "POST",
      url: "/api/backup/import-profile",
      headers: { ...importHeaders(ADMIN_SECRET), accept: "text/event-stream" },
      payload: profileEnvelope(storageKey, backupValue),
    });
    assert.equal(streamedResponse.statusCode, 200, streamedResponse.body);
    assert.match(
      streamedResponse.body,
      /"code":"coordination-unavailable"/u,
      "the product SSE transport must preserve the closed strict-durability error code",
    );
    assert.equal(
      await settingValue(db, storageKey),
      liveValue,
      "unsupported streamed restore must also write no profile data",
    );
    const after = await coordinationState(db, extensionId);
    assert.deepEqual(
      { mode: after.mode, fence: after.fence, serverBootId: after.serverBootId },
      { mode: before.mode, fence: before.fence, serverBootId: before.serverBootId },
      "unsupported strict restore must not enter the restoring barrier",
    );
  } finally {
    if (fileDb && originalCapability) fileDb._fileStore.isStrictDurabilitySupported = originalCapability;
    if (app) await app.close();
    if (fileDb) await fileDb._fileStore.close();
    if (previousDir === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousDir;
    rmSync(scenarioDir, { recursive: true, force: true });
  }
}

async function runFinalBarrierConcurrencyScenario() {
  const scenarioDir = mkdtempSync(join(tmpdir(), "marinara-restore-final-barrier-"));
  const previousDir = process.env.FILE_STORAGE_DIR;
  process.env.FILE_STORAGE_DIR = scenarioDir;
  const extensionId = "restore-final-barrier";
  const secondExtensionId = "restore-final-barrier-new-extension";
  const storageKey = `extension-storage:${extensionId}`;
  const secondStorageKey = `extension-storage:${secondExtensionId}`;
  const liveValue = cmbStorageValue([], "barrier-live");
  const backupValue = cmbStorageValue([], "barrier-backup");
  let barrierHeld = false;
  let barrierPaused = false;
  let legacySerializedWhileHeld = false;
  let phaseCReleaseSerialized = false;
  let secondCoordinationSerializedBeforeRelease = false;
  let ordinarySettled = false;
  let ordinarySettledBeforePhaseCRelease = false;
  let enterBarrier!: () => void;
  let releaseBarrier!: () => void;
  const barrierEntered = new Promise<void>((resolve) => {
    enterBarrier = resolve;
  });
  const barrierRelease = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let app: any = null;
  let fileDb: Awaited<ReturnType<typeof createFileNativeDB>> | null = null;
  let restorePromise: Promise<any> | null = null;
  let legacyPromise: Promise<any> | null = null;
  let activationPromise: Promise<any> | null = null;
  let ordinaryWritePromise: Promise<any> | null = null;

  try {
    fileDb = await createFileNativeDB({
      fileOperations: {
        writeFile: async (path, content) => {
          const serialized = String(content);
          if (barrierHeld && serialized.includes("during-final-barrier")) legacySerializedWhileHeld = true;
          if (barrierPaused && isTableShardTempPath(path, "personal_extension_coordination")) {
            const rows = JSON.parse(serialized) as Array<{ extensionId?: string; mode?: string; fence?: number }>;
            const restoredRow = rows.find((row) => row.extensionId === extensionId);
            if (restoredRow?.mode === "inactive" && Number(restoredRow.fence) > 17) {
              phaseCReleaseSerialized = true;
              ordinarySettledBeforePhaseCRelease = ordinarySettled;
            }
            if (rows.some((row) => row.extensionId === secondExtensionId) && !phaseCReleaseSerialized) {
              secondCoordinationSerializedBeforeRelease = true;
            }
          }
          if (
            barrierHeld &&
            !barrierPaused &&
            isTableShardTempPath(path, "app_settings") &&
            serialized.includes("barrier-backup")
          ) {
            barrierPaused = true;
            enterBarrier();
            await barrierRelease;
          }
          await writeFile(path, content);
        },
        flushFile: async () => {},
        flushDirectory: async () => {},
      },
    });
    const db = fileDb as unknown as DB;
    const extensionStorage = createPersonalExtensionsStorage(db);
    const extension = await extensionStorage.create(
      { name: extensionId, runtime: "client", js: "self.postMessage({ type: 'ready' });" },
      { id: extensionId, source: "professor_mari" },
    );
    await extensionStorage.approve(extensionId, extension.contentHash);
    const secondExtension = await extensionStorage.create(
      {
        name: secondExtensionId,
        runtime: "client",
        capabilities: ["full_page_access"],
        js: "window.__restoreSecondExtension = true;",
      },
      { id: secondExtensionId, source: "external" },
    );
    await extensionStorage.approve(secondExtensionId, secondExtension.contentHash);
    const timestamp = new Date().toISOString();
    await db.insert(personalExtensionCoordination).values({
      extensionId,
      contentHash: extension.contentHash,
      mode: "inactive",
      serverBootId: `${extensionId}-boot`,
      fence: 17,
      protectedLorebookRegistry: "{}",
      activeOperations: "[]",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(appSettings).values({ key: storageKey, value: liveValue, updatedAt: timestamp });
    await db.insert(appSettings).values({ key: secondStorageKey, value: liveValue, updatedAt: timestamp });
    await db.insert(appSettings).values({ key: "external-extensions-enabled", value: "true", updatedAt: timestamp });
    await fileDb._fileStore.flushStrict();
    assert.deepEqual(
      await db
        .select()
        .from(personalExtensionCoordination)
        .where(eq(personalExtensionCoordination.extensionId, secondExtensionId)),
      [],
      "the second approved full-page extension starts without a coordination row",
    );

    const Fastify = (await import("../../packages/server/node_modules/fastify/fastify.js")).default;
    app = Fastify();
    app.decorate("db", db);
    await app.register(backupRoutes, { prefix: "/api/backup" });
    await app.register(personalExtensionsRoutes, { prefix: "/api/personal-extensions" });
    await app.ready();

    barrierHeld = true;
    restorePromise = Promise.resolve(
      app.inject({
        method: "POST",
        url: "/api/backup/import-profile",
        headers: importHeaders(ADMIN_SECRET),
        payload: profileEnvelope(storageKey, backupValue),
      }),
    );
    await Promise.race([
      barrierEntered,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("restore never reached the decorated final durability barrier")), 2_000),
      ),
    ]);

    let legacySettled = false;
    legacyPromise = Promise.resolve(
      app.inject({
        method: "PATCH",
        url: `/api/personal-extensions/${extensionId}/storage`,
        payload: { probe: "during-final-barrier" },
      }),
    ).finally(() => {
      legacySettled = true;
    });
    let activationSettled = false;
    activationPromise = getPersonalExtensionCoordinationService(db)
      .activateCoordination(secondExtensionId)
      .catch((error) => error)
      .finally(() => {
        activationSettled = true;
      });
    ordinaryWritePromise = Promise.resolve(
      db
        .update(appSettings)
        .set({ value: "ordinary-write-after-restore", updatedAt: new Date().toISOString() })
        .where(eq(appSettings.key, "external-extensions-enabled") as never),
    ).finally(() => {
      ordinarySettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(legacySettled, false, "legacy admission must not complete while the final restore barrier is open");
    assert.equal(activationSettled, false, "activation must not complete while the final restore barrier is open");
    assert.equal(ordinarySettled, false, "ordinary DB writes must wait while the restore sequence is open");
    assert.equal(legacySerializedWhileHeld, false, "legacy storage data must not be serialized during the barrier");
    const durableRowsDuringBarrier = JSON.parse(
      readFileSync(coordinationShardPath(scenarioDir, extensionId), "utf8"),
    ) as Array<{ extensionId?: string }>;
    assert.equal(
      durableRowsDuringBarrier.some((row) => row.extensionId === secondExtensionId),
      false,
      "activation of an extension absent from Phase A must not create a durable row during Phase B",
    );

    barrierHeld = false;
    releaseBarrier();
    const restored = await restorePromise;
    assert.equal(
      restored.statusCode,
      200,
      `the held restore must complete after the barrier is released: ${restored.body}`,
    );
    assert.equal(phaseCReleaseSerialized, true, "the original restoring row must be durably released first");
    assert.equal(
      ordinarySettledBeforePhaseCRelease,
      false,
      "ordinary DB writes must not interleave between restore phases B and C",
    );
    assert.equal(
      secondCoordinationSerializedBeforeRelease,
      false,
      "the process-wide restore gate must keep a new extension activation out until Phase C releases",
    );
    await Promise.allSettled([legacyPromise, activationPromise, ordinaryWritePromise]);
  } finally {
    barrierHeld = false;
    releaseBarrier();
    await Promise.allSettled(
      [restorePromise, legacyPromise, activationPromise, ordinaryWritePromise].filter(Boolean) as Promise<any>[],
    );
    if (app) await app.close();
    if (fileDb) await fileDb._fileStore.close();
    if (previousDir === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousDir;
    rmSync(scenarioDir, { recursive: true, force: true });
  }
}

try {
  const fileDb = await createFileNativeDB({ fileOperations: { writeFile, flushDirectory: async () => {} } });
  const db = fileDb as never as DB;
  const installedExtension = await createPersonalExtensionsStorage(db).create(
    {
      name: "restore-guard-extension",
      runtime: "client",
      js: "self.postMessage({ type: 'ready' });",
    },
    { id: "restore-guard-extension", source: "professor_mari" },
  );
  await createPersonalExtensionsStorage(db).approve("restore-guard-extension", installedExtension.contentHash);

  const timestamp = new Date().toISOString();
  const baseRow = {
    extensionId: "restore-guard-extension",
    contentHash: installedExtension.contentHash,
    serverBootId: "boot-before-restore",
    fence: 7,
    protectedLorebookRegistry: "{}",
    activeOperations: "[]",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const STORAGE_KEY = "extension-storage:restore-guard-extension";
  const markerConfig = cmbStorageValue(["mutation-ambiguous"], "live marker");
  const cleanLiveConfig = cmbStorageValue([], "live clean");
  const backupConfig = cmbStorageValue([], "backup");

  // 1. Neither coordination table may ride the generic profile table loop.
  assert.equal(
    PROFILE_FILE_BACKED_TABLES.includes("personal_extension_coordination" as never),
    false,
    "coordination rows must never be restored verbatim",
  );
  assert.equal(
    PROFILE_FILE_BACKED_TABLES.includes("personal_extension_operation_journal" as never),
    false,
    "operation journals must never be restored verbatim",
  );

  // 2. An idle inactive row lets a restore proceed.
  await db.insert(personalExtensionCoordination).values({ ...baseRow, mode: "inactive" });
  await db.insert(appSettings).values({ key: STORAGE_KEY, value: cleanLiveConfig, updatedAt: timestamp });
  const idle = await assertCoordinationIdleForRestore(db);
  assert.equal(idle.length, 1, "an idle profile must be restorable");

  // 3. Every live-authority shape blocks the restore with zero data mutation.
  for (const [label, patch] of [
    ["active mode", { mode: "active" }],
    ["activating mode", { mode: "activating" }],
    ["blocked mode", { mode: "blocked" }],
    ["held lease", { mode: "inactive", leaseTokenDigest: "digest" }],
    ["bound holder", { mode: "inactive", holderSessionId: "holder" }],
    ["pending handoff", { mode: "inactive", handoffRequestId: "handoff" }],
    ["live operation", { mode: "inactive", activeOperations: '[{"digest":"op"}]' }],
  ] as const) {
    await db
      .update(personalExtensionCoordination)
      .set({
        mode: "inactive",
        leaseTokenDigest: null,
        holderSessionId: null,
        handoffRequestId: null,
        activeOperations: "[]",
        ...patch,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(personalExtensionCoordination.extensionId, "restore-guard-extension") as never);
    await assert.rejects(
      assertCoordinationIdleForRestore(db),
      (error: unknown) =>
        error instanceof ProfileImportCoordinationBlockedError &&
        error.code === "coordination-transition-blocked" &&
        error.extensionIds.includes("restore-guard-extension"),
      `${label} must block a profile restore`,
    );
  }

  // 3b. An idle row is still blocked while an operation journal is unresolved.
  // This covers older/inconsistent persisted state; restoring over it would
  // erase the only evidence of a possible protected write.
  await db
    .update(personalExtensionCoordination)
    .set({
      mode: "inactive",
      leaseTokenDigest: null,
      holderSessionId: null,
      handoffRequestId: null,
      activeOperations: "[]",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(personalExtensionCoordination.extensionId, "restore-guard-extension") as never);
  await assertCoordinationIdleForRestore(db);

  for (const phase of ["prepared", "dispatching"] as const) {
    const journalTimestamp = new Date().toISOString();
    await db.insert(personalExtensionOperationJournal).values({
      operationDigest: `journal-${phase}`,
      extensionId: "restore-guard-extension",
      targetEnsembleId: "ensemble-1",
      operationKind: "mutation",
      fence: 7,
      phase,
      protectedResourceRevisions: "[]",
      preparedAt: journalTimestamp,
      dispatchingAt: phase === "dispatching" ? journalTimestamp : null,
      finalAt: null,
      updatedAt: journalTimestamp,
    });
    await assert.rejects(
      assertCoordinationIdleForRestore(db),
      (error: unknown) =>
        error instanceof ProfileImportCoordinationBlockedError &&
        error.extensionIds.includes("restore-guard-extension"),
      `an unresolved ${phase} journal must block a profile restore`,
    );
    await db
      .update(personalExtensionOperationJournal)
      .set({ phase: "final", finalAt: journalTimestamp, updatedAt: journalTimestamp })
      .where(eq(personalExtensionOperationJournal.operationDigest, `journal-${phase}`) as never);
  }
  const resolved = await assertCoordinationIdleForRestore(db);
  assert.equal(resolved.length, 1, "final journals must not block a restore");

  const unrelatedJournalAt = new Date().toISOString();
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: "unrelated-extension-journal",
    extensionId: "unrelated-non-cmb-extension",
    targetEnsembleId: "unrelated-ensemble",
    operationKind: "mutation",
    fence: 0,
    phase: "dispatching",
    protectedResourceRevisions: "[]",
    preparedAt: unrelatedJournalAt,
    dispatchingAt: unrelatedJournalAt,
    finalAt: null,
    updatedAt: unrelatedJournalAt,
  });
  assert.equal(
    (await assertCoordinationIdleForRestore(db)).length,
    1,
    "an unrelated extension journal must not contaminate the CMB profile-restore admission set",
  );

  // 3c. Recovery evidence can outlive its journal. This is the actual CMB
  // extension-storage shape, not a test-only `marker` shortcut. An inactive row
  // with `mutation-ambiguous` must still refuse a restore (or the restore must
  // merge that reason back); otherwise a clean backup silently erases the last
  // proof that a protected mutation may have dispatched.
  await db
    .update(appSettings)
    .set({ value: markerConfig, updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_KEY));
  await assert.rejects(
    assertCoordinationIdleForRestore(db),
    (error: unknown) =>
      error instanceof ProfileImportCoordinationBlockedError && error.extensionIds.includes("restore-guard-extension"),
    "a marker-only inactive CMB config must not be admitted as a clean restore",
  );
  await db
    .update(appSettings)
    .set({ value: cleanLiveConfig, updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_KEY) as never);
  assert.equal((await assertCoordinationIdleForRestore(db)).length, 1, "a marker-free idle config remains restorable");

  // 4. Source contract: the import path must run the check inside the restore
  // transaction, fence into `restoring` before data writes, and gate the route
  // on the operator boundary.
  const source = readFileSync(new URL("../../packages/server/src/routes/backup.routes.ts", import.meta.url), "utf8");
  const importFunctionAt = source.indexOf("async function importProfileStorageSnapshot");
  const transactionStart = source.indexOf("await app.db.transaction(async (tx) => {", importFunctionAt);
  assert.ok(transactionStart > 0, "profile import must still restore inside a transaction");
  const checkAt = source.indexOf("assertCoordinationIdleForRestore(tx", transactionStart);
  const firstTableLoop = source.indexOf("for (const tableName of PROFILE_FILE_BACKED_TABLES)", transactionStart);
  assert.ok(checkAt > transactionStart, "the coordination check must run inside the restore transaction");
  assert.ok(checkAt < firstTableLoop, "the coordination check must run before any table is written");

  const fenceBumpAt = source.indexOf("fence: Number(row.fence ?? 0) + 1", transactionStart);
  assert.ok(fenceBumpAt > checkAt, "restore admission must advance the fence past pre-restore authority");
  assert.ok(fenceBumpAt < firstTableLoop, "the restoring fence must be installed before profile data is written");
  assert.ok(
    source.indexOf('mode: "restoring"', checkAt) < firstTableLoop,
    "profile writes must run behind a restoring-mode barrier",
  );
  for (const cleared of ["leaseTokenDigest: null", "holderSessionId: null", "handoffRequestId: null"]) {
    assert.ok(
      source.indexOf(cleared, fenceBumpAt) > fenceBumpAt,
      `a completed restore must clear ${cleared} so pre-restore tokens cannot be replayed`,
    );
  }

  const routeAt = source.indexOf('app.post("/import-profile"');
  assert.ok(routeAt > 0);
  const gateAt = source.indexOf('requireCoordinationAdminAccess(req, reply, { feature: "Profile import" })', routeAt);
  assert.ok(gateAt > routeAt, "profile import must reach the coordination operator gate");
  const previewGateAt = source.indexOf("Profile import preview", routeAt);
  assert.ok(previewGateAt > routeAt, "preview must keep its own, weaker gate");
  assert.ok(
    source.indexOf("coordinationRowsExist", routeAt) < 0,
    "the write path must not weaken its gate when no coordination row exists yet",
  );
  assert.ok(
    source.indexOf("restoreBootId = randomUUID();", transactionStart) > 0,
    "a restore must mint a boot id distinct from the running process",
  );

  // 5. The real route: admission, refusal with zero data mutation, and a
  // successful restore that invalidates pre-restore authority.
  const Fastify = (await import("../../packages/server/node_modules/fastify/fastify.js")).default;
  const app = Fastify();
  app.decorate("db", db);
  await app.register(backupRoutes, { prefix: "/api/backup" });
  await app.ready();

  const envelope = profileEnvelope(STORAGE_KEY, backupConfig);
  const storedConfig = async () =>
    ((await db.select().from(appSettings)) as Record<string, unknown>[]).find((row) => row.key === STORAGE_KEY)?.value;
  const coordinationRow = async () =>
    ((await db.select().from(personalExtensionCoordination)) as Record<string, unknown>[])[0]!;

  const withoutSecret = await app.inject({
    method: "POST",
    url: "/api/backup/import-profile",
    headers: importHeaders(),
    payload: envelope,
  });
  assert.equal(withoutSecret.statusCode, 403, `write path must demand the operator secret: ${withoutSecret.body}`);
  assert.equal(await storedConfig(), cleanLiveConfig, "a refused restore must not touch stored config");

  const preview = await app.inject({
    method: "POST",
    url: "/api/backup/import-profile?preview=true",
    headers: importHeaders(),
    payload: envelope,
  });
  assert.notEqual(preview.statusCode, 403, `preview must keep the ordinary gate: ${preview.body}`);
  assert.equal(await storedConfig(), cleanLiveConfig, "preview must not write");

  const beforeMalformed = await coordinationRow();
  const malformedConfig = JSON.stringify({ convoMemoryBridgeV1: { schemaVersion: 1, ensembles: "invalid" } });
  await db
    .update(appSettings)
    .set({ value: malformedConfig, updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_KEY) as never);
  const malformed = await app.inject({
    method: "POST",
    url: "/api/backup/import-profile",
    headers: importHeaders(ADMIN_SECRET),
    payload: envelope,
  });
  assert.equal(malformed.statusCode, 409, `unverifiable CMB storage must fail closed: ${malformed.body}`);
  assert.equal(malformed.json().code, "coordination-transition-blocked");
  assert.equal(await storedConfig(), malformedConfig, "a refused malformed restore must preserve the exact config");
  const afterMalformed = await coordinationRow();
  assert.deepEqual(
    { mode: afterMalformed.mode, fence: afterMalformed.fence, serverBootId: afterMalformed.serverBootId },
    { mode: beforeMalformed.mode, fence: beforeMalformed.fence, serverBootId: beforeMalformed.serverBootId },
    "unverifiable CMB storage must be rejected before authority changes",
  );

  await db
    .update(appSettings)
    .set({ value: markerConfig, updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_KEY) as never);
  const markerOnly = await app.inject({
    method: "POST",
    url: "/api/backup/import-profile",
    headers: importHeaders(ADMIN_SECRET),
    payload: envelope,
  });
  assert.equal(markerOnly.statusCode, 409, `marker-only recovery state must refuse the restore: ${markerOnly.body}`);
  assert.equal(markerOnly.json().code, "coordination-transition-blocked");
  assert.equal(await storedConfig(), markerConfig, "a refused marker-only restore must preserve recovery evidence");

  await db
    .delete(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, "restore-guard-extension") as never);
  const markerBeforeFirstActivation = await app.inject({
    method: "POST",
    url: "/api/backup/import-profile",
    headers: importHeaders(ADMIN_SECRET),
    payload: envelope,
  });
  assert.equal(
    markerBeforeFirstActivation.statusCode,
    409,
    `legacy CMB recovery evidence must block restore before the first coordination row exists: ${markerBeforeFirstActivation.body}`,
  );
  assert.equal(markerBeforeFirstActivation.json().code, "coordination-transition-blocked");
  assert.equal(
    await storedConfig(),
    markerConfig,
    "a refused pre-activation restore must preserve the exact legacy CMB recovery marker",
  );
  await db.insert(personalExtensionCoordination).values({ ...baseRow, mode: "inactive" });
  await db
    .update(appSettings)
    .set({ value: cleanLiveConfig, updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_KEY) as never);

  await db
    .update(personalExtensionCoordination)
    .set({ mode: "active", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, "restore-guard-extension") as never);
  const whileActive = await app.inject({
    method: "POST",
    url: "/api/backup/import-profile",
    headers: importHeaders(ADMIN_SECRET),
    payload: envelope,
  });
  assert.equal(whileActive.statusCode, 409, `an active row must refuse the restore: ${whileActive.body}`);
  assert.equal(whileActive.json().code, "coordination-transition-blocked");
  assert.equal(await storedConfig(), cleanLiveConfig, "a refused restore must leave the live config in place");

  const beforeRestore = await coordinationRow();
  const eventService = getPersonalExtensionCoordinationEventService(fileDb as never as DB);
  const oldSinkEvents: Array<{ type: string; eventEpoch: string; cursor: number }> = [];
  let oldSinkCloseReason: string | null = null;
  const oldSubscription = await eventService.subscribe(
    {
      extensionId: "restore-guard-extension",
      deviceSessionId: "10000000-0000-4000-8000-000000000031",
    },
    {
      send(event) {
        oldSinkEvents.push(event);
      },
      close(reason) {
        oldSinkCloseReason = reason;
      },
    },
  );
  assert.equal(oldSinkEvents.length, 1);
  assert.equal(oldSinkEvents[0]?.type, "reset");
  const oldEventEpoch = oldSinkEvents[0]!.eventEpoch;
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "inactive", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, "restore-guard-extension") as never);
  const restored = await app.inject({
    method: "POST",
    url: "/api/backup/import-profile",
    headers: importHeaders(ADMIN_SECRET),
    payload: envelope,
  });
  // The decorated fixture supplies directory-fsync support even on Windows.
  // Consulting a separate global DB would incorrectly reject this route.
  assert.equal(restored.statusCode, 200, `an idle profile must restore: ${restored.body}`);
  assert.equal(await storedConfig(), backupConfig, "a completed restore must apply the backup config");
  const afterRestore = await coordinationRow();
  assert.equal(
    Number(afterRestore.fence),
    Number(beforeRestore.fence) + 1,
    "a completed restore must advance the fence",
  );
  assert.notEqual(
    afterRestore.serverBootId,
    beforeRestore.serverBootId,
    "a completed restore must mint a boot id that kills pre-restore tokens",
  );
  assert.equal(afterRestore.mode, "inactive", "a restored profile stays read-only until an operator re-activates");
  assert.equal(oldSinkCloseReason, "runtime-changed", "restore must close stale subscribers as a runtime change");
  assert.equal(eventService.subscriberCount("restore-guard-extension"), 0);
  assert.equal(oldSinkEvents.length, 1, "an inactive restore must not wake the old CMB with a dirty reset event");

  // Model the subsequent operator re-activation. The next subscription must
  // start from a fresh epoch/cursor pair, so an old replay cursor cannot cross
  // the restore boundary.
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "active", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, "restore-guard-extension") as never);
  const newSinkEvents: Array<{ type: string; eventEpoch: string; cursor: number }> = [];
  const newSubscription = await eventService.subscribe(
    {
      extensionId: "restore-guard-extension",
      deviceSessionId: "10000000-0000-4000-8000-000000000032",
      eventEpoch: oldEventEpoch,
      cursor: oldSinkEvents[0]!.cursor,
    },
    {
      send(event) {
        newSinkEvents.push(event);
      },
      close() {},
    },
  );
  assert.equal(newSinkEvents.length, 1);
  assert.equal(newSinkEvents[0]?.type, "reset");
  assert.equal(newSinkEvents[0]?.cursor, 0, "the post-restore epoch must restart at cursor zero");
  assert.notEqual(
    newSinkEvents[0]?.eventEpoch,
    oldEventEpoch,
    "a successful restore must reset the process-local event epoch so stale SSE cursors cannot survive",
  );
  oldSubscription.close();
  newSubscription.close();
  eventService.shutdown();
  await app.close();
  await fileDb._fileStore.close();

  // 6. A strict failure at the actual restored table or directory barrier must
  // be failure-atomic both in memory and after reopening the file store.
  await runUnsupportedStrictRouteScenario();
  await runRestoreAuthorityPhaseFailureScenario("A");
  await runStrictRestoreFailureScenario("file-fsync");
  await runStrictRestoreFailureScenario("directory-fsync");
  await runStrictRestoreFailureScenario("asset-backup-file-fsync");
  await runStrictRestoreFailureScenario("asset-backup-directory-fsync");
  await runStrictRestoreFailureScenario("asset-file-fsync");
  await runStrictRestoreFailureScenario("asset-directory-fsync");
  await runRestoreAuthorityPhaseFailureScenario("C");

  // 7. Requests arriving while the final strict barrier is held must not write
  // around the restore transaction. They may resume only after durability is
  // proven (and then face the newly restored inactive state normally).
  await runFinalBarrierConcurrencyScenario();

  console.log("Coordination profile restore regression passed.");
} finally {
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(storageDir, { recursive: true, force: true });
}
