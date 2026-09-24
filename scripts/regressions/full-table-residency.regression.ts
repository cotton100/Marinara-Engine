// Whole-table reads must not bypass the lazy-storage cap for the rest of the
// process. All fixtures below are synthetic, private temporary directories.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mock } from "node:test";
import { createFileNativeDB, encodeShardKey } from "../../packages/server/src/db/file-backed-store.js";
import { eq, inArray, isNull } from "../../packages/server/src/db/file-query.js";
import { messages, messageSwipes } from "../../packages/server/src/db/schema/index.js";

if (process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true") {
  console.log("Full-table residency regressions skipped: MARINARA_EAGER_STORAGE is set.");
  process.exit(0);
}

const savedStorageDir = process.env.FILE_STORAGE_DIR;
const savedCap = process.env.MARINARA_MAX_RESIDENT_CHATS;
const prefix = "marinara-full-table-residency-";
const tempStorageDir = () => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.FILE_STORAGE_DIR = dir;
  process.env.MARINARA_MAX_RESIDENT_CHATS = "1";
  return dir;
};
const removeFixture = (dir: string) => {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith(prefix));
  rmSync(dir, { recursive: true, force: true });
};
const shardPath = (dir: string, table: string, key: string) =>
  join(dir, "tables", table, `${encodeShardKey(key)}.json`);
const writeShard = (dir: string, table: string, key: string, rows: unknown[]) => {
  const path = shardPath(dir, table, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows));
};
const readShard = (dir: string, table: string, key: string) =>
  JSON.parse(readFileSync(shardPath(dir, table, key), "utf8")) as Array<Record<string, unknown>>;
const messageRow = (id: string, chatId: string | null, content = id) => ({
  id,
  chatId,
  role: "user",
  content,
  createdAt: "2026-09-24T00:00:00.000Z",
});
const seedChat = (dir: string, id: string) => {
  writeShard(dir, "chats", id, [{ id, name: id, mode: "conversation" }]);
  writeShard(dir, "messages", id, [messageRow(`m-${id}`, id)]);
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

try {
  // Idle release keeps warm whole units and orphan rows, but drops cold rows
  // even when their chat no longer exists. The original query result survives.
  {
    const dir = tempStorageDir();
    seedChat(dir, "warm");
    seedChat(dir, "cold");
    writeShard(dir, "messages", "missing-chat", [messageRow("m-missing", "missing-chat")]);
    writeShard(dir, "messages", "orphaned-rows", [messageRow("m-orphan", null)]);
    writeShard(dir, "message_swipes", "cold", [{ id: "s-cold", messageId: "m-cold", index: 0, content: "cold swipe" }]);
    writeShard(dir, "message_swipes", "orphaned-rows", [
      { id: "s-orphan", messageId: "unknown-parent", index: 0, content: "orphan swipe" },
    ]);
    mock.timers.enable({ apis: ["setInterval"] });
    const db = await createFileNativeDB();
    try {
      await db._fileStore.flush();
      await db.select().from(messages).where(eq(messages.chatId, "warm"));
      const all = await db.select().from(messages);
      const allSwipes = await db.select().from(messageSwipes);
      assert.equal(all.length, 4);
      assert.equal(allSwipes.length, 2);
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), true);
      assert.equal(db._fileStore.getResidentChatUnits().has("cold"), false);
      const diskBefore = readFileSync(shardPath(dir, "messages", "cold"), "utf8");
      mock.timers.tick(10_000);
      assert.equal(db._fileStore.getFullyResidentLazyTables().size, 0, "idle tick releases whole-table promotion");
      assert.deepEqual(
        db._fileStore
          .getResidentLazyRows("messages")
          .map((row) => row.id)
          .sort(),
        ["m-orphan", "m-warm"],
        "only warm and pinned orphan rows remain resident",
      );
      assert.equal(readFileSync(shardPath(dir, "messages", "cold"), "utf8"), diskBefore);
      assert.equal(all.length, 4, "release does not truncate a previously returned result");
      assert.equal(allSwipes.length, 2);
      assert.equal((await db.select().from(messages).where(eq(messages.chatId, "cold")))[0]?.id, "m-cold");
      assert.equal(
        (
          await db
            .select()
            .from(messageSwipes)
            .where(inArray(messageSwipes.messageId, ["m-cold"]))
        )[0]?.id,
        "s-cold",
        "a scoped reload restores the parent-mapped swipe too",
      );
      assert.equal(
        (await db.select().from(messages).where(eq(messages.chatId, "missing-chat")))[0]?.id,
        "m-missing",
        "a shard remains accessible without a chats row",
      );
      assert.equal((await db.select().from(messages).where(isNull(messages.chatId)))[0]?.id, "m-orphan");
      assert.equal(
        (await db.select().from(messageSwipes).where(eq(messageSwipes.messageId, "unknown-parent")))[0]?.id,
        "s-orphan",
      );
      await db.insert(messages).values(messageRow("unknown-parent", "cold", "adopts the orphan swipe"));
      await db._fileStore.flush();
      assert.deepEqual(
        readShard(dir, "message_swipes", "cold")
          .map((row) => row.id)
          .sort(),
        ["s-cold", "s-orphan"],
        "orphan-adoption bookkeeping survives whole-table release",
      );
      assert.equal(existsSync(shardPath(dir, "message_swipes", "orphaned-rows")), false);
    } finally {
      await db._fileStore.close();
      mock.timers.reset();
      removeFixture(dir);
    }
  }

  // The asynchronous result notification is after materialization: dropping
  // store residency while the result waits must not change its rows.
  {
    const dir = tempStorageDir();
    seedChat(dir, "a");
    seedChat(dir, "b");
    const captured = deferred();
    const releaseRead = deferred();
    let holdRead = false;
    const db = await createFileNativeDB({
      afterTableRead: async (table) => {
        if (!holdRead || table !== "messages") return;
        holdRead = false;
        captured.release();
        await releaseRead.promise;
      },
    });
    try {
      holdRead = true;
      const pending = db.select().from(messages).run();
      await captured.promise;
      await db._fileStore.flush();
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), false);
      assert.equal(db._fileStore.getResidentLazyRows("messages").length, 0);
      releaseRead.release();
      assert.deepEqual(
        (await pending).map((row) => row.id),
        ["m-a", "m-b"],
      );
      assert.equal(db.count(messages), 2, "a later unbounded count reloads the full table");
    } finally {
      releaseRead.release();
      await db._fileStore.close();
      removeFixture(dir);
    }
  }

  // A flush owns a captured batch, not writes made while its I/O is pending.
  // Keep that dirty table promoted, while an independently clean one releases.
  {
    const dir = tempStorageDir();
    seedChat(dir, "a");
    seedChat(dir, "b");
    const captured = deferred();
    const releaseWrite = deferred();
    let holdWrite = false;
    const db = await createFileNativeDB({
      beforeTableWrite: async (table) => {
        if (!holdWrite || table !== `messages/${encodeShardKey("a")}`) return;
        holdWrite = false;
        captured.release();
        await releaseWrite.promise;
      },
    });
    try {
      await db.update(messages).set({ content: "first batch" });
      await db.select().from(messageSwipes);
      holdWrite = true;
      const pendingFlush = db._fileStore.flush();
      await captured.promise;
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), true, "active flush pins its rows");
      await db.update(messages).set({ content: "second batch" }).where(eq(messages.id, "m-a"));
      db._fileStore.markShardDirty!("messages", ["b"]);
      releaseWrite.release();
      await pendingFlush;
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), true, "new live marks block release");
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("message_swipes"), false);
      assert.equal(readShard(dir, "messages", "a")[0]?.content, "first batch");
      await db._fileStore.flush();
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), false);
      assert.equal(readShard(dir, "messages", "a")[0]?.content, "second batch");
      assert.equal(readShard(dir, "messages", "b")[0]?.content, "first batch");
    } finally {
      releaseWrite.release();
      await db._fileStore.close();
      removeFixture(dir);
    }
  }

  // A full-table update need not load complete units. After ordinary save,
  // strict durability must reload those units, and preserve them on failure.
  {
    const dir = tempStorageDir();
    for (const key of ["a", "b", "c"]) seedChat(dir, key);
    const failure = new Error("synthetic strict rewrite failure");
    let rejectWrite = false;
    let aWrites = 0;
    const db = await createFileNativeDB({
      beforeTableWrite: (table) => {
        if (table !== `messages/${encodeShardKey("a")}`) return;
        aWrites++;
        if (rejectWrite) throw failure;
      },
      fileOperations: { flushDirectory: async () => {} },
    });
    try {
      await db.update(messages).set({ content: "saved full-table update" });
      assert.equal(db._fileStore.getResidentChatUnits().has("a"), false);
      await db._fileStore.flush();
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), false);
      assert.equal(db._fileStore.getResidentLazyRows("messages").length, 0);
      assert.equal(aWrites, 1);
      rejectWrite = true;
      await assert.rejects(db._fileStore.flushStrict(), (error) => error === failure);
      assert.equal(
        db._fileStore.getResidentLazyRows("messages").length,
        3,
        "failed strict rewrite retains reloaded rows",
      );
      rejectWrite = false;
      await db._fileStore.flushStrict();
      assert.equal(aWrites, 3, "strict retry actually rewrites the previously released shard");
      for (const key of ["a", "b", "c"]) {
        assert.equal(readShard(dir, "messages", key)[0]?.content, "saved full-table update");
        assert.equal(
          (await db.select().from(messages).where(eq(messages.chatId, key)))[0]?.content,
          "saved full-table update",
        );
      }
    } finally {
      rejectWrite = false;
      await db._fileStore.close();
      removeFixture(dir);
    }
  }

  // Empty shards must not resurrect when a whole-table delete is released
  // before its strict directory durability barrier succeeds.
  {
    const dir = tempStorageDir();
    seedChat(dir, "a");
    seedChat(dir, "b");
    const failure = new Error("synthetic deletion directory fsync failure");
    let rejectDeletionBarrier = false;
    let deletionBarriers = 0;
    const db = await createFileNativeDB({
      fileOperations: {
        flushDirectory: async (path) => {
          if (path !== join(dir, "tables", "messages")) return;
          deletionBarriers++;
          if (rejectDeletionBarrier) throw failure;
        },
      },
    });
    try {
      await db.delete(messages);
      rejectDeletionBarrier = true;
      await db._fileStore.flush();
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), false);
      assert.equal(existsSync(shardPath(dir, "messages", "a")), false);
      const barriersAfterSave = deletionBarriers;
      await assert.rejects(db._fileStore.flushStrict(), (error) => error === failure);
      rejectDeletionBarrier = false;
      await db._fileStore.flushStrict();
      assert.equal(
        deletionBarriers,
        barriersAfterSave + 2,
        "strict failure and retry both revisit the deletion barrier",
      );
      for (const key of ["a", "b"]) {
        assert.equal(existsSync(shardPath(dir, "messages", key)), false);
        assert.equal(existsSync(`${shardPath(dir, "messages", key)}.bak`), false);
        assert.deepEqual(await db.select().from(messages).where(eq(messages.chatId, key)), []);
      }
    } finally {
      rejectDeletionBarrier = false;
      await db._fileStore.close();
      removeFixture(dir);
    }
  }

  // Explicit cap=0 still disables release. Transaction snapshots must remain
  // complete through an in-transaction flush and the ensuing rollback.
  {
    const dir = tempStorageDir();
    seedChat(dir, "a");
    seedChat(dir, "b");
    const rollback = new Error("synthetic transaction rollback");
    const db = await createFileNativeDB();
    try {
      process.env.MARINARA_MAX_RESIDENT_CHATS = "0";
      await db.select().from(messages);
      await db._fileStore.flush();
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), true, "cap zero keeps promotion");
      process.env.MARINARA_MAX_RESIDENT_CHATS = "1";
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.update(messages).set({ content: "rolled back" });
          await db._fileStore.flush();
          assert.equal(
            db._fileStore.getFullyResidentLazyTables().has("messages"),
            true,
            "active transaction prevents release",
          );
          throw rollback;
        }),
        (error) => error === rollback,
      );
      await db._fileStore.flush();
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), false);
      for (const key of ["a", "b"]) {
        assert.equal(readShard(dir, "messages", key)[0]?.content, `m-${key}`);
        assert.equal((await db.select().from(messages).where(eq(messages.chatId, key)))[0]?.content, `m-${key}`);
      }
    } finally {
      await db._fileStore.close();
      removeFixture(dir);
    }
  }

  // A failed ordinary save must never let a clean-looking flush tail discard
  // the promoted table's only copy of a write.
  {
    const dir = tempStorageDir();
    seedChat(dir, "a");
    seedChat(dir, "b");
    const failure = new Error("synthetic ordinary save failure");
    let rejectWrite = false;
    const db = await createFileNativeDB({
      beforeTableWrite: (table) => {
        if (rejectWrite && table.startsWith("messages/")) throw failure;
      },
    });
    try {
      await db.update(messages).set({ content: "not yet saved" });
      rejectWrite = true;
      await assert.rejects(db._fileStore.flush(), (error) => error === failure);
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), true);
      assert.equal(db._fileStore.getResidentLazyRows("messages").length, 2);
      rejectWrite = false;
      await db._fileStore.flush();
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), false);
      assert.equal(readShard(dir, "messages", "a")[0]?.content, "not yet saved");
      assert.equal(readShard(dir, "messages", "b")[0]?.content, "not yet saved");
    } finally {
      rejectWrite = false;
      await db._fileStore.close();
      removeFixture(dir);
    }
  }

  // A host containing only a duplicate foreign row may not itself be pinned.
  // Its stale-file cleanup must finish before its read-once mark is released.
  {
    const dir = tempStorageDir();
    seedChat(dir, "z-owner");
    seedChat(dir, "healthy");
    writeShard(dir, "messages", "a-host", [messageRow("m-z-owner", "z-owner", "stale foreign duplicate")]);
    let rejectCleanupBarrier = false;
    const db = await createFileNativeDB({
      fileOperations: {
        flushDirectory: async (path) => {
          if (rejectCleanupBarrier && path === join(dir, "tables", "messages")) {
            throw new Error("synthetic stale-host cleanup fsync failure");
          }
        },
      },
    });
    try {
      const all = await db.select().from(messages);
      assert.equal(all.find((row) => row.id === "m-z-owner")?.content, "m-z-owner");
      rejectCleanupBarrier = true;
      await db._fileStore.flush();
      assert.equal(
        db._fileStore.getFullyResidentLazyTables().has("messages"),
        true,
        "a stale-only cleanup mark retained after best-effort save blocks release",
      );
      rejectCleanupBarrier = false;
      await db._fileStore.flush();
      assert.equal(db._fileStore.getFullyResidentLazyTables().has("messages"), false);
      assert.equal(existsSync(shardPath(dir, "messages", "a-host")), false);
      assert.equal(
        db._fileStore.getResidentChatUnits().has("z-owner"),
        false,
        "pinning does not fake a whole loaded unit",
      );
      assert.deepEqual(
        db._fileStore.getResidentLazyRows("messages").map((row) => row.id),
        ["m-z-owner"],
        "the pinned canonical owner stays, unrelated healthy rows release",
      );
      assert.equal((await db.select().from(messages).where(eq(messages.chatId, "healthy")))[0]?.id, "m-healthy");
      assert.equal((await db.select().from(messages).where(eq(messages.chatId, "z-owner")))[0]?.content, "m-z-owner");
      assert.equal(
        (await db.select().from(messages)).length,
        2,
        "repeated promotion never revives the foreign duplicate",
      );
    } finally {
      rejectCleanupBarrier = false;
      await db._fileStore.close();
      removeFixture(dir);
    }
  }
} finally {
  if (savedStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = savedStorageDir;
  if (savedCap === undefined) delete process.env.MARINARA_MAX_RESIDENT_CHATS;
  else process.env.MARINARA_MAX_RESIDENT_CHATS = savedCap;
}

console.log("Full-table residency regressions passed.");
