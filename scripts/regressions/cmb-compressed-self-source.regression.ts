import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { lorebookEntries, lorebooks } from "../../packages/server/src/db/schema/index.js";
import { createCmbCompressionFixture } from "./helpers/cmb-compression-fixture.js";
import { processLorebooks } from "../../packages/server/src/services/lorebook/index.js";
import { recallMemories } from "../../packages/server/src/services/memory-recall.js";

const directory = mkdtempSync(join(tmpdir(), "marinara-cmb-self-compression-"));
const previous = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = directory;
process.env.LOG_LEVEL = "silent";
const db = (await createFileNativeDB()) as unknown as DB;
let checks = 0;
try {
  const fixture = await createCmbCompressionFixture(db);
  const entry = await fixture.createMemory({ id: "self-compressed", native: true, appliedTo: ["a", "b"] });
  const original = JSON.stringify(await fixture.storage.getEntry(entry.id));
  const scan = (overrides: Parameters<typeof processLorebooks>[3] = {}) =>
    processLorebooks(db, [{ role: "user", content: "a semantic-only query" }], null, {
      chatId: "rp",
      characterIds: ["character-a"],
      cmbAudienceCharacterIds: ["character-a"],
      activeLorebookIds: [fixture.bookId],
      chatEmbedding: [1, 0, 0, 0],
      semanticEmbeddingSpaceId: "fixture",
      ...overrides,
    });
  const native = () =>
    recallMemories(db, "harbor", ["rp"], {
      embeddingSource: { spaceId: "fixture", label: "synthetic", embed: async () => [[1, 0, 0, 0]] },
    });
  const self = await scan();
  assert.deepEqual(self.activatedEntryIds, [entry.id], "the source room must retrieve its permitted summary");
  assert.match(self.activatedEntries[0]!.content, /SHORT_A/u);
  assert.doesNotMatch(self.activatedEntries[0]!.content, /SHORT_B|only after Bora arrived/u);
  assert.deepEqual(await native(), [], "native recall must not reopen compressed original details");
  assert.equal(JSON.stringify(await fixture.storage.getEntry(entry.id)), original, "retrieval never writes a body");
  checks++;

  assert.deepEqual((await scan({ chatId: "dm-a" })).activatedEntryIds, [entry.id]);
  assert.deepEqual((await scan({ forcedEntryIds: [entry.id], forcedEntriesOnly: true })).activatedEntryIds, [entry.id]);
  const merged = await scan({
    characterIds: ["character-a", "character-b"],
    cmbAudienceCharacterIds: ["character-a", "character-b"],
  });
  assert.match(merged.activatedEntries[0]!.content, /SHORT_A[\s\S]*SHORT_B/u);
  checks++;

  assert.deepEqual((await scan({ entryStateOverrides: { [entry.id]: { enabled: false } } })).activatedEntryIds, []);
  await db.update(lorebookEntries).set({ enabled: "false" }).where(eq(lorebookEntries.id, entry.id));
  assert.deepEqual((await scan()).activatedEntryIds, []);
  await db.update(lorebookEntries).set({ enabled: "true" }).where(eq(lorebookEntries.id, entry.id));
  await db.update(lorebooks).set({ enabled: "false" }).where(eq(lorebooks.id, fixture.bookId));
  assert.deepEqual((await scan()).activatedEntryIds, []);
  await db.update(lorebooks).set({ enabled: "true" }).where(eq(lorebooks.id, fixture.bookId));
  assert.deepEqual((await scan({ tokenBudget: 1 })).activatedEntryIds, [], "summaries retain token limits");
  checks++;

  const malformed = { ...entry.dynamicState, convoMemoryBridgeCompression: { schemaVersion: 2 } };
  await fixture.writeDynamic(entry.id, malformed);
  assert.deepEqual((await scan()).activatedEntryIds, []);
  assert.deepEqual(await native(), [], "malformed compression never permits an original fallback");
  await fixture.writeDynamic(entry.id, entry.dynamicState);
  fixture.aging.rooms[0]!.currentDay = 31;
  await fixture.saveSettings();
  assert.deepEqual((await scan()).activatedEntryIds, [], "a stale summary stays held");
  assert.deepEqual(await native(), []);
  fixture.aging.rooms[0]!.currentDay = 30;
  await fixture.saveSettings();
  checks++;

  const released = structuredClone(entry.dynamicState);
  const byCast = (released.convoMemoryBridgeCompression as { byCast: Record<string, { active: boolean }> }).byCast;
  byCast.b!.active = false;
  await fixture.writeDynamic(entry.id, released);
  assert.deepEqual((await scan()).activatedEntryIds, [entry.id], "the still-compressed reader keeps their summary");
  assert.deepEqual(
    (await scan({ characterIds: ["character-b"], cmbAudienceCharacterIds: ["character-b"] })).activatedEntryIds,
    [],
    "another reader's active compression must not admit this reader's uncompressed duplicate",
  );
  assert.deepEqual(
    (
      await scan({
        characterIds: ["character-a", "character-b"],
        cmbAudienceCharacterIds: ["character-a", "character-b"],
      })
    ).activatedEntryIds,
    [],
    "a mixed compressed/uncompressed audience cannot reopen raw details",
  );
  byCast.a!.active = false;
  await fixture.writeDynamic(entry.id, released);
  assert.deepEqual((await scan()).activatedEntryIds, [], "released local originals retain native deduplication");
  assert.equal((await native()).length, 1, "explicit release restores the native recall path");
  const explicitOriginal = await scan({ forcedEntriesOnly: true, forcedEntryIds: [entry.id] });
  assert.match(explicitOriginal.activatedEntries[0]!.content, /only after Bora arrived/u);
  await fixture.writeDynamic(entry.id, entry.dynamicState);
  checks++;

  await db.update(lorebookEntries).set({ enabled: "false" }).where(eq(lorebookEntries.id, entry.id));
  const hidden = await fixture.createMemory({ id: "self-private", native: true, unknownTo: ["b"] });
  assert.deepEqual((await scan()).activatedEntryIds, [hidden.id]);
  for (const audience of [["character-b"], ["character-a", "character-b"], ["outsider"]]) {
    assert.deepEqual(
      (await scan({ characterIds: audience, cmbAudienceCharacterIds: audience })).activatedEntryIds,
      [],
      "self-source selection does not bypass knowledge or audience filters",
    );
  }
  checks++;

  console.log(`CMB compressed self-source: ${checks} groups passed`);
} finally {
  await (db as unknown as { _fileStore: { close(): Promise<void> } })._fileStore.close();
  if (previous === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previous;
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("marinara-cmb-self-compression-"));
  rmSync(directory, { recursive: true, force: true });
}
