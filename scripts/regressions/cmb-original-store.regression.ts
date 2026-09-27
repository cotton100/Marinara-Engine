import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileNativeDB,
  encodeShardKey,
  STORAGE_VERSION,
  StorageFormatTooNewError,
  type FileNativeDB,
} from "../../packages/server/src/db/file-backed-store.js";
import { CmbOriginalStorageError, parseCmbOriginalReference } from "../../packages/server/src/db/cmb-original-store.js";
import { and, asc, eq, like } from "../../packages/server/src/db/file-query.js";
import { lorebookEntries, lorebooks } from "../../packages/server/src/db/schema/index.js";

const directory = mkdtempSync(join(tmpdir(), "cmb-original-store-"));
const previousDirectory = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = directory;
const original =
  "[Memory]\n아린은 열쇠를 넘기지 않았다. 보라가 돌아오면 전달할 예정이다.\n" + "원본 보존🙂\uD800".repeat(1200);
const stamp = "2026-09-27T00:00:00.000Z";
const bookId = "cold-book";
const shard = join(directory, "tables", "lorebook_entries", `${encodeShardKey(bookId)}.json`);
const manifest = join(directory, "manifest.json");
mkdirSync(join(directory, "tables", "lorebook_entries"), { recursive: true });
mkdirSync(join(directory, "tables", "lorebooks"), { recursive: true });
writeFileSync(
  shard,
  JSON.stringify([
    {
      id: "original",
      lorebookId: bookId,
      name: "Original",
      content: original,
      embedding: "[1,0]",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]),
);
writeFileSync(
  join(directory, "tables", "lorebooks", `${encodeShardKey(bookId)}.json`),
  JSON.stringify([{ id: bookId, name: "Cold book", createdAt: stamp, updatedAt: stamp }]),
);
writeFileSync(
  manifest,
  JSON.stringify({ version: 6, backend: "file-native", tables: { lorebooks: 1, lorebook_entries: 1 } }),
);

let reads = 0;
let failBlobFlush = false;
let editDuringBlobFlush = false;
let checkedPublish = false;
let db: FileNativeDB | null = null;
const openStore = () =>
  createFileNativeDB({
    afterCmbOriginalRead: () => {
      reads++;
    },
    beforeTableWrite: (table, serialized) => {
      if (!table.startsWith("lorebook_entries/")) return;
      for (const row of JSON.parse(serialized)) {
        if (typeof row.content === "string") continue;
        const ref = parseCmbOriginalReference(row.content);
        assert.ok(
          existsSync(join(directory, "cmb-originals", `${ref.sha256}.json`)),
          "blob exists before reference publication",
        );
        assert.equal(
          JSON.parse(readFileSync(manifest, "utf8")).version,
          STORAGE_VERSION,
          "downgrade gate precedes reference shard",
        );
        checkedPublish = true;
      }
    },
    fileOperations: {
      flushDirectory: async () => {},
      flushFile: async (path) => {
        if (failBlobFlush && path.includes("cmb-originals")) {
          failBlobFlush = false;
          throw new Error("injected original fsync failure");
        }
        if (editDuringBlobFlush && path.includes("cmb-originals")) {
          editDuringBlobFlush = false;
          await db!
            .update(lorebookEntries)
            .set({ content: "Concurrent edit" })
            .where(eq(lorebookEntries.id, "original"));
        }
        const handle = await open(path, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    },
  });
const content = async (id = "original") => {
  const rows = await db!
    .select({ content: lorebookEntries.content })
    .from(lorebookEntries)
    .where(eq(lorebookEntries.id, id));
  return rows[0]?.content;
};
const diskContent = (id = "original") =>
  JSON.parse(readFileSync(shard, "utf8")).find((row: { id: string }) => row.id === id)?.content;
const archive = (id = "original") =>
  db!.transaction(async (tx) => {
    const result = await tx._fileStore.archiveCmbOriginal(id);
    await tx._fileStore.flushStrict();
    return result;
  });

try {
  db = await openStore();
  assert.equal(reads, 0);
  assert.equal(await content(), original, "v6 inline rows remain verbatim");
  assert.deepEqual(db._fileStore.getCmbOriginalState("original"), {
    state: "inline",
    characters: original.length,
    sha256: null,
  });
  await assert.rejects(db._fileStore.archiveCmbOriginal("original"), /active DB transaction/u);
  await assert.rejects(db._fileStore.restoreCmbOriginal("original"), /active DB transaction/u);
  assert.throws(() => db!._fileStore.getCmbOriginalState("missing"), CmbOriginalStorageError);

  const archived = await archive();
  assert.equal(archived.state, "archived");
  assert.equal(archived.characters, original.length);
  assert.ok(checkedPublish);
  const blob = join(directory, "cmb-originals", `${archived.sha256}.json`);
  const payload = readFileSync(blob, "utf8");
  assert.equal(JSON.parse(payload), original, "Korean, astral characters and lone surrogates survive exactly");
  assert.equal(typeof diskContent(), "object");
  const resident = db._fileStore.getResidentLazyRows("lorebook_entries")[0]!;
  assert.equal(typeof resident.content, "object");
  assert.ok(Object.isFrozen(resident.content));
  assert.ok(JSON.stringify(resident.content).length < 200, "resident content is only a bounded descriptor");

  reads = 0;
  assert.equal(db.count(lorebookEntries, eq(lorebookEntries.id, "original")), 1);
  const metadata = await db
    .select({ id: lorebookEntries.id, name: lorebookEntries.name, vector: lorebookEntries.embedding })
    .from(lorebookEntries)
    .where(and(eq(lorebookEntries.lorebookId, bookId), like(lorebookEntries.name, "%Original%")))
    .orderBy(asc(lorebookEntries.name));
  assert.equal(metadata.length, 1);
  assert.ok(metadata[0]!.vector instanceof Float64Array);
  await db
    .select({ entryId: lorebookEntries.id, book: lorebooks.name })
    .from(lorebookEntries)
    .innerJoin(lorebooks, eq(lorebookEntries.lorebookId, lorebooks.id))
    .where(eq(lorebookEntries.id, "original"));
  db._fileStore.getCmbOriginalState("original");
  await db.update(lorebookEntries).set({ name: "Renamed" }).where(eq(lorebookEntries.id, "original"));
  await db._fileStore.flushStrict();
  assert.equal(reads, 0, "metadata queries, vector access, joins, state reads and metadata writes never hydrate");
  assert.equal(await content(), original);
  assert.equal(reads, 1);
  assert.equal(await content(), original);
  assert.equal(reads, 2, "there is no resident body cache after a public read");
  assert.equal((await db.select().from(lorebookEntries))[0]!.content, original);
  assert.equal((await db.select().from(lorebookEntries))[0]!.embedding, "[1,0]");
  const joined = await db
    .select()
    .from(lorebookEntries)
    .innerJoin(lorebooks, eq(lorebookEntries.lorebookId, lorebooks.id));
  assert.equal(joined[0]!.lorebook_entries.content, original);
  assert.equal(
    (await db.select({ id: lorebookEntries.id }).from(lorebookEntries).where(eq(lorebookEntries.content, original)))
      .length,
    1,
  );
  await db.insert(lorebookEntries).values({
    id: "sort-other",
    lorebookId: bookId,
    name: "Sort",
    content: "Zeta",
    createdAt: stamp,
    updatedAt: stamp,
  });
  const beforeSortReads = reads;
  const sorted = await db
    .select({ id: lorebookEntries.id })
    .from(lorebookEntries)
    .orderBy(asc(lorebookEntries.content));
  assert.deepEqual(
    sorted.map((row) => row.id),
    [
      { id: "original", content: original },
      { id: "sort-other", content: "Zeta" },
    ]
      .sort((a, b) => a.content.localeCompare(b.content))
      .map((row) => row.id),
  );
  assert.ok(reads > beforeSortReads, "ordering explicitly on content hydrates comparison values");
  assert.equal(db.count(lorebookEntries, like(lorebookEntries.content, "%열쇠%")), 1);
  assert.equal(
    (await db.select({ id: lorebookEntries.id }).from(lorebookEntries).orderBy(asc(lorebookEntries.content)))[0]!.id,
    "original",
  );
  assert.equal(typeof db._fileStore.getResidentLazyRows("lorebook_entries")[0]!.content, "object");

  await db._fileStore.close();
  db = null;
  reads = 0;
  db = await openStore();
  assert.equal(reads, 0, "startup loads references without opening their payloads");
  assert.equal(db._fileStore.getCmbOriginalState("original").state, "archived");
  assert.equal(await content(), original);

  // A public caller cannot smuggle an arbitrary path/reference into a row.
  const reference = diskContent();
  await assert.rejects(
    db.update(lorebookEntries).set({ content: reference }).where(eq(lorebookEntries.id, "original")).run(),
    CmbOriginalStorageError,
  );
  await assert.rejects(
    db.insert(lorebookEntries).values({ id: "forged", lorebookId: bookId, content: reference }).run(),
    CmbOriginalStorageError,
  );
  await assert.rejects(
    db
      .insert(lorebookEntries)
      .values({ id: "original", content: "ignored" })
      .onConflictDoUpdate({ target: lorebookEntries.id, set: { content: reference } })
      .run(),
    CmbOriginalStorageError,
  );
  assert.throws(() => parseCmbOriginalReference({ ...reference, sha256: "../escape" }), CmbOriginalStorageError);

  // Restoring and then failing after a strict flush repairs the durable row too.
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx._fileStore.restoreCmbOriginal("original");
      await tx._fileStore.flushStrict();
      assert.equal(typeof diskContent(), "string");
      throw new Error("rollback restored row");
    }),
    /rollback restored row/u,
  );
  assert.equal(db._fileStore.getCmbOriginalState("original").state, "archived");
  assert.equal(typeof diskContent(), "object");
  assert.equal(await content(), original);
  await db.transaction(async (tx) => {
    await tx._fileStore.restoreCmbOriginal("original");
    await tx._fileStore.flushStrict();
  });
  assert.equal(diskContent(), original);
  assert.ok(existsSync(blob), "restore deliberately retains the original file");
  editDuringBlobFlush = true;
  await assert.rejects(archive(), /changed during archiving/u);
  assert.equal(await content(), original, "an interleaved same-transaction edit cannot publish an obsolete reference");
  assert.equal(db._fileStore.getCmbOriginalState("original").state, "inline");
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx._fileStore.archiveCmbOriginal("original");
      await tx._fileStore.flushStrict();
      throw new Error("rollback archived row");
    }),
    /rollback archived row/u,
  );
  assert.equal(db._fileStore.getCmbOriginalState("original").state, "inline");
  assert.equal(diskContent(), original);

  await db.insert(lorebookEntries).values({
    id: "failed",
    lorebookId: bookId,
    name: "Failure",
    content: "different original",
    createdAt: stamp,
    updatedAt: stamp,
  });
  failBlobFlush = true;
  await assert.rejects(archive("failed"), /injected original fsync failure/u);
  assert.equal(db._fileStore.getCmbOriginalState("failed").state, "inline");
  assert.equal(diskContent("failed"), "different original");
  await archive("failed");
  assert.equal(await content("failed"), "different original");

  await archive();
  const preservedPath = `${blob}.test-preserved`;
  renameSync(blob, preservedPath);
  try {
    assert.equal(db._fileStore.getCmbOriginalState("original").state, "archived");
    await db.select({ id: lorebookEntries.id }).from(lorebookEntries).where(eq(lorebookEntries.id, "original"));
    await assert.rejects(content(), CmbOriginalStorageError);
    await assert.rejects(
      db.transaction((tx) => tx._fileStore.restoreCmbOriginal("original")),
      CmbOriginalStorageError,
    );
    assert.equal(db._fileStore.getCmbOriginalState("original").state, "archived");
  } finally {
    renameSync(preservedPath, blob);
  }
  writeFileSync(blob, payload.replace("아린", "보라"));
  await assert.rejects(content(), CmbOriginalStorageError);
  await assert.rejects(archive(), CmbOriginalStorageError);
  writeFileSync(blob, payload);
  assert.equal(await content(), original);

  // Normal explicit content edits return inline; metadata edits stay archived.
  await db.update(lorebookEntries).set({ content: "Edited original" }).where(eq(lorebookEntries.id, "original"));
  assert.equal(db._fileStore.getCmbOriginalState("original").state, "inline");
  assert.equal(await content(), "Edited original");
  assert.ok(existsSync(blob));
  await db._fileStore.flushStrict();
  await db._fileStore.close();
  db = null;
  const supportedManifest = readFileSync(manifest, "utf8");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(supportedManifest), version: STORAGE_VERSION + 1 }));
  await assert.rejects(openStore(), StorageFormatTooNewError);
  writeFileSync(manifest, supportedManifest);
  console.log(
    "CMB original store: 8 groups passed (cold metadata, query compatibility, restart, rollback, failure, preservation, format gate, Unicode).",
  );
} finally {
  if (db) await db._fileStore.close();
  if (previousDirectory === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousDirectory;
}
