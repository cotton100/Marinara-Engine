// Character history is a whole-table lazy lease: ordinary chats keep no
// historical card bodies resident, while every actual history operation keeps
// the eager store's table-wide uniqueness, cascade, export and recovery rules.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mock } from "node:test";
import {
  createFileNativeDB,
  encodeShardKey,
  STORAGE_VERSION,
  type FileNativeDB,
  type FileNativeStoreTestHooks,
} from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { characterCardVersions as versions, characters } from "../../packages/server/src/db/schema/index.js";

const TABLE = "character_card_versions";
const eager = process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true";
const timestamp = "2026-10-02T00:00:00.000Z";
const version = (id: string, characterId: string, data = id) => ({
  id,
  characterId,
  data,
  avatarPath: `/api/avatars/file/${id}.png`,
  comment: "",
  version: "1.0",
  source: "manual",
  reason: "",
  createdAt: timestamp,
});
const shardPath = (dir: string, table: string, owner: string) =>
  join(dir, "tables", table, `${encodeShardKey(owner)}.json`);
function writeShard(dir: string, table: string, owner: string, rows: unknown[]) {
  mkdirSync(join(dir, "tables", table), { recursive: true });
  writeFileSync(shardPath(dir, table, owner), JSON.stringify(rows));
}
const resident = (db: FileNativeDB) => db._fileStore.getResidentLazyRows(TABLE);
const readHistory = (dir: string, owner: string) =>
  JSON.parse(readFileSync(shardPath(dir, TABLE, owner), "utf8")) as Array<Record<string, unknown>>;
const ids = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map((row) => row.id).sort();
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
};
let checks = 0;
async function fixture(
  name: string,
  test: (db: FileNativeDB, dir: string) => Promise<void>,
  options: { hooks?: FileNativeStoreTestHooks; prepare?: (dir: string) => void } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "marinara-history-"));
  const previousStorage = process.env.FILE_STORAGE_DIR;
  process.env.FILE_STORAGE_DIR = dir;
  let db: FileNativeDB | undefined;
  try {
    for (const id of ["a", "b"]) {
      writeShard(dir, "characters", id, [
        { id, data: JSON.stringify({ name: id }), createdAt: timestamp, updatedAt: timestamp },
      ]);
    }
    writeShard(dir, TABLE, "a", [version("v-a1", "a"), version("v-a2", "a")]);
    writeShard(dir, TABLE, "b", [version("v-b", "b")]);
    options.prepare?.(dir);
    db = await createFileNativeDB(options.hooks);
    await test(db, dir);
    checks++;
    console.log(`PASS ${name}`);
  } finally {
    await db?._fileStore.close();
    if (previousStorage === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previousStorage;
    // Only the directory returned by this fixture's mkdtemp may be removed.
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("marinara-history-"));
    rmSync(dir, { recursive: true, force: true });
  }
}

await fixture("boot/query/release/reload preserve payloads and original files", async (db, dir) => {
  assert.equal(resident(db).length, eager ? 3 : 0, "lazy boot does not retain history bodies");
  const originalA = readFileSync(shardPath(dir, TABLE, "a"), "utf8");
  const originalB = readFileSync(shardPath(dir, TABLE, "b"), "utf8");
  const selected = await db.select().from(versions).where(eq(versions.characterId, "a"));
  assert.deepEqual(ids(selected), ["v-a1", "v-a2"]);
  assert.equal(resident(db).length, 3, "first access leases the complete table");
  const captured = JSON.stringify(selected);
  await db._fileStore.flush();
  assert.equal(resident(db).length, eager ? 3 : 0, "clean release honors the eager escape hatch");
  assert.equal(JSON.stringify(selected), captured, "previously returned arrays survive release");
  assert.equal(readFileSync(shardPath(dir, TABLE, "a"), "utf8"), originalA);
  assert.equal(readFileSync(shardPath(dir, TABLE, "b"), "utf8"), originalB);
  assert.deepEqual(ids(await db.select().from(versions)), ["v-a1", "v-a2", "v-b"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version, STORAGE_VERSION);
});

for (const sample of [
  {
    name: "two canonical shards prefer the older duplicate, not directory order",
    a: [{ ...version("duplicate", "a", "newer"), createdAt: "2026-10-02T00:00:00.000Z" }],
    b: [{ ...version("duplicate", "b", "winner"), createdAt: "2026-10-01T00:00:00.000Z" }],
    owner: "b",
  },
  {
    name: "reversed duplicates within one shard keep the sort-first copy",
    a: [
      { ...version("duplicate", "a", "newer"), createdAt: "2026-10-02T00:00:00.000Z" },
      { ...version("duplicate", "a", "winner"), createdAt: "2026-10-01T00:00:00.000Z" },
    ],
    b: [],
    owner: "a",
  },
  {
    name: "a later canonical copy beats an older foreign copy in the same shard",
    a: [
      { ...version("duplicate", "b", "foreign"), createdAt: "2026-10-01T00:00:00.000Z" },
      { ...version("duplicate", "a", "winner"), createdAt: "2026-10-02T00:00:00.000Z" },
    ],
    b: [],
    owner: "a",
  },
]) {
  await fixture(
    sample.name,
    async (db, dir) => {
      // Loading corrupt disk rows is not a mutation: a failed transaction must
      // preserve both its selected winner and its pending disk-healing marks.
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.update(characters).set({ comment: "rollback" }).where(eq(characters.id, "a"));
          const loaded = await tx.select().from(versions);
          assert.equal(loaded.length, 1);
          assert.equal(loaded[0]?.data, "winner");
          assert.equal(loaded[0]?.characterId, sample.owner);
          throw new Error("duplicate recovery rollback");
        }),
        /duplicate recovery rollback/,
      );
      await db._fileStore.flush();
      assert.equal(resident(db).length, eager ? 1 : 0);
      const reloaded = await db.select().from(versions);
      assert.equal(reloaded.length, 1);
      assert.equal(reloaded[0]?.data, "winner");
      assert.equal(reloaded[0]?.characterId, sample.owner);
      const onDisk = ["a", "b"].flatMap((owner) =>
        existsSync(shardPath(dir, TABLE, owner)) ? readHistory(dir, owner) : [],
      );
      assert.equal(onDisk.length, 1, "the losing duplicate cannot return after restart");
      assert.equal(onDisk[0]?.data, "winner");
    },
    {
      prepare: (dir) => {
        writeShard(dir, TABLE, "a", sample.a);
        writeShard(dir, TABLE, "b", sample.b);
      },
    },
  );
}

if (eager) {
  console.log(`Character-history eager compatibility: ${checks} group passed.`);
  process.exit(0);
}

// Read-only history does not stay hot just because chat eviction was disabled.
const savedCap = process.env.MARINARA_MAX_RESIDENT_CHATS;
process.env.MARINARA_MAX_RESIDENT_CHATS = "0";
mock.timers.enable({ apis: ["setInterval"] });
try {
  await fixture("idle release is independent of the chat cap", async (db) => {
    await db._fileStore.flush();
    assert.equal(db.count(versions, eq(versions.characterId, "b")), 1);
    assert.equal(resident(db).length, 3, "count also acquires a full lease");
    mock.timers.tick(10_000);
    assert.equal(resident(db).length, 0, "a clean idle safety tick releases history");
  });
} finally {
  mock.timers.reset();
  if (savedCap === undefined) delete process.env.MARINARA_MAX_RESIDENT_CHATS;
  else process.env.MARINARA_MAX_RESIDENT_CHATS = savedCap;
}

await fixture("cold writes preserve global IDs, re-homing and deletion cascades", async (db, dir) => {
  await assert.rejects(async () => {
    await db.insert(versions).values(version("v-b", "a", "must not replace another owner"));
  }, /unique|duplicate/i);
  await db._fileStore.flush();
  assert.equal(resident(db).length, 0);
  await db
    .insert(versions)
    .values(version("v-b", "a"))
    .onConflictDoUpdate({
      target: versions.id,
      set: { characterId: "a", data: "moved" },
    });
  await db._fileStore.flush();
  assert.equal(existsSync(shardPath(dir, TABLE, "b")), false, "old owner is empty after upsert move");
  assert.deepEqual(ids(readHistory(dir, "a")), ["v-a1", "v-a2", "v-b"]);
  await db.update(versions).set({ data: "edited" }).where(eq(versions.id, "v-a1"));
  await db._fileStore.flush();
  assert.equal(readHistory(dir, "a").find((row) => row.id === "v-a1")?.data, "edited");
  await db.insert(versions).values(version("v-new", "b"));
  await db._fileStore.flush();
  assert.deepEqual(ids(await db.select().from(versions)), ["v-a1", "v-a2", "v-b", "v-new"]);
  await db._fileStore.flush();
  await db.delete(versions).where(eq(versions.id, "v-new"));
  await db._fileStore.flush();
  assert.equal(existsSync(shardPath(dir, TABLE, "b")), false);
  await db.delete(characters).where(eq(characters.id, "a"));
  await db._fileStore.flush();
  assert.equal(existsSync(shardPath(dir, TABLE, "a")), false, "cold character cascade deletes its history");
  assert.equal(db.count(versions), 0);
});

await fixture("transaction rollback preserves concurrent cold reads and pre-edit history", async (db, dir) => {
  const started = gate();
  const proceed = gate();
  const rejected = assert.rejects(
    db.transaction(async (tx) => {
      await tx.update(characters).set({ comment: "rollback" }).where(eq(characters.id, "a"));
      started.release();
      await proceed.promise;
      throw new Error("rollback fixture");
    }),
    /rollback fixture/,
  );
  await started.promise;
  const read = await db.select().from(versions);
  assert.equal(read.length, 3, "a concurrent request can load untouched history");
  proceed.release();
  await rejected;
  assert.deepEqual(ids(await db.select().from(versions)), ["v-a1", "v-a2", "v-b"]);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.update(versions).set({ data: "not committed" }).where(eq(versions.id, "v-a1"));
      await tx.delete(versions).where(eq(versions.id, "v-b"));
      await db._fileStore.flush();
      assert.equal(resident(db).length, 2, "a forced in-transaction flush must not release its rows");
      throw new Error("durable rollback fixture");
    }),
    /durable rollback fixture/,
  );
  await db._fileStore.flush();
  assert.equal(resident(db).length, 0);
  assert.equal(readHistory(dir, "a")[0]?.data, "v-a1");
  assert.deepEqual(ids(readHistory(dir, "b")), ["v-b"]);
  assert.deepEqual(ids(read), ["v-a1", "v-a2", "v-b"]);
});

await fixture(
  "backup recovery and foreign-shard canonical rows survive release",
  async (db, dir) => {
    assert.equal(resident(db).length, 0);
    assert.equal(readFileSync(shardPath(dir, TABLE, "a"), "utf8"), "{broken");
    const loaded = await db.select().from(versions).where(eq(versions.characterId, "a"));
    assert.equal(loaded.find((row) => row.id === "v-a1")?.data, "canonical");
    assert.deepEqual(ids(loaded), ["v-a1", "v-a2", "v-stray"]);
    await db._fileStore.flush();
    assert.equal(resident(db).length, 0, "healed full-table history can be released safely");
    assert.deepEqual(ids(readHistory(dir, "a")), ["v-a1", "v-a2", "v-stray"]);
    assert.deepEqual(ids(readHistory(dir, "b")), ["v-b"]);
    assert.equal((await db.select().from(versions).where(eq(versions.id, "v-a1")))[0]?.data, "canonical");
  },
  {
    prepare: (dir) => {
      writeFileSync(
        `${shardPath(dir, TABLE, "a")}.bak`,
        JSON.stringify([version("v-a1", "a", "canonical"), version("v-a2", "a")]),
      );
      writeFileSync(shardPath(dir, TABLE, "a"), "{broken");
      writeShard(dir, TABLE, "b", [version("v-b", "b"), version("v-a1", "a", "stale"), version("v-stray", "a")]);
    },
  },
);

let failWrite = false;
const flushStarted = gate();
const finishFlush = gate();
let holdWrite = false;
await fixture(
  "active or failed flush retains rows until successful retry",
  async (db, dir) => {
    try {
      await db.update(versions).set({ data: "saved eventually" }).where(eq(versions.id, "v-a1"));
      holdWrite = true;
      const pending = db._fileStore.flush();
      await flushStarted.promise;
      assert.equal(resident(db).length, 3, "in-flight persistence retains the lease");
      const returned = await db.select().from(versions);
      failWrite = true;
      finishFlush.release();
      await assert.rejects(pending, /history write failure/);
      assert.equal(resident(db).length, 3, "a failed write never releases dirty history");
      assert.equal(readHistory(dir, "a")[0]?.data, "v-a1");
      failWrite = false;
      await db._fileStore.flush();
      assert.equal(resident(db).length, 0);
      assert.equal(readHistory(dir, "a")[0]?.data, "saved eventually");
      assert.equal(returned.find((row) => row.id === "v-a1")?.data, "saved eventually");
    } finally {
      failWrite = false;
      finishFlush.release();
    }
  },
  {
    hooks: {
      beforeTableWrite: async (table) => {
        if (!table.startsWith(`${TABLE}/`)) return;
        if (holdWrite) {
          holdWrite = false;
          flushStarted.release();
          await finishFlush.promise;
        }
        if (failWrite) throw new Error("history write failure");
      },
    },
  },
);

await fixture("whole export, joins and avatar projections remain complete", async (db) => {
  const exported = await db.select().from(versions);
  await db._fileStore.flush();
  const avatars = await db.select({ avatarPath: versions.avatarPath }).from(versions);
  assert.deepEqual(avatars.map((row) => row.avatarPath).sort(), [
    "/api/avatars/file/v-a1.png",
    "/api/avatars/file/v-a2.png",
    "/api/avatars/file/v-b.png",
  ]);
  await db._fileStore.flush();
  const joined = await db
    .select({ id: versions.id })
    .from(characters)
    .innerJoin(versions, eq(versions.characterId, characters.id));
  assert.deepEqual(ids(joined), ["v-a1", "v-a2", "v-b"]);
  await db._fileStore.flush();
  assert.equal(resident(db).length, 0);
  assert.deepEqual(ids(JSON.parse(JSON.stringify(exported))), ["v-a1", "v-a2", "v-b"]);
});

let historyWrites = 0;
let failStrict = false;
await fixture(
  "strict barrier reloads a released best-effort history and retries failures",
  async (db, dir) => {
    try {
      await db.update(versions).set({ data: "strict payload" }).where(eq(versions.id, "v-a1"));
      await db._fileStore.flush();
      assert.equal(historyWrites, 1);
      assert.equal(resident(db).length, 0);
      failStrict = true;
      await assert.rejects(db._fileStore.flushStrict(), /strict history failure/);
      assert.equal(resident(db).length, 3);
      failStrict = false;
      await db._fileStore.flushStrict();
      assert.equal(historyWrites, 3);
      assert.equal(resident(db).length, 0);
      assert.equal(readHistory(dir, "a")[0]?.data, "strict payload");
    } finally {
      failStrict = false;
    }
  },
  {
    hooks: {
      beforeTableWrite: (table) => {
        if (!table.startsWith(`${TABLE}/`)) return;
        historyWrites++;
        if (failStrict) throw new Error("strict history failure");
      },
      // Existing test seam models supported directory fsync on Windows too.
      fileOperations: { flushDirectory: async () => {} },
    },
  },
);

console.log(`Character-history lazy regressions: ${checks} groups passed.`);
