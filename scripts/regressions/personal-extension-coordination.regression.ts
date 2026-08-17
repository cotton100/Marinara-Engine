import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB, FILE_BACKED_TABLES } from "../../packages/server/src/db/file-backed-store.js";
import { getFileTableConfig } from "../../packages/server/src/db/file-schema.js";
import {
  installedExtensions,
  personalExtensionCoordination,
  personalExtensionOperationJournal,
} from "../../packages/server/src/db/schema/index.js";
import {
  filterProfileFileBackedTables,
  PROFILE_FILE_BACKED_TABLES,
} from "../../packages/server/src/routes/backup.routes.js";
import {
  createPersonalExtensionCoordinationService,
  PersonalExtensionCoordinationUnavailableError,
  PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
} from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";

function coordinationRow(mode: "inactive" | "active" | "blocked") {
  return {
    extensionId: "approved-extension",
    contentHash: "persisted-content-hash",
    mode,
  };
}

function coordinationTestDb(row: ReturnType<typeof coordinationRow>) {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where: async () =>
              table === personalExtensionCoordination
                ? [row]
                : [{ contentHash: "approved-content-hash", approvedHash: "approved-content-hash" }],
          };
        },
      };
    },
  } as unknown as DB;
}

const schemaConfig = getFileTableConfig(personalExtensionCoordination);
assert.equal(schemaConfig.name, "personal_extension_coordination");
assert.equal(schemaConfig.columns.find((column) => column.key === "extensionId")?.primary, true);
assert.equal(schemaConfig.columns.find((column) => column.key === "mode")?.defaultValue, "inactive");
assert.equal(schemaConfig.columns.find((column) => column.key === "fence")?.defaultValue, 0);
assert.equal(schemaConfig.columns.find((column) => column.key === "configRevision")?.defaultValue, 0);
assert.equal(schemaConfig.columns.find((column) => column.key === "protectedLorebookRegistry")?.defaultValue, "{}");
assert.equal(schemaConfig.columns.find((column) => column.key === "activeOperations")?.defaultValue, "[]");
const journalSchemaConfig = getFileTableConfig(personalExtensionOperationJournal);
assert.equal(journalSchemaConfig.name, "personal_extension_operation_journal");
assert.equal(journalSchemaConfig.columns.find((column) => column.key === "operationDigest")?.primary, true);
assert.equal(journalSchemaConfig.columns.find((column) => column.key === "targetEnsembleId")?.isNotNull, true);
assert.equal(
  journalSchemaConfig.columns.find((column) => column.key === "protectedResourceRevisions")?.defaultValue,
  "[]",
);

const storageDir = mkdtempSync(join(tmpdir(), "marinara-personal-extension-coordination-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;
try {
  const fileDb = await createFileNativeDB();
  const db = fileDb as unknown as DB;
  const service = createPersonalExtensionCoordinationService(db, { serverBootId: "coordination-test-boot" });

  const missing = await service.getInactiveState("missing-extension");
  assert.deepEqual(missing, {
    schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
    extensionId: "missing-extension",
    serverBootId: "coordination-test-boot",
    contentHash: "",
    mode: "inactive",
    coordinationActive: false,
    capabilities: [],
  });
  assert.equal(await service.getPersistedRow("missing-extension"), null);
  assert.equal(
    Object.keys(service).join(","),
    "getPersistedRow,getState,getInactiveState,acquireLease,requestHandoff,renewLease,releaseLease,beginOperation,endOperation,activateCoordination,deactivateCoordination,recoverBlockedCoordination,recoverStaleTransitions,runLegacyInactiveMutation,runFencedResourceMutation,runFencedResourceRead,runFencedOperationRead,runFencedLorebookRegistryTransition",
  );
  for (const forbiddenApi of ["activate", "deactivate", "handoff"]) {
    assert.equal(forbiddenApi in service, false);
  }

  const timestamp = new Date(0).toISOString();
  await db.insert(installedExtensions).values({
    id: "approved-extension",
    name: "Approved extension",
    description: "Regression fixture",
    runtime: "client",
    capabilities: "[]",
    enabled: "true",
    contentHash: "approved-content-hash",
    approvedHash: "approved-content-hash",
    source: "local",
    revisions: "[]",
    installedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const approved = await service.getInactiveState("approved-extension");
  assert.equal(approved.contentHash, "approved-content-hash");
  assert.equal(approved.mode, "inactive");
  assert.equal(approved.coordinationActive, false);
  assert.deepEqual(approved.capabilities, []);

  assert.deepEqual(await db.select().from(personalExtensionCoordination), []);
  await db.insert(personalExtensionCoordination).values({
    extensionId: "approved-extension",
    contentHash: "historical-content-hash",
    mode: "inactive",
    serverBootId: "historical-boot",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await fileDb._fileStore.flush();
  await fileDb._fileStore.close();

  const reopened = await createFileNativeDB();
  const reopenedService = createPersonalExtensionCoordinationService(reopened as unknown as DB, {
    serverBootId: "reopened-boot",
  });
  assert.equal((await reopenedService.getPersistedRow("approved-extension"))?.mode, "inactive");
  assert.equal(
    (await reopenedService.getInactiveState("approved-extension")).contentHash,
    "approved-content-hash",
    "the current approved extension hash must override a historical coordination-row hash",
  );
  await reopened._fileStore.close();
} finally {
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}

const inactivePersistedService = createPersonalExtensionCoordinationService(
  coordinationTestDb(coordinationRow("inactive")),
  { serverBootId: "persisted-inactive-boot" },
);
assert.equal((await inactivePersistedService.getPersistedRow("approved-extension"))?.mode, "inactive");
const inactivePersisted = await inactivePersistedService.getInactiveState("approved-extension");
assert.equal(inactivePersisted.mode, "inactive");
assert.equal(inactivePersisted.coordinationActive, false);
assert.equal(inactivePersisted.contentHash, "approved-content-hash");

const defaultBootStateA = await createPersonalExtensionCoordinationService(
  coordinationTestDb(coordinationRow("inactive")),
).getInactiveState("approved-extension");
const defaultBootStateB = await createPersonalExtensionCoordinationService(
  coordinationTestDb(coordinationRow("inactive")),
).getInactiveState("approved-extension");
assert.equal(
  defaultBootStateA.serverBootId,
  defaultBootStateB.serverBootId,
  "the default boot ID must be process-stable",
);

for (const mode of ["active", "blocked"] as const) {
  const service = createPersonalExtensionCoordinationService(coordinationTestDb(coordinationRow(mode)));
  await assert.rejects(service.getInactiveState("approved-extension"), (error) => {
    assert.ok(error instanceof PersonalExtensionCoordinationUnavailableError);
    assert.equal(error.code, "coordination-unavailable");
    return true;
  });
}

const futureRegistry = filterProfileFileBackedTables([
  "app_settings",
  "personal_extension_coordination",
  "personal_extension_operation_journal",
  "installed_extensions",
] as const);
assert.deepEqual(futureRegistry, ["app_settings", "installed_extensions"]);
assert.equal((FILE_BACKED_TABLES as readonly string[]).includes("personal_extension_coordination"), true);
assert.equal((FILE_BACKED_TABLES as readonly string[]).includes("personal_extension_operation_journal"), true);
assert.equal((PROFILE_FILE_BACKED_TABLES as readonly string[]).includes("personal_extension_coordination"), false);
assert.equal((PROFILE_FILE_BACKED_TABLES as readonly string[]).includes("personal_extension_operation_journal"), false);

console.info("Personal extension coordination inactive-only regression passed.");
