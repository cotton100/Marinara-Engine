import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

if (process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true") {
  console.info("Advanced memory residency regression skipped: eager storage is enabled.");
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "marinara-advanced-memory-residency-"));
const previousDataDir = process.env.DATA_DIR;
const previousStorageDir = process.env.FILE_STORAGE_DIR;
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("This residency fixture must never make a network request");
};
const { createFileNativeDB, encodeShardKey } = await import("../../packages/server/src/db/file-backed-store.js");
const { and, eq } = await import("../../packages/server/src/db/file-query.js");
const { chats, messages, advancedMemoryRecords } = await import("../../packages/server/src/db/schema/index.js");
const { createAdvancedMemoryService } = await import("../../packages/server/src/services/advanced-memory.js");
const coldDirectory = join(process.env.FILE_STORAGE_DIR, "tables", "advanced_memory_records");
mkdirSync(coldDirectory, { recursive: true });
writeFileSync(
  join(coldDirectory, `${encodeShardKey("cold")}.json`),
  JSON.stringify([{ id: "cold-record", chatId: "cold", content: "Synthetic unrelated memory" }]),
);
const db = await createFileNativeDB();
try {
  await db.insert(chats).values([
    { id: "active", name: "Active", mode: "roleplay", metadata: '{"advancedMemory":{"enabled":true}}' },
    { id: "cold", name: "Cold", mode: "roleplay" },
  ]);
  await db.insert(messages).values({
    id: "active-message",
    chatId: "active",
    role: "user",
    content: "Synthetic scene source",
    createdAt: "2026-09-24T00:00:00.000Z",
  });
  const memory = createAdvancedMemoryService(db);
  const request = await memory.getSceneCheck("active", { force: true });
  assert.ok(request);
  assert.equal(await memory.commitSceneCheck("active", request, { starts: [] }), true);
  assert.equal(
    db._fileStore.getFullyResidentLazyTables().has("advanced_memory_records"),
    false,
    "put() checking a new record must not lease every chat's memory",
  );
  assert.equal(db._fileStore.getResidentChatUnits().has("cold"), false);
  assert.equal(
    db._fileStore.getResidentLazyRows("advanced_memory_records").some((record) => record.id === "cold-record"),
    false,
  );
  const rows = await db.select().from(advancedMemoryRecords).where(eq(advancedMemoryRecords.chatId, "active"));
  assert.equal(rows.length, 1, "actual scene scaffold creation remains intact");
  assert.equal(rows[0].id, "scene-active-message");
  assert.equal(rows[0].chatId, "active");

  const source = readFileSync(
    new URL("../../packages/server/src/services/advanced-memory.ts", import.meta.url),
    "utf8",
  );
  for (const owner of ["record", "cacheOwner"]) {
    assert.match(
      source,
      new RegExp(
        `\\.where\\(\\s*and\\(eq\\(advancedMemoryRecords.chatId, ctx.chatId\\), eq\\(advancedMemoryRecords.id, ${owner}.id\\)\\),?\\s*\\)`,
        "u",
      ),
      `${owner} lookup must retain the chat condition in the actual service`,
    );
    for (const id of [rows[0].id, "not-created-yet"]) {
      const result = await db
        .select()
        .from(advancedMemoryRecords)
        .where(and(eq(advancedMemoryRecords.chatId, "active"), eq(advancedMemoryRecords.id, id)));
      assert.equal(result.length, id === rows[0].id ? 1 : 0);
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("advanced_memory_records"), false);
    }
  }
  console.info("Advanced memory residency regression passed.");
} finally {
  await db._fileStore.close();
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("marinara-advanced-memory-residency-"));
  rmSync(directory, { recursive: true, force: true });
}
