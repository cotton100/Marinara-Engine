import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../packages/server/src/db/file-query.js";
import { fileTable, isFileUniqueConstraintError, text } from "../../packages/server/src/db/file-schema.js";
import {
  createFileNativeDB,
  FileNativeStrictDurabilityUnsupportedError,
} from "../../packages/server/src/db/file-backed-store.js";
import { closeDB, flushDBStrict, isDBStrictDurabilitySupported } from "../../packages/server/src/db/connection.js";
import { appSettings, customStickers, noodleInteractions } from "../../packages/server/src/db/schema/index.js";
import { createAppSettingsStorage } from "../../packages/server/src/services/storage/app-settings.storage.js";

async function fsyncTestFile(path: string) {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const storageDir = mkdtempSync(join(tmpdir(), "marinara-file-close-"));
process.env.FILE_STORAGE_DIR = storageDir;

let releaseWrite!: () => void;
const writeGate = new Promise<void>((resolve) => {
  releaseWrite = resolve;
});
let capturedWrite!: () => void;
const writeCaptured = new Promise<void>((resolve) => {
  capturedWrite = resolve;
});
let blockedFirstSettingsWrite = false;

try {
  const db = await createFileNativeDB({
    beforeTableWrite: async (table) => {
      if (table !== "app_settings" || blockedFirstSettingsWrite) return;
      blockedFirstSettingsWrite = true;
      capturedWrite();
      await writeGate;
    },
  });

  await db.insert(appSettings).values({ key: "before-active-flush", value: "one", updatedAt: "2026-07-14" });
  const activeFlush = db._fileStore.flush();
  await writeCaptured;

  await db.insert(appSettings).values({ key: "queued-during-flush", value: "two", updatedAt: "2026-07-14" });
  let closeResolved = false;
  const close = db._fileStore.close().then(() => {
    closeResolved = true;
  });
  await Promise.resolve();
  assert.equal(closeResolved, false, "close must wait for the active table write");

  releaseWrite();
  await Promise.all([activeFlush, close]);

  const persisted = JSON.parse(readFileSync(join(storageDir, "tables", "app_settings.json"), "utf8")) as Array<{
    key: string;
  }>;
  assert.deepEqual(persisted.map((row) => row.key).sort(), ["before-active-flush", "queued-during-flush"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(storageDir, "tables")).mode & 0o777, 0o700);
    assert.equal(statSync(join(storageDir, "tables", "app_settings.json")).mode & 0o777, 0o600);
  }
  console.info("File-backed graceful shutdown regression passed.");
} finally {
  releaseWrite();
  rmSync(storageDir, { recursive: true, force: true });
}

const malformedRowStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-malformed-row-"));
process.env.FILE_STORAGE_DIR = malformedRowStorageDir;
try {
  const tablesDir = join(malformedRowStorageDir, "tables");
  const settingsPath = join(tablesDir, "app_settings.json");
  const originalRows = [{ key: "valid-setting", value: "preserved", updatedAt: "2026-08-01" }, null, "invalid", 42, []];
  mkdirSync(tablesDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(originalRows));
  if (process.platform !== "win32") {
    chmodSync(malformedRowStorageDir, 0o755);
    chmodSync(tablesDir, 0o755);
    chmodSync(settingsPath, 0o644);
  }

  const db = await createFileNativeDB();
  if (process.platform !== "win32") {
    assert.equal(statSync(malformedRowStorageDir).mode & 0o777, 0o700);
    assert.equal(statSync(tablesDir).mode & 0o777, 0o700);
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  }
  const rows = await db.select().from(appSettings);
  assert.deepEqual(rows, [{ key: "valid-setting", value: "preserved", updatedAt: "2026-08-01" }]);

  const quarantined = db._fileStore.getQuarantinedTables().find((entry) => entry.table === "app_settings");
  assert.equal(quarantined?.files.length, 1);
  const preservedPath = quarantined?.files[0]?.to;
  assert.ok(preservedPath);
  assert.deepEqual(JSON.parse(readFileSync(preservedPath, "utf8")), originalRows);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), [originalRows[0]]);

  await db._fileStore.close();
  console.info("File-backed malformed-row recovery regression passed.");
} finally {
  rmSync(malformedRowStorageDir, { recursive: true, force: true });
}

const failingStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-close-failure-"));
process.env.FILE_STORAGE_DIR = failingStorageDir;
try {
  const expectedFailure = new Error("simulated persistent write failure");
  const db = await createFileNativeDB({
    beforeTableWrite: (table) => {
      if (table === "app_settings") throw expectedFailure;
    },
  });
  await db.insert(appSettings).values({ key: "must-report-failure", value: "one", updatedAt: "2026-07-14" });
  await assert.rejects(db._fileStore.close(), expectedFailure);
} finally {
  rmSync(failingStorageDir, { recursive: true, force: true });
}

const transactionStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-transaction-"));
process.env.FILE_STORAGE_DIR = transactionStorageDir;
try {
  const db = await createFileNativeDB();
  await db.insert(appSettings).values({ key: "transaction-value", value: "live", updatedAt: "2026-07-16" });
  await db._fileStore.flush();

  let releaseTransaction!: () => void;
  const transactionGate = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let transactionStarted!: () => void;
  const transactionReady = new Promise<void>((resolve) => {
    transactionStarted = resolve;
  });
  const failedTransaction = db.transaction(async (tx) => {
    await tx.update(appSettings).set({ value: "imported" }).where(eq(appSettings.key, "transaction-value"));
    await db._fileStore.flush();
    transactionStarted();
    await transactionGate;
    throw new Error("simulated profile asset promotion failure");
  });
  await transactionReady;

  let outsideWriteFinished = false;
  const outsideWrite = db
    .insert(appSettings)
    .values({ key: "outside-write", value: "preserved", updatedAt: "2026-07-16" })
    .then(() => {
      outsideWriteFinished = true;
    });
  await Promise.resolve();
  assert.equal(outsideWriteFinished, false, "non-transaction writes must wait for the active transaction");

  releaseTransaction();
  await assert.rejects(failedTransaction, /simulated profile asset promotion failure/u);
  await outsideWrite;
  await db._fileStore.flush();

  const rows = await db.select().from(appSettings);
  assert.equal(rows.find((row) => row.key === "transaction-value")?.value, "live");
  assert.equal(rows.find((row) => row.key === "outside-write")?.value, "preserved");
  const persistedRows = JSON.parse(
    readFileSync(join(transactionStorageDir, "tables", "app_settings.json"), "utf8"),
  ) as Array<{ key: string; value: string }>;
  assert.equal(persistedRows.find((row) => row.key === "transaction-value")?.value, "live");
  assert.equal(persistedRows.find((row) => row.key === "outside-write")?.value, "preserved");
  await db._fileStore.close();
  console.info("File-backed serialized durable transaction regression passed.");
} finally {
  rmSync(transactionStorageDir, { recursive: true, force: true });
}

const transactionFlushFailureDir = mkdtempSync(join(tmpdir(), "marinara-file-transaction-flush-failure-"));
process.env.FILE_STORAGE_DIR = transactionFlushFailureDir;
let rejectNextTransactionWrite = false;
try {
  const expectedFailure = new Error("simulated transaction flush failure");
  const db = await createFileNativeDB({
    beforeTableWrite: (table) => {
      if (table !== "app_settings" || !rejectNextTransactionWrite) return;
      rejectNextTransactionWrite = false;
      throw expectedFailure;
    },
  });
  await db.insert(appSettings).values({ key: "flush-rollback", value: "live", updatedAt: "2026-07-16" });
  await db._fileStore.flush();

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.update(appSettings).set({ value: "imported" }).where(eq(appSettings.key, "flush-rollback"));
      rejectNextTransactionWrite = true;
      await db._fileStore.flush();
    }),
    expectedFailure,
  );

  const rows = await db.select().from(appSettings);
  assert.equal(rows.find((row) => row.key === "flush-rollback")?.value, "live");
  const persistedRows = JSON.parse(
    readFileSync(join(transactionFlushFailureDir, "tables", "app_settings.json"), "utf8"),
  ) as Array<{ key: string; value: string }>;
  assert.equal(persistedRows.find((row) => row.key === "flush-rollback")?.value, "live");
  await db._fileStore.close();
  console.info("File-backed failed transaction flush rollback regression passed.");
} finally {
  rmSync(transactionFlushFailureDir, { recursive: true, force: true });
}

const packagedSchemaStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-package-schema-"));
process.env.FILE_STORAGE_DIR = packagedSchemaStorageDir;
try {
  // Capability bundles contain their own file-table instances. Their table
  // and column objects have different identities even though they target the
  // same registered Engine tables.
  const packagedChats = fileTable("chats", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    mode: text("mode").notNull(),
    characterIds: text("character_ids").notNull().default("[]"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  });
  const packagedCallSessions = fileTable("conversation_call_sessions", {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    status: text("status").notNull(),
    mode: text("mode").notNull().default("audio"),
    initiator: text("initiator").notNull(),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  });

  const db = await createFileNativeDB();
  await db.insert(packagedChats).values({
    id: "package-chat",
    name: "Package Schema Chat",
    mode: "conversation",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  });
  await db.insert(packagedCallSessions).values({
    id: "package-call",
    chatId: "package-chat",
    status: "active",
    initiator: "user",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  });
  const calls = await db
    .select({ id: packagedCallSessions.id, chatId: packagedCallSessions.chatId })
    .from(packagedCallSessions)
    .where(eq(packagedCallSessions.chatId, "package-chat"));
  assert.deepEqual(calls, [{ id: "package-call", chatId: "package-chat" }]);
  await db._fileStore.close();
  console.info("File-backed capability schema identity regression passed.");
} finally {
  rmSync(packagedSchemaStorageDir, { recursive: true, force: true });
}

const uniqueStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-unique-"));
process.env.FILE_STORAGE_DIR = uniqueStorageDir;
try {
  const db = await createFileNativeDB();
  const stickerBase = {
    filePath: "sticker.webp",
    width: 64,
    height: 64,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
  await db.insert(customStickers).values({ id: "sticker-one", name: "same_name", ...stickerBase });
  await assert.rejects(
    db.insert(customStickers).values({ id: "sticker-two", name: "same_name", ...stickerBase }),
    (error) => isFileUniqueConstraintError(error, "custom_stickers", ["name"]),
  );
  await db.insert(customStickers).values({ id: "sticker-two", name: "other_name", ...stickerBase });
  await assert.rejects(
    db.update(customStickers).set({ name: "same_name" }).where(eq(customStickers.id, "sticker-two")),
    (error) => isFileUniqueConstraintError(error, "custom_stickers", ["name"]),
  );
  const unchangedSticker = await db
    .select({ name: customStickers.name })
    .from(customStickers)
    .where(eq(customStickers.id, "sticker-two"));
  assert.deepEqual(unchangedSticker, [{ name: "other_name" }]);

  const interactionBase = {
    postId: "post-one",
    parentInteractionId: null,
    actorAccountId: "actor-one",
    content: null,
    imageUrl: null,
    actorSnapshot: "{}",
    createdAt: "2026-07-15T00:00:00.000Z",
  };
  await db.insert(noodleInteractions).values({ id: "like-one", type: "like", ...interactionBase });
  await assert.rejects(
    db.insert(noodleInteractions).values({ id: "like-two", type: "like", ...interactionBase }),
    (error) =>
      isFileUniqueConstraintError(error, "noodle_interactions", [
        "postId",
        "actorAccountId",
        "type",
        "parentInteractionId",
      ]),
  );
  await db.insert(noodleInteractions).values({ id: "reply-one", type: "reply", ...interactionBase });
  await db.insert(noodleInteractions).values({ id: "reply-two", type: "reply", ...interactionBase });

  await db._fileStore.close();
  console.info("File-backed unique-key regression passed.");
} finally {
  rmSync(uniqueStorageDir, { recursive: true, force: true });
}

const unsupportedStrictStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-strict-unsupported-"));
process.env.FILE_STORAGE_DIR = unsupportedStrictStorageDir;
try {
  const db = await createFileNativeDB();
  await db.insert(appSettings).values({ key: "strict-platform", value: "pending", updatedAt: "2026-08-15" });

  if (process.platform === "win32") {
    assert.equal(db._fileStore.isStrictDurabilitySupported(), false);
    await assert.rejects(
      db._fileStore.flushStrict(),
      (error) =>
        error instanceof FileNativeStrictDurabilityUnsupportedError &&
        error.code === "FILE_STORAGE_STRICT_DURABILITY_UNSUPPORTED",
    );
    assert.equal(
      existsSync(join(unsupportedStrictStorageDir, "tables", "app_settings.json")),
      false,
      "unsupported strict flush must fail before it writes any snapshot",
    );
    await db._fileStore.flush();
  } else {
    assert.equal(db._fileStore.isStrictDurabilitySupported(), true);
    await db._fileStore.flushStrict();
  }

  const rows = JSON.parse(
    readFileSync(join(unsupportedStrictStorageDir, "tables", "app_settings.json"), "utf8"),
  ) as Array<{ key: string }>;
  assert.equal(
    rows.some((row) => row.key === "strict-platform"),
    true,
  );
  await db._fileStore.close();
  console.info("File-backed strict durability platform capability regression passed.");
} finally {
  rmSync(unsupportedStrictStorageDir, { recursive: true, force: true });
}

type StrictFailureOperation = "writeFile" | "rename" | "flushFile" | "flushDirectory";

for (const operation of ["writeFile", "rename", "flushFile", "flushDirectory"] as const) {
  const strictFailureStorageDir = mkdtempSync(join(tmpdir(), `marinara-file-strict-${operation}-`));
  process.env.FILE_STORAGE_DIR = strictFailureStorageDir;
  const expectedFailure = new Error(`simulated strict ${operation} failure`);
  let failingOperation: StrictFailureOperation | null = null;
  try {
    const db = await createFileNativeDB({
      fileOperations: {
        writeFile: async (path, content) => {
          if (failingOperation === "writeFile") throw expectedFailure;
          await writeFile(path, content);
        },
        rename: async (from, to) => {
          if (failingOperation === "rename") throw expectedFailure;
          await rename(from, to);
        },
        flushFile: async (path) => {
          if (failingOperation === "flushFile") throw expectedFailure;
          await fsyncTestFile(path);
        },
        // Supplying this hook models a runtime with a real directory-fsync
        // implementation while keeping the regression portable on Windows.
        flushDirectory: async () => {
          if (failingOperation === "flushDirectory") throw expectedFailure;
        },
      },
    });
    assert.equal(db._fileStore.isStrictDurabilitySupported(), true);
    await db.insert(appSettings).values({
      key: `strict-${operation}`,
      value: "baseline",
      updatedAt: "2026-08-15",
    });
    await db._fileStore.flushStrict();
    await db
      .update(appSettings)
      .set({ value: "retry-me" })
      .where(eq(appSettings.key, `strict-${operation}`));
    failingOperation = operation;
    await assert.rejects(db._fileStore.flushStrict(), (error) => error === expectedFailure);

    failingOperation = null;
    await db._fileStore.flushStrict();
    const rows = JSON.parse(
      readFileSync(join(strictFailureStorageDir, "tables", "app_settings.json"), "utf8"),
    ) as Array<{ key: string; value: string }>;
    assert.equal(
      rows.find((row) => row.key === `strict-${operation}`)?.value,
      "retry-me",
      `${operation} failure must retain dirty state for a later strict retry`,
    );
    await db._fileStore.close();
  } finally {
    failingOperation = null;
    rmSync(strictFailureStorageDir, { recursive: true, force: true });
  }
}
console.info("File-backed strict durability operation failure regressions passed.");

const bestEffortCompatibilityDir = mkdtempSync(join(tmpdir(), "marinara-file-best-effort-fsync-"));
process.env.FILE_STORAGE_DIR = bestEffortCompatibilityDir;
let rejectBestEffortSync = true;
let appSettingsWrites = 0;
try {
  const db = await createFileNativeDB({
    fileOperations: {
      writeFile: async (path, content) => {
        if (path.includes("app_settings.json.tmp-")) appSettingsWrites++;
        await writeFile(path, content);
      },
      flushFile: async (path) => {
        if (rejectBestEffortSync && path.includes("app_settings.json.tmp-")) {
          throw new Error("simulated best-effort file fsync failure");
        }
        await fsyncTestFile(path);
      },
      flushDirectory: async () => {
        if (rejectBestEffortSync) throw new Error("simulated best-effort directory fsync failure");
      },
    },
  });
  await db.insert(appSettings).values({ key: "best-effort-compatible", value: "one", updatedAt: "2026-08-15" });
  await db._fileStore.flush();
  const writesAfterBestEffortFlush = appSettingsWrites;
  assert.equal(writesAfterBestEffortFlush, 1);

  rejectBestEffortSync = false;
  await db._fileStore.flushStrict();
  assert.equal(
    appSettingsWrites,
    writesAfterBestEffortFlush + 1,
    "strict flush must rewrite data whose prior best-effort fsync was not proven",
  );
  const rows = JSON.parse(
    readFileSync(join(bestEffortCompatibilityDir, "tables", "app_settings.json"), "utf8"),
  ) as Array<{ key: string }>;
  assert.equal(
    rows.some((row) => row.key === "best-effort-compatible"),
    true,
  );
  await db._fileStore.close();
  console.info("File-backed best-effort fsync compatibility regression passed.");
} finally {
  rejectBestEffortSync = false;
  rmSync(bestEffortCompatibilityDir, { recursive: true, force: true });
}

const strictRollbackStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-strict-rollback-"));
process.env.FILE_STORAGE_DIR = strictRollbackStorageDir;
let rejectStrictRollbackWrite = false;
try {
  const rollbackFlushFailure = new Error("simulated strict rollback write failure");
  const transactionFailure = new Error("simulated failure after strict transaction flush");
  const db = await createFileNativeDB({
    fileOperations: {
      writeFile: async (path, content) => {
        if (rejectStrictRollbackWrite) throw rollbackFlushFailure;
        await writeFile(path, content);
      },
      flushDirectory: async () => {},
    },
  });
  await db.insert(appSettings).values({ key: "strict-rollback", value: "live", updatedAt: "2026-08-15" });
  await db._fileStore.flushStrict();

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.update(appSettings).set({ value: "temporary" }).where(eq(appSettings.key, "strict-rollback"));
      await tx._fileStore.flushStrict();
      rejectStrictRollbackWrite = true;
      throw transactionFailure;
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(transactionFailure) &&
      error.errors.includes(rollbackFlushFailure),
  );

  const restoredRows = await db.select().from(appSettings).where(eq(appSettings.key, "strict-rollback"));
  assert.equal(restoredRows[0]?.value, "live", "failed durable rollback must still restore the in-memory snapshot");
  rejectStrictRollbackWrite = false;
  await db._fileStore.flushStrict();
  const persistedRows = JSON.parse(
    readFileSync(join(strictRollbackStorageDir, "tables", "app_settings.json"), "utf8"),
  ) as Array<{ key: string; value: string }>;
  assert.equal(persistedRows.find((row) => row.key === "strict-rollback")?.value, "live");
  await db._fileStore.close();
  console.info("File-backed strict transaction rollback recovery regression passed.");
} finally {
  rejectStrictRollbackWrite = false;
  rmSync(strictRollbackStorageDir, { recursive: true, force: true });
}

const exclusiveReadBarrierStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-exclusive-read-barrier-"));
process.env.FILE_STORAGE_DIR = exclusiveReadBarrierStorageDir;
let pauseExistingSettingRead = false;
let releaseExistingSettingRead!: () => void;
const existingSettingReadRelease = new Promise<void>((resolve) => {
  releaseExistingSettingRead = resolve;
});
let existingSettingReadEntered!: () => void;
const existingSettingReadEntry = new Promise<void>((resolve) => {
  existingSettingReadEntered = resolve;
});
try {
  const db = await createFileNativeDB({
    afterTableRead: async (table) => {
      if (table !== "app_settings" || !pauseExistingSettingRead) return;
      pauseExistingSettingRead = false;
      existingSettingReadEntered();
      await existingSettingReadRelease;
    },
    fileOperations: { flushDirectory: async () => {} },
  });
  const settings = createAppSettingsStorage(db as never);
  const transactionFailure = new Error("simulated restore data-phase rollback");
  let releaseDataPhase!: () => void;
  const dataPhaseRelease = new Promise<void>((resolve) => {
    releaseDataPhase = resolve;
  });
  let dataPhaseEntered!: () => void;
  const dataPhaseEntry = new Promise<void>((resolve) => {
    dataPhaseEntered = resolve;
  });

  const restore = db._fileStore.runExclusiveTransactions(async () => {
    await db.transaction(async (tx) => {
      await tx.insert(appSettings).values({
        key: "exclusive-read-branch",
        value: "transient-backup",
        updatedAt: "2026-08-16",
      });
      dataPhaseEntered();
      await dataPhaseRelease;
      throw transactionFailure;
    });
  });
  await dataPhaseEntry;

  let externalWriteSettled = false;
  const externalWrite = settings.set("exclusive-read-branch", "user-write").finally(() => {
    externalWriteSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    externalWriteSettled,
    false,
    "an external read-then-write must not branch on transient rows from an exclusive restore sequence",
  );

  releaseDataPhase();
  await assert.rejects(restore, (error) => error === transactionFailure);
  await externalWrite;
  assert.equal(
    await settings.get("exclusive-read-branch"),
    "user-write",
    "the external writer must re-read after rollback and insert its value",
  );

  await settings.set("exclusive-existing-branch", "live");
  pauseExistingSettingRead = true;
  const existingSettingWrite = settings.set("exclusive-existing-branch", "user-write");
  await existingSettingReadEntry;

  let exclusiveEnteredBeforeReadWriteFinished = false;
  const deleteExistingSetting = db._fileStore.runExclusiveTransactions(async () => {
    exclusiveEnteredBeforeReadWriteFinished = true;
    await db.transaction(async (tx) => {
      await tx.delete(appSettings).where(eq(appSettings.key, "exclusive-existing-branch"));
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const exclusiveOvertookReadWrite = exclusiveEnteredBeforeReadWriteFinished;
  releaseExistingSettingRead();
  await Promise.all([existingSettingWrite, deleteExistingSetting]);
  assert.equal(
    exclusiveOvertookReadWrite,
    false,
    "an exclusive restore must not overtake a read-modify-write after it has read an existing row",
  );
  assert.equal(
    await settings.get("exclusive-existing-branch"),
    null,
    "the later exclusive delete must run after the complete setting write",
  );

  await settings.set("exclusive-active-transaction", "live");
  let releaseActiveTransaction!: () => void;
  const activeTransactionRelease = new Promise<void>((resolve) => {
    releaseActiveTransaction = resolve;
  });
  let activeTransactionEntered!: () => void;
  const activeTransactionEntry = new Promise<void>((resolve) => {
    activeTransactionEntered = resolve;
  });
  const activeTransaction = db.transaction(async (tx) => {
    activeTransactionEntered();
    await activeTransactionRelease;
    const rows = await tx.select().from(appSettings).where(eq(appSettings.key, "exclusive-active-transaction"));
    assert.equal(rows[0]?.value, "live");
    await tx
      .update(appSettings)
      .set({ value: "transaction-finished" })
      .where(eq(appSettings.key, "exclusive-active-transaction"));
  });
  await activeTransactionEntry;
  const queuedExclusive = db._fileStore.runExclusiveTransactions(async () => undefined);
  releaseActiveTransaction();
  await Promise.race([
    Promise.all([activeTransaction, queuedExclusive]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("an active transaction deadlocked with a queued exclusive sequence")), 1_000),
    ),
  ]);

  const fifoOrder: string[] = [];
  let releaseFirstExclusive!: () => void;
  const firstExclusiveRelease = new Promise<void>((resolve) => {
    releaseFirstExclusive = resolve;
  });
  let firstExclusiveEntered!: () => void;
  const firstExclusiveEntry = new Promise<void>((resolve) => {
    firstExclusiveEntered = resolve;
  });
  const firstExclusive = db._fileStore.runExclusiveTransactions(async () => {
    fifoOrder.push("exclusive-1-start");
    firstExclusiveEntered();
    await firstExclusiveRelease;
    fifoOrder.push("exclusive-1-end");
  });
  await firstExclusiveEntry;
  const queuedTransaction = db.transaction(async (tx) => {
    await tx.insert(appSettings).values({
      key: "exclusive-fifo-transaction",
      value: "committed",
      updatedAt: "2026-08-16",
    });
    fifoOrder.push("transaction");
  });
  const secondExclusive = db._fileStore.runExclusiveTransactions(async () => {
    fifoOrder.push("exclusive-2");
  });
  releaseFirstExclusive();
  await Promise.race([
    Promise.all([firstExclusive, queuedTransaction, secondExclusive]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("exclusive/transaction FIFO queue deadlocked")), 1_000),
    ),
  ]);
  assert.deepEqual(fifoOrder, ["exclusive-1-start", "exclusive-1-end", "transaction", "exclusive-2"]);

  await db._fileStore.close();
  console.info("File-backed exclusive read/write admission regression passed.");
} finally {
  releaseExistingSettingRead();
  rmSync(exclusiveReadBarrierStorageDir, { recursive: true, force: true });
}

const strictConnectionStorageDir = mkdtempSync(join(tmpdir(), "marinara-file-strict-connection-"));
process.env.FILE_STORAGE_DIR = strictConnectionStorageDir;
try {
  const supported = await isDBStrictDurabilitySupported();
  assert.equal(supported, process.platform !== "win32");
  if (supported) {
    await flushDBStrict();
  } else {
    await assert.rejects(flushDBStrict(), FileNativeStrictDurabilityUnsupportedError);
  }
  console.info("File-backed strict connection export regression passed.");
} finally {
  await closeDB();
  rmSync(strictConnectionStorageDir, { recursive: true, force: true });
}
