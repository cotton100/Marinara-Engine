import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createFileNativeDB,
  encodeShardKey,
  type FileNativeDB,
  type FileNativeStoreTestHooks,
} from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { chats, memoryChunks, messages, messageSwipes } from "../../packages/server/src/db/schema/index.js";

const priorDir = process.env.FILE_STORAGE_DIR;
const priorCap = process.env.MARINARA_MAX_RESIDENT_CHATS;
const eager = ["1", "true"].includes(process.env.MARINARA_EAGER_STORAGE ?? "");
const pathFor = (dir: string, table: string, key: string) => join(dir, "tables", table, `${encodeShardKey(key)}.json`);
const writeShard = (dir: string, table: string, key: string, rows: unknown[]) => {
  const path = pathFor(dir, table, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows));
};
const row = (id: string, chatId: string, content = id) => ({
  id,
  chatId,
  content,
  role: "user",
  createdAt: "2026-10-04T00:00:00.000Z",
});
const read = (db: FileNativeDB, id = "a") => db.select().from(messages).tableOnly().where(eq(messages.chatId, id));
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
let passed = 0;
async function fixture(
  run: (db: FileNativeDB, dir: string) => Promise<void>,
  prepare?: (dir: string) => void,
  hooks?: FileNativeStoreTestHooks,
) {
  const dir = mkdtempSync(join(tmpdir(), "marinara-table-read-"));
  process.env.FILE_STORAGE_DIR = dir;
  process.env.MARINARA_MAX_RESIDENT_CHATS = "1";
  for (const key of ["a", "b"]) {
    writeShard(dir, "chats", key, [{ id: key, name: key, mode: "conversation" }]);
    writeShard(dir, "messages", key, [row(`m-${key}`, key)]);
    writeShard(dir, "message_swipes", key, [
      { id: `s-${key}`, messageId: `m-${key}`, index: 0, content: `swipe-${key}` },
    ]);
    writeShard(dir, "memory_chunks", key, [{ id: `c-${key}`, chatId: key, content: `memory-${key}`, messageCount: 1 }]);
  }
  prepare?.(dir);
  const db = await createFileNativeDB(hooks);
  try {
    await run(db, dir);
    passed++;
  } finally {
    await db._fileStore.close();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("marinara-table-read-"));
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  // A read returns the same immutable results before/after eviction. New writes
  // load complete units and never replace pre-existing disk rows with a slice.
  await fixture(async (db) => {
    const first = await read(db);
    assert.equal(first[0]?.content, "m-a");
    if (!eager) assert.equal(db._fileStore.getResidentLazyRows("message_swipes").length, 0);
    await db._fileStore.flush();
    assert.deepEqual(await read(db), first);
    assert.equal(first[0]?.content, "m-a");
    await db.insert(messages).values(row("new", "a"));
    await db.update(messages).set({ content: "changed" }).where(eq(messages.id, "m-a"));
    assert.deepEqual((await read(db)).map((r) => r.content).sort(), ["changed", "new"]);
    await db._fileStore.flush();
    // Load another whole unit and evict a, then confirm round-trip persistence.
    await db.select().from(messages).where(eq(messages.chatId, "b"));
    await db._fileStore.flush();
    assert.deepEqual((await read(db)).map((r) => r.content).sort(), ["changed", "new"]);
    assert.equal(
      (await db.select().from(messageSwipes).where(eq(messageSwipes.messageId, "m-a")))[0]?.content,
      "swipe-a",
    );
    await db.delete(chats).where(eq(chats.id, "a"));
    await db._fileStore.flush();
    assert.deepEqual(await read(db), []);
    assert.deepEqual(await db.select().from(memoryChunks).tableOnly().where(eq(memoryChunks.chatId, "a")), []);
  });

  // A concurrent read during a transaction must survive its rollback, including
  // a table snapshot that was taken before the cold read.
  await fixture(async (db) => {
    const started = deferred();
    const resume = deferred();
    const transaction = assert.rejects(
      db.transaction(async (tx) => {
        await tx.update(messages).set({ content: "rolled back" }).where(eq(messages.id, "m-a"));
        started.release();
        await resume.promise;
        throw new Error("rollback-test");
      }),
      /rollback-test/,
    );
    await started.promise;
    const cold = await read(db, "b");
    assert.equal(cold[0]?.content, "m-b");
    resume.release();
    await transaction;
    assert.equal((await read(db))[0]?.content, "m-a");
    assert.deepEqual(await read(db, "b"), cold);
    await db._fileStore.flush();
    assert.equal((await read(db, "b"))[0]?.content, "m-b");
  });

  // Cross-chat moves update parent indexes and swipes even after a partial read.
  await fixture(async (db) => {
    await read(db);
    await db.update(messages).set({ chatId: "b" }).where(eq(messages.id, "m-a"));
    await db._fileStore.flush();
    assert.deepEqual(await read(db), []);
    assert.equal((await read(db, "b")).length, 2);
    assert.equal(
      (await db.select().from(messageSwipes).where(eq(messageSwipes.messageId, "m-a")))[0]?.content,
      "swipe-a",
    );
  });

  // Stray messages are found through the existing harvest index; their host and
  // canonical units are complete before healing/flush, as on the default path.
  await fixture(
    async (db) => {
      assert.deepEqual((await read(db)).map((r) => r.id).sort(), ["m-a", "stray"]);
      await db._fileStore.flush();
      assert.deepEqual((await read(db)).map((r) => r.id).sort(), ["m-a", "stray"]);
    },
    (dir) => writeShard(dir, "messages", "b", [row("m-b", "b"), row("stray", "a")]),
  );

  // Native-memory foreign rows/duplicate IDs force complete-unit recovery too.
  await fixture(
    async (db) => {
      const chunks = await db.select().from(memoryChunks).tableOnly().where(eq(memoryChunks.chatId, "b"));
      assert.equal(chunks.find((r) => r.id === "c-b")?.content, "canonical");
      await db._fileStore.flush();
      assert.equal((await db.select().from(memoryChunks).tableOnly().where(eq(memoryChunks.chatId, "b"))).length, 1);
    },
    (dir) => {
      writeShard(dir, "memory_chunks", "b", [
        { id: "c-b", chatId: "b", content: "canonical", messageCount: 1 },
        { id: "c-a", chatId: "a", content: "stray", messageCount: 1 },
      ]);
    },
  );

  // Corrupt primary / good backup, including bak-only shards. No shortcut past
  // normal recovery, and unrelated original bodies must survive the rewrite.
  for (const bakOnly of [false, true])
    await fixture(
      async (db) => {
        const recovered = await db.select().from(memoryChunks).tableOnly().where(eq(memoryChunks.chatId, "recover"));
        assert.equal(recovered[0]?.content, "recovered");
        await db._fileStore.flush();
        assert.equal(
          (await db.select().from(memoryChunks).tableOnly().where(eq(memoryChunks.chatId, "recover")))[0]?.content,
          "recovered",
        );
      },
      (dir) => {
        const path = pathFor(dir, "memory_chunks", "recover");
        writeFileSync(
          `${path}.bak`,
          JSON.stringify([{ id: "r", chatId: "recover", content: "recovered", messageCount: 1 }]),
        );
        if (!bakOnly) writeFileSync(path, "broken-json");
      },
    );

  // Joins and unbounded scans explicitly fall back to the established behavior.
  await fixture(async (db) => {
    const joined = await db
      .select({ id: messages.id, swipe: messageSwipes.content })
      .from(messages)
      .tableOnly()
      .innerJoin(messageSwipes, eq(messageSwipes.messageId, messages.id))
      .where(eq(messages.chatId, "a"));
    assert.deepEqual(joined, [{ id: "m-a", swipe: "swipe-a" }]);
    assert.equal((await db.select().from(messages).tableOnly()).length, 2);
    await db._fileStore.flush();
    assert.equal((await read(db, "b"))[0]?.content, "m-b");
  });

  // Failed save retains dirty rows; a strict retry reloads evicted clean units
  // with best-effort pending marks. Windows uses the existing fsync test seam.
  let fail = false;
  await fixture(
    async (db, dir) => {
      await read(db);
      await db.update(messages).set({ content: "unsaved" }).where(eq(messages.id, "m-a"));
      fail = true;
      await assert.rejects(db._fileStore.flush(), /synthetic-save-failure/);
      assert.equal((await read(db))[0]?.content, "unsaved");
      fail = false;
      await db._fileStore.flush();
      await db.select().from(messages).where(eq(messages.chatId, "b"));
      await db._fileStore.flush();
      await db._fileStore.flushStrict();
      assert.ok(existsSync(pathFor(dir, "messages", "a")));
      assert.equal(JSON.parse(readFileSync(pathFor(dir, "messages", "a"), "utf8"))[0]?.content, "unsaved");
    },
    undefined,
    {
      beforeTableWrite: (table) => {
        if (fail && table.startsWith("messages/")) throw new Error("synthetic-save-failure");
      },
      fileOperations: { flushDirectory: async () => {} },
    },
  );

  // A cold read while a flush owns captured dirty marks must not lose either
  // the captured write or the read result when the idle sweep finally runs.
  const flushing = deferred();
  const finish = deferred();
  let hold = true;
  await fixture(
    async (db) => {
      await db.update(messages).set({ content: "during-flush" }).where(eq(messages.id, "m-a"));
      const pending = db._fileStore.flush();
      try {
        await flushing.promise;
        const cold = await db.select().from(memoryChunks).tableOnly().where(eq(memoryChunks.chatId, "b"));
        assert.equal(cold[0]?.content, "memory-b");
        finish.release();
        await pending;
        assert.equal((await read(db))[0]?.content, "during-flush");
        assert.equal(cold[0]?.content, "memory-b");
        assert.equal(
          (await db.select().from(memoryChunks).tableOnly().where(eq(memoryChunks.chatId, "b")))[0]?.content,
          "memory-b",
        );
      } finally {
        hold = false;
        finish.release();
        await pending;
      }
    },
    undefined,
    {
      beforeTableWrite: async (table) => {
        if (hold && table.startsWith("messages/")) {
          hold = false;
          flushing.release();
          await finish.promise;
        }
      },
    },
  );

  await fixture(async (db) => {
    process.env.MARINARA_MAX_RESIDENT_CHATS = "0";
    await read(db);
    await db._fileStore.flush();
    assert.equal(
      db._fileStore.getResidentLazyRows("messages").some((r) => r.id === "m-a"),
      true,
      "explicit zero still disables idle eviction",
    );
  });

  console.log(`Table-scoped reads: ${passed} groups PASS (${eager ? "eager" : "lazy"})`);
} finally {
  if (priorDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = priorDir;
  if (priorCap === undefined) delete process.env.MARINARA_MAX_RESIDENT_CHATS;
  else process.env.MARINARA_MAX_RESIDENT_CHATS = priorCap;
}
