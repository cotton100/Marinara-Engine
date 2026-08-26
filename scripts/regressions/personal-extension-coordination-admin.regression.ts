import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import {
  characters,
  chats,
  personalExtensionCoordination,
  personalExtensionOperationJournal,
} from "../../packages/server/src/db/schema/index.js";
import { personalExtensionCoordinationRoutes } from "../../packages/server/src/routes/personal-extension-coordination.routes.js";
import { personalExtensionsRoutes } from "../../packages/server/src/routes/personal-extensions.routes.js";
import { assertCoordinationIdleForRestore } from "../../packages/server/src/routes/backup.routes.js";
import {
  PersonalExtensionCoordinationKernelError,
  PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
} from "../../packages/server/src/services/extensions/personal-extension-coordination-kernel.service.js";
import {
  createPersonalExtensionCoordinationService,
  getPersonalExtensionCoordinationService,
} from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";
import {
  createPersonalExtensionCoordinationEventService,
  type PersonalExtensionCoordinationEventService,
} from "../../packages/server/src/services/extensions/personal-extension-coordination-events.service.js";
import { createPersonalExtensionsStorage } from "../../packages/server/src/services/extensions/personal-extension-storage.service.js";
import { createAppSettingsStorage } from "../../packages/server/src/services/storage/app-settings.storage.js";
import { createLorebooksStorage } from "../../packages/server/src/services/storage/lorebooks.storage.js";

const routeSource = readFileSync(
  new URL("../../packages/server/src/routes/personal-extension-coordination.routes.ts", import.meta.url),
  "utf8",
);
assert.match(routeSource, /\/:id\/coordination\/admin\/\$\{action\}/u);
for (const action of ["activate", "deactivate", "recover-blocked"] as const) {
  assert.match(routeSource, new RegExp(`adminTransition\\("${action}"`, "u"));
}
assert.match(routeSource, /requireCoordinationAdminAccess\(request, reply/u);

const EXTENSION_ID = "cmb-admin-transition";
const BOOTSTRAP_EXTENSION_ID = "cmb-admin-empty-bootstrap";
const STALE_EXTENSION_ID = "cmb-admin-stale-transition";
const ENSEMBLE_ID = "ensemble-main";
const CHARACTER_ID = "character-alice";
const RP_CHAT_ID = "chat-rp";
const DM_CHAT_ID = "chat-dm";
const SECOND_ENSEMBLE_ID = "ensemble-second";
const SECOND_CHARACTER_ID = "character-bob";
const SECOND_RP_CHAT_ID = "chat-second-rp";
const SECOND_DM_CHAT_ID = "chat-second-dm";
const STORAGE_KEY = `extension-storage:${EXTENSION_ID}`;
const MANAGED_LOREBOOK_TAG = "convo-memory-bridge";
const POLICY_ENTRY_TAG = "convo-memory-bridge-policy";
const exactSecret = "coordination-admin-transition-secret";
const storageDir = mkdtempSync(join(tmpdir(), "marinara-coordination-admin-"));
const environmentNames = ["FILE_STORAGE_DIR", "ADMIN_SECRET", "ENABLE_EXTERNAL_EXTENSIONS"] as const;
const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
process.env.FILE_STORAGE_DIR = storageDir;
process.env.ADMIN_SECRET = exactSecret;
process.env.ENABLE_EXTERNAL_EXTENSIONS = "true";

let failStrictWrite = false;
const fileDb = await createFileNativeDB({
  fileOperations: {
    writeFile: async (...args) => {
      if (failStrictWrite) {
        failStrictWrite = false;
        throw new Error("simulated admin transition strict write failure");
      }
      return writeFile(...args);
    },
    flushDirectory: async () => {},
  },
});
const db = fileDb as unknown as DB;
const extensions = createPersonalExtensionsStorage(db);
const lorebooks = createLorebooksStorage(db);
const settings = createAppSettingsStorage(db);
const timestamp = "2026-08-16T00:00:00.000Z";
const embedding = { connectionId: "__local_sidecar__", model: "local-sidecar" };

const extension = await extensions.create(
  {
    name: "Convo Memory Bridge",
    runtime: "client",
    capabilities: ["full_page_access"],
    js: "window.__cmbAdminRegression = true;",
  },
  { id: EXTENSION_ID, source: "external" },
);
assert.ok(extension);
await extensions.approve(EXTENSION_ID, extension.contentHash);
const bootstrapExtension = await extensions.create(
  {
    name: "Convo Memory Bridge bootstrap",
    runtime: "client",
    capabilities: ["full_page_access"],
    js: "window.__cmbBootstrapRegression = true;",
  },
  { id: BOOTSTRAP_EXTENSION_ID, source: "external" },
);
assert.ok(bootstrapExtension);
await extensions.approve(BOOTSTRAP_EXTENSION_ID, bootstrapExtension.contentHash);
const staleExtension = await extensions.create(
  { name: "Stale transition fixture", runtime: "client", js: "window.__stale = true;" },
  { id: STALE_EXTENSION_ID, source: "external" },
);
assert.ok(staleExtension);

await settings.set("external-extensions-enabled", "true");
await db.insert(characters).values({
  id: CHARACTER_ID,
  data: JSON.stringify({ name: "Alice" }),
  comment: "",
  createdAt: timestamp,
  updatedAt: timestamp,
});
await db.insert(characters).values({
  id: SECOND_CHARACTER_ID,
  data: JSON.stringify({ name: "Bob" }),
  comment: "",
  createdAt: timestamp,
  updatedAt: timestamp,
});
await db.insert(characters).values({
  id: "unrelated-corrupt-character",
  data: "not-json",
  comment: "",
  createdAt: timestamp,
  updatedAt: timestamp,
});
for (const chat of [
  {
    id: RP_CHAT_ID,
    name: "RP",
    mode: "roleplay" as const,
    characterIds: JSON.stringify([CHARACTER_ID]),
    metadata: JSON.stringify({ groupChatMode: "merged" }),
  },
  {
    id: DM_CHAT_ID,
    name: "DM",
    mode: "conversation" as const,
    characterIds: JSON.stringify([CHARACTER_ID]),
    metadata: JSON.stringify({ crossChatAwareness: false }),
  },
  {
    id: SECOND_RP_CHAT_ID,
    name: "Second RP",
    mode: "roleplay" as const,
    characterIds: JSON.stringify([SECOND_CHARACTER_ID]),
    metadata: JSON.stringify({ groupChatMode: "merged" }),
  },
  {
    id: SECOND_DM_CHAT_ID,
    name: "Second DM",
    mode: "conversation" as const,
    characterIds: JSON.stringify([SECOND_CHARACTER_ID]),
    metadata: JSON.stringify({ crossChatAwareness: false }),
  },
]) {
  await db.insert(chats).values({
    ...chat,
    connectionId: "__local_sidecar__",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

const lorebook = await lorebooks.create({
  name: "CMB managed",
  tags: [MANAGED_LOREBOOK_TAG, `convo-memory-bridge-ensemble:${ENSEMBLE_ID}`],
  characterIds: [CHARACTER_ID],
  scope: { mode: "specific", chatIds: [RP_CHAT_ID, DM_CHAT_ID] },
  excludeFromVectorization: false,
});
assert.ok(lorebook);
const secondLorebook = await lorebooks.create({
  name: "CMB managed second",
  tags: [MANAGED_LOREBOOK_TAG, `convo-memory-bridge-ensemble:${SECOND_ENSEMBLE_ID}`],
  characterIds: [SECOND_CHARACTER_ID],
  scope: { mode: "specific", chatIds: [SECOND_RP_CHAT_ID, SECOND_DM_CHAT_ID] },
  excludeFromVectorization: false,
});
assert.ok(secondLorebook);

const policyMembers = [{ castId: "alice", characterId: CHARACTER_ID, displayName: "Alice" }];
const policyContent = [
  "[Character knowledge boundary]",
  "Memory labels use stable cast IDs. Current cast ID map:",
  "- alice = Alice",
  "Each recalled memory declares which stable cast IDs do not know it.",
  'A character whose cast ID is listed under "Unknown to cast IDs" must not recall, mention, react to, infer, or act on that memory unless it becomes visible in the current conversation.',
  "Other characters may use it normally.",
].join("\n");
const policyEntry = await lorebooks.createEntry({
  lorebookId: lorebook.id,
  name: "Convo Memory Bridge Cast Policy",
  description: "Stable cast-ID knowledge policy for managed memories.",
  content: policyContent,
  keys: [],
  secondaryKeys: [],
  enabled: true,
  constant: true,
  selective: false,
  characterFilterMode: "include",
  characterFilterIds: [CHARACTER_ID],
  position: 0,
  depth: 4,
  order: -1_000_000,
  role: "system",
  preventRecursion: true,
  excludeRecursion: false,
  delayUntilRecursion: false,
  locked: true,
  tag: POLICY_ENTRY_TAG,
  relationships: {},
  activationConditions: [],
  schedule: null,
  excludeFromVectorization: true,
  dynamicState: { convoMemoryBridge: { schemaVersion: 1, ensembleId: ENSEMBLE_ID, policyMembers } },
});
assert.ok(policyEntry);
const secondPolicyMembers = [{ castId: "bob", characterId: SECOND_CHARACTER_ID, displayName: "Bob" }];
const secondPolicyEntry = await lorebooks.createEntry({
  lorebookId: secondLorebook.id,
  name: "Convo Memory Bridge Cast Policy",
  description: "Stable cast-ID knowledge policy for managed memories.",
  content: [
    "[Character knowledge boundary]",
    "Memory labels use stable cast IDs. Current cast ID map:",
    "- bob = Bob",
    "Each recalled memory declares which stable cast IDs do not know it.",
    'A character whose cast ID is listed under "Unknown to cast IDs" must not recall, mention, react to, infer, or act on that memory unless it becomes visible in the current conversation.',
    "Other characters may use it normally.",
  ].join("\n"),
  keys: [],
  secondaryKeys: [],
  enabled: true,
  constant: true,
  selective: false,
  characterFilterMode: "include",
  characterFilterIds: [SECOND_CHARACTER_ID],
  position: 0,
  depth: 4,
  order: -1_000_000,
  role: "system",
  preventRecursion: true,
  excludeRecursion: false,
  delayUntilRecursion: false,
  locked: true,
  tag: POLICY_ENTRY_TAG,
  relationships: {},
  activationConditions: [],
  schedule: null,
  excludeFromVectorization: true,
  dynamicState: {
    convoMemoryBridge: {
      schemaVersion: 1,
      ensembleId: SECOND_ENSEMBLE_ID,
      policyMembers: secondPolicyMembers,
    },
  },
});
assert.ok(secondPolicyEntry);
const manualEntry = await lorebooks.createEntry({
  lorebookId: lorebook.id,
  name: "Manual memory",
  tag: MANAGED_LOREBOOK_TAG,
  dynamicState: {
    convoMemoryBridge: {
      schemaVersion: 1,
      ensembleId: ENSEMBLE_ID,
      memoryId: "manual-memory-1",
      source: { kind: "manual" },
    },
  },
});
const foreignEntry = await lorebooks.createEntry({
  lorebookId: lorebook.id,
  name: "Ordinary foreign entry",
  tag: "ordinary-user-entry",
  dynamicState: { arbitrary: true },
});
assert.ok(manualEntry && foreignEntry);

function config(manualRecoveryReasons: string[] = []) {
  return {
    schemaVersion: 1,
    ensembles: [
      {
        ensembleId: ENSEMBLE_ID,
        name: "Main ensemble",
        rpChatId: RP_CHAT_ID,
        groupConvoChatIds: [],
        lorebookId: lorebook.id,
        autoSync: true,
        embedding,
        runtime: {
          semanticStatus: "ready",
          lastSuccessfulEmbeddingProfile: embedding,
          pendingEmbeddingProfile: null,
          manualRecoveryReasons,
          lastSuccessfulSyncAt: null,
        },
        members: [{ castId: "alice", characterId: CHARACTER_ID, dmChatId: DM_CHAT_ID }],
      },
    ],
  };
}

type PreparedActivationConfigPatch = {
  autoSync?: boolean;
  semanticStatus?: string;
  lastSuccessfulEmbeddingProfile?: typeof embedding | null;
  pendingEmbeddingProfile?: typeof embedding | null;
  manualRecoveryReasons?: string[];
  includeSecondPreparedEnsemble?: boolean;
};

function preparedActivationConfig(patch: PreparedActivationConfigPatch = {}) {
  const value = config();
  const ensemble = value.ensembles[0]!;
  const preparedRuntime = {
    ...ensemble.runtime,
    semanticStatus: patch.semanticStatus ?? "pending",
    lastSuccessfulEmbeddingProfile:
      patch.lastSuccessfulEmbeddingProfile === undefined ? embedding : patch.lastSuccessfulEmbeddingProfile,
    pendingEmbeddingProfile: patch.pendingEmbeddingProfile === undefined ? embedding : patch.pendingEmbeddingProfile,
    manualRecoveryReasons: patch.manualRecoveryReasons ?? ["mutation-ambiguous", "vectorization-pending"],
  };
  return {
    ...value,
    ensembles: [
      {
        ...ensemble,
        autoSync: patch.autoSync ?? true,
        runtime: preparedRuntime,
      },
      ...(patch.includeSecondPreparedEnsemble
        ? [
            {
              ensembleId: SECOND_ENSEMBLE_ID,
              name: "Second ensemble",
              rpChatId: SECOND_RP_CHAT_ID,
              groupConvoChatIds: [],
              lorebookId: secondLorebook.id,
              autoSync: true,
              embedding,
              runtime: {
                ...preparedRuntime,
                lastSuccessfulEmbeddingProfile: null,
              },
              members: [{ castId: "bob", characterId: SECOND_CHARACTER_ID, dmChatId: SECOND_DM_CHAT_ID }],
            },
          ]
        : []),
    ],
  };
}

function secondOnlyPreparedActivationConfig() {
  const clean = config();
  const withTwoPrepared = preparedActivationConfig({ includeSecondPreparedEnsemble: true });
  return {
    ...withTwoPrepared,
    ensembles: [clean.ensembles[0]!, withTwoPrepared.ensembles[1]!],
  };
}

async function setConfigValue(value: unknown) {
  await settings.set(STORAGE_KEY, JSON.stringify({ convoMemoryBridgeV1: value }));
}

async function setConfig(manualRecoveryReasons: string[] = []) {
  await setConfigValue(config(manualRecoveryReasons));
}
await setConfig();
await fileDb._fileStore.flushStrict();

let adminEventService: PersonalExtensionCoordinationEventService;
const publishedAdminDrafts: Array<Record<string, unknown>> = [];
const coordinationRouteService = createPersonalExtensionCoordinationService(db, {
  eventPublisher: {
    publish(extensionId, draft) {
      publishedAdminDrafts.push(draft);
      return adminEventService.publish(extensionId, draft);
    },
  },
});
adminEventService = createPersonalExtensionCoordinationEventService(db, {
  coordinationService: coordinationRouteService,
  sweepIntervalMs: 0,
});

const app = Fastify();
app.decorate("db", db);
await app.register(personalExtensionsRoutes, { prefix: "/api/personal-extensions" });
await app.register(personalExtensionCoordinationRoutes, {
  prefix: "/api/personal-extensions",
  service: coordinationRouteService,
  eventService: adminEventService,
});

function adminHeaders(secret?: string) {
  return {
    host: "127.0.0.1:7860",
    origin: "http://127.0.0.1:7860",
    "sec-fetch-site": "same-origin",
    ...(secret ? { "x-admin-secret": secret } : {}),
  };
}

function adminUrl(action: "activate" | "deactivate" | "recover-blocked", extensionId: string = EXTENSION_ID) {
  return `/api/personal-extensions/${extensionId}/coordination/admin/${action}`;
}

async function coordinationRow(extensionId: string = EXTENSION_ID) {
  const rows = await db
    .select()
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, extensionId));
  return rows[0] ?? null;
}

async function expectLifecycleBlocked(label: string, mutation: () => Promise<unknown>) {
  await assert.rejects(
    mutation,
    (error) =>
      error instanceof PersonalExtensionCoordinationKernelError &&
      error.code === "coordination-transition-blocked" &&
      error.statusCode === 409,
    label,
  );
  assert.equal((await extensions.getById(EXTENSION_ID))?.enabled, true, `${label} must write nothing`);
}

try {
  await app.ready();
  const missingSecret = await app.inject({ method: "POST", url: adminUrl("activate"), headers: adminHeaders() });
  assert.equal(missingSecret.statusCode, 403, missingSecret.body);
  assert.equal(await coordinationRow(), null, "admin denial must occur before provisional activation writes");

  failStrictWrite = true;
  const emptyBootstrapStrictFailure = await app.inject({
    method: "POST",
    url: adminUrl("activate", BOOTSTRAP_EXTENSION_ID),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(emptyBootstrapStrictFailure.statusCode, 503, emptyBootstrapStrictFailure.body);
  assert.equal(emptyBootstrapStrictFailure.json().code, "coordination-unavailable");
  assert.equal(
    await settings.get(`extension-storage:${BOOTSTRAP_EXTENSION_ID}`),
    null,
    "a failed bootstrap durability barrier must roll back the synthetic empty storage row",
  );
  assert.equal(
    await coordinationRow(BOOTSTRAP_EXTENSION_ID),
    null,
    "a failed bootstrap durability barrier must not create coordination authority",
  );

  const emptyBootstrapActivation = await app.inject({
    method: "POST",
    url: adminUrl("activate", BOOTSTRAP_EXTENSION_ID),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(emptyBootstrapActivation.statusCode, 200, emptyBootstrapActivation.body);
  assert.equal(emptyBootstrapActivation.json().mode, "active");
  assert.deepEqual(
    JSON.parse((await settings.get(`extension-storage:${BOOTSTRAP_EXTENSION_ID}`)) ?? "null"),
    { convoMemoryBridgeV1: { schemaVersion: 1, ensembles: [] } },
    "a genuinely fresh extension must durably bootstrap its exact empty storage before activation",
  );
  const bootstrapRow = await coordinationRow(BOOTSTRAP_EXTENSION_ID);
  assert.ok(bootstrapRow, "empty CMB configuration must create an active coordination row");
  assert.deepEqual(JSON.parse(bootstrapRow.protectedLorebookRegistry).lorebooks, {});
  const bootstrapCoordination = getPersonalExtensionCoordinationService(db);
  const bootstrapLease = await bootstrapCoordination.acquireLease({
    extensionId: BOOTSTRAP_EXTENSION_ID,
    holderSessionId: "bootstrap-holder",
    serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
    contentHash: bootstrapExtension.contentHash,
  });
  assert.ok(bootstrapLease.fence > bootstrapRow.fence, "empty bootstrap must issue a fresh guarded-writer fence");
  const bootstrapWriterRow = await coordinationRow(BOOTSTRAP_EXTENSION_ID);
  assert.equal(bootstrapWriterRow?.fence, bootstrapLease.fence);
  assert.equal(bootstrapWriterRow?.holderSessionId, "bootstrap-holder");
  await bootstrapCoordination.releaseLease({
    extensionId: BOOTSTRAP_EXTENSION_ID,
    holderSessionId: "bootstrap-holder",
    serverBootId: bootstrapLease.serverBootId,
    contentHash: bootstrapLease.contentHash,
    fence: bootstrapLease.fence,
    leaseToken: bootstrapLease.leaseToken,
  });
  const emptyBootstrapDeactivation = await app.inject({
    method: "POST",
    url: adminUrl("deactivate", BOOTSTRAP_EXTENSION_ID),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(emptyBootstrapDeactivation.statusCode, 200, emptyBootstrapDeactivation.body);
  assert.equal((await coordinationRow(BOOTSTRAP_EXTENSION_ID))?.mode, "inactive");

  const bootstrapStorageKey = `extension-storage:${BOOTSTRAP_EXTENSION_ID}`;
  const retiredFinalDigest = "e".repeat(64);
  const retiredFinalAt = new Date().toISOString();
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: retiredFinalDigest,
    extensionId: BOOTSTRAP_EXTENSION_ID,
    targetEnsembleId: ENSEMBLE_ID,
    operationKind: "mutation",
    fence: (await coordinationRow(BOOTSTRAP_EXTENSION_ID))!.fence,
    phase: "final",
    protectedResourceRevisions: "[]",
    preparedAt: retiredFinalAt,
    dispatchingAt: retiredFinalAt,
    finalAt: retiredFinalAt,
    updatedAt: retiredFinalAt,
  });

  failStrictWrite = true;
  const failedRetirement = await app.inject({
    method: "DELETE",
    url: `/api/personal-extensions/${BOOTSTRAP_EXTENSION_ID}`,
    headers: adminHeaders(exactSecret),
  });
  assert.equal(failedRetirement.statusCode, 503, failedRetirement.body);
  assert.equal(failedRetirement.json().code, "coordination-unavailable");
  assert.ok(await extensions.getById(BOOTSTRAP_EXTENSION_ID), "failed retirement must restore the extension row");
  assert.notEqual(await settings.get(bootstrapStorageKey), null, "failed retirement must restore extension storage");
  assert.ok(await coordinationRow(BOOTSTRAP_EXTENSION_ID), "failed retirement must restore coordination authority");
  assert.equal(
    (
      await db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, retiredFinalDigest))
    ).length,
    1,
    "failed retirement must restore journal evidence",
  );

  const retired = await app.inject({
    method: "DELETE",
    url: `/api/personal-extensions/${BOOTSTRAP_EXTENSION_ID}`,
    headers: adminHeaders(exactSecret),
  });
  assert.equal(retired.statusCode, 204, retired.body);
  assert.equal(await extensions.getById(BOOTSTRAP_EXTENSION_ID), null);
  assert.equal(await settings.get(bootstrapStorageKey), null);
  assert.equal(await coordinationRow(BOOTSTRAP_EXTENSION_ID), null);
  assert.equal(
    (
      await db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.extensionId, BOOTSTRAP_EXTENSION_ID))
    ).length,
    0,
    "successful retirement must remove final journal rows",
  );
  await assertCoordinationIdleForRestore(db);

  const reinstalledBootstrapExtension = await extensions.create(
    {
      name: "Convo Memory Bridge bootstrap reinstalled",
      runtime: "client",
      capabilities: ["full_page_access"],
      js: "window.__cmbBootstrapRegressionReinstalled = true;",
    },
    { id: BOOTSTRAP_EXTENSION_ID, source: "external" },
  );
  assert.ok(reinstalledBootstrapExtension);
  await extensions.approve(BOOTSTRAP_EXTENSION_ID, reinstalledBootstrapExtension.contentHash);
  const reinstalledActivation = await app.inject({
    method: "POST",
    url: adminUrl("activate", BOOTSTRAP_EXTENSION_ID),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(reinstalledActivation.statusCode, 200, reinstalledActivation.body);
  assert.deepEqual(JSON.parse((await settings.get(bootstrapStorageKey)) ?? "null"), {
    convoMemoryBridgeV1: { schemaVersion: 1, ensembles: [] },
  });
  const reinstalledDeactivation = await app.inject({
    method: "POST",
    url: adminUrl("deactivate", BOOTSTRAP_EXTENSION_ID),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(reinstalledDeactivation.statusCode, 200, reinstalledDeactivation.body);

  const unresolvedRetirementDigest = "f".repeat(64);
  const unresolvedRetirementAt = new Date().toISOString();
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: unresolvedRetirementDigest,
    extensionId: BOOTSTRAP_EXTENSION_ID,
    targetEnsembleId: ENSEMBLE_ID,
    operationKind: "mutation",
    fence: (await coordinationRow(BOOTSTRAP_EXTENSION_ID))!.fence,
    phase: "prepared",
    protectedResourceRevisions: "[]",
    preparedAt: unresolvedRetirementAt,
    dispatchingAt: null,
    finalAt: null,
    updatedAt: unresolvedRetirementAt,
  });
  const unresolvedRetirement = await app.inject({
    method: "DELETE",
    url: `/api/personal-extensions/${BOOTSTRAP_EXTENSION_ID}`,
    headers: adminHeaders(exactSecret),
  });
  assert.equal(unresolvedRetirement.statusCode, 409, unresolvedRetirement.body);
  assert.equal(unresolvedRetirement.json().code, "operations-active");
  assert.ok(await extensions.getById(BOOTSTRAP_EXTENSION_ID), "unresolved retirement must preserve the extension");
  assert.ok(await coordinationRow(BOOTSTRAP_EXTENSION_ID), "unresolved retirement must preserve coordination state");
  await db
    .delete(personalExtensionOperationJournal)
    .where(eq(personalExtensionOperationJournal.operationDigest, unresolvedRetirementDigest));
  const retiredAfterRecovery = await app.inject({
    method: "DELETE",
    url: `/api/personal-extensions/${BOOTSTRAP_EXTENSION_ID}`,
    headers: adminHeaders(exactSecret),
  });
  assert.equal(retiredAfterRecovery.statusCode, 204, retiredAfterRecovery.body);
  await assertCoordinationIdleForRestore(db);

  failStrictWrite = true;
  const strictActivationFailure = await app.inject({
    method: "POST",
    url: adminUrl("activate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(strictActivationFailure.statusCode, 503, strictActivationFailure.body);
  assert.equal(strictActivationFailure.json().code, "coordination-unavailable");
  assert.equal(await coordinationRow(), null, "failed activating barrier must roll back its provisional row");

  for (const [label, prepared] of [
    ["same last-success profile", preparedActivationConfig()],
    [
      "null last-success profile and reversed marker order",
      preparedActivationConfig({
        lastSuccessfulEmbeddingProfile: null,
        manualRecoveryReasons: ["vectorization-pending", "mutation-ambiguous"],
      }),
    ],
    ["one prepared ensemble among multiple ensembles", secondOnlyPreparedActivationConfig()],
  ] as const) {
    await setConfigValue(prepared);
    const rawPreparedStorage = await settings.get(STORAGE_KEY);
    const preparedRevisionBefore = (await coordinationRow())?.configRevision ?? 0;
    const preparedActivation = await app.inject({
      method: "POST",
      url: adminUrl("activate"),
      headers: adminHeaders(exactSecret),
      payload: {},
    });
    assert.equal(preparedActivation.statusCode, 200, `${label}: ${preparedActivation.body}`);
    assert.equal(preparedActivation.json().mode, "active");
    assert.equal(
      (await coordinationRow())?.configRevision,
      preparedRevisionBefore,
      `${label} activation must preserve the storage revision used by browser recovery`,
    );
    assert.equal(
      await settings.get(STORAGE_KEY),
      rawPreparedStorage,
      `${label} activation must preserve the exact prepared-auto recovery evidence for the client`,
    );
    const preparedDeactivation = await app.inject({
      method: "POST",
      url: adminUrl("deactivate"),
      headers: adminHeaders(exactSecret),
      payload: {},
    });
    assert.equal(preparedDeactivation.statusCode, 200, `${label}: ${preparedDeactivation.body}`);
    assert.equal((await coordinationRow())?.mode, "inactive");
  }

  const unsafePreparedActivationFixtures: ReadonlyArray<
    readonly [string, ReturnType<typeof preparedActivationConfig>]
  > = [
    ["missing vectorization marker", preparedActivationConfig({ manualRecoveryReasons: ["mutation-ambiguous"] })],
    [
      "extra recovery marker",
      preparedActivationConfig({
        manualRecoveryReasons: ["mutation-ambiguous", "vectorization-pending", "source-read-incomplete"],
      }),
    ],
    ["auto sync disabled", preparedActivationConfig({ autoSync: false })],
    ["semantic state not pending", preparedActivationConfig({ semanticStatus: "ready" })],
    ["missing pending profile", preparedActivationConfig({ pendingEmbeddingProfile: null })],
    [
      "mismatched pending profile",
      preparedActivationConfig({
        pendingEmbeddingProfile: { connectionId: "different-connection", model: "different-model" },
      }),
    ],
    [
      "mismatched last-success profile",
      preparedActivationConfig({
        lastSuccessfulEmbeddingProfile: { connectionId: "different-connection", model: "different-model" },
      }),
    ],
    ["multiple prepared ensembles", preparedActivationConfig({ includeSecondPreparedEnsemble: true })],
  ];
  for (const [label, unsafePrepared] of unsafePreparedActivationFixtures) {
    await setConfigValue(unsafePrepared);
    const rawUnsafeStorage = await settings.get(STORAGE_KEY);
    const inactiveRowBefore = await coordinationRow();
    assert.equal(inactiveRowBefore?.mode, "inactive");
    const adminEventCountBefore = publishedAdminDrafts.length;
    const unsafeActivation = await app.inject({
      method: "POST",
      url: adminUrl("activate"),
      headers: adminHeaders(exactSecret),
      payload: {},
    });
    assert.equal(unsafeActivation.statusCode, 409, `${label}: ${unsafeActivation.body}`);
    assert.equal(unsafeActivation.json().code, "coordination-validation-failed", label);
    const inactiveRowAfter = await coordinationRow();
    assert.equal(inactiveRowAfter?.mode, "inactive", `${label} must roll back the activation barrier`);
    assert.equal(inactiveRowAfter?.fence, inactiveRowBefore?.fence, `${label} must preserve the writer fence`);
    assert.equal(
      inactiveRowAfter?.configRevision,
      inactiveRowBefore?.configRevision,
      `${label} must preserve the storage revision`,
    );
    assert.equal(
      inactiveRowAfter?.protectedLorebookRegistry,
      inactiveRowBefore?.protectedLorebookRegistry,
      `${label} must preserve the protected-resource registry`,
    );
    assert.equal(await settings.get(STORAGE_KEY), rawUnsafeStorage, `${label} rejection must preserve storage`);
    assert.equal(publishedAdminDrafts.length, adminEventCountBefore, `${label} must not publish an admin event`);
  }
  await setConfig();

  const activated = await app.inject({
    method: "POST",
    url: adminUrl("activate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal(activated.json().mode, "active");
  assert.equal((await coordinationRow())?.mode, "active");
  assert.deepEqual(publishedAdminDrafts.at(-1), { type: "lease-changed" });
  const transitionEvents: Array<Record<string, unknown>> = [];
  const transitionSubscription = await adminEventService.subscribe(
    { extensionId: EXTENSION_ID, deviceSessionId: "10000000-0000-4000-8000-000000000031" },
    {
      send(event) {
        transitionEvents.push(event);
      },
      close() {},
    },
  );
  assert.ok(await lorebooks.getEntry(manualEntry.id), "manual CMB memories must survive activation");
  assert.ok(await lorebooks.getEntry(foreignEntry.id), "ordinary foreign entries must survive activation");

  let removeSideEffect = false;
  await expectLifecycleBlocked("update", () => extensions.update(EXTENSION_ID, { description: "must not update" }));
  await expectLifecycleBlocked("approve", () => extensions.approve(EXTENSION_ID, extension.contentHash));
  await expectLifecycleBlocked("disable", () => extensions.disable(EXTENSION_ID));
  await expectLifecycleBlocked("disableExternal", () => extensions.disableExternal());
  await expectLifecycleBlocked("rollback", () => extensions.rollback(EXTENSION_ID, "missing-revision"));
  await expectLifecycleBlocked("remove", () =>
    extensions.remove(EXTENSION_ID, async () => {
      removeSideEffect = true;
    }),
  );
  assert.equal(removeSideEffect, false, "remove side effects must run only after lifecycle admission");
  for (const mode of ["activating", "draining-deactivate", "restoring", "blocked"] as const) {
    await db
      .update(personalExtensionCoordination)
      .set({ mode, updatedAt: new Date().toISOString() })
      .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
    await expectLifecycleBlocked(`${mode} lifecycle`, () => extensions.disable(EXTENSION_ID));
  }
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "active", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));

  const policyBefore = await settings.get("external-extensions-enabled");
  const policyBlocked = await app.inject({
    method: "PATCH",
    url: "/api/personal-extensions/policy/external",
    headers: adminHeaders(),
    payload: { enabled: false },
  });
  assert.equal(policyBlocked.statusCode, 409, policyBlocked.body);
  assert.equal(policyBlocked.json().code, "coordination-transition-blocked");
  assert.equal(
    await settings.get("external-extensions-enabled"),
    policyBefore,
    "policy must not flip before disable admission",
  );

  const coordination = getPersonalExtensionCoordinationService(db);
  const lease = await coordination.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "admin-regression-holder",
    serverBootId: PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
    contentHash: extension.contentHash,
  });
  const operation = await coordination.beginOperation({
    extensionId: EXTENSION_ID,
    holderSessionId: "admin-regression-holder",
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    kind: "mutation",
    targetEnsembleId: ENSEMBLE_ID,
  });
  const operationBlocked = await app.inject({
    method: "POST",
    url: adminUrl("deactivate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(operationBlocked.statusCode, 409, operationBlocked.body);
  assert.equal(operationBlocked.json().code, "operations-active");
  assert.equal((await coordinationRow())?.mode, "active");
  await coordination.endOperation({
    extensionId: EXTENSION_ID,
    holderSessionId: "admin-regression-holder",
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
    operationHandle: operation.operationHandle,
    disposition: "aborted",
  });
  await coordination.releaseLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "admin-regression-holder",
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
  });

  const unresolvedTransitionDigest = "a".repeat(64);
  const unresolvedTransitionAt = new Date().toISOString();
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: unresolvedTransitionDigest,
    extensionId: EXTENSION_ID,
    targetEnsembleId: ENSEMBLE_ID,
    operationKind: "mutation",
    fence: (await coordinationRow())!.fence,
    phase: "dispatching",
    protectedResourceRevisions: "[]",
    preparedAt: unresolvedTransitionAt,
    dispatchingAt: unresolvedTransitionAt,
    finalAt: null,
    updatedAt: unresolvedTransitionAt,
  });
  const unresolvedDeactivate = await app.inject({
    method: "POST",
    url: adminUrl("deactivate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(unresolvedDeactivate.statusCode, 409, unresolvedDeactivate.body);
  assert.equal(unresolvedDeactivate.json().code, "operations-active");
  assert.equal((await coordinationRow())?.mode, "active", "an unresolved journal must keep legacy ingress closed");

  await db
    .update(personalExtensionCoordination)
    .set({ mode: "inactive", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const unresolvedActivation = await app.inject({
    method: "POST",
    url: adminUrl("activate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(unresolvedActivation.statusCode, 409, unresolvedActivation.body);
  assert.equal(unresolvedActivation.json().code, "operations-active");
  assert.equal((await coordinationRow())?.mode, "inactive", "activation must not discard unresolved evidence");
  await db
    .delete(personalExtensionOperationJournal)
    .where(eq(personalExtensionOperationJournal.operationDigest, unresolvedTransitionDigest));
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "active", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));

  await db
    .update(personalExtensionCoordination)
    .set({
      handoffRequestId: "handoff-pending",
      handoffRequester: "other-device",
      handoffDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const handoffBlocked = await app.inject({
    method: "POST",
    url: adminUrl("deactivate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(handoffBlocked.statusCode, 409, handoffBlocked.body);
  assert.equal(handoffBlocked.json().code, "handoff-pending");
  await db
    .update(personalExtensionCoordination)
    .set({ handoffRequestId: null, handoffRequester: null, handoffDeadlineAt: null })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));

  const eventsBeforeStrictDeactivateFailure = transitionEvents.length;
  failStrictWrite = true;
  const strictDeactivateFailure = await app.inject({
    method: "POST",
    url: adminUrl("deactivate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(strictDeactivateFailure.statusCode, 503, strictDeactivateFailure.body);
  assert.equal(strictDeactivateFailure.json().code, "coordination-unavailable");
  assert.equal((await coordinationRow())?.mode, "active", "failed draining barrier must leave active mode intact");
  assert.equal(
    transitionEvents.length,
    eventsBeforeStrictDeactivateFailure,
    "failed admin transitions must publish no lease event",
  );

  const fenceBeforeDeactivate = (await coordinationRow())!.fence;
  const deactivated = await app.inject({
    method: "POST",
    url: adminUrl("deactivate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(deactivated.statusCode, 200, deactivated.body);
  assert.equal(deactivated.json().mode, "inactive");
  assert.equal((await coordinationRow())?.fence, fenceBeforeDeactivate + 1);
  assert.deepEqual(publishedAdminDrafts.at(-1), { type: "lease-changed" });
  assert.equal(transitionEvents.at(-1)?.type, "lease-changed", "active subscribers must observe deactivation");

  const originalTransaction = db.transaction.bind(db);
  let armRollbackFailure = true;
  (db as DB & { transaction: typeof db.transaction }).transaction = (async (
    ...args: Parameters<typeof db.transaction>
  ) => {
    try {
      return await originalTransaction(...args);
    } catch (error) {
      if (
        armRollbackFailure &&
        error instanceof PersonalExtensionCoordinationKernelError &&
        error.code === "coordination-validation-failed"
      ) {
        armRollbackFailure = false;
        failStrictWrite = true;
      }
      throw error;
    }
  }) as typeof db.transaction;
  await db
    .update(characters)
    .set({ data: JSON.stringify({}) })
    .where(eq(characters.id, CHARACTER_ID));
  const rollbackFailure = await app.inject({
    method: "POST",
    url: adminUrl("activate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(rollbackFailure.statusCode, 409, rollbackFailure.body);
  assert.equal(rollbackFailure.json().code, "coordination-validation-failed");
  assert.equal(armRollbackFailure, false, "validation failure must arm the rollback durability fault");
  assert.equal((await coordinationRow())?.mode, "blocked", "failed inactive rollback must close into blocked mode");
  (db as DB & { transaction: typeof db.transaction }).transaction = originalTransaction;
  await db
    .update(characters)
    .set({ data: JSON.stringify({ name: "Alice" }) })
    .where(eq(characters.id, CHARACTER_ID));
  const rollbackRecovered = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(rollbackRecovered.statusCode, 200, rollbackRecovered.body);
  assert.equal(rollbackRecovered.json().mode, "inactive");
  assert.deepEqual(publishedAdminDrafts.at(-1), { type: "lease-changed" });

  let injectSnapshotDrift = true;
  (db as DB & { transaction: typeof db.transaction }).transaction = (async (
    ...args: Parameters<typeof db.transaction>
  ) => {
    const result = await originalTransaction(...args);
    if (injectSnapshotDrift) {
      injectSnapshotDrift = false;
      const drifted = config();
      drifted.ensembles[0]!.name = "Changed after the activation snapshot";
      await settings.set(STORAGE_KEY, JSON.stringify({ convoMemoryBridgeV1: drifted }));
    }
    return result;
  }) as typeof db.transaction;
  const snapshotDrift = await app.inject({
    method: "POST",
    url: adminUrl("activate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(snapshotDrift.statusCode, 409, snapshotDrift.body);
  assert.equal(snapshotDrift.json().code, "coordination-validation-failed");
  assert.equal((await coordinationRow())?.mode, "inactive");
  assert.match((await settings.get(STORAGE_KEY)) ?? "", /Changed after the activation snapshot/u);
  (db as DB & { transaction: typeof db.transaction }).transaction = originalTransaction;
  await setConfig();

  const ambiguous = await lorebooks.createEntry({
    lorebookId: lorebook.id,
    name: "Ambiguous owned entry",
    tag: MANAGED_LOREBOOK_TAG,
    dynamicState: {},
  });
  assert.ok(ambiguous);
  const ambiguousActivation = await app.inject({
    method: "POST",
    url: adminUrl("activate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(ambiguousActivation.statusCode, 409, ambiguousActivation.body);
  assert.equal(ambiguousActivation.json().code, "coordination-validation-failed");
  assert.equal((await coordinationRow())?.mode, "inactive", "failed validation must roll provisional state back");
  assert.ok(await lorebooks.getEntry(ambiguous.id), "failed activation must not clean up ambiguous user data");
  await lorebooks.removeEntry(ambiguous.id);

  await lorebooks.updateEntry(policyEntry.id, { content: "stale policy body" });
  const policyMismatchActivation = await app.inject({
    method: "POST",
    url: adminUrl("activate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(policyMismatchActivation.statusCode, 409, policyMismatchActivation.body);
  assert.equal(policyMismatchActivation.json().code, "coordination-validation-failed");
  assert.equal((await coordinationRow())?.mode, "inactive");
  await lorebooks.updateEntry(policyEntry.id, { content: policyContent });

  await db
    .update(characters)
    .set({
      data: JSON.stringify({
        name: "Alice",
        extensions: { importMetadata: { embeddedLorebook: { lorebookId: lorebook.id } } },
      }),
    })
    .where(eq(characters.id, CHARACTER_ID));
  const embeddedActivation = await app.inject({
    method: "POST",
    url: adminUrl("activate"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(embeddedActivation.statusCode, 409, embeddedActivation.body);
  assert.equal(embeddedActivation.json().code, "coordination-validation-failed");
  assert.equal((await coordinationRow())?.mode, "inactive");
  await db
    .update(characters)
    .set({ data: JSON.stringify({ name: "Alice" }) })
    .where(eq(characters.id, CHARACTER_ID));

  await setConfig(["mutation-ambiguous"]);
  const beforeRecoveryRaw = await settings.get(STORAGE_KEY);
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "blocked", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const fenceBeforeRecovery = (await coordinationRow())!.fence;
  const draftsBeforeStrictRecoveryFailure = publishedAdminDrafts.length;
  failStrictWrite = true;
  const strictRecoveryFailure = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(strictRecoveryFailure.statusCode, 503, strictRecoveryFailure.body);
  assert.equal(strictRecoveryFailure.json().code, "coordination-unavailable");
  assert.equal((await coordinationRow())?.mode, "blocked", "failed recovery barrier must preserve blocked mode");
  assert.equal(await settings.get(STORAGE_KEY), beforeRecoveryRaw);
  assert.equal(
    publishedAdminDrafts.length,
    draftsBeforeStrictRecoveryFailure,
    "failed recovery must publish no lease event",
  );

  const recovered = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().mode, "inactive");
  assert.equal((await coordinationRow())?.fence, fenceBeforeRecovery + 1);
  assert.equal(await settings.get(STORAGE_KEY), beforeRecoveryRaw, "recover-blocked must preserve recovery markers");
  assert.deepEqual(publishedAdminDrafts.at(-1), { type: "lease-changed" });

  await setConfig();
  const safePreparedDigest = "b".repeat(64);
  const safePreparedAt = new Date().toISOString();
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "blocked", updatedAt: safePreparedAt })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const safePreparedFence = (await coordinationRow())!.fence;
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: safePreparedDigest,
    extensionId: EXTENSION_ID,
    targetEnsembleId: ENSEMBLE_ID,
    operationKind: "mutation",
    fence: safePreparedFence,
    phase: "prepared",
    protectedResourceRevisions: "[]",
    preparedAt: safePreparedAt,
    dispatchingAt: null,
    finalAt: null,
    updatedAt: safePreparedAt,
  });
  await fileDb._fileStore.flushStrict();
  failStrictWrite = true;
  const safePreparedStrictFailure = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(safePreparedStrictFailure.statusCode, 503, safePreparedStrictFailure.body);
  assert.equal(safePreparedStrictFailure.json().code, "coordination-unavailable");
  assert.equal((await coordinationRow())?.mode, "blocked");
  assert.equal(
    (
      await db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, safePreparedDigest))
    ).length,
    1,
    "a failed recovery flush must roll back safe journal cleanup",
  );
  const safePreparedRecovered = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(safePreparedRecovered.statusCode, 200, safePreparedRecovered.body);
  assert.equal(safePreparedRecovered.json().mode, "inactive");
  assert.equal((await coordinationRow())?.fence, safePreparedFence + 1);
  assert.equal(
    (
      await db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, safePreparedDigest))
    ).length,
    0,
    "recover-blocked may close only a prepared journal proving marker and dispatch count zero",
  );

  await setConfig(["mutation-ambiguous"]);
  const unsafeDispatchDigest = "c".repeat(64);
  const unsafeDispatchAt = new Date().toISOString();
  const unsafeFence = (await coordinationRow())!.fence;
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "blocked", updatedAt: unsafeDispatchAt })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: unsafeDispatchDigest,
    extensionId: EXTENSION_ID,
    targetEnsembleId: ENSEMBLE_ID,
    operationKind: "mutation",
    fence: unsafeFence,
    phase: "dispatching",
    protectedResourceRevisions: JSON.stringify([
      {
        kind: "extension-storage",
        resourceId: EXTENSION_ID,
        presence: "present",
        resourceRevision: (await coordinationRow())!.configRevision,
      },
    ]),
    preparedAt: unsafeDispatchAt,
    dispatchingAt: unsafeDispatchAt,
    finalAt: null,
    updatedAt: unsafeDispatchAt,
  });
  await fileDb._fileStore.flushStrict();
  const markerBeforeDispatchRecovery = await settings.get(STORAGE_KEY);
  const unsafeRecovery = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(unsafeRecovery.statusCode, 200, unsafeRecovery.body);
  assert.equal(unsafeRecovery.json().mode, "inactive");
  assert.equal(
    (
      await db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, unsafeDispatchDigest))
    ).length,
    0,
    "an exact CMB mutation-ambiguous marker must authorize journal cleanup",
  );
  assert.equal(
    await settings.get(STORAGE_KEY),
    markerBeforeDispatchRecovery,
    "dispatching recovery must preserve the manual mutation-ambiguous marker",
  );

  const supersededBase = (await coordinationRow())!;
  const supersededRegistry = JSON.parse(supersededBase.protectedLorebookRegistry) as {
    version: number;
    extensionStorage: { resourceRevision: number };
    lorebooks: Record<string, { resourceRevision: number }>;
  };
  const supersededJournalStorageRevision = supersededBase.configRevision;
  const supersededJournalLorebookRevision = supersededRegistry.lorebooks[lorebook.id]!.resourceRevision;
  const supersededCurrentRevision = supersededJournalStorageRevision + 2;
  const supersededCurrentLorebookRevision = supersededJournalLorebookRevision + 44;
  supersededRegistry.extensionStorage.resourceRevision = supersededCurrentRevision;
  supersededRegistry.lorebooks[lorebook.id]!.resourceRevision = supersededCurrentLorebookRevision;
  const supersededJournalAt = "2026-08-22T18:35:44.448Z";
  const supersededSuccessfulAt = "2026-08-22T18:37:52.923Z";
  const supersededConfig = config();
  supersededConfig.ensembles[0]!.runtime.lastSuccessfulSyncAt = supersededSuccessfulAt;
  await setConfigValue(supersededConfig);
  const supersededBlockedFence = supersededBase.fence + 2;
  await db
    .update(personalExtensionCoordination)
    .set({
      mode: "blocked",
      fence: supersededBlockedFence,
      configRevision: supersededCurrentRevision,
      protectedLorebookRegistry: JSON.stringify(supersededRegistry),
      updatedAt: supersededSuccessfulAt,
    })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const supersededDigest = "e".repeat(64);
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: supersededDigest,
    extensionId: EXTENSION_ID,
    targetEnsembleId: ENSEMBLE_ID,
    operationKind: "mutation",
    fence: supersededBase.fence,
    phase: "dispatching",
    protectedResourceRevisions: JSON.stringify([
      {
        kind: "extension-storage",
        resourceId: EXTENSION_ID,
        presence: "present",
        resourceRevision: supersededJournalStorageRevision,
      },
      {
        kind: "lorebook",
        resourceId: lorebook.id,
        presence: "present",
        resourceRevision: supersededJournalLorebookRevision,
      },
    ]),
    preparedAt: supersededJournalAt,
    dispatchingAt: supersededJournalAt,
    finalAt: null,
    updatedAt: supersededJournalAt,
  });
  await fileDb._fileStore.flushStrict();
  const supersededStorageBeforeRecovery = await settings.get(STORAGE_KEY);
  const supersededRecovery = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(supersededRecovery.statusCode, 200, supersededRecovery.body);
  assert.equal(supersededRecovery.json().mode, "inactive");
  assert.equal((await coordinationRow())?.fence, supersededBlockedFence + 1);
  assert.equal(
    (
      await db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, supersededDigest))
    ).length,
    0,
    "a later fully-ready protected state must supersede its single stale dispatching journal",
  );
  assert.equal(
    await settings.get(STORAGE_KEY),
    supersededStorageBeforeRecovery,
    "superseded recovery must not rewrite current CMB storage",
  );

  const missingSuccessDigest = "f".repeat(64);
  const missingSuccessFence = (await coordinationRow())!.fence + 1;
  await setConfig();
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "blocked", fence: missingSuccessFence, updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: missingSuccessDigest,
    extensionId: EXTENSION_ID,
    targetEnsembleId: ENSEMBLE_ID,
    operationKind: "mutation",
    fence: missingSuccessFence - 1,
    phase: "dispatching",
    protectedResourceRevisions: JSON.stringify([
      {
        kind: "extension-storage",
        resourceId: EXTENSION_ID,
        presence: "present",
        resourceRevision: supersededCurrentRevision - 1,
      },
      {
        kind: "lorebook",
        resourceId: lorebook.id,
        presence: "present",
        resourceRevision: supersededCurrentLorebookRevision - 1,
      },
    ]),
    preparedAt: supersededJournalAt,
    dispatchingAt: supersededJournalAt,
    finalAt: null,
    updatedAt: supersededJournalAt,
  });
  const missingSuccessRecovery = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(missingSuccessRecovery.statusCode, 409, missingSuccessRecovery.body);
  assert.equal(missingSuccessRecovery.json().code, "coordination-validation-failed");
  assert.equal((await coordinationRow())?.mode, "blocked");
  assert.equal(
    (
      await db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, missingSuccessDigest))
    ).length,
    1,
    "a later revision without a later successful-sync proof must remain blocked",
  );
  await db
    .delete(personalExtensionOperationJournal)
    .where(eq(personalExtensionOperationJournal.operationDigest, missingSuccessDigest));
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "inactive", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));

  await setConfig();
  const missingMarkerDigest = "d".repeat(64);
  const missingMarkerAt = new Date().toISOString();
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "blocked", updatedAt: missingMarkerAt })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await db.insert(personalExtensionOperationJournal).values({
    operationDigest: missingMarkerDigest,
    extensionId: EXTENSION_ID,
    targetEnsembleId: ENSEMBLE_ID,
    operationKind: "mutation",
    fence: (await coordinationRow())!.fence,
    phase: "dispatching",
    protectedResourceRevisions: JSON.stringify([
      {
        kind: "extension-storage",
        resourceId: EXTENSION_ID,
        presence: "present",
        resourceRevision: (await coordinationRow())!.configRevision,
      },
    ]),
    preparedAt: missingMarkerAt,
    dispatchingAt: missingMarkerAt,
    finalAt: null,
    updatedAt: missingMarkerAt,
  });
  const missingMarkerRecovery = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(missingMarkerRecovery.statusCode, 409, missingMarkerRecovery.body);
  assert.equal(missingMarkerRecovery.json().code, "coordination-validation-failed");
  assert.equal((await coordinationRow())?.mode, "blocked");
  assert.equal(
    (
      await db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, missingMarkerDigest))
    ).length,
    1,
    "a missing marker must preserve the blocked journal",
  );

  await settings.set(STORAGE_KEY, "{malformed-cmb-storage");
  const malformedMarkerRecovery = await app.inject({
    method: "POST",
    url: adminUrl("recover-blocked"),
    headers: adminHeaders(exactSecret),
    payload: {},
  });
  assert.equal(malformedMarkerRecovery.statusCode, 409, malformedMarkerRecovery.body);
  assert.equal(malformedMarkerRecovery.json().code, "coordination-validation-failed");
  assert.equal((await coordinationRow())?.mode, "blocked", "malformed marker evidence must fail closed");
  await db
    .delete(personalExtensionOperationJournal)
    .where(eq(personalExtensionOperationJournal.operationDigest, missingMarkerDigest));
  await setConfig();
  await db
    .update(personalExtensionCoordination)
    .set({ mode: "inactive", updatedAt: new Date().toISOString() })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  transitionSubscription.close();

  await db.insert(personalExtensionCoordination).values({
    extensionId: STALE_EXTENSION_ID,
    contentHash: staleExtension.contentHash,
    mode: "restoring",
    serverBootId: "previous-process-boot",
    fence: 9,
    leaseTokenDigest: "a".repeat(64),
    holderSessionId: "stale-holder",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    handoffRequestId: "stale-handoff",
    handoffRequester: "stale-requester",
    handoffDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    protectedLorebookRegistry: JSON.stringify({
      version: 1,
      extensionStorage: { resourceRevision: 0 },
      lorebooks: {},
    }),
    activeOperations: "[]",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const startupService = createPersonalExtensionCoordinationService(db, { serverBootId: "fresh-process-boot" });
  failStrictWrite = true;
  await assert.rejects(
    startupService.recoverStaleTransitions(),
    (error) => error instanceof PersonalExtensionCoordinationKernelError && error.code === "coordination-unavailable",
  );
  const stillTransitional = await db
    .select()
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, STALE_EXTENSION_ID));
  assert.equal(stillTransitional[0]?.mode, "restoring", "failed startup barrier must remain fail-closed");
  assert.equal(stillTransitional[0]?.serverBootId, "previous-process-boot");
  assert.deepEqual(await startupService.recoverStaleTransitions(), { blocked: 1 });
  const staleRows = await db
    .select()
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, STALE_EXTENSION_ID));
  assert.equal(staleRows[0]?.mode, "blocked");
  assert.equal(staleRows[0]?.serverBootId, "fresh-process-boot");
  assert.equal(staleRows[0]?.fence, 10);
  assert.equal(staleRows[0]?.leaseTokenDigest, null);
  assert.equal(staleRows[0]?.holderSessionId, null);
  assert.equal(staleRows[0]?.handoffRequestId, null);
  assert.equal(staleRows[0]?.activeOperations, "[]");
} finally {
  await app.close();
  for (const name of environmentNames) {
    const previous = previousEnvironment.get(name);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  rmSync(storageDir, { recursive: true, force: true });
}

console.info("Personal extension coordination admin regression passed.");
