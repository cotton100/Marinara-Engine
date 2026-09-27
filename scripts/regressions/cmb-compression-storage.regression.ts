import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { appSettings, characters, personalExtensionCoordination } from "../../packages/server/src/db/schema/index.js";
import { lorebooksRoutes } from "../../packages/server/src/routes/lorebooks.routes.js";
import { getPersonalExtensionCoordinationService } from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";
import { PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID } from "../../packages/server/src/services/extensions/personal-extension-coordination-kernel.service.js";
import { inspectCmbCompression } from "../../packages/server/src/services/lorebook/cmb-compression.js";
import { createCmbCompressionFixture } from "./helpers/cmb-compression-fixture.js";

const directory = mkdtempSync(join(tmpdir(), "cmb-compression-storage-"));
const previousDirectory = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = directory;
const db = await createFileNativeDB({ fileOperations: { flushDirectory: async () => {} } });
const fixture = await createCmbCompressionFixture(db);
const { extensionId, contentHash, ensemble, bookId, storage } = fixture;
const entry = await fixture.createMemory({ id: "guarded", appliedTo: [] });
ensemble.runtime = {
  semanticStatus: "ready",
  lastSuccessfulEmbeddingProfile: null,
  pendingEmbeddingProfile: null,
  lastSuccessfulSyncAt: null,
  manualRecoveryReasons: [],
};
await fixture.saveSettings();
await db
  .update(personalExtensionCoordination)
  .set({ serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID })
  .where(eq(personalExtensionCoordination.extensionId, extensionId));
await db._fileStore.flushStrict();
const service = getPersonalExtensionCoordinationService(db);
const holderSessionId = "cmb-compression-storage-holder";
const lease = await service.acquireLease({
  extensionId,
  contentHash,
  holderSessionId,
  serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
});
const authority = {
  extensionId,
  contentHash,
  holderSessionId,
  serverBootId: lease.serverBootId,
  fence: lease.fence,
  leaseToken: lease.leaseToken,
};
const operation = await service.beginOperation({
  ...authority,
  kind: "mutation",
  targetEnsembleId: ensemble.ensembleId,
});
const context = { ...authority, operationHandle: operation.operationHandle };
const app = Fastify();
app.decorate("db", db);
await app.register(lorebooksRoutes, { prefix: "/api/lorebooks" });
const headers = {
  "x-marinara-coordination-holder-session-id": holderSessionId,
  "x-marinara-coordination-extension-id": extensionId,
  "x-marinara-coordination-server-boot-id": lease.serverBootId,
  "x-marinara-coordination-content-hash": contentHash,
  "x-marinara-coordination-fence": String(lease.fence),
  "x-marinara-coordination-lease-token": lease.leaseToken,
};
const url = `/api/lorebooks/${bookId}/coordination/entries/${entry.id}/cmb-compression`;
const bodyAuthority = {
  extensionId,
  contentHash,
  serverBootId: lease.serverBootId,
  fence: lease.fence,
  leaseToken: lease.leaseToken,
  operationHandle: operation.operationHandle,
};
const original = entry.content.slice(entry.content.indexOf("[Memory]\n") + "[Memory]\n".length);
const summary = "Arin will return the harbor key only after Bora arrived. The promise is unresolved.";
let closed = false;
try {
  const read = await app.inject({ method: "GET", url: `${url}?castId=a&importanceMode=auto`, headers });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().state, "none");
  assert.equal(read.json().eligibility.status, "ready");
  const input = {
    castId: "a",
    importanceMode: "auto" as const,
    expectedBasisFingerprint: read.json().basisFingerprint as string,
    expectedCompressionRevision: 0,
    summary,
    importanceReason: "Unresolved promise.",
    retention: "essentials" as const,
    evidence: [{ quote: original }],
    facts: [
      {
        actors: ["Arin", "Bora"],
        negation: null,
        condition: "only after Bora arrived",
        status: "unresolved",
        evidenceQuote: original,
      },
    ],
  };
  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `${url}/apply`,
      headers,
      payload: { ...bodyAuthority, expectedResourceRevision: 0, ...payload },
    });
  const unmarked = await post(input);
  assert.equal(unmarked.statusCode, 503, unmarked.body);
  assert.equal(unmarked.json().code, "coordination-unavailable", "writes require the durable dispatch marker");
  assert.equal(
    (await app.inject({ method: "GET", url: `${url}?castId=a&importanceMode=auto` })).statusCode,
    400,
    "no lease authority means no inspect",
  );

  ensemble.runtime = { ...ensemble.runtime, manualRecoveryReasons: ["mutation-ambiguous"] };
  await service.runFencedResourceMutation(
    context,
    [{ kind: "extension-storage", resourceId: extensionId, expectedRevision: 0 }],
    async (tx) => {
      await tx
        .update(appSettings)
        .set({ value: JSON.stringify(fixture.stored) })
        .where(eq(appSettings.key, `extension-storage:${extensionId}`));
      await tx
        .update(personalExtensionCoordination)
        .set({ configRevision: 1 })
        .where(eq(personalExtensionCoordination.extensionId, extensionId));
    },
  );
  assert.equal(
    (await post({ ...input, expectedBasisFingerprint: "0".repeat(64) })).statusCode,
    409,
    "stale source basis rejects atomically",
  );
  assert.equal(
    (await post({ ...input, summary: "Arin promised the key." })).statusCode,
    409,
    "edited summary cannot drop declared conditions/status",
  );
  assert.equal(
    (await post({ ...input, evidence: [{ quote: "invented" }] })).statusCode,
    409,
    "fabricated evidence rejects",
  );
  const applied = await post(input);
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().resourceRevision, 1);
  const after = (await storage.getEntry(entry.id))!;
  assert.equal(after.id, entry.id);
  assert.equal(after.content, entry.content);
  assert.deepEqual(after.embedding, entry.embedding);
  assert.equal(after.embeddingSpaceId, entry.embeddingSpaceId);
  assert.deepEqual(after.dynamicState.convoMemoryBridge, entry.dynamicState.convoMemoryBridge);
  assert.equal((await post(input)).statusCode, 409, "replayed request cannot write twice");
  const committedNamespace = after.dynamicState.convoMemoryBridgeCompression;
  const generic = await storage.updateEntryFenced(context, bookId, entry.id, 1, {
    dynamicState: { convoMemoryBridge: entry.dynamicState.convoMemoryBridge, testExtension: { intact: true } },
  });
  assert.deepEqual(
    generic.value.dynamicState.convoMemoryBridgeCompression,
    committedNamespace,
    "generic edits preserve applied state",
  );
  await assert.rejects(
    storage.updateEntryFenced(context, bookId, entry.id, 2, {
      dynamicState: { ...after.dynamicState, convoMemoryBridgeCompression: { schemaVersion: 1, byCast: {} } },
    }),
    { code: "coordination-validation-failed" },
  );
  await db
    .update(characters)
    .set({ data: JSON.stringify({ name: "아린", personality: "changed" }) })
    .where(eq(characters.id, "character-a"));
  const held = await inspectCmbCompression(db, (await storage.getEntry(entry.id))!, "a", "auto", extensionId, true);
  assert.equal(held.state, "held", "card change invalidates existing summary");
  assert.equal(held.reason, "basis-changed");
  const removed = await app.inject({
    method: "POST",
    url: `${url}/remove`,
    headers,
    payload: { ...bodyAuthority, expectedResourceRevision: 2, castId: "a", expectedCompressionRevision: 1 },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  const released = (await storage.getEntry(entry.id))!;
  assert.equal(released.content, entry.content);
  assert.deepEqual(released.embedding, entry.embedding);
  const namespace = released.dynamicState.convoMemoryBridgeCompression as {
    byCast: { a: { active: boolean; revision: number } };
    history: Array<{ castId: string; record: { revision: number; summary: string } }>;
  };
  assert.equal(namespace.byCast.a.active, false);
  assert.equal(namespace.byCast.a.revision, 2);
  assert.equal(namespace.history.length, 1);
  assert.equal(namespace.history[0]?.castId, "a");
  assert.equal(namespace.history[0]?.record.summary, summary, "undo preserves the approved summary history");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `${url}/remove`,
        headers,
        payload: { ...bodyAuthority, expectedResourceRevision: 3, castId: "a", expectedCompressionRevision: 1 },
      })
    ).statusCode,
    409,
  );
  await db._fileStore.close();
  closed = true;
  const reread = await createFileNativeDB({ fileOperations: { flushDirectory: async () => {} } });
  try {
    const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
    assert.deepEqual(
      (await createLorebooksStorage(reread).getEntry(entry.id))?.dynamicState,
      released.dynamicState,
      "state survives DB reopen",
    );
  } finally {
    await reread._fileStore.close();
  }
  console.info("PASS: CMB guarded inspect/apply/replay/evidence/marker/undo/reopen preserve original and vector");
} finally {
  await app.close();
  if (!closed) await db._fileStore.close();
  if (previousDirectory === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousDirectory;
  // Retain this synthetic fixture for inspection; no user data or model traffic.
}
