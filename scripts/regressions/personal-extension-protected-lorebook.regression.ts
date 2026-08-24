import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import {
  PERSONAL_EXTENSION_COORDINATION_BOOT_HEADER,
  PERSONAL_EXTENSION_COORDINATION_CONTENT_HASH_HEADER,
  PERSONAL_EXTENSION_COORDINATION_EXTENSION_HEADER,
  PERSONAL_EXTENSION_COORDINATION_FENCE_HEADER,
  PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER,
  PERSONAL_EXTENSION_COORDINATION_LEASE_TOKEN_HEADER,
  personalExtensionCoordinationRevisionedLorebookEntryListResponseSchema,
  personalExtensionCoordinationRevisionedLorebookEntryProjectionListResponseSchema,
  personalExtensionCoordinationRevisionedLorebookEntryResponseSchema,
  personalExtensionCoordinationRevisionedLorebookListResponseSchema,
  personalExtensionCoordinationRevisionedLorebookResponseSchema,
} from "../../packages/shared/src/schemas/personal-extension-coordination.schema.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  appSettings,
  lorebookEntries,
  lorebooks,
  personalExtensionCoordination,
} from "../../packages/server/src/db/schema/index.js";
import {
  createPersonalExtensionCoordinationKernel,
  PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
  PersonalExtensionCoordinationKernelError,
  parsePersonalExtensionProtectedResourceRegistry,
} from "../../packages/server/src/services/extensions/personal-extension-coordination-kernel.service.js";
import { getPersonalExtensionCoordinationService } from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";
import { getPersonalExtensionCoordinationEventService } from "../../packages/server/src/services/extensions/personal-extension-coordination-events.service.js";
import { createPersonalExtensionsStorage } from "../../packages/server/src/services/extensions/personal-extension-storage.service.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { createLorebooksStorage } from "../../packages/server/src/services/storage/lorebooks.storage.js";
import { lorebooksRoutes } from "../../packages/server/src/routes/lorebooks.routes.js";

const EXTENSION_ID = "protected-lorebook-owner";
const HOLDER = "protected-lorebook-holder";
const ENSEMBLE_ID = "ensemble-protected-lorebook";
const DRAFT_ENSEMBLE_ID = "ensemble-protected-draft";
const STORAGE_KEY = `extension-storage:${EXTENSION_ID}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cmbStorageValue(existingLorebookId: string, existingReasons: string[], draftReasons: string[] = []) {
  return JSON.stringify({
    convoMemoryBridgeV1: {
      schemaVersion: 1,
      ensembles: [
        {
          ensembleId: ENSEMBLE_ID,
          name: "Protected fixture",
          rpChatId: "protected-rp-chat",
          groupConvoChatIds: [],
          lorebookId: existingLorebookId,
          autoSync: true,
          embedding: { connectionId: "__local_sidecar__", model: "local-sidecar" },
          runtime: {
            semanticStatus: "ready",
            lastSuccessfulEmbeddingProfile: null,
            pendingEmbeddingProfile: null,
            manualRecoveryReasons: existingReasons,
            lastSuccessfulSyncAt: null,
          },
          members: [{ castId: "alpha", characterId: "protected-character", dmChatId: "protected-dm-chat" }],
        },
        {
          ensembleId: DRAFT_ENSEMBLE_ID,
          name: "Protected draft fixture",
          rpChatId: "protected-draft-rp-chat",
          groupConvoChatIds: [],
          lorebookId: "",
          autoSync: true,
          embedding: { connectionId: "__local_sidecar__", model: "local-sidecar" },
          runtime: {
            semanticStatus: "ready",
            lastSuccessfulEmbeddingProfile: null,
            pendingEmbeddingProfile: null,
            manualRecoveryReasons: draftReasons,
            lastSuccessfulSyncAt: null,
          },
          members: [{ castId: "draft", characterId: "protected-draft-character", dmChatId: "protected-draft-dm-chat" }],
        },
      ],
    },
  });
}
const storageDir = mkdtempSync(join(tmpdir(), "marinara-protected-lorebook-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;
const fileDb = await createFileNativeDB({ fileOperations: { writeFile, flushDirectory: async () => {} } });
const db = fileDb as unknown as DB;
const extensions = createPersonalExtensionsStorage(db);
const extension = await extensions.create(
  { name: EXTENSION_ID, runtime: "client", js: "self.postMessage('ready');" },
  { id: EXTENSION_ID, source: "professor_mari" },
);
assert.ok(extension);
await extensions.approve(EXTENSION_ID, extension.contentHash);
const storage = createLorebooksStorage(db);
const protectedBook = await storage.create({ name: "Protected book", tags: ["not-authority"] });
const ordinaryBook = await storage.create({ name: "Ordinary book" });
assert.ok(protectedBook && ordinaryBook);
const protectedEntry = await storage.createEntry({ lorebookId: protectedBook.id, name: "Protected entry" });
assert.ok(protectedEntry);
const protectedFolder = await storage.createFolder(protectedBook.id, { name: "Protected folder" });
assert.ok(protectedFolder);
// A chat that references the protected book the way a live CMB ensemble does.
// A rejected legacy delete must leave this wiring untouched.
const chatsStorage = createChatsStorage(db);
const wiredChat = await chatsStorage.create({
  name: "Protected wiring",
  mode: "conversation",
  characterIds: [],
  groupId: null,
  personaId: null,
  promptPresetId: null,
  connectionId: null,
});
await chatsStorage.patchMetadata(wiredChat.id, { activeLorebookIds: [protectedBook.id] });
function wiredChatLorebookIds(chat: { metadata: string } | null | undefined) {
  if (!chat) return null;
  const parsed = JSON.parse(chat.metadata) as { activeLorebookIds?: unknown };
  return Array.isArray(parsed.activeLorebookIds) ? parsed.activeLorebookIds : null;
}
const protectedRegistry = {
  version: 1 as const,
  extensionStorage: { resourceRevision: 0 },
  lorebooks: { [protectedBook.id]: { resourceRevision: 0 } },
};
const timestamp = new Date().toISOString();
await db.insert(personalExtensionCoordination).values({
  extensionId: EXTENSION_ID,
  contentHash: extension.contentHash,
  mode: "active",
  serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
  protectedLorebookRegistry: JSON.stringify(protectedRegistry),
  activeOperations: "[]",
  createdAt: timestamp,
  updatedAt: timestamp,
});
await db.insert(appSettings).values({
  key: STORAGE_KEY,
  value: cmbStorageValue(protectedBook.id, []),
  updatedAt: timestamp,
});
await fileDb._fileStore.flushStrict();
const eventService = getPersonalExtensionCoordinationEventService(db);
const publishedEvents: Array<Record<string, unknown>> = [];
const eventSubscription = await eventService.subscribe(
  { extensionId: EXTENSION_ID, deviceSessionId: "10000000-0000-4000-8000-000000000021" },
  {
    send(event) {
      publishedEvents.push(event);
    },
    close() {},
  },
);
const app = Fastify();
app.decorate("db", db);
await app.register(lorebooksRoutes, { prefix: "/api/lorebooks" });

// The client facade validates every coordination response with these closed
// schemas; a key that upstream adds to ordinary lorebook rows (lorebooks.embedding,
// lorebook_entries.embeddingSpaceId) must never leak into the fenced wire shape.
function assertContractShape(label: string, schema: { safeParse(value: unknown): { success: boolean; error?: unknown } }, body: unknown) {
  const parsed = schema.safeParse(body);
  assert.ok(parsed.success, `${label}: fenced response must match the closed client contract: ${String(parsed.error)}`);
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error) => error instanceof PersonalExtensionCoordinationKernelError && error.code === code,
  );
}

try {
  await app.ready();
  await db.update(lorebooks).set({ tags: "[]" }).where(eq(lorebooks.id, protectedBook.id));
  for (const mode of ["activating", "active", "draining-deactivate", "restoring", "blocked"] as const) {
    await db
      .update(personalExtensionCoordination)
      .set({ mode, updatedAt: new Date().toISOString() })
      .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
    const before = await storage.getById(protectedBook.id);
    await expectCode(storage.update(protectedBook.id, { name: `must not update in ${mode}` }), "coordination-required");
    assert.equal((await storage.getById(protectedBook.id))?.name, before?.name, `${mode} must mutate nothing`);
  }
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "active", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await expectCode(
    storage.createEntry({ lorebookId: protectedBook.id, name: "must not create" }),
    "coordination-required",
  );
  await expectCode(storage.updateEntry(protectedEntry.id, { name: "must not update" }), "coordination-required");
  await expectCode(storage.removeEntry(protectedEntry.id), "coordination-required");
  await expectCode(storage.remove(protectedBook.id), "coordination-required");
  await expectCode(
    storage.bulkUpdateEntries(protectedBook.id, [protectedEntry.id], { enabled: false }),
    "coordination-required",
  );
  await expectCode(storage.bulkCreateEntries(protectedBook.id, [{ name: "must not import" }]), "coordination-required");
  await expectCode(storage.reorderEntries(protectedBook.id, [protectedEntry.id]), "coordination-required");
  await expectCode(storage.updateEntryEmbedding(protectedEntry.id, [0.25]), "coordination-required");
  await expectCode(storage.clearEntryEmbeddings(protectedBook.id), "coordination-required");
  await expectCode(storage.createFolder(protectedBook.id, { name: "must not create folder" }), "coordination-required");
  await expectCode(
    storage.updateFolder(protectedFolder.id, { name: "must not update folder" }, protectedBook.id),
    "coordination-required",
  );
  await expectCode(storage.removeFolder(protectedFolder.id, protectedBook.id), "coordination-required");
  await expectCode(storage.reorderFolders(protectedBook.id, [protectedFolder.id]), "coordination-required");
  await expectCode(storage.cloneFolder(protectedFolder.id, protectedBook.id), "coordination-required");
  const ordinary = await storage.update(ordinaryBook.id, { name: "ordinary still works" });
  assert.equal(ordinary?.name, "ordinary still works", "unprotected CRUD must retain legacy behavior");

  const raceBook = await storage.create({ name: "Legacy activation race" });
  const disposableInactiveBook = await storage.create({ name: "Disposable inactive book" });
  assert.ok(raceBook && disposableInactiveBook);
  const raceRegistry = JSON.stringify({
    ...protectedRegistry,
    lorebooks: {
      ...protectedRegistry.lorebooks,
      [raceBook.id]: { resourceRevision: 0 },
      [disposableInactiveBook.id]: { resourceRevision: 0 },
    },
  });
  const raceStorageValue = cmbStorageValue(raceBook.id, []);
  await db
    .update(appSettings)
    .set({ value: raceStorageValue, updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_KEY));
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "inactive", protectedLorebookRegistry: raceRegistry, updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));

  // An inactive registry must retain the full legacy storage behavior. This
  // also exercises every multi-write path after moving it under one guard.
  const inactiveFolder = await storage.createFolder(raceBook.id, { name: "Inactive folder" });
  assert.ok(inactiveFolder);
  const updatedInactiveFolder = await storage.updateFolder(
    inactiveFolder.id,
    { name: "Inactive folder updated" },
    raceBook.id,
  );
  assert.equal(updatedInactiveFolder?.name, "Inactive folder updated");
  const inactiveEntry = await storage.createEntry({
    lorebookId: raceBook.id,
    folderId: inactiveFolder.id,
    name: "Inactive entry",
  });
  assert.ok(inactiveEntry);
  assert.equal((await storage.updateEntry(inactiveEntry.id, { content: "legacy content" }))?.content, "legacy content");
  assert.deepEqual(await storage.bulkUpdateEntries(raceBook.id, [inactiveEntry.id], { enabled: false }), {
    updated: 1,
  });
  await storage.updateEntryEmbedding(inactiveEntry.id, [0.25, 0.75]);
  assert.deepEqual((await storage.getEntry(inactiveEntry.id))?.embedding, [0.25, 0.75]);
  await storage.clearEntryEmbeddings(raceBook.id);
  assert.equal((await storage.getEntry(inactiveEntry.id))?.embedding, null);
  const [importedInactiveEntry] = await storage.bulkCreateEntries(raceBook.id, [
    { folderId: inactiveFolder.id, name: "Imported inactive entry" },
  ]);
  assert.ok(importedInactiveEntry);
  await storage.reorderEntries(raceBook.id, [importedInactiveEntry.id, inactiveEntry.id], inactiveFolder.id);
  await storage.reorderFolders(raceBook.id, [inactiveFolder.id]);
  const clonedInactiveFolder = await storage.cloneFolder(inactiveFolder.id, raceBook.id);
  assert.ok(clonedInactiveFolder);
  await storage.removeFolder(clonedInactiveFolder.id, raceBook.id, true);
  await storage.removeEntry(importedInactiveEntry.id);
  await storage.removeFolder(inactiveFolder.id, raceBook.id, true);
  await storage.remove(disposableInactiveBook.id);
  assert.equal(await storage.getById(disposableInactiveBook.id), null);

  // Force activation to commit after the legacy route-level check but before
  // its transaction begins. The transaction-local guard must observe active.
  const legacyTransactionReached = deferred();
  const resumeLegacyTransaction = deferred();
  let pauseNextTransaction = true;
  const pausedLegacyDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async <T>(callback: (tx: DB) => Promise<T> | T) => {
          if (pauseNextTransaction) {
            pauseNextTransaction = false;
            legacyTransactionReached.resolve();
            await resumeLegacyTransaction.promise;
          }
          return target.transaction(callback);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const pausedLegacyStorage = createLorebooksStorage(pausedLegacyDb);
  const losingLegacyUpdate = pausedLegacyStorage.update(raceBook.id, { name: "must not cross activation" });
  await legacyTransactionReached.promise;
  const raceKernel = createPersonalExtensionCoordinationKernel(db);
  const activateRaceCoordination = async () => {
    const snapshot = {
      contentHash: extension.contentHash,
      configRevision: 0,
      rawStorageValue: raceStorageValue,
      registry: parsePersonalExtensionProtectedResourceRegistry(raceRegistry),
    };
    const barrier = await raceKernel.beginActivation(EXTENSION_ID, snapshot);
    return raceKernel.completeActivation(barrier, async () => snapshot);
  };
  await activateRaceCoordination();
  resumeLegacyTransaction.resolve();
  await expectCode(losingLegacyUpdate, "coordination-required");
  assert.equal((await storage.getById(raceBook.id))?.name, "Legacy activation race", "activation winner writes zero");

  // Inverse ordering: once the legacy guard owns the transaction, activation
  // queues behind it, so the legacy write commits before protected mode begins.
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "inactive", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const legacyGuardPassed = deferred();
  const resumeLegacyWrite = deferred();
  const legacyFirst = db.transaction(async (tx) => {
    await storage.assertLegacyWritable(raceBook.id, tx);
    legacyGuardPassed.resolve();
    await resumeLegacyWrite.promise;
    await tx.update(lorebooks).set({ name: "legacy committed first" }).where(eq(lorebooks.id, raceBook.id));
  });
  await legacyGuardPassed.promise;
  let activationCommitted = false;
  const activationSecond = activateRaceCoordination().then(() => {
    activationCommitted = true;
  });
  await Promise.resolve();
  assert.equal(activationCommitted, false, "activation must wait for the admitted legacy transaction");
  resumeLegacyWrite.resolve();
  await legacyFirst;
  await activationSecond;
  assert.equal((await storage.getById(raceBook.id))?.name, "legacy committed first");
  await db
    .update(appSettings)
    .set({ value: cmbStorageValue(protectedBook.id, []), updatedAt: new Date().toISOString() })
    .where(eq(appSettings.key, STORAGE_KEY));
  await db
    .update(personalExtensionCoordination)
    .set({
      mode: "active",
      protectedLorebookRegistry: JSON.stringify(protectedRegistry),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));

  const coordination = getPersonalExtensionCoordinationService(db);
  const lease = await coordination.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
    contentHash: extension.contentHash,
  });
  const operation = await coordination.beginOperation({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const fencedContext = {
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    operationHandle: operation.operationHandle,
  };
  await coordination.runFencedResourceMutation(
    fencedContext,
    [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 0 }],
    async (tx) => {
      const markerTimestamp = new Date().toISOString();
      await tx
        .update(appSettings)
        .set({ value: cmbStorageValue(protectedBook.id, ["mutation-ambiguous"]), updatedAt: markerTimestamp })
        .where(eq(appSettings.key, STORAGE_KEY));
      await tx
        .update(personalExtensionCoordination)
        .set({ configRevision: 1, updatedAt: markerTimestamp })
        .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
      return "durable-marker";
    },
  );
  await storage.runFencedLorebookMutation(
    fencedContext,
    [{ kind: "lorebook", resourceId: protectedBook.id, expectedRevision: 0 }],
    async (tx) => {
      await tx.update(lorebooks).set({ name: "fenced protected update" }).where(eq(lorebooks.id, protectedBook.id));
    },
  );
  assert.deepEqual(publishedEvents.at(-1), {
    schemaVersion: 1,
    eventEpoch: publishedEvents.at(-1)?.eventEpoch,
    cursor: publishedEvents.at(-1)?.cursor,
    type: "resource-changed",
    resourceRevision: 1,
  });
  const row = (
    await db
      .select()
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID))
  )[0];
  assert.ok(row);
  assert.equal(
    parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry).lorebooks[protectedBook.id]
      ?.resourceRevision,
    1,
  );
  assert.equal((await storage.getById(protectedBook.id))?.name, "fenced protected update");

  const guardedUrl = (bookId: string) => `/api/lorebooks/${bookId}/coordination`;
  const guardedBody = (
    fence: number,
    expectedResourceRevision: number,
    operationHandle = operation.operationHandle,
  ) => ({
    extensionId: EXTENSION_ID,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence,
    leaseToken: lease.leaseToken,
    operationHandle,
    expectedResourceRevision,
  });
  const guardedHeaders = {
    [PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER]: HOLDER,
    [PERSONAL_EXTENSION_COORDINATION_EXTENSION_HEADER]: EXTENSION_ID,
    [PERSONAL_EXTENSION_COORDINATION_BOOT_HEADER]: lease.serverBootId,
    [PERSONAL_EXTENSION_COORDINATION_CONTENT_HASH_HEADER]: lease.contentHash,
    [PERSONAL_EXTENSION_COORDINATION_FENCE_HEADER]: String(lease.fence),
    [PERSONAL_EXTENSION_COORDINATION_LEASE_TOKEN_HEADER]: lease.leaseToken,
  };

  const ordinaryDelete = await app.inject({ method: "DELETE", url: `/api/lorebooks/${ordinaryBook.id}` });
  assert.equal(ordinaryDelete.statusCode, 204, ordinaryDelete.body);
  assert.equal(await storage.getById(ordinaryBook.id), null, "ordinary inactive delete keeps legacy parity");

  for (const [label, bookId, body, status, code] of [
    ["stale", protectedBook.id, guardedBody(lease.fence, 0), 409, "resource-revision-conflict"],
    [
      "wrong-book",
      protectedEntry.lorebookId === protectedBook.id ? "not-registered-book" : protectedBook.id,
      guardedBody(lease.fence, 1),
      409,
      "protected-resource-unregistered",
    ],
    ["old-fence", protectedBook.id, guardedBody(lease.fence + 1, 1), 409, "lease-lost"],
  ] as const) {
    const response = await app.inject({
      method: "DELETE",
      url: guardedUrl(bookId),
      headers: guardedHeaders,
      payload: body,
    });
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    assert.equal(response.json().code, code);
    assert.ok(await storage.getById(protectedBook.id), `${label} must not delete the protected book`);
  }

  const listResponse = await app.inject({
    method: "GET",
    url: "/api/lorebooks/coordination",
    headers: guardedHeaders,
  });
  assert.equal(listResponse.statusCode, 200, listResponse.body);
  assert.equal(listResponse.json().items[0].resourceRevision, 1);
  assert.equal(listResponse.body.includes(lease.leaseToken), false, "read responses must not echo raw authority");
  assertContractShape("list", personalExtensionCoordinationRevisionedLorebookListResponseSchema, listResponse.json());
  const getResponse = await app.inject({
    method: "GET",
    url: guardedUrl(protectedBook.id),
    headers: guardedHeaders,
  });
  assert.equal(getResponse.statusCode, 200, getResponse.body);
  assert.equal(getResponse.json().value.id, protectedBook.id);
  assertContractShape("get", personalExtensionCoordinationRevisionedLorebookResponseSchema, getResponse.json());

  const guardedUpdate = await app.inject({
    method: "PATCH",
    url: guardedUrl(protectedBook.id),
    headers: guardedHeaders,
    payload: {
      ...guardedBody(lease.fence, 1),
      changes: { name: "guarded route update", excludeFromVectorization: false },
    },
  });
  assert.equal(guardedUpdate.statusCode, 200, guardedUpdate.body);
  assert.equal(guardedUpdate.json().resourceRevision, 2);
  assert.equal(guardedUpdate.json().value.name, "guarded route update");
  assertContractShape("update", personalExtensionCoordinationRevisionedLorebookResponseSchema, guardedUpdate.json());

  const guardedCreateEntry = await app.inject({
    method: "POST",
    url: `${guardedUrl(protectedBook.id)}/entries`,
    headers: guardedHeaders,
    payload: { ...guardedBody(lease.fence, 2), entry: { name: "guarded route entry", content: "memory" } },
  });
  assert.equal(guardedCreateEntry.statusCode, 200, guardedCreateEntry.body);
  assert.equal(guardedCreateEntry.json().resourceRevision, 3);
  assertContractShape("create entry", personalExtensionCoordinationRevisionedLorebookEntryResponseSchema, guardedCreateEntry.json());
  const guardedEntryId = String(guardedCreateEntry.json().value.id);
  const guardedEntriesList = await app.inject({
    method: "GET",
    url: `${guardedUrl(protectedBook.id)}/entries`,
    headers: guardedHeaders,
  });
  assert.equal(guardedEntriesList.statusCode, 200, guardedEntriesList.body);
  assert.ok(
    guardedEntriesList.json().items.some((entry: { id: string }) => entry.id === guardedEntryId),
    "fenced entry list must include the guarded entry",
  );
  assertContractShape("list entries", personalExtensionCoordinationRevisionedLorebookEntryListResponseSchema, guardedEntriesList.json());
  const missingProjectionResponse = await app.inject({
    method: "GET",
    url: `${guardedUrl(protectedBook.id)}/entry-projections`,
    headers: guardedHeaders,
  });
  assert.equal(missingProjectionResponse.statusCode, 200, missingProjectionResponse.body);
  assertContractShape(
    "list entry projections",
    personalExtensionCoordinationRevisionedLorebookEntryProjectionListResponseSchema,
    missingProjectionResponse.json(),
  );
  assert.equal(missingProjectionResponse.json().projection, "embedding-state-v1");
  const missingProjection = missingProjectionResponse
    .json()
    .items.find((entry: { id: string }) => entry.id === protectedEntry.id);
  assert.equal(missingProjection?.embeddingState, "missing");
  assert.equal(Object.hasOwn(missingProjection ?? {}, "embedding"), false, "compact projections must omit raw vectors");

  const largeEmbedding = Array.from({ length: 4096 }, () => 0.12345678901234567);
  await db
    .update(lorebookEntries)
    .set({ embedding: JSON.stringify(largeEmbedding) })
    .where(eq(lorebookEntries.id, protectedEntry.id));
  const largeRawResponse = await app.inject({
    method: "GET",
    url: `${guardedUrl(protectedBook.id)}/entries`,
    headers: guardedHeaders,
  });
  const largeProjectionResponse = await app.inject({
    method: "GET",
    url: `${guardedUrl(protectedBook.id)}/entry-projections`,
    headers: guardedHeaders,
  });
  assert.equal(largeRawResponse.statusCode, 200, largeRawResponse.body);
  assert.equal(largeProjectionResponse.statusCode, 200, largeProjectionResponse.body);
  assertContractShape(
    "large list entry projections",
    personalExtensionCoordinationRevisionedLorebookEntryProjectionListResponseSchema,
    largeProjectionResponse.json(),
  );
  const readyProjection = largeProjectionResponse
    .json()
    .items.find((entry: { id: string }) => entry.id === protectedEntry.id);
  assert.equal(readyProjection?.embeddingState, "ready");
  assert.equal(Object.hasOwn(readyProjection ?? {}, "embedding"), false, "ready projections must still omit vectors");
  assert.ok(
    Buffer.byteLength(largeProjectionResponse.body) * 10 < Buffer.byteLength(largeRawResponse.body),
    "the compact projection must reduce a large-vector list payload by at least 90%",
  );

  for (const invalidEmbedding of ["[]", "not-json"]) {
    await db
      .update(lorebookEntries)
      .set({ embedding: invalidEmbedding })
      .where(eq(lorebookEntries.id, protectedEntry.id));
    const invalidProjectionResponse = await app.inject({
      method: "GET",
      url: `${guardedUrl(protectedBook.id)}/entry-projections`,
      headers: guardedHeaders,
    });
    assert.equal(invalidProjectionResponse.statusCode, 200, invalidProjectionResponse.body);
    const invalidProjection = invalidProjectionResponse
      .json()
      .items.find((entry: { id: string }) => entry.id === protectedEntry.id);
    assert.equal(invalidProjection?.embeddingState, "invalid");
    assert.equal(Object.hasOwn(invalidProjection ?? {}, "embedding"), false);
  }
  await db.update(lorebookEntries).set({ embedding: null }).where(eq(lorebookEntries.id, protectedEntry.id));
  const guardedGetEntry = await app.inject({
    method: "GET",
    url: `${guardedUrl(protectedBook.id)}/entries/${encodeURIComponent(guardedEntryId)}`,
    headers: guardedHeaders,
  });
  assert.equal(guardedGetEntry.statusCode, 200, guardedGetEntry.body);
  assert.equal(guardedGetEntry.json().value.id, guardedEntryId);
  assertContractShape("get entry", personalExtensionCoordinationRevisionedLorebookEntryResponseSchema, guardedGetEntry.json());

  const guardedUpdateEntry = await app.inject({
    method: "PATCH",
    url: `${guardedUrl(protectedBook.id)}/entries/${encodeURIComponent(guardedEntryId)}`,
    headers: guardedHeaders,
    payload: { ...guardedBody(lease.fence, 3), changes: { content: "updated memory" } },
  });
  assert.equal(guardedUpdateEntry.statusCode, 200, guardedUpdateEntry.body);
  assert.equal(guardedUpdateEntry.json().resourceRevision, 4);
  assert.equal(guardedUpdateEntry.json().value.content, "updated memory");
  assertContractShape("update entry", personalExtensionCoordinationRevisionedLorebookEntryResponseSchema, guardedUpdateEntry.json());

  const guardedDeleteEntry = await app.inject({
    method: "DELETE",
    url: `${guardedUrl(protectedBook.id)}/entries/${encodeURIComponent(guardedEntryId)}`,
    headers: guardedHeaders,
    payload: guardedBody(lease.fence, 4),
  });
  assert.equal(guardedDeleteEntry.statusCode, 200, guardedDeleteEntry.body);
  assert.deepEqual(guardedDeleteEntry.json(), { deleted: true, resourceRevision: 5 });
  assert.equal(await storage.getEntry(guardedEntryId), null);

  await db
    .update(personalExtensionCoordination)
    .set({ mode: "activating", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const transition = await app.inject({
    method: "DELETE",
    url: guardedUrl(protectedBook.id),
    headers: guardedHeaders,
    payload: guardedBody(lease.fence, 5),
  });
  assert.equal(transition.statusCode, 409, transition.body);
  assert.equal(transition.json().code, "coordination-transition-blocked");
  assert.ok(await storage.getById(protectedBook.id), "transition mode must not delete");
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "active", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const v1Delete = await app.inject({
    method: "DELETE",
    url: guardedUrl(protectedBook.id),
    headers: guardedHeaders,
    payload: guardedBody(lease.fence, 5),
  });
  assert.equal(v1Delete.statusCode, 503, v1Delete.body);
  assert.equal(v1Delete.json().code, "coordination-unavailable");
  assert.ok(await storage.getById(protectedBook.id), "v1 must fail closed rather than detach a protected target");
  const afterRejectedDelete = (
    await db
      .select()
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID))
  )[0];
  assert.ok(afterRejectedDelete);
  assert.equal(
    parsePersonalExtensionProtectedResourceRegistry(afterRejectedDelete.protectedLorebookRegistry).lorebooks[
      protectedBook.id
    ]?.resourceRevision,
    5,
    "a rejected v1 detach must not advance the protected resource revision",
  );

  // A legacy (unguarded) delete must be refused BEFORE it touches anything.
  // Detaching first and rejecting afterwards destroys the ensemble wiring on a
  // request that reports failure.
  const legacyDelete = await app.inject({ method: "DELETE", url: `/api/lorebooks/${protectedBook.id}` });
  assert.equal(legacyDelete.statusCode, 428, legacyDelete.body);
  assert.equal(legacyDelete.json().code, "coordination-required");
  assert.ok(await storage.getById(protectedBook.id), "a rejected legacy delete must keep the protected book");
  assert.deepEqual(
    wiredChatLorebookIds(await chatsStorage.getById(wiredChat.id)),
    [protectedBook.id],
    "a rejected legacy delete must not detach the protected book from chats",
  );

  // Source contract: a pre-check alone is not enough, because coordination can be
  // activated between the check and the detach. The guarded delete — which
  // re-checks protection inside its own transaction — must run before anything
  // else is mutated, so the ordering itself is pinned here.
  const routeSource = readFileSync(
    new URL("../../packages/server/src/routes/lorebooks.routes.ts", import.meta.url),
    "utf8",
  );
  const deleteHandlerAt = routeSource.indexOf('app.delete<{ Params: { id: string } }>("/:id"');
  assert.ok(deleteHandlerAt > 0, "the legacy lorebook delete handler must still exist");
  const handlerEnd = routeSource.indexOf("// ── Export ──", deleteHandlerAt);
  const handler = routeSource.slice(deleteHandlerAt, handlerEnd > 0 ? handlerEnd : undefined);
  const removeAt = handler.indexOf("await storage.remove(req.params.id);");
  const detachAt = handler.indexOf("removeLorebookFromChatMetadata(req.params.id)");
  assert.ok(removeAt > 0, "the handler must delete through the guarded storage path");
  assert.ok(detachAt > 0, "the handler must still detach chat references");
  assert.ok(removeAt < detachAt, "the guarded delete must complete before any chat metadata is rewritten");

  const vectorOperation = await coordination.beginOperation({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    kind: "vectorize",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const vectorContext = { ...fencedContext, operationHandle: vectorOperation.operationHandle };
  await coordination.runFencedResourceMutation(
    vectorContext,
    [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 1 }],
    async (tx) => {
      const markerTimestamp = new Date().toISOString();
      await tx
        .update(appSettings)
        .set({ value: cmbStorageValue(protectedBook.id, ["mutation-ambiguous"]), updatedAt: markerTimestamp })
        .where(eq(appSettings.key, STORAGE_KEY));
      await tx
        .update(personalExtensionCoordination)
        .set({ configRevision: 2, updatedAt: markerTimestamp })
        .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
    },
  );
  const vectorSnapshot = await storage.getVectorizationSnapshotFenced(vectorContext, protectedBook.id, false);
  const protectedVectorEntry = vectorSnapshot.entries.find((entry) => entry.value.id === protectedEntry.id);
  assert.ok(protectedVectorEntry);
  const VECTOR_SPACE_ID = "remote:protected-lorebook-regression-space";
  const committedVector = await storage.commitEntryEmbeddingsFenced(
    vectorContext,
    protectedBook.id,
    5,
    [{ entryId: protectedEntry.id, fingerprint: protectedVectorEntry.fingerprint, embedding: [0.25, 0.75] }],
    VECTOR_SPACE_ID,
  );
  assert.deepEqual(committedVector, { updated: 1, resourceRevision: 6 });
  assert.equal(publishedEvents.at(-1)?.type, "resource-changed");
  assert.equal(publishedEvents.at(-1)?.resourceRevision, 6, "vector commits must publish their durable revision");
  // Upstream 2.4.3 recall rejects vectors without an embedding space id, so a
  // coordinated vector commit must record the same space id the legacy route does.
  const committedVectorRow = (await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, protectedEntry.id)))[0];
  assert.equal(committedVectorRow?.embeddingSpaceId, VECTOR_SPACE_ID, "coordinated vector commits must record their space");
  const spacedSnapshot = await storage.getVectorizationSnapshotFenced(vectorContext, protectedBook.id, true);
  assert.deepEqual(spacedSnapshot.existingEmbeddingSpaceIds, [VECTOR_SPACE_ID]);
  assert.equal(spacedSnapshot.existingEmbeddingDimension, 2);
  assert.equal(
    spacedSnapshot.entries.some((entry) => entry.value.id === protectedEntry.id),
    false,
    "an entry vectorized in a known space is not missing",
  );
  // A vector written before space ids existed is stale under 2.4.3 recall: it
  // must count as missing (so coordination can repair it) and never as a known space.
  await db
    .update(lorebookEntries)
    .set({ embeddingSpaceId: null })
    .where(eq(lorebookEntries.id, protectedEntry.id));
  const legacySnapshot = await storage.getVectorizationSnapshotFenced(vectorContext, protectedBook.id, true);
  assert.equal(
    legacySnapshot.entries.some((entry) => entry.value.id === protectedEntry.id),
    true,
    "a legacy vector without a space id must be re-vectorized, not treated as present",
  );
  assert.deepEqual(legacySnapshot.existingEmbeddingSpaceIds, []);
  assert.equal(legacySnapshot.existingEmbeddingDimension, null);
  await db
    .update(lorebookEntries)
    .set({ embeddingSpaceId: VECTOR_SPACE_ID })
    .where(eq(lorebookEntries.id, protectedEntry.id));
  const clearVectors = await app.inject({
    method: "DELETE",
    url: `${guardedUrl(protectedBook.id)}/vectors`,
    headers: guardedHeaders,
    payload: guardedBody(lease.fence, 6, vectorOperation.operationHandle),
  });
  assert.equal(clearVectors.statusCode, 200, clearVectors.body);
  assert.deepEqual(clearVectors.json(), { cleared: 1, total: 1, resourceRevision: 7 });
  assert.equal(publishedEvents.at(-1)?.type, "resource-changed");
  assert.equal(publishedEvents.at(-1)?.resourceRevision, 7, "vector clears must publish their durable revision");

  const staleFingerprintSnapshot = await storage.getVectorizationSnapshotFenced(vectorContext, protectedBook.id, false);
  const staleFingerprintEntry = staleFingerprintSnapshot.entries.find((entry) => entry.value.id === protectedEntry.id);
  assert.ok(staleFingerprintEntry);
  const eventsBeforeRejectedVectorCommit = publishedEvents.length;
  await db
    .update(lorebookEntries)
    .set({ content: "changed after provider compute", updatedAt: new Date().toISOString() })
    .where(eq(lorebookEntries.id, protectedEntry.id));
  await expectCode(
    storage.commitEntryEmbeddingsFenced(
      vectorContext,
      protectedBook.id,
      7,
      [{ entryId: protectedEntry.id, fingerprint: staleFingerprintEntry.fingerprint, embedding: [1, 0] }],
      VECTOR_SPACE_ID,
    ),
    "resource-revision-conflict",
  );
  assert.equal(
    publishedEvents.length,
    eventsBeforeRejectedVectorCommit,
    "rejected resource commits must publish no resource event",
  );
  const afterStaleVector = (
    await db
      .select()
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID))
  )[0];
  assert.ok(afterStaleVector);
  assert.equal(
    parsePersonalExtensionProtectedResourceRegistry(afterStaleVector.protectedLorebookRegistry).lorebooks[
      protectedBook.id
    ]?.resourceRevision,
    7,
    "a stale post-provider fingerprint must roll back without advancing the resource revision",
  );

  const draftOperation = await coordination.beginOperation({
    extensionId: EXTENSION_ID,
    holderSessionId: HOLDER,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    kind: "mutation",
    targetEnsembleId: DRAFT_ENSEMBLE_ID,
  });
  const draftContext = { ...fencedContext, operationHandle: draftOperation.operationHandle };
  await coordination.runFencedResourceMutation(
    draftContext,
    [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 2 }],
    async (tx) => {
      const markerTimestamp = new Date().toISOString();
      await tx
        .update(appSettings)
        .set({
          value: cmbStorageValue(protectedBook.id, ["mutation-ambiguous"], ["mutation-ambiguous"]),
          updatedAt: markerTimestamp,
        })
        .where(eq(appSettings.key, STORAGE_KEY));
      await tx
        .update(personalExtensionCoordination)
        .set({ configRevision: 3, updatedAt: markerTimestamp })
        .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
    },
  );
  const guardedCreateBook = await app.inject({
    method: "POST",
    url: "/api/lorebooks/coordination",
    headers: guardedHeaders,
    payload: {
      extensionId: EXTENSION_ID,
      serverBootId: lease.serverBootId,
      contentHash: lease.contentHash,
      fence: lease.fence,
      leaseToken: lease.leaseToken,
      operationHandle: draftOperation.operationHandle,
      book: { name: "guarded draft book" },
    },
  });
  assert.equal(guardedCreateBook.statusCode, 200, guardedCreateBook.body);
  assert.equal(guardedCreateBook.json().resourceRevision, 0);
  assertContractShape("create", personalExtensionCoordinationRevisionedLorebookResponseSchema, guardedCreateBook.json());
  assert.deepEqual(publishedEvents.at(-1), {
    schemaVersion: 1,
    eventEpoch: publishedEvents.at(-1)?.eventEpoch,
    cursor: publishedEvents.at(-1)?.cursor,
    type: "resource-changed",
    resourceRevision: 0,
  });
  const guardedCreatedBookId = String(guardedCreateBook.json().value.id);
  const afterCreate = (
    await db
      .select()
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID))
  )[0];
  assert.ok(afterCreate);
  assert.equal(
    parsePersonalExtensionProtectedResourceRegistry(afterCreate.protectedLorebookRegistry).lorebooks[
      guardedCreatedBookId
    ]?.resourceRevision,
    0,
    "guarded create must bind the new book into the protected registry in the same strict commit",
  );
} finally {
  eventSubscription.close();
  eventService.shutdown();
  await app.close();
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}

const centralIngressSources = [
  "../../packages/server/src/routes/lorebooks.routes.ts",
  "../../packages/server/src/services/lorebook/embeddings.ts",
  "../../packages/server/src/routes/generate/lorebook-keeper-utils.ts",
  "../../packages/server/src/services/import/marinara.importer.ts",
  "../../packages/server/src/services/import/st-lorebook.importer.ts",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const [lorebookRouteSource, embeddingWarmupSource, keeperSource, marinaraImportSource, stImportSource] =
  centralIngressSources;
assert.match(lorebookRouteSource!, /storage\.createEntry\([\s\S]*storage\.removeEntry\(/u);
assert.match(lorebookRouteSource!, /storage\.createFolder\([\s\S]*storage\.cloneFolder\(/u);
assert.match(embeddingWarmupSource!, /storage\.updateEntryEmbedding\(/u);
assert.match(keeperSource!, /lorebooksStore\.(?:updateEntry|createEntry)\(/u);
assert.match(marinaraImportSource!, /storage\.bulkCreateEntries\(/u);
assert.match(stImportSource!, /storage\.(?:createEntry|removeEntry)\(/u);
assert.equal(
  centralIngressSources.some((source) =>
    /\.(?:insert|update|delete)\((?:lorebooks|lorebookEntries|lorebookFolders)\)/u.test(source),
  ),
  false,
  "move, folder, import, keeper, and warmup ingress must converge on the guarded storage facade",
);

const lorebookStorageSource = readFileSync(
  new URL("../../packages/server/src/services/storage/lorebooks.storage.ts", import.meta.url),
  "utf8",
);
assert.match(
  lorebookStorageSource,
  /db\.transaction\(async \(tx\) => \{[\s\S]*assertLegacyBookWritable\(lorebookId, tx\)/u,
  "the shared legacy mutation wrapper must check protected ownership inside its transaction",
);
for (const method of [
  "create",
  "update",
  "remove",
  "createEntry",
  "updateEntry",
  "bulkUpdateEntries",
  "updateEntryEmbedding",
  "clearEntryEmbeddings",
  "bulkCreateEntries",
  "reorderEntries",
  "removeEntry",
  "createFolder",
  "updateFolder",
  "removeFolder",
  "reorderFolders",
  "cloneFolder",
] as const) {
  const marker = `    async ${method}(`;
  const start = lorebookStorageSource.indexOf(marker);
  assert.notEqual(start, -1, `${method} legacy ingress must exist`);
  const remainder = lorebookStorageSource.slice(start + marker.length);
  const nextMethod = /\n    async [A-Za-z]/u.exec(remainder);
  const methodBody = lorebookStorageSource.slice(
    start,
    start + marker.length + (nextMethod?.index ?? remainder.length),
  );
  assert.match(methodBody, /runLegacyBookMutation\(/u, `${method} must enter the atomic legacy guard`);
}

console.info("Protected lorebook central guard regression passed.");
