// ──────────────────────────────────────────────
// File Storage Connection
// ──────────────────────────────────────────────
import { logger } from "../lib/logger.js";
import { createFileNativeDB, type FileNativeDB, type FileNativeStoreController } from "./file-backed-store.js";

type DbCleanup = () => void | Promise<void>;

let dbPromise: Promise<DB> | null = null;
let dbCleanup: DbCleanup | null = null;
let fileStore: FileNativeStoreController | null = null;

async function createStorage(): Promise<DB> {
  const db = await createFileNativeDB();
  fileStore = db._fileStore;
  dbCleanup = async () => {
    await fileStore?.close();
    fileStore = null;
  };
  return db;
}

export async function getDB() {
  if (!dbPromise) {
    dbPromise = createStorage();
  }
  return dbPromise;
}

export async function flushDB() {
  await fileStore?.flush();
}

/**
 * Coordination-critical durability barrier. Unlike the legacy best-effort
 * flush, this initializes storage if necessary and rejects when the runtime
 * cannot prove file and directory fsync completion.
 */
export async function flushDBStrict() {
  const db = await getDB();
  await db._fileStore.flushStrict();
}

export async function isDBStrictDurabilitySupported() {
  const db = await getDB();
  return db._fileStore.isStrictDurabilitySupported();
}

export async function closeDB() {
  const activePromise = dbPromise;
  if (!activePromise) {
    return;
  }

  dbPromise = null;

  try {
    await activePromise;
  } catch (err) {
    logger.error(err, "[db] Failed to initialize database before shutdown");
    dbCleanup = null;
    return;
  }

  const cleanup = dbCleanup;
  dbCleanup = null;
  if (!cleanup) {
    return;
  }

  try {
    await cleanup();
  } catch (err) {
    logger.error(err, "[db] Failed to close database");
  }
}

export type DB = FileNativeDB;
