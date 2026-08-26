import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { getFileTableConfig } from "../../packages/server/src/db/file-schema.js";
import {
  installedExtensions,
  personalExtensionCoordination,
  personalExtensionOperationJournal,
  type PersonalExtensionCoordinationMode,
} from "../../packages/server/src/db/schema/index.js";
import {
  createPersonalExtensionCoordinationKernel,
  parsePersonalExtensionProtectedResourceRegistry,
  PersonalExtensionCoordinationKernelError,
  PERSONAL_EXTENSION_OPERATION_DEADLINES_MS,
  PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
  type PersonalExtensionOperationVectorizeTransitionProof,
} from "../../packages/server/src/services/extensions/personal-extension-coordination-kernel.service.js";

const EXTENSION_ID = "coordination-kernel-extension";
const CONTENT_HASH = "approved-kernel-content-hash";
const BOOT_ID = "coordination-kernel-boot";
const START_WALL_MS = Date.parse("2026-08-15T00:00:00.000Z");

type KernelFixture = Awaited<ReturnType<typeof createKernelFixture>>;

async function createKernelFixture() {
  const storageDir = mkdtempSync(join(tmpdir(), "marinara-coordination-kernel-"));
  const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
  process.env.FILE_STORAGE_DIR = storageDir;
  let monotonicMs = 10_000;
  let wallMs = START_WALL_MS;
  let tokenCounter = 0;
  let handoffRequestCounter = 0;
  let failNextWrite = false;
  let vectorizeTransitionProof: PersonalExtensionOperationVectorizeTransitionProof = async () => true;

  const fileDb = await createFileNativeDB({
    fileOperations: {
      writeFile: async (path, content) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("simulated coordination strict write failure");
        }
        await writeFile(path, content);
      },
      // The production Windows runtime correctly reports strict durability as
      // unsupported. This injected implementation lets the pure kernel tests
      // exercise the supported path without pretending production succeeded.
      flushDirectory: async () => {},
    },
  });
  const db = fileDb as unknown as DB;
  const timestamp = new Date(wallMs).toISOString();
  await db.insert(installedExtensions).values({
    id: EXTENSION_ID,
    name: "Coordination kernel fixture",
    description: "Regression fixture",
    runtime: "client",
    capabilities: "[]",
    enabled: "true",
    contentHash: CONTENT_HASH,
    approvedHash: CONTENT_HASH,
    source: "local",
    revisions: "[]",
    installedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(personalExtensionCoordination).values({
    extensionId: EXTENSION_ID,
    contentHash: CONTENT_HASH,
    mode: "active",
    serverBootId: BOOT_ID,
    activeOperations: "[]",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await fileDb._fileStore.flushStrict();

  const kernelOptions = {
    serverBootId: BOOT_ID,
    monotonicNow: () => monotonicMs,
    wallNow: () => wallMs,
    randomToken: () => `raw-kernel-secret-${++tokenCounter}`,
    randomRequestId: () => `handoff-request-${++handoffRequestCounter}`,
    // This kernel-focused fixture exercises authority/revision mechanics. The
    // CMB-specific marker parser has its own dynamic journal regression.
    proveDispatchMarker: async () => true,
    proveVectorizeTransition: (...args) => vectorizeTransitionProof(...args),
  };
  const kernel = createPersonalExtensionCoordinationKernel(db, kernelOptions);

  return {
    db,
    fileDb,
    kernel,
    createSiblingKernel: () => createPersonalExtensionCoordinationKernel(db, kernelOptions),
    advance(ms: number) {
      monotonicMs += ms;
      wallMs += ms;
    },
    failNextStrictWrite() {
      failNextWrite = true;
    },
    setVectorizeTransitionProof(proof: PersonalExtensionOperationVectorizeTransitionProof) {
      vectorizeTransitionProof = proof;
    },
    async setMode(mode: PersonalExtensionCoordinationMode) {
      await db
        .update(personalExtensionCoordination)
        .set({ mode, updatedAt: new Date(wallMs).toISOString() })
        .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
      await fileDb._fileStore.flushStrict();
    },
    async setProtectedRegistry(value: unknown) {
      await db
        .update(personalExtensionCoordination)
        .set({ protectedLorebookRegistry: JSON.stringify(value), updatedAt: new Date(wallMs).toISOString() })
        .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
      await fileDb._fileStore.flushStrict();
    },
    async cleanup() {
      failNextWrite = false;
      await fileDb._fileStore.close();
      if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
      else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

async function coordinationRow(fixture: KernelFixture) {
  const rows = await fixture.db
    .select()
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  assert.ok(rows[0]);
  return rows[0];
}

async function journalForIsolatedKernelTest(fixture: KernelFixture, operationDigest: string) {
  const rows = await fixture.db
    .select()
    .from(personalExtensionOperationJournal)
    .where(eq(personalExtensionOperationJournal.operationDigest, operationDigest));
  assert.ok(rows[0]);
  return rows[0];
}

async function expectKernelCode(promise: Promise<unknown>, code: PersonalExtensionCoordinationKernelError["code"]) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PersonalExtensionCoordinationKernelError);
    assert.equal(error.code, code);
    return true;
  });
}

function authority(
  lease: { leaseToken: string; fence: number; serverBootId: string; contentHash: string },
  holderSessionId: string,
) {
  return {
    extensionId: EXTENSION_ID,
    holderSessionId,
    serverBootId: lease.serverBootId,
    contentHash: lease.contentHash,
    fence: lease.fence,
    leaseToken: lease.leaseToken,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const schemaKeys = new Set(getFileTableConfig(personalExtensionCoordination).columns.map((column) => column.key));
assert.equal(schemaKeys.has("activeOperations"), true);
for (const removedKey of [
  "activeOperationDigest",
  "activeOperationStartedAt",
  "activeOperationDeadlineAt",
  "activeOperationDrainEligible",
]) {
  assert.equal(schemaKeys.has(removedKey), false, `${removedKey} must not preserve the singular operation model`);
}

const modeFixture = await createKernelFixture();
try {
  for (const [mode, code] of [
    ["inactive", "coordination-inactive"],
    ["activating", "coordination-transition-blocked"],
    ["draining-deactivate", "coordination-transition-blocked"],
    ["restoring", "coordination-transition-blocked"],
    ["blocked", "coordination-transition-blocked"],
  ] as const) {
    await modeFixture.setMode(mode);
    const before = await coordinationRow(modeFixture);
    await expectKernelCode(
      modeFixture.kernel.acquireLease({
        extensionId: EXTENSION_ID,
        holderSessionId: "mode-holder",
        serverBootId: BOOT_ID,
        contentHash: CONTENT_HASH,
      }),
      code,
    );
    assert.deepEqual(await coordinationRow(modeFixture), before);
  }
  await modeFixture.setMode("active");

  const originalCapability = modeFixture.fileDb._fileStore.isStrictDurabilitySupported;
  modeFixture.fileDb._fileStore.isStrictDurabilitySupported = () => false;
  const beforeUnsupported = await coordinationRow(modeFixture);
  await expectKernelCode(
    modeFixture.kernel.acquireLease({
      extensionId: EXTENSION_ID,
      holderSessionId: "unsupported-holder",
      serverBootId: BOOT_ID,
      contentHash: CONTENT_HASH,
    }),
    "coordination-unavailable",
  );
  assert.deepEqual(await coordinationRow(modeFixture), beforeUnsupported);
  modeFixture.fileDb._fileStore.isStrictDurabilitySupported = originalCapability;

  const beforeStrictFailure = await coordinationRow(modeFixture);
  modeFixture.failNextStrictWrite();
  await expectKernelCode(
    modeFixture.kernel.acquireLease({
      extensionId: EXTENSION_ID,
      holderSessionId: "strict-failure-holder",
      serverBootId: BOOT_ID,
      contentHash: CONTENT_HASH,
    }),
    "coordination-unavailable",
  );
  assert.deepEqual(await coordinationRow(modeFixture), beforeStrictFailure);
} finally {
  await modeFixture.cleanup();
}

const leaseFixture = await createKernelFixture();
try {
  const firstAcquire = leaseFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "holder-a",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const competingAcquire = leaseFixture.createSiblingKernel().acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "holder-b",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const firstLease = await firstAcquire;
  await expectKernelCode(competingAcquire, "lease-held");
  assert.equal(firstLease.fence, 1);
  assert.equal(firstLease.remainingMs, 45_000);

  const firstRow = await coordinationRow(leaseFixture);
  assert.equal(firstRow.fence, 1);
  assert.equal(firstRow.holderSessionId, "holder-a");
  assert.equal(firstRow.leaseTokenDigest, sha256(firstLease.leaseToken));
  assert.equal(JSON.stringify(firstRow).includes(firstLease.leaseToken), false, "raw lease token must never be stored");

  leaseFixture.advance(45_001);
  assert.equal((await coordinationRow(leaseFixture)).fence, 1, "TTL passage alone must not advance the fence");

  const renewWins = leaseFixture.kernel.renewLease(authority(firstLease, "holder-a"));
  const acquireLoses = leaseFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "holder-b",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const renewedLease = await renewWins;
  await expectKernelCode(acquireLoses, "lease-held");
  assert.equal(renewedLease.fence, firstLease.fence, "renew must preserve the fence");

  leaseFixture.advance(45_001);
  const acquireWins = leaseFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "holder-b",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const lateRenewLoses = leaseFixture.kernel.renewLease(authority(firstLease, "holder-a"));
  const secondLease = await acquireWins;
  await expectKernelCode(lateRenewLoses, "lease-lost");
  assert.equal(secondLease.fence, firstLease.fence + 1);

  const validAuthority = authority(secondLease, "holder-b");
  const exactFailureCases = [
    [{ ...validAuthority, leaseToken: "wrong-token" }, "lease-lost"],
    [{ ...validAuthority, holderSessionId: "wrong-holder" }, "lease-lost"],
    [{ ...validAuthority, serverBootId: "wrong-boot" }, "lease-lost"],
    [{ ...validAuthority, contentHash: "wrong-hash" }, "extension-runtime-changed"],
    [{ ...validAuthority, fence: validAuthority.fence + 1 }, "lease-lost"],
  ] as const;
  for (const [invalidAuthority, code] of exactFailureCases) {
    const before = await coordinationRow(leaseFixture);
    await expectKernelCode(leaseFixture.kernel.renewLease(invalidAuthority), code);
    assert.deepEqual(await coordinationRow(leaseFixture), before);
  }

  await leaseFixture.db
    .update(installedExtensions)
    .set({ approvedHash: "changed-approved-hash" })
    .where(eq(installedExtensions.id, EXTENSION_ID));
  await leaseFixture.fileDb._fileStore.flushStrict();
  const beforeApprovalMismatch = await coordinationRow(leaseFixture);
  await expectKernelCode(leaseFixture.kernel.renewLease(validAuthority), "extension-runtime-changed");
  assert.deepEqual(await coordinationRow(leaseFixture), beforeApprovalMismatch);
  await leaseFixture.db
    .update(installedExtensions)
    .set({ approvedHash: CONTENT_HASH })
    .where(eq(installedExtensions.id, EXTENSION_ID));
  await leaseFixture.fileDb._fileStore.flushStrict();

  const released = await leaseFixture.kernel.releaseLease(validAuthority);
  assert.equal(released.fence, secondLease.fence + 1, "release must advance the fence");
  const releasedRow = await coordinationRow(leaseFixture);
  assert.equal(releasedRow.leaseTokenDigest, null);
  assert.equal(releasedRow.holderSessionId, null);
  assert.equal(releasedRow.expiresAt, null);

  const thirdLease = await leaseFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "holder-c",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  assert.equal(thirdLease.fence, released.fence + 1, "a new grant must advance the fence");
} finally {
  await leaseFixture.cleanup();
}

const handoffFixture = await createKernelFixture();
try {
  const writerLease = await handoffFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "handoff-writer",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const writerAuthority = authority(writerLease, "handoff-writer");
  const drainingOperation = await handoffFixture.kernel.beginOperation({
    ...writerAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-handoff-drain",
    requestedDeadlineMs: 1_000,
  });
  const requester = {
    extensionId: EXTENSION_ID,
    holderSessionId: "handoff-requester",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  };

  const beforeStrictRequestFailure = await coordinationRow(handoffFixture);
  handoffFixture.failNextStrictWrite();
  await expectKernelCode(handoffFixture.kernel.requestHandoff(requester), "coordination-unavailable");
  assert.deepEqual(await coordinationRow(handoffFixture), beforeStrictRequestFailure);

  const handoff = await handoffFixture.kernel.requestHandoff(requester);
  assert.deepEqual(Object.keys(handoff).sort(), ["deadlineAt", "remainingMs", "requestId", "status"]);
  assert.equal(handoff.status, "draining");
  assert.equal(handoff.requestId, "handoff-request-2");
  assert.equal(handoff.remainingMs, 1_000);
  assert.equal("holderSessionId" in handoff, false);
  assert.equal("leaseToken" in handoff, false);
  assert.equal("requester" in handoff, false);
  assert.deepEqual(await handoffFixture.kernel.requestHandoff(requester), handoff, "same requester must be idempotent");
  await expectKernelCode(
    handoffFixture.kernel.requestHandoff({ ...requester, holderSessionId: "unrelated-requester" }),
    "handoff-pending",
  );

  const pendingRow = await coordinationRow(handoffFixture);
  await expectKernelCode(
    handoffFixture.kernel.beginOperation({
      ...writerAuthority,
      kind: "mutation",
      targetEnsembleId: "ensemble-after-handoff",
    }),
    "handoff-pending",
  );
  await expectKernelCode(handoffFixture.kernel.renewLease(writerAuthority), "handoff-pending");
  await expectKernelCode(
    handoffFixture.kernel.releaseLease({ ...writerAuthority, handoffRequestId: "wrong-handoff-request" }),
    "handoff-pending",
  );
  await expectKernelCode(
    handoffFixture.kernel.releaseLease({ ...writerAuthority, handoffRequestId: handoff.requestId }),
    "operations-active",
  );
  assert.deepEqual(await coordinationRow(handoffFixture), pendingRow, "failed handoff release must mutate nothing");

  await handoffFixture.kernel.endOperation({
    ...writerAuthority,
    operationHandle: drainingOperation.operationHandle,
  });
  const reserved = await handoffFixture.kernel.releaseLease({
    ...writerAuthority,
    handoffRequestId: handoff.requestId,
  });
  assert.equal(reserved.fence, writerLease.fence + 1, "handoff release must advance the fence exactly once");
  let row = await coordinationRow(handoffFixture);
  assert.equal(row.fence, reserved.fence);
  assert.equal(row.holderSessionId, requester.holderSessionId);
  assert.equal(row.leaseTokenDigest, null, "reserved grant must not persist an undisclosed raw token");
  assert.equal(row.handoffRequestId, handoff.requestId);
  assert.equal(row.handoffRequester, requester.holderSessionId);

  await expectKernelCode(
    handoffFixture.kernel.acquireLease({ ...requester, holderSessionId: "unrelated-claimant" }),
    "handoff-pending",
  );
  assert.equal((await coordinationRow(handoffFixture)).fence, reserved.fence);
  await expectKernelCode(handoffFixture.kernel.renewLease(writerAuthority), "lease-lost");
  await expectKernelCode(
    handoffFixture.kernel.beginOperation({
      ...writerAuthority,
      kind: "mutation",
      targetEnsembleId: "ensemble-old-writer",
    }),
    "lease-lost",
  );

  const requesterLease = await handoffFixture.kernel.acquireLease(requester);
  assert.equal(requesterLease.fence, reserved.fence, "reserved requester claim must preserve the granted fence");
  row = await coordinationRow(handoffFixture);
  assert.equal(row.handoffRequestId, null);
  assert.equal(row.handoffRequester, null);
  assert.equal(row.handoffDeadlineAt, null);
  assert.equal(row.leaseTokenDigest, sha256(requesterLease.leaseToken));

  const requesterAuthority = authority(requesterLease, requester.holderSessionId);
  const boundedOperation = await handoffFixture.kernel.beginOperation({
    ...requesterAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-bounded-drain",
    requestedDeadlineMs: 1_000,
  });
  assert.ok(boundedOperation.operationHandle);
  const unclaimedRequester = { ...requester, holderSessionId: "unclaimed-requester" };
  const boundedHandoff = await handoffFixture.kernel.requestHandoff(unclaimedRequester);
  assert.equal(boundedHandoff.remainingMs, 1_000);
  handoffFixture.advance(1_001);
  const boundedReservation = await handoffFixture.kernel.releaseLease({
    ...requesterAuthority,
    handoffRequestId: boundedHandoff.requestId,
  });
  assert.equal(boundedReservation.fence, requesterLease.fence + 1);
  assert.deepEqual(JSON.parse((await coordinationRow(handoffFixture)).activeOperations), []);

  await expectKernelCode(
    handoffFixture.kernel.acquireLease({ ...unclaimedRequester, holderSessionId: "early-unrelated-claimant" }),
    "handoff-pending",
  );
  const beforeClaimDeadline = await coordinationRow(handoffFixture);
  handoffFixture.advance(45_001);
  assert.equal(
    (await coordinationRow(handoffFixture)).fence,
    beforeClaimDeadline.fence,
    "claim timeout passage alone must never change the fence",
  );
  const fallbackLease = await handoffFixture.kernel.acquireLease({
    ...unclaimedRequester,
    holderSessionId: "fallback-holder",
  });
  assert.equal(fallbackLease.fence, boundedReservation.fence + 1, "expired reservation must use normal acquire fence");
  await expectKernelCode(handoffFixture.kernel.acquireLease(unclaimedRequester), "lease-held");

  const fallbackAuthority = authority(fallbackLease, "fallback-holder");
  const ttlRequester = { ...requester, holderSessionId: "ttl-requester" };
  const ttlHandoff = await handoffFixture.kernel.requestHandoff(ttlRequester);
  await expectKernelCode(
    handoffFixture.kernel.acquireLease({ ...ttlRequester, holderSessionId: "ttl-steal-attempt" }),
    "handoff-pending",
  );
  const fenceBeforeTtl = (await coordinationRow(handoffFixture)).fence;
  handoffFixture.advance(45_001);
  assert.equal(
    (await coordinationRow(handoffFixture)).fence,
    fenceBeforeTtl,
    "handoff timer must not mutate authority",
  );
  const ttlFallback = await handoffFixture.kernel.acquireLease(ttlRequester);
  assert.equal(ttlFallback.fence, fallbackLease.fence + 1);
  assert.equal((await coordinationRow(handoffFixture)).handoffRequestId, null);
  await expectKernelCode(handoffFixture.kernel.renewLease(fallbackAuthority), "lease-lost");
  assert.ok(ttlHandoff.requestId);

  const ttlFallbackAuthority = authority(ttlFallback, ttlRequester.holderSessionId);
  await handoffFixture.kernel.beginOperation({
    ...ttlFallbackAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-drain-beyond-lease-ttl",
    requestedDeadlineMs: 60_000,
  });
  const longDrainRequester = { ...requester, holderSessionId: "long-drain-requester" };
  const longDrainHandoff = await handoffFixture.kernel.requestHandoff(longDrainRequester);
  assert.equal(longDrainHandoff.remainingMs, 60_000);
  const longDrainFence = (await coordinationRow(handoffFixture)).fence;
  handoffFixture.advance(45_001);
  await expectKernelCode(handoffFixture.kernel.acquireLease(longDrainRequester), "handoff-pending");
  assert.equal(
    (await coordinationRow(handoffFixture)).fence,
    longDrainFence,
    "lease TTL must not fence an already admitted operation before its bounded deadline",
  );
  handoffFixture.advance(15_000);
  const longDrainFallback = await handoffFixture.kernel.acquireLease(longDrainRequester);
  assert.equal(longDrainFallback.fence, longDrainFence + 1);
} finally {
  await handoffFixture.cleanup();
}

const operationFixture = await createKernelFixture();
try {
  const lease = await operationFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "operation-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease, "operation-holder");

  const beforeFailedBegin = await coordinationRow(operationFixture);
  operationFixture.failNextStrictWrite();
  await expectKernelCode(
    operationFixture.kernel.beginOperation({
      ...leaseAuthority,
      kind: "mutation",
      targetEnsembleId: "ensemble-operation",
    }),
    "coordination-unavailable",
  );
  assert.deepEqual(await coordinationRow(operationFixture), beforeFailedBegin);

  const mutationOperation = await operationFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-mutation",
  });
  const vectorOperation = await operationFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "vectorize",
    targetEnsembleId: "ensemble-vectorize",
  });
  assert.equal(mutationOperation.remainingMs, PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.mutation);
  assert.equal(vectorOperation.remainingMs, PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.vectorize);

  let row = await coordinationRow(operationFixture);
  let operations = JSON.parse(row.activeOperations) as Array<{ digest: string; kind: string }>;
  assert.equal(operations.length, 2, "valid journal-backed operations may remain concurrently active");
  assert.deepEqual(operations.map((operation) => operation.kind).sort(), ["mutation", "vectorize"]);
  assert.deepEqual(
    operations.map((operation) => operation.digest).sort(),
    [sha256(mutationOperation.operationHandle), sha256(vectorOperation.operationHandle)].sort(),
  );
  assert.equal(row.activeOperations.includes(mutationOperation.operationHandle), false);
  assert.equal(row.activeOperations.includes(vectorOperation.operationHandle), false);

  const beforeActiveRelease = row;
  await expectKernelCode(operationFixture.kernel.releaseLease(leaseAuthority), "operations-active");
  assert.deepEqual(await coordinationRow(operationFixture), beforeActiveRelease);

  const beforeUnsupportedKind = row.activeOperations;
  await expectKernelCode(
    operationFixture.kernel.beginOperation({
      ...leaseAuthority,
      kind: "not-allowlisted" as "mutation",
      targetEnsembleId: "ensemble-invalid-kind",
    }),
    "operation-kind-unsupported",
  );
  assert.equal((await coordinationRow(operationFixture)).activeOperations, beforeUnsupportedKind);

  const beforeFailedEnd = await coordinationRow(operationFixture);
  operationFixture.failNextStrictWrite();
  await expectKernelCode(
    operationFixture.kernel.endOperation({
      ...leaseAuthority,
      operationHandle: mutationOperation.operationHandle,
    }),
    "coordination-unavailable",
  );
  assert.deepEqual(await coordinationRow(operationFixture), beforeFailedEnd);

  await operationFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: mutationOperation.operationHandle,
  });
  row = await coordinationRow(operationFixture);
  operations = JSON.parse(row.activeOperations) as Array<{ digest: string; kind: string }>;
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.kind, "vectorize");
  await expectKernelCode(
    operationFixture.kernel.endOperation({
      ...leaseAuthority,
      operationHandle: mutationOperation.operationHandle,
    }),
    "operation-lost",
  );

  const cappedOperation = await operationFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-capped",
    requestedDeadlineMs: PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.vectorize,
  });
  assert.equal(
    cappedOperation.remainingMs,
    PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.mutation,
    "a client request must not extend the server allowlisted mutation deadline",
  );
  await operationFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: cappedOperation.operationHandle,
  });

  const expiringOperation = await operationFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-expiring",
    requestedDeadlineMs: 1_000,
  });
  operationFixture.advance(1_001);
  const postReapOperation = await operationFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-post-reap",
    requestedDeadlineMs: 2_000,
  });
  operations = JSON.parse((await coordinationRow(operationFixture)).activeOperations) as Array<{
    digest: string;
    kind: string;
  }>;
  assert.equal(operations.length, 2, "a later admission reaps only the expired operation");
  assert.deepEqual(
    operations.map((operation) => operation.digest).sort(),
    [sha256(vectorOperation.operationHandle), sha256(postReapOperation.operationHandle)].sort(),
  );
  await expectKernelCode(
    operationFixture.kernel.endOperation({
      ...leaseAuthority,
      operationHandle: expiringOperation.operationHandle,
    }),
    "operation-lost",
  );
  await operationFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: postReapOperation.operationHandle,
  });

  await operationFixture.db
    .update(personalExtensionCoordination)
    .set({
      handoffRequestId: "handoff-request-legacy",
      handoffRequester: "next-holder",
      handoffDeadlineAt: new Date(START_WALL_MS + 30_000).toISOString(),
    })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await operationFixture.fileDb._fileStore.flushStrict();
  const beforeHandoffBegin = (await coordinationRow(operationFixture)).activeOperations;
  await expectKernelCode(
    operationFixture.kernel.beginOperation({
      ...leaseAuthority,
      kind: "mutation",
      targetEnsembleId: "ensemble-handoff",
    }),
    "handoff-pending",
  );
  await expectKernelCode(operationFixture.kernel.renewLease(leaseAuthority), "handoff-pending");
  assert.equal((await coordinationRow(operationFixture)).activeOperations, beforeHandoffBegin);

  await operationFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: vectorOperation.operationHandle,
  });
  assert.deepEqual(JSON.parse((await coordinationRow(operationFixture)).activeOperations), []);
} finally {
  await operationFixture.cleanup();
}

const transitionFixture = await createKernelFixture();
try {
  await transitionFixture.setProtectedRegistry({
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: 0 },
    lorebooks: {},
  });
  const lease = await transitionFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "transition-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease, "transition-holder");
  const operation = await transitionFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-transition",
    requestedDeadlineMs: 1_000,
  });
  const operationDigest = sha256(operation.operationHandle);
  const beforeFailedTransition = await coordinationRow(transitionFixture);
  const beforeFailedJournal = (
    await transitionFixture.db
      .select()
      .from(personalExtensionOperationJournal)
      .where(eq(personalExtensionOperationJournal.operationDigest, operationDigest))
  )[0];
  assert.ok(beforeFailedJournal);

  await expectKernelCode(
    transitionFixture.kernel.transitionOperationToVectorize({
      ...leaseAuthority,
      operationHandle: operation.operationHandle,
      targetEnsembleId: "other-ensemble",
    }),
    "operation-lost",
  );
  assert.deepEqual(await coordinationRow(transitionFixture), beforeFailedTransition);

  transitionFixture.failNextStrictWrite();
  await expectKernelCode(
    transitionFixture.kernel.transitionOperationToVectorize({
      ...leaseAuthority,
      operationHandle: operation.operationHandle,
      targetEnsembleId: "ensemble-transition",
    }),
    "coordination-unavailable",
  );
  assert.deepEqual(
    await coordinationRow(transitionFixture),
    beforeFailedTransition,
    "a failed strict transition must leave the persisted operation unchanged",
  );
  assert.deepEqual(
    (
      await transitionFixture.db
        .select()
        .from(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, operationDigest))
    )[0],
    beforeFailedJournal,
    "a failed strict transition must leave the same journal revision and phase unchanged",
  );

  const transitioned = await transitionFixture.kernel.transitionOperationToVectorize({
    ...leaseAuthority,
    operationHandle: operation.operationHandle,
    targetEnsembleId: "ensemble-transition",
  });
  assert.equal(transitioned.operationHandle, operation.operationHandle);
  assert.equal(transitioned.kind, "vectorize");
  assert.equal(transitioned.remainingMs, PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.vectorize);
  assert.equal(
    transitioned.deadlineAt,
    new Date(START_WALL_MS + PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.vectorize).toISOString(),
  );
  const transitionedRow = await coordinationRow(transitionFixture);
  const transitionedOperations = JSON.parse(transitionedRow.activeOperations) as Array<Record<string, unknown>>;
  assert.equal(transitionedOperations.length, 1);
  assert.equal(transitionedOperations[0]?.digest, operationDigest);
  assert.equal(transitionedOperations[0]?.kind, "vectorize");
  assert.equal(transitionedOperations[0]?.startedAt, new Date(START_WALL_MS).toISOString());
  assert.equal(transitionedOperations[0]?.deadlineAt, transitioned.deadlineAt);
  const transitionedJournal = (
    await transitionFixture.db
      .select()
      .from(personalExtensionOperationJournal)
      .where(eq(personalExtensionOperationJournal.operationDigest, operationDigest))
  )[0];
  assert.ok(transitionedJournal);
  assert.equal(transitionedJournal.operationKind, "vectorize");
  assert.equal(transitionedJournal.phase, beforeFailedJournal.phase);
  assert.equal(transitionedJournal.protectedResourceRevisions, beforeFailedJournal.protectedResourceRevisions);

  assert.deepEqual(
    await transitionFixture.kernel.transitionOperationToVectorize({
      ...leaseAuthority,
      operationHandle: operation.operationHandle,
      targetEnsembleId: "ensemble-transition",
    }),
    transitioned,
    "a same-handle replay must recover a lost transition response without creating new authority",
  );

  let callbackRan = false;
  await expectKernelCode(
    transitionFixture.kernel.runFencedResourceMutation(
      { ...leaseAuthority, operationHandle: operation.operationHandle },
      [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 0 }],
      async () => {
        callbackRan = true;
        return null;
      },
      { operationKind: "mutation" },
    ),
    "operation-kind-unsupported",
  );
  assert.equal(callbackRan, false, "a transitioned handle must reject every later mutation dispatch");
  assert.equal(
    await transitionFixture.kernel.runFencedOperationRead(
      { ...leaseAuthority, operationHandle: operation.operationHandle },
      "vectorize",
      async () => "vectorize-admitted",
    ),
    "vectorize-admitted",
  );

  await transitionFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: operation.operationHandle,
  });

  let proofEnteredResolve!: () => void;
  const proofEntered = new Promise<void>((resolve) => {
    proofEnteredResolve = resolve;
  });
  let releaseProof!: () => void;
  const proofGate = new Promise<void>((resolve) => {
    releaseProof = resolve;
  });
  transitionFixture.setVectorizeTransitionProof(async () => {
    proofEnteredResolve();
    await proofGate;
    return true;
  });
  const expiring = await transitionFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-transition-expiring-proof",
    requestedDeadlineMs: 1_000,
  });
  const expiringDigest = sha256(expiring.operationHandle);
  const beforeExpiredProof = await coordinationRow(transitionFixture);
  const beforeExpiredProofJournal = await journalForIsolatedKernelTest(
    transitionFixture,
    expiringDigest,
  );
  const expiredProofRejection = expectKernelCode(
    transitionFixture.kernel.transitionOperationToVectorize({
      ...leaseAuthority,
      operationHandle: expiring.operationHandle,
      targetEnsembleId: "ensemble-transition-expiring-proof",
    }),
    "operation-lost",
  );
  await proofEntered;
  transitionFixture.advance(1_001);
  releaseProof();
  await expiredProofRejection;
  assert.deepEqual(
    await coordinationRow(transitionFixture),
    beforeExpiredProof,
    "proof completion after the mutation deadline must not transition the persisted operation",
  );
  assert.deepEqual(
    await journalForIsolatedKernelTest(transitionFixture, expiringDigest),
    beforeExpiredProofJournal,
    "proof completion after expiry must not transition or revise the journal",
  );

  const replacement = await transitionFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-after-expired-proof",
  });
  const afterExpiredProofReap = JSON.parse(
    (await coordinationRow(transitionFixture)).activeOperations,
  ) as Array<{ digest: string }>;
  assert.equal(
    afterExpiredProofReap.some((candidate) => candidate.digest === expiringDigest),
    false,
    "a rejected transition must not extend the expired operation's runtime deadline",
  );
  await transitionFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: replacement.operationHandle,
  });
} finally {
  await transitionFixture.cleanup();
}

const transitionHandoffFixture = await createKernelFixture();
try {
  await transitionHandoffFixture.setProtectedRegistry({
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: 0 },
    lorebooks: {},
  });
  const lease = await transitionHandoffFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "transition-draining-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease, "transition-draining-holder");
  const operation = await transitionHandoffFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-transition-draining",
    requestedDeadlineMs: 1_000,
  });
  const requester = {
    extensionId: EXTENSION_ID,
    holderSessionId: "transition-next-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  };
  const initialHandoff = await transitionHandoffFixture.kernel.requestHandoff(requester);
  assert.equal(initialHandoff.remainingMs, 1_000);
  const transitioned = await transitionHandoffFixture.kernel.transitionOperationToVectorize({
    ...leaseAuthority,
    operationHandle: operation.operationHandle,
    targetEnsembleId: "ensemble-transition-draining",
  });
  const expectedDeadlineAt = new Date(
    START_WALL_MS + PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.vectorize,
  ).toISOString();
  assert.equal(transitioned.deadlineAt, expectedDeadlineAt);
  const drainingRow = await coordinationRow(transitionHandoffFixture);
  assert.equal(drainingRow.handoffRequestId, initialHandoff.requestId);
  assert.equal(drainingRow.handoffRequester, requester.holderSessionId);
  assert.equal(drainingRow.handoffDeadlineAt, expectedDeadlineAt);
  assert.equal(
    (await transitionHandoffFixture.kernel.requestHandoff(requester)).deadlineAt,
    expectedDeadlineAt,
    "the same handoff request must observe the transitioned operation's absolute cap",
  );

  transitionHandoffFixture.advance(45_001);
  await expectKernelCode(
    transitionHandoffFixture.kernel.acquireLease(requester),
    "handoff-pending",
  );
  await transitionHandoffFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: operation.operationHandle,
  });
  const reservation = await transitionHandoffFixture.kernel.releaseLease({
    ...leaseAuthority,
    handoffRequestId: initialHandoff.requestId,
  });
  assert.equal(reservation.fence, lease.fence + 1);
} finally {
  await transitionHandoffFixture.cleanup();
}

const transitionExpiryHandoffFixture = await createKernelFixture();
try {
  await transitionExpiryHandoffFixture.setProtectedRegistry({
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: 0 },
    lorebooks: {},
  });
  const lease = await transitionExpiryHandoffFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "transition-expiry-draining-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease, "transition-expiry-draining-holder");
  const operation = await transitionExpiryHandoffFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-transition-expiry-draining",
    requestedDeadlineMs: 1_000,
  });
  const requester = {
    extensionId: EXTENSION_ID,
    holderSessionId: "transition-expiry-next-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  };
  const handoff = await transitionExpiryHandoffFixture.kernel.requestHandoff(requester);
  const operationDigest = sha256(operation.operationHandle);
  const beforeExpiredProof = await coordinationRow(transitionExpiryHandoffFixture);
  const beforeExpiredProofJournal = await journalForIsolatedKernelTest(
    transitionExpiryHandoffFixture,
    operationDigest,
  );
  let proofEnteredResolve!: () => void;
  const proofEntered = new Promise<void>((resolve) => {
    proofEnteredResolve = resolve;
  });
  let releaseProof!: () => void;
  const proofGate = new Promise<void>((resolve) => {
    releaseProof = resolve;
  });
  transitionExpiryHandoffFixture.setVectorizeTransitionProof(async () => {
    proofEnteredResolve();
    await proofGate;
    return true;
  });
  const expiredProofRejection = expectKernelCode(
    transitionExpiryHandoffFixture.kernel.transitionOperationToVectorize({
      ...leaseAuthority,
      operationHandle: operation.operationHandle,
      targetEnsembleId: "ensemble-transition-expiry-draining",
    }),
    "operation-lost",
  );
  await proofEntered;
  transitionExpiryHandoffFixture.advance(1_001);
  releaseProof();
  await expiredProofRejection;
  assert.deepEqual(
    await coordinationRow(transitionExpiryHandoffFixture),
    beforeExpiredProof,
    "an expired draining transition must preserve the operation and handoff deadlines",
  );
  assert.deepEqual(
    await journalForIsolatedKernelTest(transitionExpiryHandoffFixture, operationDigest),
    beforeExpiredProofJournal,
    "an expired draining transition must preserve the mutation journal",
  );
  assert.equal(
    (await transitionExpiryHandoffFixture.kernel.requestHandoff(requester)).remainingMs,
    0,
    "a rejected transition must not extend the draining handoff runtime deadline",
  );
  await transitionExpiryHandoffFixture.kernel.endOperation({
    ...leaseAuthority,
    operationHandle: operation.operationHandle,
  });
  const reservation = await transitionExpiryHandoffFixture.kernel.releaseLease({
    ...leaseAuthority,
    handoffRequestId: handoff.requestId,
  });
  assert.equal(reservation.fence, lease.fence + 1);
} finally {
  await transitionExpiryHandoffFixture.cleanup();
}

const fencedFixture = await createKernelFixture();
try {
  const registry = {
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: 2 },
    lorebooks: {
      "protected-lorebook": { resourceRevision: 7 },
    },
  };
  await fencedFixture.setProtectedRegistry(registry);
  assert.deepEqual(
    parsePersonalExtensionProtectedResourceRegistry(JSON.stringify(registry)),
    registry,
    "the protected resource registry must round-trip only its closed JSON shape",
  );
  for (const malformed of ["{}", "[]", "{", JSON.stringify({ ...registry, extra: true })]) {
    assert.throws(
      () => parsePersonalExtensionProtectedResourceRegistry(malformed),
      (error) => error instanceof PersonalExtensionCoordinationKernelError && error.code === "coordination-unavailable",
    );
  }

  const lease = await fencedFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "fenced-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const leaseAuthority = authority(lease, "fenced-holder");
  const operation = await fencedFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-fenced",
  });
  const context = { ...leaseAuthority, operationHandle: operation.operationHandle };
  await fencedFixture.kernel.runFencedResourceMutation(
    context,
    [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 2 }],
    async () => "durable-marker",
  );
  const resources = [{ kind: "lorebook" as const, resourceId: "protected-lorebook", expectedRevision: 7 }];

  const committed = await fencedFixture.kernel.runFencedResourceMutation(context, resources, async (tx) => {
    await tx
      .update(installedExtensions)
      .set({ description: "fenced mutation committed" })
      .where(eq(installedExtensions.id, EXTENSION_ID));
    return "committed" as const;
  });
  assert.equal(committed.result, "committed");
  assert.deepEqual(committed.resourceRevisions, [
    { kind: "lorebook", resourceId: "protected-lorebook", presence: "present", resourceRevision: 8 },
  ]);
  let row = await coordinationRow(fencedFixture);
  assert.deepEqual(parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry), {
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: 3 },
    lorebooks: { "protected-lorebook": { resourceRevision: 8 } },
  });
  assert.equal(
    (
      await fencedFixture.db
        .select({ description: installedExtensions.description })
        .from(installedExtensions)
        .where(eq(installedExtensions.id, EXTENSION_ID))
    )[0]?.description,
    "fenced mutation committed",
  );

  let callbackRan = false;
  await expectKernelCode(
    fencedFixture.kernel.runFencedResourceMutation(context, resources, async () => {
      callbackRan = true;
      return null;
    }),
    "resource-revision-conflict",
  );
  assert.equal(callbackRan, false, "a stale resource context must not reach the data callback");
  assert.deepEqual(await coordinationRow(fencedFixture), row);

  await expectKernelCode(
    fencedFixture.kernel.runFencedResourceMutation(
      context,
      [{ kind: "lorebook", resourceId: "other-owner-lorebook", expectedRevision: 0 }],
      async () => {
        callbackRan = true;
        return null;
      },
    ),
    "coordination-unavailable",
  );
  assert.equal(callbackRan, false, "foreign resources must fail before their callback");

  await fencedFixture.setProtectedRegistry("malformed-registry");
  await expectKernelCode(
    fencedFixture.kernel.runFencedResourceMutation(
      context,
      [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 3 }],
      async () => {
        callbackRan = true;
        return null;
      },
    ),
    "coordination-unavailable",
  );
  assert.equal(callbackRan, false, "malformed active registries must fail closed before mutation");

  await fencedFixture.setProtectedRegistry({
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: 3 },
    lorebooks: { "protected-lorebook": { resourceRevision: 8 } },
  });
  const shortOperation = await fencedFixture.kernel.beginOperation({
    ...leaseAuthority,
    kind: "mutation",
    targetEnsembleId: "ensemble-short",
    requestedDeadlineMs: 1_000,
  });
  fencedFixture.advance(45_001);
  const committedAfterLeaseExpiry = await fencedFixture.kernel.runFencedResourceMutation(
    context,
    [
      { kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 3 },
      { kind: "lorebook", resourceId: "protected-lorebook", expectedRevision: 8 },
    ],
    async () => "commit-after-lease-expiry",
  );
  assert.equal(
    committedAfterLeaseExpiry.result,
    "commit-after-lease-expiry",
    "an already registered operation must remain commit-capable through its own deadline",
  );
  await expectKernelCode(
    fencedFixture.kernel.runFencedResourceMutation(
      { ...leaseAuthority, operationHandle: shortOperation.operationHandle },
      [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 4 }],
      async () => {
        callbackRan = true;
        return null;
      },
    ),
    "operation-lost",
  );
  assert.equal(callbackRan, false, "expired operations must not reach the callback");

  const operationsBeforeSyntheticHandoff = JSON.parse((await coordinationRow(fencedFixture)).activeOperations) as Array<
    Record<string, unknown>
  >;
  await fencedFixture.db
    .update(personalExtensionCoordination)
    .set({
      handoffRequestId: "pending-handoff-legacy",
      handoffRequester: "next-writer",
      handoffDeadlineAt: new Date(START_WALL_MS + 90_000).toISOString(),
      activeOperations: JSON.stringify(
        operationsBeforeSyntheticHandoff.map((operation) => ({ ...operation, drainEligible: true })),
      ),
    })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await fencedFixture.fileDb._fileStore.flushStrict();
  const committedDuringHandoff = await fencedFixture.kernel.runFencedResourceMutation(
    context,
    [
      { kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 4 },
      { kind: "lorebook", resourceId: "protected-lorebook", expectedRevision: 9 },
    ],
    async () => "drain-eligible-commit",
  );
  assert.equal(committedDuringHandoff.result, "drain-eligible-commit");

  await fencedFixture.setProtectedRegistry({
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: Number.MAX_SAFE_INTEGER - 1 },
    lorebooks: {},
  });
  const beforeOverflow = await coordinationRow(fencedFixture);
  await expectKernelCode(
    fencedFixture.kernel.runFencedResourceMutation(
      context,
      [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: Number.MAX_SAFE_INTEGER - 1 }],
      async () => {
        callbackRan = true;
        return null;
      },
    ),
    "coordination-unavailable",
  );
  assert.equal(callbackRan, false, "revision overflow must fail before the callback");
  assert.deepEqual(await coordinationRow(fencedFixture), beforeOverflow);

  await fencedFixture.db
    .update(personalExtensionCoordination)
    .set({ handoffRequestId: null, handoffRequester: null, handoffDeadlineAt: null })
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  await fencedFixture.fileDb._fileStore.flushStrict();

  await fencedFixture.kernel.endOperation({ ...leaseAuthority, operationHandle: shortOperation.operationHandle });
  await fencedFixture.kernel.endOperation({ ...leaseAuthority, operationHandle: operation.operationHandle });
  await fencedFixture.kernel.releaseLease(leaseAuthority);
  await expectKernelCode(
    fencedFixture.kernel.acquireLease({
      extensionId: EXTENSION_ID,
      holderSessionId: "replacement-holder",
      serverBootId: BOOT_ID,
      contentHash: CONTENT_HASH,
    }),
    "coordination-transition-blocked",
  );
  const blockedAfterUnsafeJournal = await coordinationRow(fencedFixture);
  assert.equal(blockedAfterUnsafeJournal.mode, "blocked");
  assert.equal(blockedAfterUnsafeJournal.leaseTokenDigest, null);
  assert.equal(blockedAfterUnsafeJournal.holderSessionId, null);
  assert.equal(blockedAfterUnsafeJournal.activeOperations, "[]");
} finally {
  await fencedFixture.cleanup();
}

const oldFenceFixture = await createKernelFixture();
try {
  const oldLease = await oldFenceFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "old-fence-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const oldAuthority = authority(oldLease, "old-fence-holder");
  await oldFenceFixture.kernel.releaseLease(oldAuthority);
  const replacementLease = await oldFenceFixture.kernel.acquireLease({
    extensionId: EXTENSION_ID,
    holderSessionId: "replacement-holder",
    serverBootId: BOOT_ID,
    contentHash: CONTENT_HASH,
  });
  const beforeOldFence = await coordinationRow(oldFenceFixture);
  let oldFenceCallbackRan = false;
  await expectKernelCode(
    oldFenceFixture.kernel.runFencedResourceMutation(
      { ...oldAuthority, operationHandle: "missing-old-operation" },
      [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 0 }],
      async () => {
        oldFenceCallbackRan = true;
        return null;
      },
    ),
    "lease-lost",
  );
  assert.equal(oldFenceCallbackRan, false, "an old fence must not reach the callback");
  assert.deepEqual(await coordinationRow(oldFenceFixture), beforeOldFence);
  assert.ok(replacementLease.fence > oldLease.fence);

  await oldFenceFixture.setMode("inactive");
  await expectKernelCode(
    oldFenceFixture.kernel.runFencedResourceMutation(
      { ...authority(replacementLease, "replacement-holder"), operationHandle: "missing-operation" },
      [{ kind: "extension-storage", resourceId: EXTENSION_ID, expectedRevision: 0 }],
      async () => null,
    ),
    "coordination-inactive",
  );
} finally {
  await oldFenceFixture.cleanup();
}

console.info("Personal extension coordination pure-kernel regression passed.");
