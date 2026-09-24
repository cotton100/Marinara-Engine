import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createFileNativeDB, encodeShardKey } from "../../packages/server/src/db/file-backed-store.js";
import { eq, isNotNull } from "../../packages/server/src/db/file-query.js";
import { chats, messages } from "../../packages/server/src/db/schema/index.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";

if (process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true") {
  console.info("Autonomous notification residency regression skipped: eager storage is enabled.");
  process.exit(0);
}

const storageDir = mkdtempSync(join(tmpdir(), "marinara-notification-residency-"));
const fixtureDirectories = [storageDir];
const oldStorageDir = process.env.FILE_STORAGE_DIR;
const oldCap = process.env.MARINARA_MAX_RESIDENT_CHATS;
process.env.FILE_STORAGE_DIR = storageDir;
process.env.MARINARA_MAX_RESIDENT_CHATS = "1";
const at = (second: number) => `2026-09-24T00:00:${String(second).padStart(2, "0")}.000Z`;
const writeShard = (table: string, unit: string, rows: unknown[], rootDir = storageDir) => {
  const directory = join(rootDir, "tables", table);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${encodeShardKey(unit)}.json`), JSON.stringify(rows));
};
const row = (id: string, chatId: string, marker: string | null = null) => ({
  id,
  chatId,
  role: "assistant",
  content: "Synthetic notification fixture",
  createdAt: at(0),
  autonomousNotificationAt: marker,
});

for (const id of ["dm-a", "dm-b", "new-dm", "move-target", "cold-rp", "alias-null"]) {
  writeShard("chats", id, [{ id, name: id, mode: id === "cold-rp" ? "roleplay" : "conversation" }]);
}
writeShard("messages", "dm-a", [row("marked-a", "dm-a", at(1))]);
writeShard("messages", "dm-b", [
  { ...row("marked-b", "dm-b"), autonomousNotificationAt: undefined, autonomous_notification_at: at(2) },
]);
writeShard("messages", "cold-rp", [row("cold", "cold-rp")]);
writeShard("messages", "alias-null", [{ ...row("null-wins", "alias-null"), autonomous_notification_at: at(59) }]);

let db = await createFileNativeDB();
let storage = createChatsStorage(db);
const assertBounded = () => {
  assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), false, "feed must not lease all messages");
  assert.equal(db._fileStore.getResidentChatUnits().has("cold-rp"), false, "unmarked RP must remain cold");
  assert.equal(db._fileStore.getResidentChatUnits().has("alias-null"), false, "canonical null must beat legacy alias");
};

try {
  assert.equal((await storage.listAutonomousNotifications({ baseline: true, limit: 2 })).nextCursor, at(2));
  assertBounded();
  const first = await storage.listAutonomousNotifications({ limit: 1 });
  assert.deepEqual(
    first.events.map((event) => event.id),
    ["marked-a"],
  );
  assert.equal(first.hasMore, true);
  const second = await storage.listAutonomousNotifications({ after: first.nextCursor!, limit: 1 });
  assert.deepEqual(
    second.events.map((event) => event.id),
    ["marked-b"],
  );
  assert.equal(second.hasMore, false);
  await db._fileStore.flush();
  assertBounded();
  for (let index = 0; index < 3; index++) {
    assert.deepEqual((await storage.listAutonomousNotifications({ after: at(2), limit: 2 })).events, []);
    await db._fileStore.flush();
    assertBounded();
  }

  const created = await storage.createMessage(
    { chatId: "new-dm", role: "assistant", content: "Synthetic new reply" },
    undefined,
    { autonomousNotification: true },
  );
  assert.ok(created?.autonomousNotificationAt);
  assert.deepEqual(
    (await storage.listAutonomousNotifications({ after: at(2), limit: 10 })).events.map((event) => event.id),
    [created.id],
  );
  assertBounded();

  // Raw updates and moves must teach the shared store, not only createMessage().
  await db.insert(messages).values(row("new-marker", "move-target"));
  await db
    .update(messages)
    .set({ autonomousNotificationAt: at(3) })
    .where(eq(messages.id, "new-marker"));
  await db.update(messages).set({ chatId: "dm-a" }).where(eq(messages.id, "new-marker"));
  await db._fileStore.flush();
  assert.equal(
    (await storage.listAutonomousNotifications({ after: at(2), limit: 10 })).events.find(
      (event) => event.id === "new-marker",
    )?.chatId,
    "dm-a",
  );
  await db.delete(messages).where(eq(messages.id, "new-marker"));
  assert.equal(
    (await storage.listAutonomousNotifications({ after: at(2), limit: 10 })).events.some(
      (event) => event.id === "new-marker",
    ),
    false,
  );

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.insert(messages).values(row("rolled-back", "move-target", at(4)));
      throw new Error("synthetic rollback");
    }),
    /synthetic rollback/,
  );
  assert.equal(
    (await storage.listAutonomousNotifications({ after: at(2), limit: 10 })).events.some(
      (event) => event.id === "rolled-back",
    ),
    false,
  );
  assertBounded();

  await db._fileStore.close();
  db = await createFileNativeDB();
  storage = createChatsStorage(db);
  const reopened = await storage.listAutonomousNotifications({ limit: 10 });
  assert.deepEqual(
    reopened.events.map((event) => event.id),
    ["marked-a", "marked-b", created.id],
  );
  assertBounded();

  // Over-approximation must preserve isNotNull semantics, not only valid dates.
  await db.insert(messages).values(row("empty-marker", "move-target", ""));
  const marked = await db
    .select({ id: messages.id })
    .from(messages)
    .where(isNotNull(messages.autonomousNotificationAt));
  assert.equal(
    marked.some((message) => message.id === "empty-marker"),
    true,
  );
  assertBounded();
  // The conservative set may retain deleted/rolled-back units, but it never exposes their rows.
  assert.equal(
    marked.some((message) => message.id === "rolled-back" || message.id === "new-marker"),
    false,
  );
  assert.ok((await db.select({ id: chats.id }).from(chats)).length > 0);

  await db._fileStore.close();
  const edgeStorageDir = mkdtempSync(join(tmpdir(), "marinara-notification-residency-"));
  fixtureDirectories.push(edgeStorageDir);
  process.env.FILE_STORAGE_DIR = edgeStorageDir;
  // A malformed primary key cannot hide a marked legacy row filed under another unit.
  writeShard(
    "messages",
    "physical-host",
    [{ id: null, chat_id: "orphan-owner", autonomous_notification_at: at(1), content: "Foreign marked fixture" }],
    edgeStorageDir,
  );
  writeShard("messages", "cold-rp", [row("edge-cold", "cold-rp")], edgeStorageDir);
  db = await createFileNativeDB();
  const foreignRows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(isNotNull(messages.autonomousNotificationAt));
  assert.deepEqual(foreignRows, [{ content: "Foreign marked fixture" }]);
  assertBounded();
  console.info("Autonomous notification residency regression passed.");
} finally {
  await db._fileStore.close();
  if (oldStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = oldStorageDir;
  if (oldCap === undefined) delete process.env.MARINARA_MAX_RESIDENT_CHATS;
  else process.env.MARINARA_MAX_RESIDENT_CHATS = oldCap;
  for (const directory of fixtureDirectories) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("marinara-notification-residency-"));
    rmSync(directory, { recursive: true, force: true });
  }
}
