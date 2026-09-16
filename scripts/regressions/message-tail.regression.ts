import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { chats, messages } from "../../packages/server/src/db/schema/index.js";
import { chatsRoutes } from "../../packages/server/src/routes/chats.routes.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-message-tail-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;

const db = await createFileNativeDB();
const app = Fastify();
app.decorate("db", db);

try {
  await app.register(chatsRoutes, { prefix: "/api/chats" });
  await app.ready();
  await db.insert(chats).values({ id: "tail-chat", name: "Tail", mode: "roleplay" });
  await db.insert(messages).values(
    Array.from({ length: 251 }, (_, index) => ({
      id: `tail-${String(index).padStart(3, "0")}`,
      chatId: "tail-chat",
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      characterId: index % 2 === 0 ? null : "tail-character",
      content: `Tail content ${index}`,
      activeSwipeIndex: 0,
      extra: JSON.stringify({ unusedLargeField: "x".repeat(1024) }),
      createdAt: "2026-08-08T11:00:00.000Z",
    })),
  );

  const defaultResponse = await app.inject({ method: "GET", url: "/api/chats/tail-chat/message-tail" });
  assert.equal(defaultResponse.statusCode, 200, defaultResponse.body);
  const defaultTail = defaultResponse.json();
  assert.equal(defaultTail.length, 250, "message-tail defaults to the latest 250 rows");
  assert.equal(defaultTail[0].id, "tail-001", "the bounded tail omits the oldest tied row");
  assert.equal(defaultTail.at(-1).id, "tail-250", "the bounded tail ends at the newest tied row");
  assert.deepEqual(
    Object.keys(defaultTail[0]).sort(),
    ["characterId", "chatId", "content", "createdAt", "id", "role"],
    "message-tail exposes only its six-field contract",
  );
  assert.equal(defaultResponse.body.includes("unusedLargeField"), false, "message metadata must not leak");

  const limitedResponse = await app.inject({
    method: "GET",
    url: "/api/chats/tail-chat/message-tail?limit=2",
  });
  assert.equal(limitedResponse.statusCode, 200, limitedResponse.body);
  assert.deepEqual(
    limitedResponse.json().map((message: { id: string }) => message.id),
    ["tail-249", "tail-250"],
    "message-tail keeps chronological order after newest-first selection",
  );

  for (const boundaryLimit of [1, 250]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/chats/tail-chat/message-tail?limit=${boundaryLimit}`,
    });
    assert.equal(response.statusCode, 200, `limit=${boundaryLimit} must be accepted`);
    assert.equal(response.json().length, boundaryLimit, `limit=${boundaryLimit} must be exact`);
  }

  for (const invalidLimit of ["", "0", "01", "1.5", "2junk", "251", "-1"]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/chats/tail-chat/message-tail?limit=${encodeURIComponent(invalidLimit)}`,
    });
    assert.equal(response.statusCode, 400, `limit=${JSON.stringify(invalidLimit)} must fail exactly`);
  }

  const legacyResponse = await app.inject({ method: "GET", url: "/api/chats/tail-chat/messages?limit=1" });
  assert.equal(legacyResponse.statusCode, 200, legacyResponse.body);
  assert.equal(
    Object.hasOwn(legacyResponse.json()[0], "extra"),
    true,
    "the existing paginated message DTO remains unchanged",
  );
} finally {
  await app.close();
  await db._fileStore.close();
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}

console.info("Message tail regression passed.");
