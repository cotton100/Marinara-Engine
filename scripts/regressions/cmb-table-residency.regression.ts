// Compact CMB reads must not pull swipes/game state/the other CMB source table
// into RAM. Synthetic fixtures exercise the real HTTP routes and file store.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { createFileNativeDB, encodeShardKey } from "../../packages/server/src/db/file-backed-store.js";
import { chatsRoutes } from "../../packages/server/src/routes/chats.routes.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-cmb-table-"));
const previous = process.env.FILE_STORAGE_DIR;
const previousCap = process.env.MARINARA_MAX_RESIDENT_CHATS;
process.env.FILE_STORAGE_DIR = dir;
process.env.MARINARA_MAX_RESIDENT_CHATS = "1";
const shard = (table: string) => join(dir, "tables", table, `${encodeShardKey("room")}.json`);
const seed = (table: string, rows: unknown[]) => {
  mkdirSync(dirname(shard(table)), { recursive: true });
  writeFileSync(shard(table), JSON.stringify(rows));
};
seed("chats", [{ id: "room", name: "Synthetic", mode: "conversation" }]);
seed(
  "messages",
  Array.from({ length: 251 }, (_, i) => ({
    id: `m-${String(i).padStart(3, "0")}`,
    chatId: "room",
    role: "user",
    content: `line ${i}`,
    createdAt: "2026-10-04T00:00:00.000Z",
  })),
);
seed("message_swipes", [{ id: "s", messageId: "m-000", index: 0, content: "s".repeat(1024 * 1024) }]);
seed("memory_chunks", [{ id: "chunk", chatId: "room", content: "source memory", messageCount: 5 }]);
const before = new Map(
  ["messages", "memory_chunks", "message_swipes"].map((name) => [name, readFileSync(shard(name), "utf8")]),
);
const db = await createFileNativeDB();
const app = Fastify();
app.decorate("db", db);
try {
  await app.register(chatsRoutes, { prefix: "/api/chats" });
  const memories = await app.inject({ method: "GET", url: "/api/chats/room/memories" });
  assert.equal(memories.statusCode, 200, memories.body);
  assert.equal(memories.json()[0].content, "source memory");
  assert.equal(
    db._fileStore.getResidentLazyRows("messages").length,
    0,
    "memory-only HTTP read must leave messages cold",
  );
  assert.equal(db._fileStore.getResidentLazyRows("message_swipes").length, 0);
  assert.equal(db._fileStore.getResidentChatUnits().has("room"), false);
  await db._fileStore.flush();
  assert.equal(db._fileStore.getResidentLazyRows("memory_chunks").length, 0);

  const tail = await app.inject({ method: "GET", url: "/api/chats/room/message-tail" });
  assert.equal(tail.statusCode, 200, tail.body);
  assert.equal(tail.json().length, 250);
  assert.equal(tail.json()[0].id, "m-001");
  assert.equal(tail.json().at(-1).id, "m-250");
  assert.equal(
    db._fileStore.getResidentLazyRows("message_swipes").length,
    0,
    "tail read must leave swipe payloads cold",
  );
  assert.equal(db._fileStore.getResidentLazyRows("memory_chunks").length, 0);
  await db._fileStore.flush();
  assert.equal(db._fileStore.getResidentLazyRows("messages").length, 0);
  for (const [name, bytes] of before) assert.equal(readFileSync(shard(name), "utf8"), bytes);
  console.log("CMB table residency: compact HTTP routes, idle release, exact tail and original bytes PASS");
} finally {
  await app.close();
  await db._fileStore.close();
  if (previous === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previous;
  if (previousCap === undefined) delete process.env.MARINARA_MAX_RESIDENT_CHATS;
  else process.env.MARINARA_MAX_RESIDENT_CHATS = previousCap;
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("marinara-cmb-table-"));
  rmSync(dir, { recursive: true, force: true });
}
