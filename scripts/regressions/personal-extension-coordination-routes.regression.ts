import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import {
  PERSONAL_EXTENSION_COORDINATION_CAPABILITIES,
  PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER,
  PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS,
  PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
  personalExtensionCoordinationErrorResponseSchema,
  personalExtensionCoordinationHandoffResponseSchema,
  personalExtensionCoordinationLeaseGrantSchema,
  personalExtensionCoordinationLeaseStateSchema,
  personalExtensionCoordinationOperationEndResponseSchema,
  personalExtensionCoordinationOperationGrantSchema,
  personalExtensionCoordinationReleaseResponseSchema,
  personalExtensionCoordinationStateSchema,
} from "../../packages/shared/src/schemas/personal-extension-coordination.schema.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { installedExtensions, personalExtensionCoordination } from "../../packages/server/src/db/schema/index.js";
import { csrfProtectionHook } from "../../packages/server/src/middleware/csrf-protection.js";
import { personalExtensionCoordinationRoutes } from "../../packages/server/src/routes/personal-extension-coordination.routes.js";
import {
  createPersonalExtensionCoordinationService,
  getPersonalExtensionCoordinationService,
} from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";

const ACTIVE_EXTENSION_ID = "coordination-route-active";
const INACTIVE_EXTENSION_ID = "coordination-route-inactive";
const UNKNOWN_EXTENSION_ID = "coordination-route-unknown";
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const INACTIVE_CONTENT_HASH = `sha256:${"b".repeat(64)}`;
const SERVER_BOOT_ID = "coordination-route-boot";
const HOLDER_A = "coordination-route-holder-a";
const HOLDER_B = "coordination-route-holder-b";
const START_WALL_MS = Date.parse("2026-08-16T00:00:00.000Z");

assert.equal(
  PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS["coordination-required"],
  428,
  "legacy protected writes must use the closed 428 coordination-required contract",
);
assert.equal(PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS["storage-revision-conflict"], 409);

const storageDir = mkdtempSync(join(tmpdir(), "marinara-coordination-routes-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;

let tableWrites = 0;
let monotonicMs = 10_000;
let wallMs = START_WALL_MS;
let tokenSequence = 0;
const logs: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, callback) {
    logs.push(String(chunk));
    callback();
  },
});

const fileDb = await createFileNativeDB({
  beforeTableWrite: () => {
    tableWrites += 1;
  },
  fileOperations: {
    writeFile,
    // Model a runtime with directory fsync so the HTTP surface can exercise
    // the strict kernel portably on Windows.
    flushDirectory: async () => {},
  },
});
const db = fileDb as unknown as DB;
const timestamp = new Date(wallMs).toISOString();

for (const extension of [
  { id: ACTIVE_EXTENSION_ID, name: "Active coordination route fixture", contentHash: CONTENT_HASH },
  { id: INACTIVE_EXTENSION_ID, name: "Inactive coordination route fixture", contentHash: INACTIVE_CONTENT_HASH },
]) {
  await db.insert(installedExtensions).values({
    id: extension.id,
    name: extension.name,
    description: "Regression fixture",
    runtime: "client",
    capabilities: "[]",
    enabled: "true",
    contentHash: extension.contentHash,
    approvedHash: extension.contentHash,
    source: "local",
    revisions: "[]",
    installedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}
await db.insert(personalExtensionCoordination).values({
  extensionId: ACTIVE_EXTENSION_ID,
  contentHash: CONTENT_HASH,
  mode: "active",
  serverBootId: SERVER_BOOT_ID,
  activeOperations: "[]",
  createdAt: timestamp,
  updatedAt: timestamp,
});
await fileDb._fileStore.flushStrict();
tableWrites = 0;

const service = createPersonalExtensionCoordinationService(db, {
  serverBootId: SERVER_BOOT_ID,
  monotonicNow: () => monotonicMs,
  wallNow: () => wallMs,
  randomToken: () => `route-raw-credential-${++tokenSequence}`,
});

assert.equal(
  getPersonalExtensionCoordinationService(db),
  getPersonalExtensionCoordinationService(db),
  "the app-wide service/kernel facade must be a singleton for one database",
);

const app = Fastify({ logger: { level: "trace", stream: logStream } });
app.decorate("db", db);
app.addHook("onRequest", csrfProtectionHook);
await app.register(personalExtensionCoordinationRoutes, {
  prefix: "/api/personal-extensions",
  service,
});

function routeUrl(extensionId: string, suffix = "") {
  return `/api/personal-extensions/${extensionId}/coordination${suffix}`;
}

function headers(holder?: string, origin = "http://127.0.0.1:7860") {
  return {
    host: "127.0.0.1:7860",
    origin,
    "sec-fetch-site": origin === "http://127.0.0.1:7860" ? "same-origin" : "cross-site",
    ...(holder ? { [PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER]: holder } : {}),
  };
}

function acquirePayload(contentHash = CONTENT_HASH, serverBootId = SERVER_BOOT_ID) {
  return { serverBootId, contentHash };
}

function authorityPayload(lease: { leaseToken: string; serverBootId: string; contentHash: string; fence: number }) {
  return {
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
  };
}

async function coordinationRow() {
  const rows = await db
    .select()
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, ACTIVE_EXTENSION_ID));
  assert.ok(rows[0]);
  return rows[0];
}

async function expectError(options: Parameters<typeof app.inject>[0], status: number, code: string) {
  const response = await app.inject(options);
  assert.equal(response.statusCode, status, response.body);
  const body = personalExtensionCoordinationErrorResponseSchema.parse(response.json());
  assert.equal(body.code, code);
  return response;
}

try {
  await app.ready();

  const writesBeforeInactiveState = tableWrites;
  const inactiveResponse = await app.inject({ method: "GET", url: routeUrl(INACTIVE_EXTENSION_ID) });
  assert.equal(inactiveResponse.statusCode, 200);
  assert.deepEqual(personalExtensionCoordinationStateSchema.parse(inactiveResponse.json()), {
    schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
    extensionId: INACTIVE_EXTENSION_ID,
    serverBootId: SERVER_BOOT_ID,
    contentHash: INACTIVE_CONTENT_HASH,
    mode: "inactive",
    coordinationActive: false,
    capabilities: [],
    role: "follower",
    fence: 0,
    remainingMs: 0,
  });
  assert.equal(tableWrites, writesBeforeInactiveState, "inactive GET must not write storage");
  assert.deepEqual(
    await db
      .select()
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, INACTIVE_EXTENSION_ID)),
    [],
    "inactive GET must not lazily create a coordination row",
  );

  const writesBeforeUnknown = tableWrites;
  await expectError({ method: "GET", url: routeUrl(UNKNOWN_EXTENSION_ID) }, 404, "personal-extension-not-found");
  await expectError(
    {
      method: "POST",
      url: routeUrl(UNKNOWN_EXTENSION_ID, "/lease/acquire"),
      headers: headers(HOLDER_A),
      payload: acquirePayload(),
    },
    404,
    "personal-extension-not-found",
  );
  assert.equal(tableWrites, writesBeforeUnknown, "unknown-extension requests must mutate nothing");

  const followerBeforeAcquire = personalExtensionCoordinationStateSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: routeUrl(ACTIVE_EXTENSION_ID),
        headers: headers(HOLDER_A),
      })
    ).json(),
  );
  assert.equal(followerBeforeAcquire.mode, "active");
  assert.equal(followerBeforeAcquire.role, "follower");
  assert.equal(followerBeforeAcquire.remainingMs, 0);
  assert.deepEqual(followerBeforeAcquire.capabilities, PERSONAL_EXTENSION_COORDINATION_CAPABILITIES);

  const crossSiteWrites = tableWrites;
  const crossSite = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
    headers: headers(HOLDER_A, "https://attacker.invalid"),
    payload: acquirePayload(),
  });
  assert.equal(crossSite.statusCode, 403, "the app-wide CSRF hook must run before coordination mutations");
  assert.equal(tableWrites, crossSiteWrites);

  const malformedWrites = tableWrites;
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
      headers: headers(HOLDER_A),
      payload: { ...acquirePayload(), unexpected: true },
    },
    400,
    "invalid-request",
  );
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
      headers: headers(),
      payload: acquirePayload(),
    },
    400,
    "invalid-request",
  );
  await expectError(
    {
      method: "GET",
      url: `${routeUrl(ACTIVE_EXTENSION_ID)}?holderSessionId=query-is-not-authority`,
      headers: headers(HOLDER_A),
    },
    400,
    "invalid-request",
  );
  assert.equal(tableWrites, malformedWrites, "malformed requests must be rejected before mutation");

  const mismatchRow = await coordinationRow();
  const mismatchWrites = tableWrites;
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
      headers: headers(HOLDER_A),
      payload: acquirePayload(`sha256:${"c".repeat(64)}`),
    },
    412,
    "extension-runtime-changed",
  );
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
      headers: headers(HOLDER_A),
      payload: acquirePayload(CONTENT_HASH, "stale-server-boot"),
    },
    409,
    "lease-lost",
  );
  assert.deepEqual(await coordinationRow(), mismatchRow);
  assert.equal(tableWrites, mismatchWrites, "hash/boot mismatches must mutate nothing");

  const originalStrictCapability = fileDb._fileStore.isStrictDurabilitySupported;
  try {
    fileDb._fileStore.isStrictDurabilitySupported = () => false;
    const unavailableRow = await coordinationRow();
    const unavailableWrites = tableWrites;
    await expectError(
      {
        method: "POST",
        url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
        headers: headers(HOLDER_A),
        payload: acquirePayload(),
      },
      503,
      "coordination-unavailable",
    );
    assert.deepEqual(await coordinationRow(), unavailableRow);
    assert.equal(tableWrites, unavailableWrites, "strict-unavailable authority must mutate nothing");
  } finally {
    fileDb._fileStore.isStrictDurabilitySupported = originalStrictCapability;
  }

  const acquireResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
    headers: headers(HOLDER_A),
    payload: acquirePayload(),
  });
  assert.equal(acquireResponse.statusCode, 200, acquireResponse.body);
  const lease = personalExtensionCoordinationLeaseGrantSchema.parse(acquireResponse.json());
  assert.equal(lease.fence, 1);
  assert.equal(lease.remainingMs, 45_000);

  const staleTokenRow = await coordinationRow();
  const staleTokenWrites = tableWrites;
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/renew"),
      headers: headers(HOLDER_A),
      payload: { ...authorityPayload(lease), leaseToken: "stale-route-token-credential" },
    },
    409,
    "lease-lost",
  );
  assert.deepEqual(await coordinationRow(), staleTokenRow);
  assert.equal(tableWrites, staleTokenWrites, "a stale token with the current fence must mutate nothing");

  monotonicMs += 1_250;
  wallMs += 1_250;
  const writerState = personalExtensionCoordinationStateSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: routeUrl(ACTIVE_EXTENSION_ID),
        headers: headers(HOLDER_A),
      })
    ).json(),
  );
  const followerState = personalExtensionCoordinationStateSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: routeUrl(ACTIVE_EXTENSION_ID),
        headers: headers(HOLDER_B),
      })
    ).json(),
  );
  assert.equal(writerState.role, "writer");
  assert.equal(followerState.role, "follower");
  assert.equal(writerState.remainingMs, 43_750);
  assert.equal(followerState.remainingMs, 43_750);
  assert.equal("leaseToken" in writerState, false);
  assert.equal("holderSessionId" in writerState, false);

  const renewResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/renew"),
    headers: headers(HOLDER_A),
    payload: authorityPayload(lease),
  });
  assert.equal(renewResponse.statusCode, 200, renewResponse.body);
  const renewed = personalExtensionCoordinationLeaseStateSchema.parse(renewResponse.json());
  assert.equal(renewed.fence, lease.fence);
  assert.equal(renewed.remainingMs, 45_000);
  assert.equal("leaseToken" in renewed, false);

  const beforeMissingTargetWrites = tableWrites;
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/operations/begin"),
      headers: headers(HOLDER_A),
      payload: { ...authorityPayload(lease), kind: "mutation" },
    },
    400,
    "invalid-request",
  );
  assert.equal(tableWrites, beforeMissingTargetWrites, "missing journal target must be rejected before mutation");

  const beginResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/operations/begin"),
    headers: headers(HOLDER_A),
    payload: {
      ...authorityPayload(lease),
      kind: "mutation",
      targetEnsembleId: "ensemble-route",
    },
  });
  assert.equal(beginResponse.statusCode, 200, beginResponse.body);
  const operation = personalExtensionCoordinationOperationGrantSchema.parse(beginResponse.json());
  assert.equal(operation.kind, "mutation");

  const beforeTransitionValidation = await coordinationRow();
  const beforeTransitionValidationWrites = tableWrites;
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/operations/transition-to-vectorize"),
      headers: headers(HOLDER_A),
      payload: { ...authorityPayload(lease), operationHandle: operation.operationHandle },
    },
    400,
    "invalid-request",
  );
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/operations/transition-to-vectorize"),
      headers: headers(HOLDER_A),
      payload: {
        ...authorityPayload(lease),
        operationHandle: operation.operationHandle,
        targetEnsembleId: "other-route-ensemble",
      },
    },
    409,
    "operation-lost",
  );
  assert.deepEqual(await coordinationRow(), beforeTransitionValidation);
  assert.equal(
    tableWrites,
    beforeTransitionValidationWrites,
    "invalid or wrong-target transitions must not reach a durable write",
  );

  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/operations/transition-to-vectorize"),
      headers: headers(HOLDER_A),
      payload: {
        ...authorityPayload(lease),
        operationHandle: operation.operationHandle,
        targetEnsembleId: "ensemble-route",
      },
    },
    503,
    "coordination-unavailable",
  );
  assert.deepEqual(
    await coordinationRow(),
    beforeTransitionValidation,
    "the HTTP transition must fail closed when server-owned CMB marker proof is absent",
  );

  const malformedHandoffWrites = tableWrites;
  await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/handoff"),
      headers: headers(HOLDER_B),
      payload: { ...acquirePayload(), unexpected: true },
    },
    400,
    "invalid-request",
  );
  assert.equal(tableWrites, malformedHandoffWrites, "malformed handoff requests must mutate nothing");

  const handoffResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/handoff"),
    headers: headers(HOLDER_B),
    payload: acquirePayload(),
  });
  assert.equal(handoffResponse.statusCode, 200, handoffResponse.body);
  const handoff = personalExtensionCoordinationHandoffResponseSchema.parse(handoffResponse.json());
  assert.deepEqual(Object.keys(handoff).sort(), ["deadlineAt", "remainingMs", "requestId", "status"]);
  assert.equal(handoff.status, "draining");
  assert.equal("holderSessionId" in handoff, false);
  assert.equal("requester" in handoff, false);
  assert.equal("leaseToken" in handoff, false);

  const secondHandoff = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/handoff"),
    headers: headers(HOLDER_B),
    payload: acquirePayload(),
  });
  assert.equal(secondHandoff.statusCode, 200, secondHandoff.body);
  assert.deepEqual(
    personalExtensionCoordinationHandoffResponseSchema.parse(secondHandoff.json()),
    handoff,
    "the same requester must receive the same public request without extending the deadline",
  );

  const unrelatedHandoff = await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/handoff"),
      headers: headers("coordination-route-holder-c"),
      payload: acquirePayload(),
    },
    409,
    "handoff-pending",
  );
  const blockedBegin = await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/operations/begin"),
      headers: headers(HOLDER_A),
      payload: {
        ...authorityPayload(lease),
        kind: "mutation",
        targetEnsembleId: "ensemble-route-new",
      },
    },
    409,
    "handoff-pending",
  );
  const blockedRenew = await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/renew"),
      headers: headers(HOLDER_A),
      payload: authorityPayload(lease),
    },
    409,
    "handoff-pending",
  );
  const wrongHandoffRelease = await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/release"),
      headers: headers(HOLDER_A),
      payload: { ...authorityPayload(lease), handoffRequestId: "wrong-handoff-request" },
    },
    409,
    "handoff-pending",
  );
  const activeOperationRelease = await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/release"),
      headers: headers(HOLDER_A),
      payload: { ...authorityPayload(lease), handoffRequestId: handoff.requestId },
    },
    409,
    "operations-active",
  );

  const endResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/operations/end"),
    headers: headers(HOLDER_A),
    payload: { ...authorityPayload(lease), operationHandle: operation.operationHandle },
  });
  assert.equal(endResponse.statusCode, 200, endResponse.body);
  personalExtensionCoordinationOperationEndResponseSchema.parse(endResponse.json());

  const releaseResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/release"),
    headers: headers(HOLDER_A),
    payload: { ...authorityPayload(lease), handoffRequestId: handoff.requestId },
  });
  assert.equal(releaseResponse.statusCode, 200, releaseResponse.body);
  const released = personalExtensionCoordinationReleaseResponseSchema.parse(releaseResponse.json());
  assert.equal(released.fence, 2);

  const reservedResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/handoff"),
    headers: headers(HOLDER_B),
    payload: acquirePayload(),
  });
  assert.equal(reservedResponse.statusCode, 200, reservedResponse.body);
  const reserved = personalExtensionCoordinationHandoffResponseSchema.parse(reservedResponse.json());
  assert.equal(reserved.requestId, handoff.requestId);
  assert.equal(reserved.status, "reserved");

  const unrelatedClaim = await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
      headers: headers("coordination-route-holder-c"),
      payload: acquirePayload(),
    },
    409,
    "handoff-pending",
  );
  const claimResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/acquire"),
    headers: headers(HOLDER_B),
    payload: acquirePayload(),
  });
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);
  const requesterLease = personalExtensionCoordinationLeaseGrantSchema.parse(claimResponse.json());
  assert.equal(requesterLease.fence, 2, "reserved claim must not increment the handoff fence again");

  const requesterReleaseResponse = await app.inject({
    method: "POST",
    url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/release"),
    headers: headers(HOLDER_B),
    payload: authorityPayload(requesterLease),
  });
  assert.equal(requesterReleaseResponse.statusCode, 200, requesterReleaseResponse.body);
  const requesterReleased = personalExtensionCoordinationReleaseResponseSchema.parse(requesterReleaseResponse.json());
  assert.equal(requesterReleased.fence, 3);

  const staleRow = await coordinationRow();
  const staleWrites = tableWrites;
  const staleResponse = await expectError(
    {
      method: "POST",
      url: routeUrl(ACTIVE_EXTENSION_ID, "/lease/renew"),
      headers: headers(HOLDER_A),
      payload: authorityPayload(lease),
    },
    409,
    "lease-lost",
  );
  assert.deepEqual(await coordinationRow(), staleRow);
  assert.equal(tableWrites, staleWrites, "stale credentials must mutate nothing");

  const rawCredentials = [lease.leaseToken, requesterLease.leaseToken, operation.operationHandle];
  const nonIssuingResponses = [
    inactiveResponse.body,
    crossSite.body,
    staleResponse.body,
    JSON.stringify(writerState),
    JSON.stringify(followerState),
    renewResponse.body,
    handoffResponse.body,
    secondHandoff.body,
    unrelatedHandoff.body,
    blockedBegin.body,
    blockedRenew.body,
    wrongHandoffRelease.body,
    activeOperationRelease.body,
    endResponse.body,
    releaseResponse.body,
    reservedResponse.body,
    unrelatedClaim.body,
    requesterReleaseResponse.body,
  ].join("\n");
  for (const value of rawCredentials) {
    assert.equal(nonIssuingResponses.includes(value), false, "credentials must not leak into ordinary responses");
  }
  for (const value of [HOLDER_A, HOLDER_B, ...rawCredentials]) {
    assert.equal(logs.join("").includes(value), false, "credentials and holder metadata must not leak into logs");
  }
} finally {
  await app.close();
  await fileDb._fileStore.close();
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}

console.info("Personal extension coordination HTTP route regression passed.");
