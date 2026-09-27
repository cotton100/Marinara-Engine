import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  appSettings,
  characters,
  lorebookEntries,
  lorebooks,
  personalExtensionCoordination,
} from "../../packages/server/src/db/schema/index.js";
import { lorebooksRoutes } from "../../packages/server/src/routes/lorebooks.routes.js";
import { getPersonalExtensionCoordinationService } from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";
import { PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID } from "../../packages/server/src/services/extensions/personal-extension-coordination-kernel.service.js";
import { resolveCmbCompressionEntries } from "../../packages/server/src/services/lorebook/cmb-compression-retrieval.js";
import { processLorebooks } from "../../packages/server/src/services/lorebook/index.js";
import { createCmbCompressionFixture } from "./helpers/cmb-compression-fixture.js";

const directory = mkdtempSync(join(tmpdir(), "cmb-original-management-"));
const prior = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = directory;
let bodyReads = 0;
const db = await createFileNativeDB({
  fileOperations: { flushDirectory: async () => {} },
  afterCmbOriginalRead: () => {
    bodyReads++;
  },
});
const fixture = await createCmbCompressionFixture(db);
const { storage, ensemble, extensionId, contentHash, bookId } = fixture;
const entry = await fixture.createMemory({ id: "archive", native: true, appliedTo: ["a", "b"] });
const neverApplied = await fixture.createMemory({ id: "not-applied", appliedTo: [] });
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
const holderSessionId = "cmb-archive-holder";
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
const bodyAuthority = {
  extensionId,
  contentHash,
  serverBootId: lease.serverBootId,
  fence: lease.fence,
  leaseToken: lease.leaseToken,
  operationHandle: operation.operationHandle,
};
const headers = {
  "x-marinara-coordination-holder-session-id": holderSessionId,
  "x-marinara-coordination-extension-id": extensionId,
  "x-marinara-coordination-server-boot-id": lease.serverBootId,
  "x-marinara-coordination-content-hash": contentHash,
  "x-marinara-coordination-fence": String(lease.fence),
  "x-marinara-coordination-lease-token": lease.leaseToken,
};
const app = Fastify();
app.decorate("db", db);
await app.register(lorebooksRoutes, { prefix: "/api/lorebooks" });
let revision = 0;
const post = (id: string, action: "archive" | "restore", sha: string | null, overrides = {}) =>
  app.inject({
    method: "POST",
    url: `/api/lorebooks/${bookId}/coordination/entries/${id}/cmb-original/${action}`,
    headers,
    payload: { ...bodyAuthority, expectedResourceRevision: revision, expectedArchiveSha256: sha, ...overrides },
  });
try {
  assert.equal((await post(entry.id, "archive", null)).statusCode, 503, "durable marker required");
  assert.equal(db._fileStore.getCmbOriginalState(entry.id).state, "inline");
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
    (await post(neverApplied.id, "archive", null)).statusCode,
    409,
    "unreviewed originals are not automatically archived",
  );
  const archived = await post(entry.id, "archive", null);
  assert.equal(archived.statusCode, 200, archived.body);
  revision = archived.json().resourceRevision;
  const sha = archived.json().archive.sha256;
  assert.equal(archived.json().archive.state, "archived");
  assert.equal("content" in archived.json(), false, "mutation response carries no original");
  const archivePath = join(directory, "cmb-originals", `${sha}.json`);
  assert.equal(JSON.parse(readFileSync(archivePath, "utf8")), entry.content);
  assert.equal(
    (await post(entry.id, "archive", null)).statusCode,
    409,
    "stale archive state rejects even with current book revision",
  );
  bodyReads = 0;
  const catalog = await app.inject({
    method: "GET",
    url: `/api/lorebooks/${bookId}/coordination/cmb-memory-catalog`,
    headers,
  });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().items.length, 2);
  assert.equal(catalog.json().items.find((row: any) => row.entryId === entry.id).archive.state, "archived");
  assert.equal(bodyReads, 0, "catalog never opens the archived original");
  for (const row of catalog.json().items) {
    assert.equal("content" in row, false);
    assert.equal("embedding" in row, false);
    assert.equal("dynamicState" in row, false);
    assert.equal(
      row.compressionApplications.some((value: any) => "evidence" in value || "facts" in value || "history" in value),
      false,
    );
  }
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/lorebooks/${bookId}/coordination/cmb-memory-catalog` })).statusCode,
    400,
  );
  const publicCatalog = await app.inject({ method: "GET", url: `/api/lorebooks/${bookId}/cmb-memory-catalog` });
  assert.equal(publicCatalog.statusCode, 200);
  assert.equal(bodyReads, 0);
  const candidates = await storage.listActiveEntries({ chatId: "rp", characterIds: ["character-a"] }, true);
  assert.equal(bodyReads, 0, "recall candidate list stays body-free");
  const candidate = candidates.find((value: any) => value.id === entry.id)!;
  assert.equal((candidate as any).content, "");
  assert.deepEqual(
    await resolveCmbCompressionEntries(db, [candidate as any], { audienceCharacterIds: ["unmapped"] }),
    [],
  );
  assert.equal(bodyReads, 0, "unaware callers cannot cause original reads");
  const privateDynamic = structuredClone(entry.dynamicState);
  (privateDynamic.convoMemoryBridge as any).unknownToCastIds = ["a"];
  await db
    .update(lorebookEntries)
    .set({ dynamicState: JSON.stringify(privateDynamic), characterFilterIds: JSON.stringify(["character-b"]) })
    .where(eq(lorebookEntries.id, entry.id));
  bodyReads = 0;
  assert.deepEqual(
    await resolveCmbCompressionEntries(db, [candidate as any], { audienceCharacterIds: ["character-a"] }),
    [],
  );
  assert.equal(bodyReads, 0, "permission changes after candidate selection reject before reading the original");
  await db
    .update(lorebookEntries)
    .set({
      dynamicState: JSON.stringify(entry.dynamicState),
      characterFilterIds: JSON.stringify(entry.characterFilterIds),
    })
    .where(eq(lorebookEntries.id, entry.id));
  const releasedDynamic = structuredClone(entry.dynamicState);
  for (const value of Object.values((releasedDynamic.convoMemoryBridgeCompression as any).byCast) as any[])
    value.active = false;
  await db
    .update(lorebookEntries)
    .set({ dynamicState: JSON.stringify(releasedDynamic) })
    .where(eq(lorebookEntries.id, entry.id));
  const agentCandidates = await storage.listEntriesByLorebooks([bookId], true);
  await db.update(lorebooks).set({ enabled: "false" }).where(eq(lorebooks.id, bookId));
  bodyReads = 0;
  assert.deepEqual(
    await resolveCmbCompressionEntries(db, agentCandidates as any, { audienceCharacterIds: ["character-a"] }),
    [],
  );
  assert.equal(bodyReads, 0, "disabled source books never reopen released originals in agent recall");
  await db.update(lorebooks).set({ enabled: "true" }).where(eq(lorebooks.id, bookId));
  await db
    .update(lorebookEntries)
    .set({ dynamicState: JSON.stringify(entry.dynamicState) })
    .where(eq(lorebookEntries.id, entry.id));
  // Clear only the synthetic in-flight marker for ordinary read validation.
  ensemble.runtime = { ...ensemble.runtime, manualRecoveryReasons: [] };
  await fixture.saveSettings();
  const selected = await resolveCmbCompressionEntries(db, [candidate as any], {
    audienceCharacterIds: ["character-a"],
  });
  assert.equal(selected.length, 1);
  assert.match(selected[0]!.content, /CMB compressed memory/);
  assert.notEqual(selected[0]!.content, entry.content);
  assert.equal((selected[0] as any).cmbOriginalDeferred, undefined);
  assert.equal(
    db._fileStore.getCmbOriginalState(entry.id).state,
    "archived",
    "recall does not restore resident originals",
  );
  bodyReads = 0;
  const scanOptions = {
    chatId: "dm-a",
    characterIds: ["character-a"],
    cmbAudienceCharacterIds: ["character-a"],
    activeLorebookIds: [bookId],
    forcedEntriesOnly: true,
    forcedEntryIds: [entry.id],
    previewOnly: true,
  };
  const blocked = await processLorebooks(db, [{ role: "user", content: "harbor" }], null, {
    ...scanOptions,
    entryStateOverrides: { [entry.id]: { enabled: false } },
  });
  assert.deepEqual(blocked.activatedEntryIds, []);
  assert.equal(bodyReads, 0, "chat OFF gate precedes original reads");
  const scanned = await processLorebooks(db, [{ role: "user", content: "harbor" }], null, scanOptions);
  assert.deepEqual(scanned.activatedEntryIds, [entry.id]);
  assert.match(scanned.activatedEntries[0]!.content, /CMB compressed memory/);
  const current = await storage.getEntry(entry.id);
  assert.equal(current!.content, entry.content);
  assert.deepEqual(current!.embedding, entry.embedding);
  assert.deepEqual(current!.dynamicState, entry.dynamicState);
  // Missing originals stay visible in the metadata catalog but cannot enter prompts.
  renameSync(archivePath, `${archivePath}.preserved`);
  try {
    bodyReads = 0;
    assert.equal((await storage.listCmbMemoryCatalog(bookId)).items.length, 2);
    assert.equal(bodyReads, 0);
    assert.deepEqual(
      await resolveCmbCompressionEntries(db, [candidate as any], { audienceCharacterIds: ["character-a"] }),
      [],
    );
  } finally {
    renameSync(`${archivePath}.preserved`, archivePath);
  }
  // A missing native source remains manageable without opening the preserved original.
  const missingSourceDynamic = structuredClone(entry.dynamicState);
  (missingSourceDynamic.convoMemoryBridge as any).source.occurrences = [];
  (missingSourceDynamic.convoMemoryBridge as any).sourceStatus = "missing";
  await db
    .update(lorebookEntries)
    .set({ dynamicState: JSON.stringify(missingSourceDynamic) })
    .where(eq(lorebookEntries.id, entry.id));
  bodyReads = 0;
  const missingSourceCatalog = await storage.listCmbMemoryCatalog(bookId);
  assert.equal(missingSourceCatalog.invalidEntries, 0);
  const missingSourceItem = missingSourceCatalog.items.find((item) => item.entryId === entry.id)!;
  assert.equal(missingSourceItem.sourceStatus, "missing");
  assert.equal(missingSourceItem.compressionApplications.length, 2);
  assert.equal(bodyReads, 0);
  // Missing sources and changed cards hold summaries, but must not block explicit storage restoration.
  await db
    .update(characters)
    .set({ data: JSON.stringify({ name: "아린", personality: "changed" }) })
    .where(eq(characters.id, "character-a"));
  ensemble.runtime = { ...ensemble.runtime, manualRecoveryReasons: ["mutation-ambiguous"] };
  await fixture.saveSettings();
  assert.equal((await post(entry.id, "restore", "0".repeat(64))).statusCode, 409);
  const restored = await post(entry.id, "restore", sha);
  assert.equal(restored.statusCode, 200, restored.body);
  revision = restored.json().resourceRevision;
  assert.equal(restored.json().archive.state, "inline");
  assert.equal((await storage.getEntry(entry.id))!.content, entry.content);
  assert.deepEqual(
    (await storage.getEntry(entry.id))!.dynamicState,
    missingSourceDynamic,
    "restoring storage never changes per-character compression",
  );
  assert.equal(
    JSON.parse(readFileSync(archivePath, "utf8")),
    entry.content,
    "restore does not delete the preserved original file",
  );
  const generateSource = readFileSync(
    new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
    "utf8",
  );
  assert.match(generateSource, /listEntriesByLorebookIds: listAgentLorebookEntries/u);
  assert.equal(
    (generateSource.match(/await listAgentLorebookEntries\(sourceIds\)/gu) ?? []).length,
    2,
    "knowledge retrieval and router share CMB-safe representation",
  );
  console.info(
    "PASS: CMB archive management, catalog zero body reads, bounded recall hydration, authority/CAS, missing original hold and restore preservation",
  );
} finally {
  await app.close();
  await db._fileStore.close();
  if (prior === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = prior;
}
