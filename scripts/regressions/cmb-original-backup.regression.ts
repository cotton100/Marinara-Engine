import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic files remain available for inspection; this regression does not remove fixtures.
const root = await mkdtemp(join(tmpdir(), "marinara-cmb-original-backup-"));
const environmentKeys = ["DATA_DIR", "FILE_STORAGE_DIR", "MARINARA_ENV_FILE", "ADMIN_SECRET"];
const environment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
process.env.MARINARA_ENV_FILE = join(root, "runtime.env");
process.env.ADMIN_SECRET = "cmb-original-backup-fixture";
await writeFile(process.env.MARINARA_ENV_FILE, "# Synthetic regression only\n");
const sourceRoot = join(root, "source");
process.env.DATA_DIR = sourceRoot;
process.env.FILE_STORAGE_DIR = join(sourceRoot, "storage");

const [{ default: Fastify }, { default: multipart }, { default: AdmZip }, storeModule, schema, query, backup] =
  await Promise.all([
    import("../../packages/server/node_modules/fastify/fastify.js"),
    import("../../packages/server/node_modules/@fastify/multipart/index.js"),
    import("adm-zip"),
    import("../../packages/server/src/db/file-backed-store.js"),
    import("../../packages/server/src/db/schema/index.js"),
    import("../../packages/server/src/db/file-query.js"),
    import("../../packages/server/src/routes/backup.routes.js"),
  ]);
const { createFileNativeDB, encodeShardKey } = storeModule;
const { lorebooks, lorebookEntries } = schema;
const { eq } = query;
const original = "[Knowledge boundary]\nUnknown to cast IDs: none\n\n[Memory]\nArin kept the blue notebook. ".repeat(
  12,
);
const entryId = "archived-fixture";
const bookId = "archive-book";
const stamp = "2026-01-01T00:00:00.000Z";
let reads = 0;
let captureGate: { entered(): void; wait: Promise<void> } | null = null;
const db = await createFileNativeDB({
  fileOperations: { flushDirectory: async () => undefined },
  afterCmbOriginalRead: () => {
    reads += 1;
  },
  afterTableRead: async (table) => {
    if (table !== "lorebook_entries" || !captureGate) return;
    const gate = captureGate;
    captureGate = null;
    gate.entered();
    await gate.wait;
  },
});
const apps: Array<Awaited<ReturnType<typeof makeApp>>> = [];
const stores = [db];
async function makeApp(database: typeof db) {
  const app = Fastify();
  app.decorate("db", database);
  await app.register(multipart);
  await app.register(backup.backupRoutes, { prefix: "/api/backup" });
  await app.ready();
  return app;
}
function multipartArchive(bytes: Buffer) {
  const boundary = "cmb-original-backup-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="profile.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
async function roundTrip(label: string, payload: object | Buffer) {
  const target = join(root, label);
  process.env.DATA_DIR = target;
  process.env.FILE_STORAGE_DIR = join(target, "storage");
  const imported = await createFileNativeDB({ fileOperations: { flushDirectory: async () => undefined } });
  stores.push(imported);
  const app = await makeApp(imported);
  apps.push(app);
  const body = Buffer.isBuffer(payload) ? multipartArchive(payload) : { payload };
  const preview = await app.inject({ method: "POST", url: "/api/backup/import-profile?preview=true", ...body });
  assert.equal(preview.statusCode, 200, preview.body);
  const result = await app.inject({
    method: "POST",
    url: "/api/backup/import-profile",
    headers: { "x-admin-secret": process.env.ADMIN_SECRET!, "x-profile-preview-token": preview.json().previewToken },
  });
  assert.equal(result.statusCode, 200, result.body);
  const rows = await imported.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId));
  assert.equal(rows[0]?.content, original, `${label} restores exact original text`);
  assert.equal(imported._fileStore.getCmbOriginalState(entryId).state, "inline");
  await imported._fileStore.flush();
  process.env.DATA_DIR = sourceRoot;
  process.env.FILE_STORAGE_DIR = db._fileStore.rootDir;
}

try {
  await db
    .insert(lorebooks)
    .values({ id: bookId, name: "Synthetic archived book", createdAt: stamp, updatedAt: stamp });
  await db.insert(lorebookEntries).values({
    id: entryId,
    lorebookId: bookId,
    name: "Synthetic original",
    content: original,
    tag: "convo-memory-bridge",
    createdAt: stamp,
    updatedAt: stamp,
  });
  await db.transaction(async () => {
    await db._fileStore.archiveCmbOriginal(entryId);
    await db._fileStore.flushStrict();
  });
  const archived = db._fileStore.getCmbOriginalState(entryId);
  assert.equal(archived.state, "archived");
  assert.equal(archived.characters, original.length);
  assert.match(archived.sha256!, /^[a-f0-9]{64}$/u);
  const blob = join(db._fileStore.rootDir, "cmb-originals", `${archived.sha256}.json`);
  assert.equal(JSON.parse(await readFile(blob, "utf8")), original);
  const shardPath = join(db._fileStore.rootDir, "tables", "lorebook_entries", `${encodeShardKey(bookId)}.json`);
  assert.equal((await readFile(shardPath, "utf8")).includes("Arin kept"), false);
  const metadataReads = reads;
  await db.select({ id: lorebookEntries.id }).from(lorebookEntries);
  assert.equal(reads, metadataReads, "bodyless projection never reads the archived original");

  const app = await makeApp(db);
  apps.push(app);
  const json = await app.inject({ method: "GET", url: "/api/backup/export-profile" });
  assert.equal(json.statusCode, 200, json.body);
  const jsonEnvelope = json.json();
  assert.equal(jsonEnvelope.data.fileStorage.tables.lorebook_entries[0].content, original);
  const afterJsonReads = reads;
  assert.ok(afterJsonReads > metadataReads);
  const zip = await app.inject({ method: "GET", url: "/api/backup/export-profile?format=zip" });
  assert.equal(zip.statusCode, 200, zip.body.slice(0, 200));
  assert.ok(reads > afterJsonReads, "a previous export does not retain the hydrated original in the store");
  assert.deepEqual(db._fileStore.getCmbOriginalState(entryId), archived);
  const nativeZip = new AdmZip(zip.rawPayload);
  assert.equal(JSON.parse(nativeZip.readAsText("profile-tables/lorebook_entries.jsonl")).content, original);

  let releaseCapture!: () => void;
  let enteredCapture!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredCapture = resolve;
  });
  captureGate = {
    entered: enteredCapture,
    wait: new Promise((resolve) => {
      releaseCapture = resolve;
    }),
  };
  const fullPending = app.inject({ method: "POST", url: "/api/backup/download" });
  await entered;
  let restoreEntered = false;
  const restorePending = db.transaction(async () => {
    restoreEntered = true;
    await db._fileStore.restoreCmbOriginal(entryId);
    await db._fileStore.flushStrict();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restoreEntered, false, "restore waits until the complete backup image has been written");
  releaseCapture();
  const full = await fullPending;
  assert.equal(full.statusCode, 200, full.body.slice(0, 200));
  await restorePending;
  const fullZip = new AdmZip(full.rawPayload);
  const blobEntry = fullZip
    .getEntries()
    .find((entry) => entry.entryName.endsWith(`/storage/cmb-originals/${archived.sha256}.json`));
  assert.ok(blobEntry, "raw full backup includes the archived body file");
  assert.equal(JSON.parse(blobEntry.getData().toString("utf8")), original);
  const rawShard = fullZip
    .getEntries()
    .find((entry) => entry.entryName.endsWith(`/storage/tables/lorebook_entries/${encodeShardKey(bookId)}.json`));
  assert.ok(rawShard);
  assert.notEqual(
    typeof JSON.parse(rawShard.getData().toString("utf8"))[0].content,
    "string",
    "raw table and blob share the pre-restore snapshot",
  );
  const inlineTable = fullZip
    .getEntries()
    .find((entry) => entry.entryName.endsWith("/profile-tables/lorebook_entries.jsonl"));
  assert.ok(inlineTable);
  assert.equal(JSON.parse(inlineTable.getData().toString("utf8")).content, original);
  await writeFile(join(root, "full-backup.zip"), full.rawPayload);
  await writeFile(join(root, "profile.zip"), zip.rawPayload);
  await writeFile(join(root, "profile.json"), json.body);
  await roundTrip("json-restored", jsonEnvelope);
  await roundTrip("zip-restored", zip.rawPayload);
  await roundTrip("full-restored", full.rawPayload);

  const rawRoot = join(root, "raw-restored");
  const backupPrefix = rawShard.entryName.slice(0, rawShard.entryName.indexOf("/storage/") + 1);
  for (const entry of fullZip.getEntries()) {
    if (!entry.entryName.startsWith(`${backupPrefix}storage/`) || entry.isDirectory) continue;
    const parts = entry.entryName.slice(backupPrefix.length).split("/");
    assert.equal(
      parts.some((part) => part === ".." || part === "." || part.includes(":")),
      false,
    );
    const destination = join(rawRoot, ...parts);
    await mkdir(join(rawRoot, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(destination, entry.getData());
  }
  process.env.DATA_DIR = rawRoot;
  process.env.FILE_STORAGE_DIR = join(rawRoot, "storage");
  const rawRestored = await createFileNativeDB({ fileOperations: { flushDirectory: async () => undefined } });
  stores.push(rawRestored);
  assert.deepEqual(rawRestored._fileStore.getCmbOriginalState(entryId), archived);
  assert.equal(
    (await rawRestored.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId)))[0]?.content,
    original,
  );
  process.env.DATA_DIR = sourceRoot;
  process.env.FILE_STORAGE_DIR = db._fileStore.rootDir;

  await db.transaction(async () => {
    await db._fileStore.archiveCmbOriginal(entryId);
    await db._fileStore.flushStrict();
  });
  const folder = await app.inject({ method: "POST", url: "/api/backup/" });
  assert.equal(folder.statusCode, 200, folder.body);
  const folderRoot = join(sourceRoot, "backups", folder.json().backupName);
  assert.equal(
    JSON.parse(await readFile(join(folderRoot, "storage", "cmb-originals", `${archived.sha256}.json`), "utf8")),
    original,
  );
  assert.notEqual(
    typeof JSON.parse(
      await readFile(
        join(folderRoot, "storage", "tables", "lorebook_entries", `${encodeShardKey(bookId)}.json`),
        "utf8",
      ),
    )[0].content,
    "string",
  );
  const folderProfile = new AdmZip(await readFile(join(folderRoot, "marinara-profile.zip")));
  assert.equal(JSON.parse(folderProfile.readAsText("profile-tables/lorebook_entries.jsonl")).content, original);
  const savedBlob = `${blob}.preserved`;
  await rename(blob, savedBlob);
  for (const format of ["", "?format=zip"]) {
    const missing = await app.inject({ method: "GET", url: `/api/backup/export-profile${format}` });
    assert.equal(missing.statusCode, 500, "missing original fails export instead of writing a pointer or empty body");
  }
  await writeFile(blob, JSON.stringify("Corrupted synthetic original"));
  const corrupt = await app.inject({ method: "POST", url: "/api/backup/download" });
  assert.equal(corrupt.statusCode, 500, "corrupt original cannot produce a successful full backup");
  await rename(blob, `${blob}.corrupt-preserved`);
  await rename(savedBlob, blob);
  assert.equal((await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId)))[0]?.content, original);
  assert.deepEqual(db._fileStore.getCmbOriginalState(entryId), archived);
  console.log(
    `CMB archived originals survive profile/full backup round trips; race and missing/corrupt reads fail closed. Fixtures retained: ${root}`,
  );
} finally {
  for (const app of apps.reverse()) await app.close();
  for (const store of stores.reverse()) await store._fileStore.close();
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
