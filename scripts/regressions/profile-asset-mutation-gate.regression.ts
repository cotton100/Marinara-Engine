// Profile restore keeps an A rollback copy while it promotes backup asset C. A
// concurrent ordinary writer must not install B between those steps: if C's
// durability barrier fails, restoring A would otherwise silently erase B.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const scenarioDir = mkdtempSync(join(tmpdir(), "marinara-profile-asset-gate-"));
const previousEnvironment = new Map(
  ["ADMIN_SECRET", "DATA_DIR", "FILE_STORAGE_DIR", "ENABLE_EXTERNAL_EXTENSIONS"].map((name) => [
    name,
    process.env[name],
  ]),
);
const ADMIN_SECRET = "profile-asset-gate-regression-secret";
process.env.ADMIN_SECRET = ADMIN_SECRET;
process.env.DATA_DIR = scenarioDir;
process.env.FILE_STORAGE_DIR = scenarioDir;
process.env.ENABLE_EXTERNAL_EXTENSIONS = "true";

const extensionId = "profile-asset-gate-extension";
const storageKey = `extension-storage:${extensionId}`;
const assetPath = "avatars/profile-asset-gate.bin";
const assetOutputPath = join(scenarioDir, assetPath);
const rollbackPathSuffix = join("rollback", assetPath);
const liveAssetA = Buffer.from("asset-A-before-restore");
const concurrentAssetB = Buffer.from("asset-B-from-ordinary-writer");
const backupAssetC = Buffer.from("asset-C-from-profile-backup");

function cmbStorageValue(label: string) {
  return JSON.stringify({
    convoMemoryBridgeV1: {
      schemaVersion: 1,
      ensembles: [
        {
          ensembleId: "profile-asset-gate-ensemble",
          name: label,
          rpChatId: "profile-asset-gate-rp",
          groupConvoChatIds: [],
          lorebookId: "profile-asset-gate-lorebook",
          autoSync: true,
          embedding: { connectionId: "__local_sidecar__", model: "local-sidecar" },
          runtime: {
            semanticStatus: "ready",
            lastSuccessfulEmbeddingProfile: null,
            pendingEmbeddingProfile: null,
            manualRecoveryReasons: [],
            lastSuccessfulSyncAt: null,
          },
          members: [
            { castId: "alpha", characterId: "profile-asset-gate-character", dmChatId: "profile-asset-gate-dm" },
          ],
        },
      ],
    },
  });
}

function importHeaders() {
  return {
    host: "127.0.0.1:7860",
    origin: "http://127.0.0.1:7860",
    "content-type": "application/json",
    "x-admin-secret": ADMIN_SECRET,
  };
}

let releaseRollbackBarrier = () => undefined;
const rollbackBarrierRelease = new Promise<void>((resolve) => {
  releaseRollbackBarrier = resolve;
});
let announceRollbackBarrier = () => undefined;
const rollbackBarrierEntered = new Promise<void>((resolve) => {
  announceRollbackBarrier = resolve;
});
let rollbackBarrierHeld = false;
let promotionFailureInjected = false;
let countConcurrentStrictRollbacks = false;
let concurrentStrictRollbackCount = 0;
let releaseFirstConcurrentStrict = () => undefined;
const firstConcurrentStrictRelease = new Promise<void>((resolve) => {
  releaseFirstConcurrentStrict = resolve;
});
let announceFirstConcurrentStrict = () => undefined;
const firstConcurrentStrictEntered = new Promise<void>((resolve) => {
  announceFirstConcurrentStrict = resolve;
});
let releaseSecondConcurrentStrict = () => undefined;
const secondConcurrentStrictRelease = new Promise<void>((resolve) => {
  releaseSecondConcurrentStrict = resolve;
});
let announceSecondConcurrentStrict = () => undefined;
const secondConcurrentStrictEntered = new Promise<void>((resolve) => {
  announceSecondConcurrentStrict = resolve;
});
let app: any = null;
let fileDb: any = null;

try {
  const [{ createFileNativeDB }, { appSettings, chats, personalExtensionCoordination }, { backupRoutes }, { eq }] =
    await Promise.all([
      import("../../packages/server/src/db/file-backed-store.js"),
      import("../../packages/server/src/db/schema/index.js"),
      import("../../packages/server/src/routes/backup.routes.js"),
      import("../../packages/server/src/db/file-query.js"),
    ]);
  const gateModulePath = "../../packages/server/src/services/import/profile-asset-mutation-gate.js";
  const gateModule = (await import(gateModulePath).catch(() => null)) as null | {
    getProfileAssetMaintenanceEpoch: () => number;
    installProfileAssetMutationRequestGate: (target: any) => void;
    runWithProfileAssetMutation: <T>(operation: () => Promise<T>) => Promise<T>;
    runWithDetachedProfileAssetMutation: <T>(operation: () => Promise<T>) => Promise<T>;
    runWithProfileAssetMaintenanceExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  };

  fileDb = await createFileNativeDB({
    fileOperations: {
      writeFile,
      flushFile: async (path) => {
        if (countConcurrentStrictRollbacks && String(path).endsWith(rollbackPathSuffix)) {
          concurrentStrictRollbackCount += 1;
          if (concurrentStrictRollbackCount === 1) {
            announceFirstConcurrentStrict();
            await firstConcurrentStrictRelease;
          } else if (concurrentStrictRollbackCount === 2) {
            announceSecondConcurrentStrict();
            await secondConcurrentStrictRelease;
          }
        }
        if (rollbackBarrierHeld && String(path).endsWith(rollbackPathSuffix)) {
          rollbackBarrierHeld = false;
          announceRollbackBarrier();
          await rollbackBarrierRelease;
        }
        if (!promotionFailureInjected && String(path) === assetOutputPath) {
          promotionFailureInjected = true;
          throw new Error("simulated promoted asset fsync failure");
        }
      },
      flushDirectory: async () => {},
    },
  });
  const db = fileDb;
  const timestamp = new Date().toISOString();
  await db.insert(personalExtensionCoordination).values({
    extensionId,
    contentHash: `sha256:${extensionId}`,
    mode: "inactive",
    serverBootId: "profile-asset-gate-boot",
    fence: 3,
    protectedLorebookRegistry: "{}",
    activeOperations: "[]",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(appSettings).values({ key: storageKey, value: cmbStorageValue("live"), updatedAt: timestamp });
  await mkdir(dirname(assetOutputPath), { recursive: true });
  await writeFile(assetOutputPath, liveAssetA);
  await fileDb._fileStore.flushStrict();

  const Fastify = (await import("../../packages/server/node_modules/fastify/fastify.js")).default;
  app = Fastify();
  app.decorate("db", db);
  gateModule?.installProfileAssetMutationRequestGate(app);
  await app.register(backupRoutes, { prefix: "/api/backup" });
  await app.ready();
  const autonomousActivity = await import("../../packages/server/src/services/conversation/autonomous.service.js");
  const restoredChatId = "same-chat-id-across-profile-restore";
  autonomousActivity.recordUserActivity(restoredChatId);
  assert.ok(autonomousActivity.getActivityState(restoredChatId));

  rollbackBarrierHeld = true;
  const restorePromise = app.inject({
    method: "POST",
    url: "/api/backup/import-profile",
    headers: importHeaders(),
    payload: {
      type: "marinara_profile",
      version: 1,
      data: {
        fileStorage: {
          version: 1,
          tables: {
            app_settings: [{ key: storageKey, value: cmbStorageValue("backup"), updatedAt: new Date().toISOString() }],
          },
          files: [{ path: assetPath, size: backupAssetC.byteLength, data: backupAssetC.toString("base64") }],
        },
      },
    },
  });
  await Promise.race([
    rollbackBarrierEntered,
    new Promise((_, reject) => setTimeout(() => reject(new Error("restore never prepared its rollback copy")), 2_000)),
  ]);

  let writerSettled = false;
  const writerPromise = app
    .inject({
      method: "POST",
      url: "/api/backup/import-profile",
      headers: importHeaders(),
      payload: {
        type: "marinara_profile",
        version: 1,
        data: {
          characters: [
            {
              data: { name: "Concurrent legacy asset writer" },
              avatarPath: assetPath,
              avatarBase64: concurrentAssetB.toString("base64"),
            },
          ],
        },
      },
    })
    .finally(() => {
      writerSettled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writerSettled, false, "ordinary asset writer B must drain behind restore after rollback A is prepared");

  releaseRollbackBarrier();
  const restoreResponse = await restorePromise;
  assert.ok(restoreResponse.statusCode >= 400, "the injected C durability failure must fail the restore");
  assert.equal(promotionFailureInjected, true, "restore must reach the promoted-asset durability barrier");
  assert.equal(
    autonomousActivity.getActivityState(restoredChatId),
    undefined,
    "a failed restore after entering maintenance must also invalidate pre-restore process-memory activity",
  );
  const writerResponse = await writerPromise;
  assert.equal(writerResponse.statusCode, 200, writerResponse.body);
  assert.equal(
    writerResponse.json().imported.characters,
    1,
    "the mixed legacy import must perform its real avatar write",
  );
  assert.deepEqual(
    await readFile(assetOutputPath),
    concurrentAssetB,
    "rollback A must finish before queued ordinary writer B commits",
  );

  // Two current-format imports both begin in the global shared request gate.
  // Maintenance must be acquired before the profile lifecycle queue or the
  // second request can retain shared while waiting for the first lifecycle owner.
  await db
    .update(personalExtensionCoordination)
    .set({
      mode: "inactive",
      serverBootId: "profile-asset-gate-concurrent-boot",
      leaseTokenDigest: null,
      holderSessionId: null,
      expiresAt: null,
      handoffRequestId: null,
      handoffRequester: null,
      handoffDeadlineAt: null,
      activeOperations: "[]",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(personalExtensionCoordination.extensionId, extensionId));
  await fileDb._fileStore.flushStrict();
  const strictAssetOne = Buffer.from("strict-asset-one");
  const strictAssetTwo = Buffer.from("strict-asset-two");
  autonomousActivity.recordUserActivity(restoredChatId);
  assert.ok(autonomousActivity.getActivityState(restoredChatId));
  const strictPayload = (label: string, asset: Buffer) => ({
    type: "marinara_profile",
    version: 1,
    data: {
      fileStorage: {
        version: 1,
        tables: {
          app_settings: [{ key: storageKey, value: cmbStorageValue(label), updatedAt: new Date().toISOString() }],
        },
        files: [{ path: assetPath, size: asset.byteLength, data: asset.toString("base64") }],
      },
    },
  });
  countConcurrentStrictRollbacks = true;
  let strictOneSettled = false;
  let strictTwoSettled = false;
  let announceAnyStrictSettled = () => undefined;
  const anyStrictSettled = new Promise<void>((resolve) => {
    announceAnyStrictSettled = resolve;
  });
  const strictOne = app
    .inject({
      method: "POST",
      url: "/api/backup/import-profile",
      headers: importHeaders(),
      payload: strictPayload("strict-one", strictAssetOne),
    })
    .finally(() => {
      strictOneSettled = true;
      announceAnyStrictSettled();
    });
  const strictTwo = app
    .inject({
      method: "POST",
      url: "/api/backup/import-profile",
      headers: importHeaders(),
      payload: strictPayload("strict-two", strictAssetTwo),
    })
    .finally(() => {
      strictTwoSettled = true;
      announceAnyStrictSettled();
    });
  await Promise.race([
    firstConcurrentStrictEntered,
    new Promise((_, reject) => setTimeout(() => reject(new Error("concurrent strict imports never entered")), 2_000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(concurrentStrictRollbackCount, 1, "only one strict import may prepare rollback under maintenance");
  assert.equal(strictOneSettled || strictTwoSettled, false, "both strict imports must remain live at the held barrier");
  releaseFirstConcurrentStrict();
  await Promise.race([
    secondConcurrentStrictEntered,
    new Promise((_, reject) => setTimeout(() => reject(new Error("second strict import never entered")), 2_000)),
  ]);
  await Promise.race([
    anyStrictSettled,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("first strict response waited behind second maintenance")), 2_000),
    ),
  ]);
  assert.equal(
    Number(strictOneSettled) + Number(strictTwoSettled),
    1,
    "the completed first restore must respond while the second maintenance barrier is held",
  );
  releaseSecondConcurrentStrict();
  const strictResponses = await Promise.race([
    Promise.all([strictOne, strictTwo]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("two concurrent strict imports deadlocked")), 2_000),
    ),
  ]);
  assert.deepEqual(
    strictResponses.map((response) => response.statusCode),
    [200, 200],
    strictResponses.map((response) => response.body).join("\n"),
  );
  assert.equal(concurrentStrictRollbackCount, 2, "both strict imports must serialize through maintenance");
  assert.equal(
    autonomousActivity.getActivityState(restoredChatId),
    undefined,
    "a successful restore must invalidate pre-restore process-memory chat activity for reused UUIDs",
  );
  assert.ok(
    [strictAssetOne, strictAssetTwo].some((candidate) => candidate.equals(readFileSync(assetOutputPath))),
    "the final asset must be one complete serialized restore image",
  );
  countConcurrentStrictRollbacks = false;

  // AsyncLocalStorage is inherited by detached work. Once its parent shared
  // operation returns, that stale context must acquire a new mutation lease.
  assert.ok(gateModule, "the production gate module must be available");
  let startDetachedMutation = () => undefined;
  const detachedMutationStart = new Promise<void>((resolve) => {
    startDetachedMutation = resolve;
  });
  let detachedEntered = false;
  let detachedPromise: Promise<void> | null = null;
  await gateModule.runWithProfileAssetMutation(async () => {
    detachedPromise = (async () => {
      await detachedMutationStart;
      await gateModule.runWithProfileAssetMutation(async () => {
        detachedEntered = true;
      });
    })();
  });
  let releaseDetachedMaintenance = () => undefined;
  let announceDetachedMaintenance = () => undefined;
  const detachedMaintenanceEntered = new Promise<void>((resolve) => {
    announceDetachedMaintenance = resolve;
  });
  const detachedMaintenanceRelease = new Promise<void>((resolve) => {
    releaseDetachedMaintenance = resolve;
  });
  const detachedMaintenance = gateModule.runWithProfileAssetMaintenanceExclusive(async () => {
    announceDetachedMaintenance();
    await detachedMaintenanceRelease;
  });
  await detachedMaintenanceEntered;
  startDetachedMutation();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(detachedEntered, false, "detached work must not reuse its completed parent's stale shared context");
  releaseDetachedMaintenance();
  await detachedMaintenance;
  await detachedPromise;
  assert.equal(detachedEntered, true, "detached work must resume after maintenance releases");

  // A child deliberately detached while its parent still owns shared must get
  // its own lease, otherwise the parent can return and expose the child write.
  let releaseFreshDetached = () => undefined;
  const freshDetachedRelease = new Promise<void>((resolve) => {
    releaseFreshDetached = resolve;
  });
  let announceFreshDetached = () => undefined;
  const freshDetachedEntered = new Promise<void>((resolve) => {
    announceFreshDetached = resolve;
  });
  let freshDetachedPromise: Promise<void> | null = null;
  await gateModule.runWithProfileAssetMutation(async () => {
    freshDetachedPromise = gateModule.runWithDetachedProfileAssetMutation(async () => {
      announceFreshDetached();
      await freshDetachedRelease;
    });
    await freshDetachedEntered;
  });
  let maintenanceEnteredBehindFreshChild = false;
  const maintenanceBehindFreshChild = gateModule.runWithProfileAssetMaintenanceExclusive(async () => {
    maintenanceEnteredBehindFreshChild = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    maintenanceEnteredBehindFreshChild,
    false,
    "maintenance must wait for a detached child after its request parent returns",
  );
  releaseFreshDetached();
  await freshDetachedPromise;
  await maintenanceBehindFreshChild;
  assert.equal(maintenanceEnteredBehindFreshChild, true);

  // The inverse schedule is the subtle one: maintenance queues while a parent
  // request is still shared, then that admitted request starts a background
  // child. The child must retain the parent's position ahead of maintenance,
  // not queue stale captured work on the restored side.
  let allowRetainedChildStart = () => undefined;
  const retainedChildStart = new Promise<void>((resolve) => {
    allowRetainedChildStart = resolve;
  });
  let announceRetainedParent = () => undefined;
  const retainedParentEntered = new Promise<void>((resolve) => {
    announceRetainedParent = resolve;
  });
  let releaseRetainedChild = () => undefined;
  const retainedChildRelease = new Promise<void>((resolve) => {
    releaseRetainedChild = resolve;
  });
  let announceRetainedChild = () => undefined;
  const retainedChildEntered = new Promise<void>((resolve) => {
    announceRetainedChild = resolve;
  });
  let retainedChildPromise: Promise<void> | null = null;
  const retainedParent = gateModule.runWithProfileAssetMutation(async () => {
    announceRetainedParent();
    await retainedChildStart;
    retainedChildPromise = gateModule.runWithDetachedProfileAssetMutation(async () => {
      announceRetainedChild();
      await retainedChildRelease;
    });
  });
  await retainedParentEntered;
  const epochBeforeQueuedMaintenance = gateModule.getProfileAssetMaintenanceEpoch();
  let queuedMaintenanceEntered = false;
  const queuedMaintenance = gateModule.runWithProfileAssetMaintenanceExclusive(async () => {
    queuedMaintenanceEntered = true;
  });
  allowRetainedChildStart();
  await Promise.race([
    retainedChildEntered,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("retained detached child never entered before maintenance")), 2_000),
    ),
  ]);
  await retainedParent;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    queuedMaintenanceEntered,
    false,
    "maintenance queued first must still wait for a detached child retained by its active parent",
  );
  releaseRetainedChild();
  await retainedChildPromise;
  await queuedMaintenance;
  assert.equal(queuedMaintenanceEntered, true);
  assert.equal(
    gateModule.getProfileAssetMaintenanceEpoch(),
    epochBeforeQueuedMaintenance + 1,
    "each outer maintenance admission must advance the runtime invalidation epoch",
  );

  // Snapshot/pause used to await a poll Promise that was merely queued behind
  // maintenance, creating E(shared) -> M -> poll -> E. Only work that has
  // actually entered shared admission may participate in the pause drain.
  const noodleAdmission =
    await import("../../packages/server/src/services/noodle/noodle-autopost-scheduler.service.js");
  const admissionOrder: string[] = [];
  let allowSnapshotPause = () => undefined;
  const snapshotPauseStart = new Promise<void>((resolve) => {
    allowSnapshotPause = resolve;
  });
  let announceSnapshotShared = () => undefined;
  const snapshotSharedEntered = new Promise<void>((resolve) => {
    announceSnapshotShared = resolve;
  });
  const snapshot = gateModule.runWithProfileAssetMutation(async () => {
    announceSnapshotShared();
    await snapshotPauseStart;
    await noodleAdmission.withNoodleAutoPostPaused(async () => {
      admissionOrder.push("snapshot");
    });
  });
  await snapshotSharedEntered;
  let releasePauseCycleMaintenance = () => undefined;
  const pauseCycleMaintenanceRelease = new Promise<void>((resolve) => {
    releasePauseCycleMaintenance = resolve;
  });
  let announcePauseCycleMaintenance = () => undefined;
  const pauseCycleMaintenanceEntered = new Promise<void>((resolve) => {
    announcePauseCycleMaintenance = resolve;
  });
  const pauseCycleMaintenance = gateModule.runWithProfileAssetMaintenanceExclusive(async () => {
    admissionOrder.push("maintenance");
    announcePauseCycleMaintenance();
    await pauseCycleMaintenanceRelease;
  });
  const queuedAutoPost = noodleAdmission.runWithNoodleAutoPostAdmission(async () => {
    admissionOrder.push("poll");
  });
  allowSnapshotPause();
  await Promise.race([
    snapshot,
    new Promise((_, reject) => setTimeout(() => reject(new Error("snapshot/poll admission deadlocked")), 2_000)),
  ]);
  await Promise.race([
    pauseCycleMaintenanceEntered,
    new Promise((_, reject) => setTimeout(() => reject(new Error("maintenance never followed snapshot")), 2_000)),
  ]);
  assert.deepEqual(admissionOrder, ["snapshot", "maintenance"]);
  releasePauseCycleMaintenance();
  await Promise.all([pauseCycleMaintenance, queuedAutoPost]);
  assert.deepEqual(admissionOrder, ["snapshot", "maintenance", "poll"]);

  // A delayed autonomous job scheduled from the old profile must become a
  // no-op if restore maintenance advances the epoch before its timer fires.
  const schedulerModule =
    await import("../../packages/server/src/services/conversation/server-autonomous-scheduler.service.js");
  const autonomousTimerChatId = "same-autonomous-chat-id";
  await db.insert(chats).values({
    id: autonomousTimerChatId,
    name: "Restored same-ID conversation",
    mode: "conversation",
    characterIds: '["new-profile-character"]',
    metadata: JSON.stringify({ autonomousMessages: true }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  autonomousActivity.recordUserActivity(autonomousTimerChatId);
  const oldClaimedAt = autonomousActivity.markGenerationInProgress(autonomousTimerChatId);
  let autonomousInjectedRequests = 0;
  const fakeSchedulerApp = {
    db,
    inject: async () => {
      autonomousInjectedRequests += 1;
      return {
        statusCode: 200,
        payload: JSON.stringify({
          shouldTrigger: true,
          characterIds: ["new-profile-character"],
          generationStartedAt: Date.now(),
        }),
      };
    },
    addHook: () => undefined,
  };
  const autonomousScheduler = schedulerModule.startServerAutonomousScheduler(fakeSchedulerApp as any);
  autonomousScheduler.scheduleDelayedGenerationForRegression(autonomousTimerChatId, oldClaimedAt, 80);
  await gateModule.runWithProfileAssetMaintenanceExclusive(async () => {
    autonomousActivity.clearAllChatActivity();
  });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(
    autonomousInjectedRequests,
    0,
    "an old-epoch delayed autonomous job must not reuse its old claim or call check/generate after restore",
  );
  assert.equal(autonomousActivity.getActivityState(autonomousTimerChatId), undefined);
  autonomousScheduler.stop();

  // Profile export is a GET, but it reads tables and asset trees in sequence.
  // It must not return a mixed archive while restore maintenance is active.
  let releaseExportMaintenance = () => undefined;
  const exportMaintenanceRelease = new Promise<void>((resolve) => {
    releaseExportMaintenance = resolve;
  });
  let announceExportMaintenance = () => undefined;
  const exportMaintenanceEntered = new Promise<void>((resolve) => {
    announceExportMaintenance = resolve;
  });
  const exportMaintenance = gateModule.runWithProfileAssetMaintenanceExclusive(async () => {
    announceExportMaintenance();
    await exportMaintenanceRelease;
  });
  await exportMaintenanceEntered;
  let exportSettled = false;
  const exportPromise = app
    .inject({
      method: "GET",
      url: "/api/backup/export-profile",
      headers: importHeaders(),
    })
    .finally(() => {
      exportSettled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(exportSettled, false, "profile export must wait behind restore maintenance");
  releaseExportMaintenance();
  await exportMaintenance;
  const exportResponse = await exportPromise;
  assert.equal(exportResponse.statusCode, 200, exportResponse.body);

  // A GET/read fallback must not turn a missing or corrupt derived manifest
  // into an unadmitted game-assets write (or run the legacy music migrator).
  const { GAME_ASSETS_DIR, getAssetManifest } =
    await import("../../packages/server/src/services/game/asset-manifest.service.js");
  const corruptManifestPath = join(GAME_ASSETS_DIR, "manifest.json");
  await mkdir(GAME_ASSETS_DIR, { recursive: true });
  await writeFile(corruptManifestPath, "{corrupt-derived-cache", "utf8");
  const readOnlyManifest = getAssetManifest();
  assert.equal(typeof readOnlyManifest.count, "number");
  assert.equal(
    await readFile(corruptManifestPath, "utf8"),
    "{corrupt-derived-cache",
    "getAssetManifest fallback must scan in memory without writing a derived cache",
  );

  const appSource = readFileSync(new URL("../../packages/server/src/app.ts", import.meta.url), "utf8");
  const backupSource = readFileSync(
    new URL("../../packages/server/src/routes/backup.routes.ts", import.meta.url),
    "utf8",
  );
  const schedulerSource = readFileSync(
    new URL("../../packages/server/src/services/noodle/noodle-autopost-scheduler.service.ts", import.meta.url),
    "utf8",
  );
  const noodlerMediaSource = readFileSync(
    new URL("../../packages/server/src/services/noodle/noodle-noodler-media.ts", import.meta.url),
    "utf8",
  );
  const ttsSource = readFileSync(new URL("../../packages/server/src/routes/tts.routes.ts", import.meta.url), "utf8");
  const gameSource = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
  const generateSource = readFileSync(
    new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
    "utf8",
  );
  const noodleRefreshSource = readFileSync(
    new URL("../../packages/server/src/services/noodle/noodle-refresh-scheduler.service.ts", import.meta.url),
    "utf8",
  );
  const autonomousSchedulerSource = readFileSync(
    new URL("../../packages/server/src/services/conversation/server-autonomous-scheduler.service.ts", import.meta.url),
    "utf8",
  );
  const autonomousActivitySource = readFileSync(
    new URL("../../packages/server/src/services/conversation/autonomous.service.ts", import.meta.url),
    "utf8",
  );
  const assetManifestSource = readFileSync(
    new URL("../../packages/server/src/services/game/asset-manifest.service.ts", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /installProfileAssetMutationRequestGate\(app\)/u);
  assert.ok(
    appSource.indexOf("installProfileAssetMutationRequestGate(app)") < appSource.indexOf("await registerRoutes(app)"),
    "the process-wide request gate must be installed before any asset-writing route",
  );
  const restoreAt = backupSource.indexOf("async function importProfileStorageSnapshot");
  const assetExclusiveAt = backupSource.indexOf("runWithProfileAssetMaintenanceExclusive", restoreAt);
  const lifecycleAt = backupSource.indexOf("withProfileImportLifecycleLock", restoreAt);
  const rollbackPrepareAt = backupSource.indexOf("prepareStagedProfileAssetRollback", restoreAt);
  const cleanupAt = backupSource.indexOf("cleanupStagedProfileAssets", restoreAt);
  assert.ok(assetExclusiveAt > restoreAt && assetExclusiveAt < rollbackPrepareAt);
  assert.ok(assetExclusiveAt < lifecycleAt, "asset maintenance must be acquired before the profile lifecycle queue");
  assert.ok(cleanupAt > rollbackPrepareAt, "asset exclusive scope must include cleanup and rollback durability");
  assert.match(
    backupSource.slice(cleanupAt, backupSource.indexOf("return outcome.imported", cleanupAt)),
    /clearAllChatActivity\(\)/u,
    "a successful restore must reset process-memory autonomous activity before maintenance releases",
  );
  const automaticRunAt = backupSource.indexOf("const runAutomaticBackupIfDue");
  const automaticRunEnd = backupSource.indexOf('app.get("/automatic"', automaticRunAt);
  const automaticRunSource = backupSource.slice(automaticRunAt, automaticRunEnd);
  assert.match(
    automaticRunSource,
    /runWithDetachedProfileAssetMutation[\s\S]*loadAutomaticBackupSettings[\s\S]*writeAutomaticBackup[\s\S]*saveAutomaticBackupSettings/u,
    "every detached automatic-backup trigger must hold one fresh shared admission through its final settings RMW",
  );
  const exportRouteAt = backupSource.indexOf('app.get<{ Querystring: { format?: ExportFormat } }>("/export-profile"');
  const exportRouteEnd = backupSource.indexOf("// ── Profile Import", exportRouteAt);
  assert.match(
    backupSource.slice(exportRouteAt, exportRouteEnd),
    /runWithProfileAssetMutation[\s\S]*buildCompatibleProfileZip[\s\S]*sendNativeProfileZipExport[\s\S]*sendNativeProfileJsonExport/u,
    "all profile export formats must share one restore admission",
  );
  assert.match(
    schedulerSource,
    /runWithNoodleAutoPostAdmission[\s\S]*runWithProfileAssetMutation[\s\S]*pauseDepth > 0[\s\S]*activeWorks\.add/u,
    "Noodle poll work must be registered only after shared admission and a pause recheck",
  );
  assert.doesNotMatch(
    schedulerSource,
    /activePoll/u,
    "a queued gate waiter must never masquerade as admitted Noodle work that snapshots drain",
  );
  assert.match(noodlerMediaSource, /runWithProfileAssetMutation/u);
  assert.match(
    ttsSource,
    /setTimeout\(\(\) => \{[\s\S]*runWithDetachedProfileAssetMutation[\s\S]*buildAssetManifest/u,
    "the delayed TTS manifest writer must acquire a fresh mutation admission",
  );
  assert.match(
    gameSource,
    /runWithDetachedProfileAssetMutation\(async \(\) => \{[\s\S]*runFrameWorker/u,
    "background storyboard asset rendering must own a detached mutation admission",
  );
  assert.match(
    gameSource,
    /queueGameLorebookKeeperAfterConclusion[\s\S]*runWithDetachedProfileAssetMutation\(\(\) =>[\s\S]*runGameLorebookKeeperAfterConclusion/u,
    "queued game lorebook writes must own a detached mutation admission",
  );
  assert.match(
    generateSource,
    /Background: chunk & embed[\s\S]*runWithDetachedProfileAssetMutation[\s\S]*runMemoryRecallMutationWithDirtyHint[\s\S]*chunkAndEmbedMessages/u,
    "background Memory Recall chunk writes must own a detached mutation admission",
  );
  assert.match(
    noodleRefreshSource,
    /const poll = async[\s\S]*runWithDetachedProfileAssetMutation[\s\S]*noodle\.getSettings[\s\S]*app\.inject[\s\S]*noodle\.saveRefreshSchedule/u,
    "the Noodle refresh timer must gate its read, injected mutation, and final schedule RMW together",
  );
  assert.match(
    autonomousSchedulerSource,
    /const evaluateChat = async \(chatId: string\)[\s\S]*runWithDetachedProfileAssetMutation[\s\S]*chats\.getById\(chatId\)[\s\S]*app\.inject/u,
    "autonomous evaluation must fresh-read after detached admission",
  );
  assert.match(
    autonomousSchedulerSource,
    /scheduleDelayedGeneration[\s\S]*scheduledEpoch[\s\S]*runWithDetachedProfileAssetMutation[\s\S]*synchronizeMaintenanceEpoch[\s\S]*clearGenerationInProgress[\s\S]*\/api\/conversation\/autonomous\/check[\s\S]*activeClaimedAt/u,
    "delayed autonomous generation must invalidate old epochs and obtain a fresh claim after its timer fires",
  );
  assert.match(
    autonomousActivitySource,
    /export function clearAllChatActivity\(\)[\s\S]*activityStates\.clear\(\)/u,
    "profile restore must have an explicit process-memory activity reset primitive",
  );
  assert.match(
    assetManifestSource,
    /export function getAssetManifest[\s\S]*return scanAssetManifest\(\)/u,
    "manifest read fallback must remain side-effect free",
  );

  console.log("Profile asset mutation gate regression passed.");
} finally {
  rollbackBarrierHeld = false;
  countConcurrentStrictRollbacks = false;
  releaseRollbackBarrier();
  releaseFirstConcurrentStrict();
  releaseSecondConcurrentStrict();
  if (app) await app.close();
  if (fileDb) await fileDb._fileStore.close();
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scenarioDir, { recursive: true, force: true });
}
