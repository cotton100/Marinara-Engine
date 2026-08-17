import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  appSettings,
  installedExtensions,
  personalExtensionCoordination,
  personalExtensionOperationJournal,
} from "../../packages/server/src/db/schema/index.js";
import {
  createPersonalExtensionCoordinationKernel,
  parsePersonalExtensionJournalResourceRevisions,
  parsePersonalExtensionProtectedResourceRegistry,
  PersonalExtensionCoordinationKernelError,
  PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
} from "../../packages/server/src/services/extensions/personal-extension-coordination-kernel.service.js";
import {
  proveCmbBlockedJournalRecovery,
  proveCmbOperationConclusiveState,
  proveCmbOperationDispatchMarker,
} from "../../packages/server/src/services/extensions/personal-extension-coordination-admin.service.js";

const EXTENSION_ID = "coordination-journal-extension";
const CONTENT_HASH = "approved-journal-content-hash";
const BOOT_ID = "coordination-journal-boot";
const HOLDER = "coordination-journal-holder";
const ENSEMBLE_ID = "journal-ensemble";
const LOREBOOK_ID = "journal-lorebook";
const OTHER_LOREBOOK_ID = "journal-other-lorebook";
const STORAGE_SETTING_KEY = `extension-storage:${EXTENSION_ID}`;
const START_WALL_MS = Date.parse("2026-08-16T00:00:00.000Z");

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cmbStorageValue(
  manualRecoveryReasons: string[],
  otherManualRecoveryReasons?: string[],
  targetLorebookId = LOREBOOK_ID,
) {
  return JSON.stringify({
    convoMemoryBridgeV1: {
      schemaVersion: 1,
      ensembles: [
        {
          ensembleId: ENSEMBLE_ID,
          name: "Journal fixture",
          rpChatId: "journal-rp-chat",
          groupConvoChatIds: [],
          lorebookId: targetLorebookId,
          autoSync: true,
          embedding: { connectionId: "__local_sidecar__", model: "local-sidecar" },
          runtime: {
            semanticStatus: "ready",
            lastSuccessfulEmbeddingProfile: null,
            pendingEmbeddingProfile: null,
            manualRecoveryReasons,
            lastSuccessfulSyncAt: null,
          },
          members: [{ castId: "alpha", characterId: "journal-character", dmChatId: "journal-dm-chat" }],
        },
        ...(otherManualRecoveryReasons
          ? [
              {
                ensembleId: "journal-other-ensemble",
                name: "Other journal fixture",
                rpChatId: "journal-other-rp-chat",
                groupConvoChatIds: [],
                lorebookId: "journal-other-lorebook",
                autoSync: true,
                embedding: { connectionId: "__local_sidecar__", model: "local-sidecar" },
                runtime: {
                  semanticStatus: "ready",
                  lastSuccessfulEmbeddingProfile: null,
                  pendingEmbeddingProfile: null,
                  manualRecoveryReasons: otherManualRecoveryReasons,
                  lastSuccessfulSyncAt: null,
                },
                members: [
                  {
                    castId: "other",
                    characterId: "journal-other-character",
                    dmChatId: "journal-other-dm-chat",
                  },
                ],
              },
            ]
          : []),
      ],
    },
  });
}

async function createFixture(
  proveDispatchMarker: typeof proveCmbOperationDispatchMarker = proveCmbOperationDispatchMarker,
) {
  const storageDir = mkdtempSync(join(tmpdir(), "marinara-coordination-journal-"));
  const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
  process.env.FILE_STORAGE_DIR = storageDir;
  let monotonicMs = 1_000;
  let wallMs = START_WALL_MS;
  let secretCounter = 0;
  let failNextWrite = false;
  const fileDb = await createFileNativeDB({
    fileOperations: {
      writeFile: async (path, content) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("simulated journal strict write failure");
        }
        await writeFile(path, content);
      },
      flushDirectory: async () => {},
    },
  });
  const db = fileDb as unknown as DB;
  const timestamp = new Date(wallMs).toISOString();
  await db.insert(installedExtensions).values({
    id: EXTENSION_ID,
    name: "Journal fixture",
    description: "unchanged",
    runtime: "client",
    capabilities: "[]",
    enabled: "true",
    contentHash: CONTENT_HASH,
    approvedHash: CONTENT_HASH,
    source: "local",
    revisions: "[]",
    installedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(personalExtensionCoordination).values({
    extensionId: EXTENSION_ID,
    contentHash: CONTENT_HASH,
    mode: "active",
    serverBootId: BOOT_ID,
    configRevision: 0,
    protectedLorebookRegistry: JSON.stringify({
      version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
      extensionStorage: { resourceRevision: 0 },
      lorebooks: {
        [LOREBOOK_ID]: { resourceRevision: 0 },
        [OTHER_LOREBOOK_ID]: { resourceRevision: 0 },
      },
    }),
    activeOperations: "[]",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(appSettings).values({
    key: STORAGE_SETTING_KEY,
    value: cmbStorageValue([]),
    updatedAt: timestamp,
  });
  await fileDb._fileStore.flushStrict();
  const kernel = createPersonalExtensionCoordinationKernel(db, {
    serverBootId: BOOT_ID,
    monotonicNow: () => monotonicMs,
    wallNow: () => wallMs,
    randomToken: () => `raw-journal-secret-${++secretCounter}`,
    proveDispatchMarker,
  });
  return {
    db,
    fileDb,
    kernel,
    failNextStrictWrite() {
      failNextWrite = true;
    },
    advance(ms: number) {
      monotonicMs += ms;
      wallMs += ms;
    },
    async cleanup() {
      failNextWrite = false;
      await fileDb._fileStore.close();
      if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
      else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

async function coordinationRow(fixture: Fixture) {
  const rows = await fixture.db
    .select()
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  assert.ok(rows[0]);
  return rows[0];
}

async function journalRows(fixture: Fixture) {
  return fixture.db
    .select()
    .from(personalExtensionOperationJournal)
    .where(eq(personalExtensionOperationJournal.extensionId, EXTENSION_ID));
}

async function journalFor(fixture: Fixture, operationHandle: string) {
  const rows = await fixture.db
    .select()
    .from(personalExtensionOperationJournal)
    .where(eq(personalExtensionOperationJournal.operationDigest, sha256(operationHandle)));
  assert.ok(rows[0]);
  return rows[0];
}

async function deleteJournalForIsolatedTestSetup(fixture: Fixture, operationHandle: string) {
  await fixture.db
    .delete(personalExtensionOperationJournal)
    .where(eq(personalExtensionOperationJournal.operationDigest, sha256(operationHandle)));
  await fixture.fileDb._fileStore.flushStrict();
}

async function expectCode(promise: Promise<unknown>, code: PersonalExtensionCoordinationKernelError["code"]) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PersonalExtensionCoordinationKernelError);
    assert.equal(error.code, code);
    return true;
  });
}

function authority(
  lease: {
    leaseToken: string;
    fence: number;
    serverBootId: string;
    contentHash: string;
  },
  holderSessionId = HOLDER,
) {
  return {
    extensionId: EXTENSION_ID,
    holderSessionId,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
  };
}

async function writeConfig(
  fixture: Fixture,
  context: ReturnType<typeof authority> & { operationHandle: string },
  expectedRevision: number,
  reasons: string[],
  otherReasons?: string[],
  targetLorebookId = LOREBOOK_ID,
) {
  return fixture.kernel.runFencedResourceMutation(
    context,
    [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision }],
    async (tx) => {
      const timestamp = new Date(START_WALL_MS + expectedRevision + 1).toISOString();
      await tx
        .update(appSettings)
        .set({ value: cmbStorageValue(reasons, otherReasons, targetLorebookId), updatedAt: timestamp })
        .where(eq(appSettings.key, STORAGE_SETTING_KEY));
      await tx
        .update(personalExtensionCoordination)
        .set({ configRevision: expectedRevision + 1, updatedAt: timestamp })
        .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
      return expectedRevision + 1;
    },
  );
}

async function mutateLorebook(
  fixture: Fixture,
  context: ReturnType<typeof authority> & { operationHandle: string },
  expectedRevision: number,
  callback: (tx: DB) => Promise<void>,
  lorebookId = LOREBOOK_ID,
) {
  return fixture.kernel.runFencedResourceMutation(
    context,
    [{ kind: "lorebook", resourceId: lorebookId, expectedRevision }],
    callback,
  );
}

const markerProofFixture = await createFixture();
try {
  const lease = await markerProofFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease);
  let callbackRuns = 0;

  const unrelated = await markerProofFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const unrelatedContext = { ...leaseAuthority, operationHandle: unrelated.operationHandle };
  await writeConfig(markerProofFixture, unrelatedContext, 0, []);
  await expectCode(
    mutateLorebook(markerProofFixture, unrelatedContext, 0, async () => {
      callbackRuns += 1;
    }),
    "coordination-unavailable",
  );
  assert.equal(callbackRuns, 0, "an unrelated storage commit is not a durable target marker");
  assert.equal((await journalFor(markerProofFixture, unrelated.operationHandle)).phase, "prepared");
  await markerProofFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: unrelated.operationHandle,
    disposition: "aborted",
  });

  const wrongTarget = await markerProofFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const wrongTargetContext = { ...leaseAuthority, operationHandle: wrongTarget.operationHandle };
  await writeConfig(markerProofFixture, wrongTargetContext, 1, [], ["mutation-ambiguous"]);
  await expectCode(
    mutateLorebook(markerProofFixture, wrongTargetContext, 0, async () => {
      callbackRuns += 1;
    }),
    "coordination-unavailable",
  );
  let transitionCallbackRuns = 0;
  await expectCode(
    markerProofFixture.kernel.runFencedLorebookRegistryTransition(
      wrongTargetContext,
      { action: "bind", resourceId: "journal-new-lorebook", expectedRevision: null },
      async () => {
        transitionCallbackRuns += 1;
      },
    ),
    "coordination-unavailable",
  );
  assert.equal(callbackRuns, 0, "another ensemble's marker cannot authorize this target");
  assert.equal(transitionCallbackRuns, 0, "registry transitions use the same exact target marker barrier");
  assert.equal((await journalFor(markerProofFixture, wrongTarget.operationHandle)).phase, "prepared");
  await markerProofFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: wrongTarget.operationHandle,
    disposition: "aborted",
  });

  const conflictingSetup = await markerProofFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const conflictingSetupContext = { ...leaseAuthority, operationHandle: conflictingSetup.operationHandle };
  await writeConfig(markerProofFixture, conflictingSetupContext, 2, [
    "mutation-ambiguous",
    "setup-attach-ambiguous",
    "setup-reconcile-ambiguous",
  ]);
  await expectCode(
    mutateLorebook(markerProofFixture, conflictingSetupContext, 0, async () => {
      callbackRuns += 1;
    }),
    "coordination-unavailable",
  );
  assert.equal(callbackRuns, 0, "conflicting setup markers cannot authorize protected data");
  assert.equal((await journalFor(markerProofFixture, conflictingSetup.operationHandle)).phase, "prepared");
  await markerProofFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: conflictingSetup.operationHandle,
    disposition: "aborted",
  });

  const wrongResource = await markerProofFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const wrongResourceContext = { ...leaseAuthority, operationHandle: wrongResource.operationHandle };
  await writeConfig(markerProofFixture, wrongResourceContext, 3, ["mutation-ambiguous"]);
  await expectCode(
    mutateLorebook(
      markerProofFixture,
      wrongResourceContext,
      0,
      async () => {
        callbackRuns += 1;
      },
      OTHER_LOREBOOK_ID,
    ),
    "coordination-unavailable",
  );
  assert.equal(callbackRuns, 0, "a target marker cannot authorize another registered lorebook");
  assert.equal((await journalFor(markerProofFixture, wrongResource.operationHandle)).phase, "prepared");
  await markerProofFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: wrongResource.operationHandle,
    disposition: "aborted",
  });

  const pairedSetup = await markerProofFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const pairedSetupContext = { ...leaseAuthority, operationHandle: pairedSetup.operationHandle };
  await writeConfig(markerProofFixture, pairedSetupContext, 4, ["mutation-ambiguous", "setup-attach-ambiguous"]);
  await mutateLorebook(markerProofFixture, pairedSetupContext, 0, async () => {
    callbackRuns += 1;
  });
  assert.equal(callbackRuns, 1, "one setup reason paired with the generic target marker is admissible");
  assert.equal((await journalFor(markerProofFixture, pairedSetup.operationHandle)).phase, "dispatching");
} finally {
  await markerProofFixture.cleanup();
}

const bindFixture = await createFixture();
try {
  await bindFixture.db
    .update(personalExtensionCoordination)
    .set({
      protectedLorebookRegistry: JSON.stringify({
        version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
        extensionStorage: { resourceRevision: 0 },
        lorebooks: {},
      }),
    })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await bindFixture.db
    .update(appSettings)
    .set({ value: cmbStorageValue([], undefined, "") })
    .where(eq(appSettings.key, STORAGE_SETTING_KEY));
  await bindFixture.fileDb._fileStore.flushStrict();

  const lease = await bindFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease);
  const operation = await bindFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const context = { ...leaseAuthority, operationHandle: operation.operationHandle };
  await writeConfig(bindFixture, context, 0, ["mutation-ambiguous"], undefined, "");
  let bindCallbackRuns = 0;
  const created = await bindFixture.kernel.runFencedLorebookRegistryTransition(
    context,
    { action: "bind", resourceId: "journal-created-lorebook", expectedRevision: null },
    async () => {
      bindCallbackRuns += 1;
      return "created" as const;
    },
  );
  assert.equal(created.result, "created");
  assert.equal(created.resourceRevision, 0);
  await expectCode(
    bindFixture.kernel.runFencedLorebookRegistryTransition(
      context,
      { action: "bind", resourceId: "journal-second-created-lorebook", expectedRevision: null },
      async () => {
        bindCallbackRuns += 1;
      },
    ),
    "coordination-unavailable",
  );
  assert.equal(bindCallbackRuns, 1, "a draft operation can bind exactly one new lorebook");
  assert.deepEqual(
    parsePersonalExtensionJournalResourceRevisions(
      (await journalFor(bindFixture, operation.operationHandle)).protectedResourceRevisions,
    ),
    [
      { kind: "extension-storage", resourceId: EXTENSION_ID, presence: "present", resourceRevision: 1 },
      {
        kind: "lorebook",
        resourceId: "journal-created-lorebook",
        presence: "present",
        resourceRevision: 0,
      },
    ],
  );
  await writeConfig(bindFixture, context, 1, [], undefined, "journal-created-lorebook");
  await bindFixture.kernel.endOperation(
    { ...leaseAuthority, operationHandle: operation.operationHandle, disposition: "conclusive" },
    proveCmbOperationConclusiveState,
  );
  assert.deepEqual(await journalRows(bindFixture), [], "final config must bind the exact created journal resource");
} finally {
  await bindFixture.cleanup();
}

let dispatchProofCalls = 0;
const dispatchRecheckFixture = await createFixture(async (tx, evidence) => {
  dispatchProofCalls += 1;
  if (dispatchProofCalls > 1) return false;
  return proveCmbOperationDispatchMarker(tx, evidence);
});
try {
  const lease = await dispatchRecheckFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease);
  const operation = await dispatchRecheckFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const context = { ...leaseAuthority, operationHandle: operation.operationHandle };
  await writeConfig(dispatchRecheckFixture, context, 0, ["mutation-ambiguous"]);
  let callbackRuns = 0;
  await expectCode(
    mutateLorebook(dispatchRecheckFixture, context, 0, async () => {
      callbackRuns += 1;
    }),
    "coordination-unavailable",
  );
  assert.equal(dispatchProofCalls, 2, "the exact marker is checked at the barrier and again before callback");
  assert.equal(callbackRuns, 0, "marker loss between strict barriers must prevent the protected callback");
  assert.equal(
    (await journalFor(dispatchRecheckFixture, operation.operationHandle)).phase,
    "dispatching",
    "a failed post-barrier recheck retains conservative dispatching evidence",
  );
} finally {
  await dispatchRecheckFixture.cleanup();
}

let registryDispatchProofCalls = 0;
const registryDispatchRecheckFixture = await createFixture(async (tx, evidence) => {
  registryDispatchProofCalls += 1;
  const proven = await proveCmbOperationDispatchMarker(tx, evidence);
  if (registryDispatchProofCalls === 1 && proven) {
    // Fault injection: the first strict barrier admitted the exact bind
    // target, then the marker/config changed before the commit transaction.
    // The second server-owned proof must observe this fresh state.
    await tx
      .update(appSettings)
      .set({ value: cmbStorageValue([], undefined, ""), updatedAt: new Date(START_WALL_MS + 2).toISOString() })
      .where(eq(appSettings.key, STORAGE_SETTING_KEY));
  }
  return proven;
});
try {
  await registryDispatchRecheckFixture.db
    .update(personalExtensionCoordination)
    .set({
      protectedLorebookRegistry: JSON.stringify({
        version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
        extensionStorage: { resourceRevision: 0 },
        lorebooks: {},
      }),
    })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await registryDispatchRecheckFixture.db
    .update(appSettings)
    .set({ value: cmbStorageValue([], undefined, "") })
    .where(eq(appSettings.key, STORAGE_SETTING_KEY));
  await registryDispatchRecheckFixture.fileDb._fileStore.flushStrict();

  const lease = await registryDispatchRecheckFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease);
  const operation = await registryDispatchRecheckFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const context = { ...leaseAuthority, operationHandle: operation.operationHandle };
  await writeConfig(registryDispatchRecheckFixture, context, 0, ["mutation-ambiguous"], undefined, "");
  const registryBefore = (await coordinationRow(registryDispatchRecheckFixture)).protectedLorebookRegistry;
  const descriptionBefore = (
    await registryDispatchRecheckFixture.db
      .select({ description: installedExtensions.description })
      .from(installedExtensions)
      .where(eq(installedExtensions.id, EXTENSION_ID))
  )[0]?.description;
  let registryCallbackRuns = 0;
  await expectCode(
    registryDispatchRecheckFixture.kernel.runFencedLorebookRegistryTransition(
      context,
      { action: "bind", resourceId: "registry-recheck-created-lorebook", expectedRevision: null },
      async (tx) => {
        registryCallbackRuns += 1;
        await tx
          .update(installedExtensions)
          .set({ description: "must-not-commit-after-marker-drift" })
          .where(eq(installedExtensions.id, EXTENSION_ID));
      },
    ),
    "coordination-unavailable",
  );
  assert.equal(
    registryDispatchProofCalls,
    2,
    "registry bind must recheck the exact marker/config/resource proof in the commit transaction",
  );
  assert.equal(registryCallbackRuns, 0, "marker drift after the bind barrier must prevent the callback");
  assert.equal(
    (
      await registryDispatchRecheckFixture.db
        .select({ description: installedExtensions.description })
        .from(installedExtensions)
        .where(eq(installedExtensions.id, EXTENSION_ID))
    )[0]?.description,
    descriptionBefore,
    "a rejected registry transition must commit no callback data",
  );
  assert.equal(
    (await coordinationRow(registryDispatchRecheckFixture)).protectedLorebookRegistry,
    registryBefore,
    "a rejected registry transition must not bind the candidate resource",
  );
  const preservedJournal = await journalFor(registryDispatchRecheckFixture, operation.operationHandle);
  assert.equal(preservedJournal.phase, "dispatching", "the first durable barrier remains conservative evidence");
  assert.deepEqual(parsePersonalExtensionJournalResourceRevisions(preservedJournal.protectedResourceRevisions), [
    { kind: "extension-storage", resourceId: EXTENSION_ID, presence: "present", resourceRevision: 1 },
  ]);
} finally {
  await registryDispatchRecheckFixture.cleanup();
}

const expiredMarkedFixture = await createFixture();
try {
  const lease = await expiredMarkedFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease);
  const operation = await expiredMarkedFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
    requestedDeadlineMs: 1_000,
  });
  await writeConfig(expiredMarkedFixture, { ...leaseAuthority, operationHandle: operation.operationHandle }, 0, [
    "mutation-ambiguous",
  ]);
  expiredMarkedFixture.advance(1_001);
  const journalBeforeRejectedAdmission = await journalFor(expiredMarkedFixture, operation.operationHandle);
  const rowBeforeRejectedAdmission = await coordinationRow(expiredMarkedFixture);
  await expectCode(
    expiredMarkedFixture.kernel.beginOperation({
      ...leaseAuthority,
      kind: "mutation",
      targetEnsembleId: "journal-expired-marked-replacement",
    }),
    "coordination-unavailable",
  );
  assert.deepEqual(
    await journalFor(expiredMarkedFixture, operation.operationHandle),
    journalBeforeRejectedAdmission,
    "an expired prepared journal with a durable marker must remain recovery evidence",
  );
  assert.deepEqual(
    await coordinationRow(expiredMarkedFixture),
    rowBeforeRejectedAdmission,
    "failed admission must not reap marker-bearing recovery state",
  );
} finally {
  await expiredMarkedFixture.cleanup();
}

const ttlPreparedTakeoverFixture = await createFixture();
try {
  const lease = await ttlPreparedTakeoverFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const operation = await ttlPreparedTakeoverFixture.kernel.beginOperation({
    ...authority(lease),
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
    requestedDeadlineMs: 1_000,
  });
  assert.equal((await journalFor(ttlPreparedTakeoverFixture, operation.operationHandle)).phase, "prepared");
  assert.deepEqual(
    parsePersonalExtensionJournalResourceRevisions(
      (await journalFor(ttlPreparedTakeoverFixture, operation.operationHandle)).protectedResourceRevisions,
    ),
    [],
    "the safe takeover fixture must prove that no marker or protected dispatch was committed",
  );

  ttlPreparedTakeoverFixture.advance(45_001);
  const takeoverHolder = "coordination-journal-takeover-holder";
  const takeover = await ttlPreparedTakeoverFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: takeoverHolder,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  assert.equal(takeover.fence, lease.fence + 1, "a non-handoff TTL takeover advances the fence once");
  assert.deepEqual(
    await journalRows(ttlPreparedTakeoverFixture),
    [],
    "takeover must close a reaped prepared journal that proves marker and dispatch count zero",
  );

  const replacement = await ttlPreparedTakeoverFixture.kernel.beginOperation({
    ...authority(takeover, takeoverHolder),
    kind: "mutation",
    targetEnsembleId: "journal-after-safe-ttl-takeover",
  });
  await ttlPreparedTakeoverFixture.kernel.endOperation({
    ...authority(takeover, takeoverHolder),
    operationHandle: replacement.operationHandle,
    disposition: "aborted",
  });
} finally {
  await ttlPreparedTakeoverFixture.cleanup();
}

const ttlMarkedTakeoverFixture = await createFixture();
try {
  const lease = await ttlMarkedTakeoverFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const operation = await ttlMarkedTakeoverFixture.kernel.beginOperation({
    ...authority(lease),
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
    requestedDeadlineMs: 1_000,
  });
  await writeConfig(ttlMarkedTakeoverFixture, { ...authority(lease), operationHandle: operation.operationHandle }, 0, [
    "mutation-ambiguous",
  ]);
  const journalBeforeTakeover = await journalFor(ttlMarkedTakeoverFixture, operation.operationHandle);
  assert.equal(journalBeforeTakeover.phase, "prepared");
  assert.equal(
    parsePersonalExtensionJournalResourceRevisions(journalBeforeTakeover.protectedResourceRevisions).length,
    1,
    "the unsafe prepared fixture must retain its durable marker revision",
  );

  ttlMarkedTakeoverFixture.advance(45_001);
  await expectCode(
    ttlMarkedTakeoverFixture.kernel.acquireLease({
      extensionId: EXTENSION_ID,
      holderSessionId: "coordination-journal-marked-takeover-holder",
      serverBootId: BOOT_ID,
      contentHash: CONTENT_HASH,
    }),
    "coordination-transition-blocked",
  );
  const blocked = await coordinationRow(ttlMarkedTakeoverFixture);
  assert.equal(blocked.mode, "blocked", "marker-bearing expired evidence must close takeover into blocked mode");
  assert.equal(blocked.leaseTokenDigest, null);
  assert.equal(blocked.holderSessionId, null);
  assert.equal(blocked.activeOperations, "[]");
  assert.deepEqual(
    await journalFor(ttlMarkedTakeoverFixture, operation.operationHandle),
    journalBeforeTakeover,
    "takeover must not discard a prepared journal carrying durable marker evidence",
  );
} finally {
  await ttlMarkedTakeoverFixture.cleanup();
}

const ttlDispatchingTakeoverFixture = await createFixture();
try {
  const lease = await ttlDispatchingTakeoverFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const operation = await ttlDispatchingTakeoverFixture.kernel.beginOperation({
    ...authority(lease),
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
    requestedDeadlineMs: 1_000,
  });
  const context = { ...authority(lease), operationHandle: operation.operationHandle };
  await writeConfig(ttlDispatchingTakeoverFixture, context, 0, ["mutation-ambiguous"]);
  await expectCode(
    mutateLorebook(ttlDispatchingTakeoverFixture, context, 0, async () => {
      throw new Error("simulated post-dispatch failure before data commit");
    }),
    "coordination-unavailable",
  );
  await ttlDispatchingTakeoverFixture.kernel.endOperation({
    ...authority(lease),
    operationHandle: operation.operationHandle,
    disposition: "aborted",
  });
  const journalBeforeTakeover = await journalFor(ttlDispatchingTakeoverFixture, operation.operationHandle);
  assert.equal(journalBeforeTakeover.phase, "dispatching");
  assert.deepEqual(
    JSON.parse((await coordinationRow(ttlDispatchingTakeoverFixture)).activeOperations),
    [],
    "a normal aborted end must leave only the durable dispatching evidence",
  );

  ttlDispatchingTakeoverFixture.advance(45_001);
  await expectCode(
    ttlDispatchingTakeoverFixture.kernel.acquireLease({
      extensionId: EXTENSION_ID,
      holderSessionId: "coordination-journal-dispatching-takeover-holder",
      serverBootId: BOOT_ID,
      contentHash: CONTENT_HASH,
    }),
    "coordination-transition-blocked",
  );
  const blocked = await coordinationRow(ttlDispatchingTakeoverFixture);
  assert.equal(blocked.mode, "blocked", "dispatching evidence must close takeover into blocked mode");
  assert.equal(blocked.leaseTokenDigest, null);
  assert.equal(blocked.holderSessionId, null);
  assert.equal(blocked.activeOperations, "[]");
  assert.deepEqual(
    await journalFor(ttlDispatchingTakeoverFixture, operation.operationHandle),
    journalBeforeTakeover,
    "takeover must retain exact dispatching recovery evidence",
  );

  let recoveryProofCalls = 0;
  const markerBeforeRecovery = (
    await ttlDispatchingTakeoverFixture.db.select().from(appSettings).where(eq(appSettings.key, STORAGE_SETTING_KEY))
  )[0]!.value;
  const recoveryEvidence = {
    coordination: blocked,
    journal: journalBeforeTakeover,
    resourceRevisions: parsePersonalExtensionJournalResourceRevisions(journalBeforeTakeover.protectedResourceRevisions),
  };
  assert.equal(
    await proveCmbBlockedJournalRecovery(ttlDispatchingTakeoverFixture.db, {
      ...recoveryEvidence,
      resourceRevisions: recoveryEvidence.resourceRevisions.map((resource) =>
        resource.kind === "extension-storage" && resource.presence === "present"
          ? { ...resource, resourceRevision: resource.resourceRevision + 1 }
          : resource,
      ),
    }),
    false,
    "a stale storage revision must not authorize dispatching journal recovery",
  );
  assert.equal(
    await proveCmbBlockedJournalRecovery(ttlDispatchingTakeoverFixture.db, {
      ...recoveryEvidence,
      resourceRevisions: [
        ...recoveryEvidence.resourceRevisions,
        {
          kind: "lorebook",
          resourceId: OTHER_LOREBOOK_ID,
          presence: "present",
          resourceRevision: 0,
        },
      ],
    }),
    false,
    "another lorebook's revision must not authorize this ensemble's recovery",
  );
  await ttlDispatchingTakeoverFixture.db
    .update(appSettings)
    .set({ value: cmbStorageValue([], ["mutation-ambiguous"]), updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_SETTING_KEY));
  assert.equal(
    await proveCmbBlockedJournalRecovery(ttlDispatchingTakeoverFixture.db, recoveryEvidence),
    false,
    "another ensemble's marker must not authorize this journal recovery",
  );
  await ttlDispatchingTakeoverFixture.db
    .update(appSettings)
    .set({ value: markerBeforeRecovery, updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_SETTING_KEY));
  const recovered = await ttlDispatchingTakeoverFixture.kernel.recoverBlockedCoordination(
    EXTENSION_ID,
    async (_tx, row) => ({
      contentHash: row.contentHash,
      configRevision: row.configRevision,
      rawStorageValue: markerBeforeRecovery,
      registry: parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry),
    }),
    async (_tx, evidence) => {
      recoveryProofCalls += 1;
      return proveCmbBlockedJournalRecovery(_tx, evidence);
    },
  );
  assert.equal(recovered.mode, "inactive", "proven dispatching evidence must have a product recovery exit");
  assert.equal(recoveryProofCalls, 1, "dispatching recovery must require a fresh server-owned proof");
  assert.deepEqual(await journalRows(ttlDispatchingTakeoverFixture), [], "recovery must close the proven journal");
  assert.equal(
    (
      await ttlDispatchingTakeoverFixture.db.select().from(appSettings).where(eq(appSettings.key, STORAGE_SETTING_KEY))
    )[0]!.value,
    markerBeforeRecovery,
    "journal recovery must preserve the mutation-ambiguous marker for manual resolution",
  );
} finally {
  await ttlDispatchingTakeoverFixture.cleanup();
}

const fixture = await createFixture();
try {
  const lease = await fixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease);

  await expectCode(
    fixture.kernel.beginOperation({
      ...leaseAuthority,
      kind: "mutation",
      targetEnsembleId: "private memory content must not become a journal key",
    }),
    "invalid-request",
  );
  assert.deepEqual(await journalRows(fixture), [], "non-identifier target content must never enter the journal");

  fixture.failNextStrictWrite();
  await expectCode(
    fixture.kernel.beginOperation({
      ...leaseAuthority,
      kind: "mutation",
      targetEnsembleId: ENSEMBLE_ID,
    }),
    "coordination-unavailable",
  );
  assert.deepEqual(await journalRows(fixture), [], "failed prepared flush must leave no journal");
  assert.deepEqual(JSON.parse((await coordinationRow(fixture)).activeOperations), []);

  const first = await fixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const firstContext = { ...leaseAuthority, operationHandle: first.operationHandle };
  let journal = await journalFor(fixture, first.operationHandle);
  assert.equal(journal.phase, "prepared");
  assert.equal(journal.targetEnsembleId, ENSEMBLE_ID);
  assert.deepEqual(parsePersonalExtensionJournalResourceRevisions(journal.protectedResourceRevisions), []);
  const serializedJournal = JSON.stringify(journal);
  assert.equal(serializedJournal.includes(first.operationHandle), false, "raw operation handle must not be journaled");
  assert.equal(serializedJournal.includes(lease.leaseToken), false, "raw lease token must not be journaled");
  assert.equal(serializedJournal.includes("private-memory-content"), false, "content must not be journaled");

  let dispatchCallbackRuns = 0;
  await expectCode(
    mutateLorebook(fixture, firstContext, 0, async () => {
      dispatchCallbackRuns += 1;
    }),
    "coordination-unavailable",
  );
  assert.equal(dispatchCallbackRuns, 0, "protected data cannot dispatch before the durable marker barrier");
  assert.equal((await journalFor(fixture, first.operationHandle)).phase, "prepared");

  fixture.failNextStrictWrite();
  await expectCode(writeConfig(fixture, firstContext, 0, ["mutation-ambiguous"]), "coordination-unavailable");
  assert.equal((await coordinationRow(fixture)).configRevision, 0, "failed marker flush rolls back config mutation");
  assert.deepEqual(
    parsePersonalExtensionJournalResourceRevisions(
      (await journalFor(fixture, first.operationHandle)).protectedResourceRevisions,
    ),
    [],
  );

  await writeConfig(fixture, firstContext, 0, ["mutation-ambiguous"]);
  journal = await journalFor(fixture, first.operationHandle);
  assert.equal(journal.phase, "prepared", "marker storage is durable before protected data dispatch");
  assert.deepEqual(parsePersonalExtensionJournalResourceRevisions(journal.protectedResourceRevisions), [
    { kind: "extension-storage", resourceId: EXTENSION_ID, presence: "present", resourceRevision: 1 },
  ]);

  fixture.failNextStrictWrite();
  await expectCode(
    mutateLorebook(fixture, firstContext, 0, async () => {
      dispatchCallbackRuns += 1;
    }),
    "coordination-unavailable",
  );
  assert.equal(dispatchCallbackRuns, 0, "dispatching strict failure must occur before the data callback");
  assert.equal((await journalFor(fixture, first.operationHandle)).phase, "prepared");

  await expectCode(
    mutateLorebook(fixture, firstContext, 0, async (tx) => {
      dispatchCallbackRuns += 1;
      await tx
        .update(installedExtensions)
        .set({ description: "must-roll-back" })
        .where(eq(installedExtensions.id, EXTENSION_ID));
      throw new Error("simulated data failure after dispatch");
    }),
    "coordination-unavailable",
  );
  assert.equal(dispatchCallbackRuns, 1);
  journal = await journalFor(fixture, first.operationHandle);
  assert.equal(journal.phase, "dispatching", "post-dispatch failure must preserve durable ambiguity evidence");
  assert.equal(journal.finalAt, null);
  assert.equal(
    (
      await fixture.db
        .select({ description: installedExtensions.description })
        .from(installedExtensions)
        .where(eq(installedExtensions.id, EXTENSION_ID))
    )[0]?.description,
    "unchanged",
    "failed data transaction must leave durable data unchanged",
  );

  const beforeStaleAttempts = await journalFor(fixture, first.operationHandle);
  let staleCallbackRuns = 0;
  await expectCode(
    mutateLorebook(fixture, { ...firstContext, operationHandle: "raw-journal-secret-missing" }, 0, async () => {
      staleCallbackRuns += 1;
    }),
    "operation-lost",
  );
  await expectCode(
    mutateLorebook(fixture, { ...firstContext, fence: firstContext.fence - 1 }, 0, async () => {
      staleCallbackRuns += 1;
    }),
    "lease-lost",
  );
  assert.equal(staleCallbackRuns, 0);
  assert.deepEqual(await journalFor(fixture, first.operationHandle), beforeStaleAttempts);
  await fixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: first.operationHandle,
    disposition: "aborted",
  });
  assert.equal((await journalFor(fixture, first.operationHandle)).phase, "dispatching");

  const unresolvedBeforeRejectedAdmission = await journalFor(fixture, first.operationHandle);
  const rowBeforeRejectedAdmission = await coordinationRow(fixture);
  await expectCode(
    fixture.kernel.beginOperation({
      ...leaseAuthority,
      kind: "mutation",
      targetEnsembleId: ENSEMBLE_ID,
    }),
    "coordination-unavailable",
  );
  assert.deepEqual(
    await journalFor(fixture, first.operationHandle),
    unresolvedBeforeRejectedAdmission,
    "same-boot admission must preserve unresolved dispatch evidence exactly",
  );
  assert.deepEqual(
    await coordinationRow(fixture),
    rowBeforeRejectedAdmission,
    "same-boot admission rejection must not mutate authority or protected revision state",
  );

  // The following cases exercise independent completion outcomes. Remove only
  // this fixture's already-asserted recovery evidence so they do not depend on
  // an operator recovery implementation outside this regression's scope.
  await deleteJournalForIsolatedTestSetup(fixture, first.operationHandle);

  const unproven = await fixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const unprovenContext = { ...leaseAuthority, operationHandle: unproven.operationHandle };
  await writeConfig(fixture, unprovenContext, 1, ["mutation-ambiguous"]);
  await mutateLorebook(fixture, unprovenContext, 0, async () => {});
  await fixture.kernel.endOperation(
    { ...leaseAuthority, operationHandle: unproven.operationHandle, disposition: "conclusive" },
    proveCmbOperationConclusiveState,
  );
  assert.equal(
    (await journalFor(fixture, unproven.operationHandle)).phase,
    "dispatching",
    "a client conclusive claim cannot clear a still-marked config",
  );
  await deleteJournalForIsolatedTestSetup(fixture, unproven.operationHandle);

  const conclusive = await fixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const conclusiveContext = { ...leaseAuthority, operationHandle: conclusive.operationHandle };
  await writeConfig(fixture, conclusiveContext, 2, ["mutation-ambiguous"]);
  await mutateLorebook(fixture, conclusiveContext, 1, async () => {});
  await writeConfig(fixture, conclusiveContext, 3, []);
  await fixture.kernel.endOperation(
    { ...leaseAuthority, operationHandle: conclusive.operationHandle, disposition: "conclusive" },
    proveCmbOperationConclusiveState,
  );
  assert.equal(
    (await journalRows(fixture)).some((row) => row.operationDigest === sha256(conclusive.operationHandle)),
    false,
    "fresh Ready + marker-clear + exact latest revisions may finalize and clear the journal",
  );

  const finalCrash = await fixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const finalCrashContext = { ...leaseAuthority, operationHandle: finalCrash.operationHandle };
  await writeConfig(fixture, finalCrashContext, 4, ["mutation-ambiguous"]);
  await mutateLorebook(fixture, finalCrashContext, 2, async () => {});
  await writeConfig(fixture, finalCrashContext, 5, []);
  const originalFlushStrict = fixture.fileDb._fileStore.flushStrict;
  let endFlushCalls = 0;
  fixture.fileDb._fileStore.flushStrict = async () => {
    endFlushCalls += 1;
    if (endFlushCalls === 2) throw new Error("simulated final journal cleanup crash");
    await originalFlushStrict();
  };
  try {
    await expectCode(
      fixture.kernel.endOperation(
        { ...leaseAuthority, operationHandle: finalCrash.operationHandle, disposition: "conclusive" },
        proveCmbOperationConclusiveState,
      ),
      "coordination-unavailable",
    );
  } finally {
    fixture.fileDb._fileStore.flushStrict = originalFlushStrict;
  }
  const finalJournal = await journalFor(fixture, finalCrash.operationHandle);
  assert.equal(finalJournal.phase, "final", "cleanup failure must retain the durable final proof state");
  assert.ok(finalJournal.finalAt);
  assert.equal(
    JSON.parse((await coordinationRow(fixture)).activeOperations).some(
      (operation: { digest: string }) => operation.digest === sha256(finalCrash.operationHandle),
    ),
    false,
    "the conclusive operation is no longer active after its final barrier",
  );
} finally {
  await fixture.cleanup();
}

const restartAcquireFixture = await createFixture();
try {
  const bootALease = await restartAcquireFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const bootAAuthority = authority(bootALease);
  const interrupted = await restartAcquireFixture.kernel.beginOperation({
    ...bootAAuthority,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const interruptedContext = { ...bootAAuthority, operationHandle: interrupted.operationHandle };
  await writeConfig(restartAcquireFixture, interruptedContext, 0, ["mutation-ambiguous"]);
  await mutateLorebook(restartAcquireFixture, interruptedContext, 0, async () => {});
  await restartAcquireFixture.kernel.endOperation({
    ...bootAAuthority,
    operationHandle: interrupted.operationHandle,
    disposition: "aborted",
  });

  const journalBeforeRestart = await journalFor(restartAcquireFixture, interrupted.operationHandle);
  const rowBeforeRestart = await coordinationRow(restartAcquireFixture);
  assert.deepEqual(
    JSON.parse(rowBeforeRestart.activeOperations),
    [],
    "restart fixture isolates orphan journal evidence",
  );
  const restartedBootId = "coordination-journal-restarted-boot";
  const restartedKernel = createPersonalExtensionCoordinationKernel(restartAcquireFixture.db, {
    serverBootId: restartedBootId,
    randomToken: () => "raw-journal-restarted-secret",
  });
  await expectCode(
    restartedKernel.acquireLease({
      extensionId: EXTENSION_ID,
      holderSessionId: "coordination-journal-restarted-holder",
      serverBootId: restartedBootId,
      contentHash: CONTENT_HASH,
    }),
    "coordination-transition-blocked",
  );

  const blocked = await coordinationRow(restartAcquireFixture);
  assert.equal(blocked.mode, "blocked");
  assert.equal(blocked.serverBootId, restartedBootId);
  assert.equal(blocked.fence, rowBeforeRestart.fence + 1);
  assert.equal(blocked.leaseTokenDigest, null);
  assert.equal(blocked.holderSessionId, null);
  assert.equal(blocked.expiresAt, null);
  assert.equal(blocked.handoffRequestId, null);
  assert.equal(blocked.handoffRequester, null);
  assert.equal(blocked.handoffDeadlineAt, null);
  assert.deepEqual(JSON.parse(blocked.activeOperations), []);
  assert.deepEqual(
    await journalFor(restartAcquireFixture, interrupted.operationHandle),
    journalBeforeRestart,
    "restart blocking must preserve the unresolved operation journal byte-for-byte",
  );
  await expectCode(
    restartedKernel.beginOperation({
      extensionId: EXTENSION_ID,
      holderSessionId: "coordination-journal-restarted-holder",
      serverBootId: restartedBootId,
      contentHash: CONTENT_HASH,
      fence: blocked.fence,
      leaseToken: "raw-journal-restarted-secret",
      kind: "mutation",
      targetEnsembleId: ENSEMBLE_ID,
    }),
    "coordination-transition-blocked",
  );
} finally {
  await restartAcquireFixture.cleanup();
}

const startupRecoveryFixture = await createFixture();
try {
  const bootALease = await startupRecoveryFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const interrupted = await startupRecoveryFixture.kernel.beginOperation({
    ...authority(bootALease),
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  // Corrupt/missing journal evidence must not make a persisted active operation
  // adoptable by a fresh process. This isolates the activeOperations half of
  // the startup fail-closed predicate.
  await deleteJournalForIsolatedTestSetup(startupRecoveryFixture, interrupted.operationHandle);
  assert.deepEqual(await journalRows(startupRecoveryFixture), []);
  const fenceBeforeRecovery = (await coordinationRow(startupRecoveryFixture)).fence;
  const startupBootId = "coordination-journal-startup-recovery-boot";
  const startupKernel = createPersonalExtensionCoordinationKernel(startupRecoveryFixture.db, {
    serverBootId: startupBootId,
  });
  assert.deepEqual(await startupKernel.recoverStaleTransitions(), { blocked: 1 });
  const blocked = await coordinationRow(startupRecoveryFixture);
  assert.equal(blocked.mode, "blocked");
  assert.equal(blocked.serverBootId, startupBootId);
  assert.equal(blocked.fence, fenceBeforeRecovery + 1);
  assert.equal(blocked.leaseTokenDigest, null);
  assert.equal(blocked.holderSessionId, null);
  assert.deepEqual(JSON.parse(blocked.activeOperations), []);
  assert.deepEqual(await journalRows(startupRecoveryFixture), [], "startup recovery must not invent journal evidence");
} finally {
  await startupRecoveryFixture.cleanup();
}

console.info("Personal extension coordination operation journal regression passed.");
