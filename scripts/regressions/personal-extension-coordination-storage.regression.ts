import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER } from "../../packages/shared/src/schemas/personal-extension-coordination.schema.js";
import { PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID } from "../../packages/server/src/services/extensions/personal-extension-coordination-kernel.service.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  appSettings,
  installedExtensions,
  personalExtensionCoordination,
} from "../../packages/server/src/db/schema/index.js";
import { personalExtensionsRoutes } from "../../packages/server/src/routes/personal-extensions.routes.js";
import { getPersonalExtensionCoordinationService } from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";
import { getPersonalExtensionCoordinationEventService } from "../../packages/server/src/services/extensions/personal-extension-coordination-events.service.js";
import { createPersonalExtensionsStorage } from "../../packages/server/src/services/extensions/personal-extension-storage.service.js";

const ACTIVE_ID = "revisioned-storage-active";
const INACTIVE_ID = "revisioned-storage-inactive";
const HOLDER_A = "revisioned-storage-holder-a";
const HOLDER_B = "revisioned-storage-holder-b";
const STORAGE_KEY = `extension-storage:${ACTIVE_ID}`;
const storageDir = mkdtempSync(join(tmpdir(), "marinara-revisioned-storage-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;

let failStrictWrite = false;
const fileDb = await createFileNativeDB({
  fileOperations: {
    writeFile: async (...args) => {
      if (failStrictWrite) {
        failStrictWrite = false;
        throw new Error("simulated revisioned storage strict write failure");
      }
      return writeFile(...args);
    },
    flushDirectory: async () => {},
  },
});
const db = fileDb as unknown as DB;
const extensionStorage = createPersonalExtensionsStorage(db);
const activeExtension = await extensionStorage.create(
  { name: ACTIVE_ID, runtime: "client", js: "self.postMessage({ type: 'ready' });" },
  { id: ACTIVE_ID, source: "professor_mari" },
);
const inactiveExtension = await extensionStorage.create(
  { name: INACTIVE_ID, runtime: "client", js: "self.postMessage({ type: 'ready' });" },
  { id: INACTIVE_ID, source: "professor_mari" },
);
assert.ok(activeExtension && inactiveExtension);
await extensionStorage.approve(ACTIVE_ID, activeExtension.contentHash);
await extensionStorage.approve(INACTIVE_ID, inactiveExtension.contentHash);
const CONTENT_HASH = activeExtension.contentHash;
const timestamp = new Date("2026-08-16T00:00:00.000Z").toISOString();
await db.insert(personalExtensionCoordination).values({
  extensionId: ACTIVE_ID,
  contentHash: CONTENT_HASH,
  mode: "active",
  serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
  protectedLorebookRegistry: JSON.stringify({ version: 1, extensionStorage: { resourceRevision: 0 }, lorebooks: {} }),
  activeOperations: "[]",
  createdAt: timestamp,
  updatedAt: timestamp,
});
await fileDb._fileStore.flushStrict();

const app = Fastify();
app.decorate("db", db);
await app.register(personalExtensionsRoutes, { prefix: "/api/personal-extensions" });
const coordination = getPersonalExtensionCoordinationService(db);
const eventService = getPersonalExtensionCoordinationEventService(db);
const publishedEvents: Array<{ type: string; configRevision?: number }> = [];
const eventSubscription = await eventService.subscribe(
  { extensionId: ACTIVE_ID, deviceSessionId: "10000000-0000-4000-8000-000000000011" },
  {
    send(event) {
      publishedEvents.push(event);
    },
    close() {},
  },
);

function legacyUrl(id: string) {
  return `/api/personal-extensions/${id}/storage`;
}

function guardedUrl(id: string) {
  return `/api/personal-extensions/${id}/coordination/storage`;
}

function headers(holder?: string) {
  return holder ? { [PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER]: holder } : {};
}

async function activeRow() {
  const rows = await db
    .select()
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, ACTIVE_ID));
  assert.ok(rows[0]);
  return rows[0];
}

async function activeStoredValue() {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, STORAGE_KEY));
  return rows[0]?.value ?? null;
}

function mutationBody(
  lease: { serverBootId: string; contentHash: string; fence: number; leaseToken: string },
  operationHandle: string,
  expectedConfigRevision: number,
  patch: Record<string, unknown>,
) {
  return {
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    operationHandle,
    expectedConfigRevision,
    patch,
  };
}

async function expectCode(response: Awaited<ReturnType<typeof app.inject>>, status: number, code: string) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().code, code, response.body);
}

try {
  await app.ready();

  const inactiveLegacyGet = await app.inject({ method: "GET", url: legacyUrl(INACTIVE_ID) });
  assert.deepEqual(inactiveLegacyGet.json(), { value: {} }, "legacy GET keeps its legacy response shape");
  const inactiveCoordinationGet = await app.inject({ method: "GET", url: guardedUrl(INACTIVE_ID) });
  assert.deepEqual(inactiveCoordinationGet.json(), { value: {}, configRevision: 0 });
  assert.deepEqual(
    await db
      .select()
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, INACTIVE_ID)),
    [],
    "read-only inactive storage requests must not create coordination rows",
  );
  const inactivePatch = await app.inject({ method: "PATCH", url: legacyUrl(INACTIVE_ID), payload: { local: true } });
  assert.equal(inactivePatch.statusCode, 200);
  assert.deepEqual(inactivePatch.json(), { value: { local: true } }, "inactive legacy PATCH keeps its response shape");

  const noContextBefore = await activeStoredValue();
  await expectCode(
    await app.inject({ method: "PATCH", url: legacyUrl(ACTIVE_ID), payload: { blocked: true } }),
    428,
    "coordination-required",
  );
  assert.equal(
    await activeStoredValue(),
    noContextBefore,
    "active legacy writes must be admitted before any app_settings write",
  );

  const lease = await coordination.acquireLease({
    extensionId: ACTIVE_ID,
    holderSessionId: HOLDER_A,
    serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const operation = await coordination.beginOperation({
    extensionId: ACTIVE_ID,
    holderSessionId: HOLDER_A,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    kind: "mutation",
    targetEnsembleId: "ensemble-storage-a",
  });
  const body = mutationBody(lease, operation.operationHandle, 0, { coordinated: true });
  const firstWrite = await app.inject({
    method: "PATCH",
    url: guardedUrl(ACTIVE_ID),
    headers: headers(HOLDER_A),
    payload: body,
  });
  assert.equal(firstWrite.statusCode, 200, firstWrite.body);
  assert.deepEqual(firstWrite.json(), { value: { coordinated: true }, configRevision: 1 });
  assert.equal((await activeRow()).configRevision, 1);
  assert.deepEqual(publishedEvents.at(-1), {
    schemaVersion: 1,
    eventEpoch: (publishedEvents.at(-1) as { eventEpoch: string }).eventEpoch,
    cursor: (publishedEvents.at(-1) as { cursor: number }).cursor,
    type: "config-changed",
    configRevision: 1,
  });

  const staleBefore = await activeStoredValue();
  await expectCode(
    await app.inject({ method: "PATCH", url: guardedUrl(ACTIVE_ID), headers: headers(HOLDER_A), payload: body }),
    409,
    "storage-revision-conflict",
  );
  assert.equal(await activeStoredValue(), staleBefore, "stale revision reuse must write nothing");

  await coordination.endOperation({
    extensionId: ACTIVE_ID,
    holderSessionId: HOLDER_A,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    operationHandle: operation.operationHandle,
  });
  await coordination.releaseLease({
    extensionId: ACTIVE_ID,
    holderSessionId: HOLDER_A,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
  });
  const replacement = await coordination.acquireLease({
    extensionId: ACTIVE_ID,
    holderSessionId: HOLDER_B,
    serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const oldFenceBefore = await activeStoredValue();
  await expectCode(
    await app.inject({ method: "PATCH", url: guardedUrl(ACTIVE_ID), headers: headers(HOLDER_A), payload: body }),
    409,
    "lease-lost",
  );
  assert.equal(await activeStoredValue(), oldFenceBefore, "old fences must write nothing");

  for (const mode of ["activating", "blocked"] as const) {
    await db
      .update(personalExtensionCoordination)
      .set({ mode, updatedAt: new Date().toISOString() })
      .where(eq(personalExtensionCoordination.extensionId, ACTIVE_ID));
    const before = await activeStoredValue();
    await expectCode(await app.inject({ method: "DELETE", url: legacyUrl(ACTIVE_ID) }), 428, "coordination-required");
    assert.equal(await activeStoredValue(), before, `${mode} legacy deletes must write nothing`);
  }
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "active", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, ACTIVE_ID));

  const replacementOperation = await coordination.beginOperation({
    extensionId: ACTIVE_ID,
    holderSessionId: HOLDER_B,
    serverBootId: replacement.serverBootId,
    contentHash: replacement.contentHash,
    fence: replacement.fence,
    leaseToken: replacement.leaseToken,
    kind: "mutation",
    targetEnsembleId: "ensemble-storage-b",
  });
  const strictFailureBody = mutationBody(replacement, replacementOperation.operationHandle, 1, { mustRollback: true });
  const strictBeforeValue = await activeStoredValue();
  const strictBeforeRow = await activeRow();
  const eventsBeforeStrictFailure = publishedEvents.length;
  failStrictWrite = true;
  await expectCode(
    await app.inject({
      method: "PATCH",
      url: guardedUrl(ACTIVE_ID),
      headers: headers(HOLDER_B),
      payload: strictFailureBody,
    }),
    503,
    "coordination-unavailable",
  );
  assert.equal(await activeStoredValue(), strictBeforeValue, "strict failure rolls back app_settings");
  assert.equal(
    (await activeRow()).configRevision,
    strictBeforeRow.configRevision,
    "strict failure rolls back config revision",
  );
  assert.equal(publishedEvents.length, eventsBeforeStrictFailure, "failed durable writes must publish no config event");

  const transaction = db.transaction.bind(db);
  (db as DB & { transaction: typeof db.transaction }).transaction = async () => {
    throw new Error("simulated coordination storage read failure");
  };
  const readFailureBefore = await activeStoredValue();
  await expectCode(
    await app.inject({
      method: "PATCH",
      url: guardedUrl(ACTIVE_ID),
      headers: headers(HOLDER_B),
      payload: strictFailureBody,
    }),
    503,
    "coordination-unavailable",
  );
  assert.equal(await activeStoredValue(), readFailureBefore, "coordination read failures must write nothing");
  (db as DB & { transaction: typeof db.transaction }).transaction = transaction;

  const { patch: _discardedPatch, ...deleteBody } = strictFailureBody;
  const guardedDelete = await app.inject({
    method: "DELETE",
    url: guardedUrl(ACTIVE_ID),
    headers: headers(HOLDER_B),
    payload: deleteBody,
  });
  assert.equal(guardedDelete.statusCode, 200, guardedDelete.body);
  assert.deepEqual(guardedDelete.json(), { value: {}, configRevision: 2 });
  assert.equal(await activeStoredValue(), null);
  assert.equal(publishedEvents.at(-1)?.type, "config-changed");
  assert.equal(publishedEvents.at(-1)?.configRevision, 2, "guarded deletes must publish their durable revision");

  const routeSource = readFileSync(
    new URL("../../packages/server/src/routes/personal-extensions.routes.ts", import.meta.url),
    "utf8",
  );
  const runtimeSource = readFileSync(
    new URL("../../packages/server/src/services/extensions/personal-server-extension-runtime.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    routeSource,
    /settings\.(patch|remove)\(extension\.id/,
    "routes must use the guarded storage facade",
  );
  assert.doesNotMatch(
    runtimeSource,
    /settings\.(patch|remove)\(extension\.id/,
    "runtime must use the guarded storage facade",
  );
} finally {
  eventSubscription.close();
  eventService.shutdown();
  await app.close();
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}

console.info("Personal extension revisioned storage regression passed.");
