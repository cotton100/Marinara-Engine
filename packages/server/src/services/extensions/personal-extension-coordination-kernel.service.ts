// ──────────────────────────────────────────────
// Service: Personal Extension Coordination Kernel
// ──────────────────────────────────────────────
// Pure server-side authority kernel. Public routes, admin transitions and
// guarded lorebook mutations are intentionally layered on later.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { and, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import {
  installedExtensions,
  personalExtensionCoordination,
  personalExtensionOperationJournal,
  type PersonalExtensionCoordinationRow,
  type PersonalExtensionOperationJournalRow,
} from "../../db/schema/index.js";

export const PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID = randomUUID();
const DEFAULT_LEASE_TTL_MS = 45_000;
const MAX_RANDOM_SECRET_ATTEMPTS = 8;
const TARGET_ENSEMBLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HANDOFF_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
export const PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION = 1;

export const PERSONAL_EXTENSION_OPERATION_DEADLINES_MS = Object.freeze({
  mutation: 180_000,
  vectorize: 600_000,
});

export type PersonalExtensionOperationKind = keyof typeof PERSONAL_EXTENSION_OPERATION_DEADLINES_MS;

export type PersistedPersonalExtensionOperation = {
  digest: string;
  kind: PersonalExtensionOperationKind;
  targetEnsembleId: string;
  holderSessionId: string;
  fence: number;
  startedAt: string;
  deadlineAt: string;
  drainEligible: boolean;
};

export type PersonalExtensionCoordinationKernelErrorCode =
  | "coordination-inactive"
  | "coordination-transition-blocked"
  | "coordination-unavailable"
  | "coordination-validation-failed"
  | "extension-runtime-changed"
  | "lease-held"
  | "lease-lost"
  | "lease-expired"
  | "handoff-pending"
  | "operation-kind-unsupported"
  | "operation-lost"
  | "operations-active"
  | "coordination-required"
  | "storage-revision-conflict"
  | "resource-revision-conflict"
  | "protected-resource-unregistered"
  | "invalid-request";

const ERROR_MESSAGES: Record<PersonalExtensionCoordinationKernelErrorCode, string> = {
  "coordination-inactive": "Personal extension coordination is inactive.",
  "coordination-transition-blocked": "Personal extension coordination is not available during this transition.",
  "coordination-unavailable": "Personal extension coordination cannot provide a durability guarantee.",
  "coordination-validation-failed": "The Personal Extension coordination configuration is not safe to activate.",
  "extension-runtime-changed": "The approved personal extension runtime changed.",
  "lease-held": "Another writer lease is active.",
  "lease-lost": "The writer lease no longer matches server authority.",
  "lease-expired": "The writer lease is not currently live.",
  "handoff-pending": "A writer handoff is pending.",
  "operation-kind-unsupported": "The requested coordination operation kind is not supported.",
  "operation-lost": "The coordination operation no longer exists.",
  "operations-active": "Active coordination operations must finish first.",
  "coordination-required": "Personal extension storage requires coordination authority.",
  "storage-revision-conflict": "The extension storage changed before this operation could commit.",
  "resource-revision-conflict": "The protected resource changed before this operation could commit.",
  "protected-resource-unregistered": "The protected resource is not registered for this extension.",
  "invalid-request": "The coordination request is invalid.",
};

export class PersonalExtensionCoordinationKernelError extends Error {
  readonly code: PersonalExtensionCoordinationKernelErrorCode;
  readonly statusCode: number;

  constructor(code: PersonalExtensionCoordinationKernelErrorCode, options?: { cause?: unknown }) {
    super(ERROR_MESSAGES[code], options);
    this.name = "PersonalExtensionCoordinationKernelError";
    this.code = code;
    this.statusCode =
      code === "coordination-unavailable"
        ? 503
        : code === "extension-runtime-changed"
          ? 412
          : code === "coordination-required"
            ? 428
            : code === "invalid-request" || code === "operation-kind-unsupported"
              ? 400
              : 409;
  }
}

export type PersonalExtensionCoordinationKernelOptions = {
  serverBootId?: string;
  monotonicNow?: () => number;
  wallNow?: () => number;
  randomToken?: () => string;
  randomRequestId?: () => string;
  leaseTtlMs?: number;
  operationDeadlinesMs?: Partial<Record<PersonalExtensionOperationKind, number>>;
  /**
   * Server-owned CMB validation for the durable marker that must precede any
   * protected lorebook dispatch. An absent proof fails closed.
   */
  proveDispatchMarker?: PersonalExtensionOperationDispatchMarkerProof;
  /**
   * Runs only after a newly-created handoff request is durably committed.
   * The callback is notification-only: failures must be contained by the
   * caller and must never change the committed handoff result.
   */
  afterHandoffCommitted?: (extensionId: string, requestId: string) => void;
};

export type PersonalExtensionLeaseAuthority = {
  extensionId: string;
  holderSessionId: string;
  serverBootId: string;
  contentHash: string;
  fence: number;
  leaseToken: string;
};

export type PersonalExtensionLeaseAcquireInput = Pick<
  PersonalExtensionLeaseAuthority,
  "extensionId" | "holderSessionId" | "serverBootId" | "contentHash"
>;

export type PersonalExtensionHandoffRequestInput = PersonalExtensionLeaseAcquireInput;

export type PersonalExtensionLeaseReleaseInput = PersonalExtensionLeaseAuthority & {
  handoffRequestId?: string;
};

export type PersonalExtensionLeaseGrant = {
  leaseToken: string;
  holderSessionId: string;
  serverBootId: string;
  contentHash: string;
  fence: number;
  expiresAt: string;
  remainingMs: number;
};

export type PersonalExtensionLeaseState = Omit<PersonalExtensionLeaseGrant, "leaseToken">;

export type PersonalExtensionHandoffResponse = {
  requestId: string;
  status: "draining" | "reserved";
  deadlineAt: string;
  remainingMs: number;
};

export type PersonalExtensionOperationBeginInput = PersonalExtensionLeaseAuthority & {
  kind: PersonalExtensionOperationKind;
  targetEnsembleId: string;
  requestedDeadlineMs?: number;
};

export type PersonalExtensionOperationEndInput = PersonalExtensionLeaseAuthority & {
  operationHandle: string;
  /**
   * `conclusive` is only a request to evaluate server-owned proof. It is never
   * sufficient by itself to clear a dispatching recovery journal.
   */
  disposition?: "aborted" | "conclusive";
};

export type PersonalExtensionOperationGrant = {
  operationHandle: string;
  kind: PersonalExtensionOperationKind;
  deadlineAt: string;
  remainingMs: number;
};

type PersonalExtensionCoordinationKernelStateBase = {
  extensionId: string;
  serverBootId: string;
  contentHash: string;
  fence: number;
};

export type PersonalExtensionCoordinationKernelState = PersonalExtensionCoordinationKernelStateBase &
  (
    | {
        mode: "active";
        coordinationActive: true;
        role: "writer" | "follower";
        remainingMs: number;
      }
    | {
        mode: Exclude<PersonalExtensionCoordinationRow["mode"], "active">;
        coordinationActive: false;
        role: "follower";
        remainingMs: 0;
      }
  );

export type PersonalExtensionProtectedResourceKind = "extension-storage" | "lorebook";

export type PersonalExtensionProtectedResource = {
  kind: PersonalExtensionProtectedResourceKind;
  resourceId: string;
  expectedRevision: number;
};

export type PersonalExtensionFencedMutationContext = PersonalExtensionLeaseAuthority & {
  operationHandle: string;
};

export type PersonalExtensionJournalResourceRevision = {
  kind: PersonalExtensionProtectedResourceKind;
  resourceId: string;
} & ({ presence: "present"; resourceRevision: number } | { presence: "absent"; resourceRevision: null });

export type PersonalExtensionLorebookRegistryTransition =
  | { action: "bind"; resourceId: string; expectedRevision: null }
  | { action: "unbind"; resourceId: string; expectedRevision: number };

export type PersonalExtensionFencedMutationOptions = {
  operationKind?: PersonalExtensionOperationKind;
};

export type PersonalExtensionOperationConclusionEvidence = {
  coordination: PersonalExtensionCoordinationRow;
  journal: PersonalExtensionOperationJournalRow;
  resourceRevisions: readonly PersonalExtensionJournalResourceRevision[];
};

export type PersonalExtensionOperationConclusionProof = (
  tx: DB,
  evidence: PersonalExtensionOperationConclusionEvidence,
) => Promise<boolean>;

export type PersonalExtensionBlockedJournalRecoveryProof = (
  tx: DB,
  evidence: PersonalExtensionOperationConclusionEvidence,
) => Promise<boolean>;

export type PersonalExtensionOperationDispatchTarget =
  | {
      kind: "resources";
      resources: readonly PersonalExtensionProtectedResource[];
    }
  | {
      kind: "registry-transition";
      transition: PersonalExtensionLorebookRegistryTransition;
    };

export type PersonalExtensionOperationDispatchMarkerEvidence = PersonalExtensionOperationConclusionEvidence & {
  dispatch: PersonalExtensionOperationDispatchTarget;
};

export type PersonalExtensionOperationDispatchMarkerProof = (
  tx: DB,
  evidence: PersonalExtensionOperationDispatchMarkerEvidence,
) => Promise<boolean>;

export type PersonalExtensionProtectedResourceRegistry = {
  version: typeof PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION;
  extensionStorage: { resourceRevision: number };
  lorebooks: Record<string, { resourceRevision: number }>;
};

export type PersonalExtensionActivationSnapshot = {
  contentHash: string;
  configRevision: number;
  rawStorageValue: string;
  registry: PersonalExtensionProtectedResourceRegistry;
};

export type PersonalExtensionActivationBarrier = {
  extensionId: string;
  snapshot: PersonalExtensionActivationSnapshot;
  previousRow: PersonalExtensionCoordinationRow | null;
};

export type PersonalExtensionAdminValidationResult = Pick<
  PersonalExtensionActivationSnapshot,
  "contentHash" | "configRevision" | "rawStorageValue" | "registry"
>;

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// Process-wide rather than factory-local: accidentally constructing two
// service facades must not create two authority lanes for one extension.
const extensionMutexes = new Map<string, AsyncMutex>();
// Profile restore rewrites every protected table across multiple strict
// barriers. Normal coordination/legacy mutation admission takes this gate
// before an extension mutex; restore takes it once for the whole lifecycle.
// This intentionally serializes only the short server-side commit sections,
// not an operation's external embedding work or its full lease tenure.
const profileRestoreAdmissionGate = new AsyncMutex();

export function runPersonalExtensionCoordinationRestoreExclusive<T>(operation: () => Promise<T>) {
  if (typeof operation !== "function") throw kernelError("invalid-request");
  return profileRestoreAdmissionGate.runExclusive(operation);
}

type RuntimeLease = {
  tokenDigest: string;
  holderSessionId: string;
  serverBootId: string;
  fence: number;
  deadlineMs: number;
};

type RuntimeOperation = {
  extensionId: string;
  fence: number;
  deadlineMs: number;
};

type RuntimeHandoff = {
  requestId: string;
  requester: string;
  fence: number;
  phase: "draining" | "reserved";
  deadlineMs: number;
};

// Monotonic deadlines are meaningful only within this process/boot. Keep them
// process-wide with the mutexes so two facades cannot disagree about liveness.
const runtimeLeaseDeadlines = new Map<string, RuntimeLease>();
const runtimeOperationDeadlines = new Map<string, RuntimeOperation>();
const runtimeHandoffDeadlines = new Map<string, RuntimeHandoff>();

function mutexFor(extensionId: string) {
  let mutex = extensionMutexes.get(extensionId);
  if (!mutex) {
    mutex = new AsyncMutex();
    extensionMutexes.set(extensionId, mutex);
  }
  return mutex;
}

function runWithExtensionMutexes<T>(extensionIds: readonly string[], operation: () => Promise<T>): Promise<T> {
  const ids = [...new Set(extensionIds)].sort();
  const acquire = (index: number): Promise<T> =>
    index >= ids.length ? operation() : mutexFor(ids[index]!).runExclusive(() => acquire(index + 1));
  return acquire(0);
}

function kernelError(code: PersonalExtensionCoordinationKernelErrorCode, cause?: unknown) {
  return new PersonalExtensionCoordinationKernelError(code, cause === undefined ? undefined : { cause });
}

function requireIdentifier(value: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw kernelError("invalid-request");
  }
}

function requireTargetEnsembleId(value: string) {
  if (typeof value !== "string" || !TARGET_ENSEMBLE_ID_PATTERN.test(value)) {
    throw kernelError("invalid-request");
  }
}

function requireHandoffRequestId(value: string) {
  if (typeof value !== "string" || !HANDOFF_REQUEST_ID_PATTERN.test(value)) {
    throw kernelError("invalid-request");
  }
}

function requireFinitePositive(value: number) {
  if (!Number.isFinite(value) || value <= 0) throw kernelError("invalid-request");
  return value;
}

function requireResourceRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw kernelError("invalid-request");
  }
  return value;
}

function parseRegistryRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw kernelError("coordination-unavailable");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parsePersonalExtensionProtectedResourceRegistry(
  serialized: string,
): PersonalExtensionProtectedResourceRegistry {
  if (typeof serialized !== "string") throw kernelError("coordination-unavailable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw kernelError("coordination-unavailable", error);
  }
  if (!isPlainRecord(parsed) || !exactKeys(parsed, ["version", "extensionStorage", "lorebooks"])) {
    throw kernelError("coordination-unavailable");
  }
  if (parsed.version !== PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION) {
    throw kernelError("coordination-unavailable");
  }
  if (!isPlainRecord(parsed.extensionStorage) || !exactKeys(parsed.extensionStorage, ["resourceRevision"])) {
    throw kernelError("coordination-unavailable");
  }
  if (!isPlainRecord(parsed.lorebooks)) throw kernelError("coordination-unavailable");

  const lorebooks: Record<string, { resourceRevision: number }> = {};
  for (const [lorebookId, value] of Object.entries(parsed.lorebooks)) {
    try {
      requireIdentifier(lorebookId);
    } catch {
      throw kernelError("coordination-unavailable");
    }
    if (!isPlainRecord(value) || !exactKeys(value, ["resourceRevision"])) {
      throw kernelError("coordination-unavailable");
    }
    lorebooks[lorebookId] = { resourceRevision: parseRegistryRevision(value.resourceRevision) };
  }
  return {
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: parseRegistryRevision(parsed.extensionStorage.resourceRevision) },
    lorebooks,
  };
}

export function serializePersonalExtensionProtectedResourceRegistry(
  registry: PersonalExtensionProtectedResourceRegistry,
) {
  const lorebooks = Object.fromEntries(
    Object.entries(registry.lorebooks)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([lorebookId, value]) => [lorebookId, { resourceRevision: value.resourceRevision }]),
  );
  return JSON.stringify({
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: registry.extensionStorage.resourceRevision },
    lorebooks,
  });
}

function normalizeProtectedResources(
  context: PersonalExtensionFencedMutationContext,
  resources: readonly PersonalExtensionProtectedResource[],
) {
  if (!Array.isArray(resources) || resources.length === 0) throw kernelError("invalid-request");
  const normalized: PersonalExtensionProtectedResource[] = [];
  const keys = new Set<string>();
  for (const resource of resources) {
    if (!resource || (resource.kind !== "extension-storage" && resource.kind !== "lorebook")) {
      throw kernelError("invalid-request");
    }
    requireIdentifier(resource.resourceId);
    requireResourceRevision(resource.expectedRevision);
    if (resource.kind === "extension-storage" && resource.resourceId !== context.extensionId) {
      throw kernelError("coordination-unavailable");
    }
    const key = `${resource.kind}\u0000${resource.resourceId}`;
    if (keys.has(key)) throw kernelError("invalid-request");
    keys.add(key);
    normalized.push({
      kind: resource.kind,
      resourceId: resource.resourceId,
      expectedRevision: resource.expectedRevision,
    });
  }
  return normalized;
}

function journalResourceKey(resource: Pick<PersonalExtensionJournalResourceRevision, "kind" | "resourceId">) {
  return `${resource.kind}\u0000${resource.resourceId}`;
}

export function parsePersonalExtensionJournalResourceRevisions(
  serialized: string,
): PersonalExtensionJournalResourceRevision[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw kernelError("coordination-unavailable", error);
  }
  if (!Array.isArray(parsed)) throw kernelError("coordination-unavailable");
  const revisions: PersonalExtensionJournalResourceRevision[] = [];
  const keys = new Set<string>();
  for (const candidate of parsed) {
    if (
      !isPlainRecord(candidate) ||
      !exactKeys(candidate, ["kind", "resourceId", "presence", "resourceRevision"]) ||
      (candidate.kind !== "extension-storage" && candidate.kind !== "lorebook") ||
      typeof candidate.resourceId !== "string" ||
      (candidate.presence !== "present" && candidate.presence !== "absent")
    ) {
      throw kernelError("coordination-unavailable");
    }
    requireIdentifier(candidate.resourceId);
    let revision: PersonalExtensionJournalResourceRevision;
    if (candidate.presence === "present") {
      requireResourceRevision(candidate.resourceRevision as number);
      revision = {
        kind: candidate.kind,
        resourceId: candidate.resourceId,
        presence: "present",
        resourceRevision: candidate.resourceRevision as number,
      };
    } else {
      if (candidate.kind !== "lorebook" || candidate.resourceRevision !== null) {
        throw kernelError("coordination-unavailable");
      }
      revision = {
        kind: "lorebook",
        resourceId: candidate.resourceId,
        presence: "absent",
        resourceRevision: null,
      };
    }
    const key = journalResourceKey(revision);
    if (keys.has(key)) throw kernelError("coordination-unavailable");
    keys.add(key);
    revisions.push(revision);
  }
  return revisions;
}

function serializeJournalResourceRevisions(resources: readonly PersonalExtensionJournalResourceRevision[]) {
  return JSON.stringify(
    [...resources]
      .sort((left, right) => journalResourceKey(left).localeCompare(journalResourceKey(right)))
      .map((resource) => ({
        kind: resource.kind,
        resourceId: resource.resourceId,
        presence: resource.presence,
        resourceRevision: resource.resourceRevision,
      })),
  );
}

function mergeJournalResourceRevisions(
  current: readonly PersonalExtensionJournalResourceRevision[],
  committed: readonly PersonalExtensionJournalResourceRevision[],
) {
  const merged = new Map(current.map((resource) => [journalResourceKey(resource), resource]));
  for (const resource of committed) merged.set(journalResourceKey(resource), resource);
  return [...merged.values()];
}

function digestSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function digestMatches(storedDigest: string | null, rawSecret: string) {
  if (
    !storedDigest ||
    !/^[a-f0-9]{64}$/u.test(storedDigest) ||
    typeof rawSecret !== "string" ||
    rawSecret.length < 16 ||
    rawSecret.length > 1024
  ) {
    return false;
  }
  const candidate = digestSecret(rawSecret);
  return timingSafeEqual(Buffer.from(storedDigest, "hex"), Buffer.from(candidate, "hex"));
}

function nextFence(fence: number) {
  if (!Number.isSafeInteger(fence) || fence < 0 || fence >= Number.MAX_SAFE_INTEGER) {
    throw kernelError("coordination-unavailable");
  }
  return fence + 1;
}

function isOperationKind(value: string): value is PersonalExtensionOperationKind {
  return Object.prototype.hasOwnProperty.call(PERSONAL_EXTENSION_OPERATION_DEADLINES_MS, value);
}

function parseOperations(serialized: string): PersistedPersonalExtensionOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw kernelError("coordination-unavailable", error);
  }
  if (!Array.isArray(parsed)) throw kernelError("coordination-unavailable");

  const operations = parsed.map((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !("digest" in candidate) ||
      typeof candidate.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(candidate.digest) ||
      !("kind" in candidate) ||
      typeof candidate.kind !== "string" ||
      !isOperationKind(candidate.kind) ||
      !("targetEnsembleId" in candidate) ||
      typeof candidate.targetEnsembleId !== "string" ||
      !TARGET_ENSEMBLE_ID_PATTERN.test(candidate.targetEnsembleId) ||
      !("holderSessionId" in candidate) ||
      typeof candidate.holderSessionId !== "string" ||
      candidate.holderSessionId.length === 0 ||
      !("fence" in candidate) ||
      typeof candidate.fence !== "number" ||
      !Number.isSafeInteger(candidate.fence) ||
      candidate.fence < 0 ||
      !("startedAt" in candidate) ||
      typeof candidate.startedAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.startedAt)) ||
      !("deadlineAt" in candidate) ||
      typeof candidate.deadlineAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.deadlineAt)) ||
      !("drainEligible" in candidate) ||
      typeof candidate.drainEligible !== "boolean"
    ) {
      throw kernelError("coordination-unavailable");
    }
    return {
      digest: candidate.digest,
      kind: candidate.kind,
      targetEnsembleId: candidate.targetEnsembleId,
      holderSessionId: candidate.holderSessionId,
      fence: candidate.fence,
      startedAt: candidate.startedAt,
      deadlineAt: candidate.deadlineAt,
      drainEligible: candidate.drainEligible,
    };
  });
  if (new Set(operations.map((operation) => operation.digest)).size !== operations.length) {
    throw kernelError("coordination-unavailable");
  }
  return operations;
}

function hasAnyHandoff(row: PersonalExtensionCoordinationRow) {
  return [row.handoffRequestId, row.handoffRequester, row.handoffDeadlineAt].some(
    (value) => typeof value === "string" && value.length > 0,
  );
}

function parseHandoff(row: PersonalExtensionCoordinationRow) {
  if (!hasAnyHandoff(row)) return null;
  if (
    typeof row.handoffRequestId !== "string" ||
    !HANDOFF_REQUEST_ID_PATTERN.test(row.handoffRequestId) ||
    typeof row.handoffRequester !== "string" ||
    row.handoffRequester.length === 0 ||
    row.handoffRequester.length > 512 ||
    typeof row.handoffDeadlineAt !== "string" ||
    !Number.isFinite(Date.parse(row.handoffDeadlineAt))
  ) {
    throw kernelError("coordination-unavailable");
  }
  return {
    requestId: row.handoffRequestId,
    requester: row.handoffRequester,
    deadlineAt: row.handoffDeadlineAt,
  };
}

function hasHandoff(row: PersonalExtensionCoordinationRow) {
  return parseHandoff(row) !== null;
}

function exactApprovedContentHash(
  extension: { enabled: string; contentHash: string; approvedHash: string | null } | undefined,
) {
  if (!extension || extension.enabled !== "true" || extension.contentHash !== extension.approvedHash) return "";
  return extension.contentHash;
}

function assertActiveMode(
  row: PersonalExtensionCoordinationRow | undefined,
): asserts row is PersonalExtensionCoordinationRow {
  if (!row || row.mode === "inactive") throw kernelError("coordination-inactive");
  if (row.mode !== "active") throw kernelError("coordination-transition-blocked");
}

export function createPersonalExtensionCoordinationKernel(
  db: DB,
  options: PersonalExtensionCoordinationKernelOptions = {},
) {
  const serverBootId = options.serverBootId ?? PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const randomRequestId = options.randomRequestId ?? (() => randomUUID());
  const leaseTtlMs = requireFinitePositive(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
  const operationDeadlinesMs = {
    mutation: requireFinitePositive(
      options.operationDeadlinesMs?.mutation ?? PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.mutation,
    ),
    vectorize: requireFinitePositive(
      options.operationDeadlinesMs?.vectorize ?? PERSONAL_EXTENSION_OPERATION_DEADLINES_MS.vectorize,
    ),
  } satisfies Record<PersonalExtensionOperationKind, number>;
  const proveDispatchMarker = options.proveDispatchMarker;
  if (proveDispatchMarker !== undefined && typeof proveDispatchMarker !== "function") {
    throw kernelError("invalid-request");
  }
  const afterHandoffCommitted = options.afterHandoffCommitted;
  if (afterHandoffCommitted !== undefined && typeof afterHandoffCommitted !== "function") {
    throw kernelError("invalid-request");
  }

  requireIdentifier(serverBootId);

  const leaseRuntimeKey = (extensionId: string) => `${serverBootId}\u0000${extensionId}`;
  const operationRuntimeKey = (extensionId: string, digest: string) =>
    `${serverBootId}\u0000${extensionId}\u0000${digest}`;
  const handoffRuntimeKey = (extensionId: string) => `${serverBootId}\u0000${extensionId}`;

  const checkedMonotonicNow = () => {
    const value = monotonicNow();
    if (!Number.isFinite(value) || value < 0) throw kernelError("coordination-unavailable");
    return value;
  };

  const checkedWallNow = () => {
    const value = wallNow();
    if (!Number.isFinite(value)) throw kernelError("coordination-unavailable");
    return value;
  };

  const issueUniqueSecret = (excludedDigests: Set<string>) => {
    for (let attempt = 0; attempt < MAX_RANDOM_SECRET_ATTEMPTS; attempt++) {
      const secret = randomToken();
      if (typeof secret !== "string" || secret.length < 16 || secret.length > 1024) continue;
      const digest = digestSecret(secret);
      if (!excludedDigests.has(digest)) return { secret, digest };
    }
    throw kernelError("coordination-unavailable");
  };

  const issueHandoffRequestId = () => {
    for (let attempt = 0; attempt < MAX_RANDOM_SECRET_ATTEMPTS; attempt++) {
      const requestId = randomRequestId();
      if (typeof requestId === "string" && HANDOFF_REQUEST_ID_PATTERN.test(requestId)) return requestId;
    }
    throw kernelError("coordination-unavailable");
  };

  const readActiveContext = async (
    tx: DB,
    input: Pick<PersonalExtensionLeaseAuthority, "extensionId" | "serverBootId" | "contentHash">,
  ): Promise<PersonalExtensionCoordinationRow> => {
    const [coordinationRows, extensionRows] = await Promise.all([
      tx
        .select()
        .from(personalExtensionCoordination)
        .where(eq(personalExtensionCoordination.extensionId, input.extensionId)),
      tx
        .select({
          enabled: installedExtensions.enabled,
          contentHash: installedExtensions.contentHash,
          approvedHash: installedExtensions.approvedHash,
        })
        .from(installedExtensions)
        .where(eq(installedExtensions.id, input.extensionId)),
    ]);
    const row = coordinationRows[0];
    assertActiveMode(row);
    const approvedHash = exactApprovedContentHash(extensionRows[0]);
    if (
      input.serverBootId !== serverBootId ||
      approvedHash.length === 0 ||
      input.contentHash !== approvedHash ||
      row.contentHash !== approvedHash
    ) {
      if (input.serverBootId !== serverBootId) throw kernelError("lease-lost");
      throw kernelError("extension-runtime-changed");
    }
    return row;
  };

  const assertExactAuthority = (row: PersonalExtensionCoordinationRow, input: PersonalExtensionLeaseAuthority) => {
    if (
      row.serverBootId !== serverBootId ||
      row.serverBootId !== input.serverBootId ||
      row.contentHash !== input.contentHash ||
      row.holderSessionId !== input.holderSessionId ||
      row.fence !== input.fence ||
      !digestMatches(row.leaseTokenDigest, input.leaseToken)
    ) {
      throw kernelError("lease-lost");
    }
  };

  const liveLeaseRuntime = (row: PersonalExtensionCoordinationRow, nowMs: number) => {
    const runtime = runtimeLeaseDeadlines.get(leaseRuntimeKey(row.extensionId));
    return runtime &&
      row.leaseTokenDigest === runtime.tokenDigest &&
      row.holderSessionId === runtime.holderSessionId &&
      row.serverBootId === runtime.serverBootId &&
      row.fence === runtime.fence &&
      nowMs < runtime.deadlineMs
      ? runtime
      : null;
  };

  const isLeaseLive = (row: PersonalExtensionCoordinationRow, nowMs: number) => liveLeaseRuntime(row, nowMs) !== null;

  const assertLeaseLive = (row: PersonalExtensionCoordinationRow, nowMs: number) => {
    if (!isLeaseLive(row, nowMs)) throw kernelError("lease-expired");
  };

  const liveHandoffRuntime = (
    row: PersonalExtensionCoordinationRow,
    handoff: NonNullable<ReturnType<typeof parseHandoff>>,
    phase: RuntimeHandoff["phase"],
    nowMs: number,
  ) => {
    const runtime = runtimeHandoffDeadlines.get(handoffRuntimeKey(row.extensionId));
    return runtime &&
      runtime.requestId === handoff.requestId &&
      runtime.requester === handoff.requester &&
      runtime.fence === row.fence &&
      runtime.phase === phase &&
      nowMs < runtime.deadlineMs
      ? runtime
      : null;
  };

  const assertOperationLive = (
    row: PersonalExtensionCoordinationRow,
    context: PersonalExtensionFencedMutationContext,
    monotonicMs: number,
    wallMs: number,
  ): PersistedPersonalExtensionOperation => {
    const operation = parseOperations(row.activeOperations).find(
      (candidate) =>
        digestMatches(candidate.digest, context.operationHandle) &&
        candidate.holderSessionId === context.holderSessionId &&
        candidate.fence === context.fence,
    );
    if (!operation) throw kernelError("operation-lost");
    const runtime = runtimeOperationDeadlines.get(operationRuntimeKey(context.extensionId, operation.digest));
    if (
      !runtime ||
      runtime.extensionId !== context.extensionId ||
      runtime.fence !== context.fence ||
      monotonicMs >= runtime.deadlineMs ||
      wallMs >= Date.parse(operation.deadlineAt)
    ) {
      throw kernelError("operation-lost");
    }
    return operation;
  };

  const readOperationJournal = async (tx: DB, extensionId: string, operation: PersistedPersonalExtensionOperation) => {
    const rows = await tx
      .select()
      .from(personalExtensionOperationJournal)
      .where(eq(personalExtensionOperationJournal.operationDigest, operation.digest));
    const journal = rows[0];
    if (
      !journal ||
      journal.extensionId !== extensionId ||
      journal.operationKind !== operation.kind ||
      journal.targetEnsembleId !== operation.targetEnsembleId ||
      journal.fence !== operation.fence ||
      (journal.phase !== "prepared" && journal.phase !== "dispatching" && journal.phase !== "final") ||
      !Number.isFinite(Date.parse(journal.preparedAt)) ||
      !Number.isFinite(Date.parse(journal.updatedAt)) ||
      (journal.phase === "prepared" && (journal.dispatchingAt !== null || journal.finalAt !== null)) ||
      (journal.phase === "dispatching" &&
        (!journal.dispatchingAt || !Number.isFinite(Date.parse(journal.dispatchingAt)) || journal.finalAt !== null)) ||
      (journal.phase === "final" &&
        (!journal.dispatchingAt ||
          !Number.isFinite(Date.parse(journal.dispatchingAt)) ||
          !journal.finalAt ||
          !Number.isFinite(Date.parse(journal.finalAt))))
    ) {
      throw kernelError("coordination-unavailable");
    }
    return {
      journal,
      resourceRevisions: parsePersonalExtensionJournalResourceRevisions(journal.protectedResourceRevisions),
    };
  };

  const readUnresolvedOperationJournals = async (tx: DB, extensionId: string) => {
    const rows = await tx
      .select()
      .from(personalExtensionOperationJournal)
      .where(eq(personalExtensionOperationJournal.extensionId, extensionId));
    return rows.filter((journal) => journal.phase !== "final");
  };

  const registeredResource = (
    registry: PersonalExtensionProtectedResourceRegistry,
    resource: Pick<PersonalExtensionProtectedResource, "kind" | "resourceId">,
  ) => (resource.kind === "extension-storage" ? registry.extensionStorage : registry.lorebooks[resource.resourceId]);

  const assertRequestedResourceRevisions = (
    registry: PersonalExtensionProtectedResourceRegistry,
    resources: readonly PersonalExtensionProtectedResource[],
  ) => {
    for (const resource of resources) {
      const registered = registeredResource(registry, resource);
      if (!registered) throw kernelError("coordination-unavailable");
      if (registered.resourceRevision !== resource.expectedRevision) {
        throw kernelError(
          resource.kind === "extension-storage" ? "storage-revision-conflict" : "resource-revision-conflict",
        );
      }
    }
  };

  const journalRevisionsAreCurrent = (
    registry: PersonalExtensionProtectedResourceRegistry,
    revisions: readonly PersonalExtensionJournalResourceRevision[],
  ) =>
    revisions.every((resource) => {
      const registered = registeredResource(registry, resource);
      return resource.presence === "absent"
        ? registered === undefined
        : registered?.resourceRevision === resource.resourceRevision;
    });

  const assertDurableDispatchMarker = async (
    tx: DB,
    coordination: PersonalExtensionCoordinationRow,
    journalState: Awaited<ReturnType<typeof readOperationJournal>>,
    dispatch: PersonalExtensionOperationDispatchTarget,
  ) => {
    if (
      proveDispatchMarker === undefined ||
      !(await proveDispatchMarker(tx, {
        coordination,
        journal: journalState.journal,
        resourceRevisions: journalState.resourceRevisions,
        dispatch,
      }))
    ) {
      throw kernelError("coordination-unavailable");
    }
  };

  const reapExpiredOperations = (
    extensionId: string,
    fence: number,
    operations: PersistedPersonalExtensionOperation[],
    nowMs: number,
  ) => {
    const kept: PersistedPersonalExtensionOperation[] = [];
    const reapedKeys: string[] = [];
    const reapedOperations: PersistedPersonalExtensionOperation[] = [];
    for (const operation of operations) {
      const key = operationRuntimeKey(extensionId, operation.digest);
      const runtime = runtimeOperationDeadlines.get(key);
      if (runtime && runtime.extensionId === extensionId && runtime.fence === fence && nowMs >= runtime.deadlineMs) {
        reapedKeys.push(key);
        reapedOperations.push(operation);
      } else {
        kept.push(operation);
      }
    }
    return { kept, reapedKeys, reapedOperations };
  };

  const clearSafelyReapedPreparedJournals = async (
    tx: DB,
    extensionId: string,
    reapedOperations: readonly PersistedPersonalExtensionOperation[],
  ) => {
    for (const operation of reapedOperations) {
      const journalState = await readOperationJournal(tx, extensionId, operation);
      if (journalState.journal.phase === "prepared" && journalState.resourceRevisions.length === 0) {
        // No protected resource reached even the marker commit, so the server
        // can conclusively resolve this expired admission without replaying or
        // touching user data. Any prepared journal with revisions remains in
        // the recovery domain and blocks later admission.
        await tx
          .delete(personalExtensionOperationJournal)
          .where(eq(personalExtensionOperationJournal.operationDigest, journalState.journal.operationDigest));
      }
    }
  };

  const clearSafelyClosableBlockedJournals = async (
    tx: DB,
    row: PersonalExtensionCoordinationRow,
    proveBlockedJournalRecovery?: PersonalExtensionBlockedJournalRecoveryProof,
  ) => {
    const unresolved = await readUnresolvedOperationJournals(tx, row.extensionId);
    for (const journal of unresolved) {
      let revisions: PersonalExtensionJournalResourceRevision[];
      try {
        revisions = parsePersonalExtensionJournalResourceRevisions(journal.protectedResourceRevisions);
      } catch {
        throw kernelError("coordination-validation-failed");
      }
      const preparedMs = Date.parse(journal.preparedAt);
      const dispatchingMs = journal.dispatchingAt === null ? Number.NaN : Date.parse(journal.dispatchingAt);
      const updatedMs = Date.parse(journal.updatedAt);
      const commonEvidenceIsInvalid =
        !/^[a-f0-9]{64}$/u.test(journal.operationDigest) ||
        journal.extensionId !== row.extensionId ||
        !TARGET_ENSEMBLE_ID_PATTERN.test(journal.targetEnsembleId) ||
        (journal.operationKind !== "mutation" && journal.operationKind !== "vectorize") ||
        !Number.isSafeInteger(journal.fence) ||
        journal.fence < 0 ||
        journal.fence > row.fence ||
        journal.finalAt !== null ||
        !Number.isFinite(preparedMs) ||
        !Number.isFinite(updatedMs) ||
        updatedMs < preparedMs;
      if (commonEvidenceIsInvalid) {
        throw kernelError("coordination-validation-failed");
      }

      const safelyPrepared = journal.phase === "prepared" && journal.dispatchingAt === null && revisions.length === 0;
      let provenDispatching = false;
      if (
        journal.phase === "dispatching" &&
        Number.isFinite(dispatchingMs) &&
        dispatchingMs >= preparedMs &&
        updatedMs >= dispatchingMs &&
        proveBlockedJournalRecovery !== undefined
      ) {
        try {
          provenDispatching = await proveBlockedJournalRecovery(tx, {
            coordination: row,
            journal,
            resourceRevisions: revisions,
          });
        } catch {
          provenDispatching = false;
        }
      }
      if (!safelyPrepared && !provenDispatching) {
        // Prepared evidence is closable only before any marker commit. A
        // dispatching journal needs a fresh server-owned marker proof; malformed
        // or marker-free evidence stays operator-visible in blocked mode.
        throw kernelError("coordination-validation-failed");
      }
    }
    for (const journal of unresolved) {
      await tx
        .delete(personalExtensionOperationJournal)
        .where(eq(personalExtensionOperationJournal.operationDigest, journal.operationDigest));
    }
  };

  const runStrictMutation = async <T>(
    extensionId: string,
    mutation: (tx: DB) => Promise<T>,
    afterCommit?: (result: T) => void,
  ) => {
    requireIdentifier(extensionId);
    return profileRestoreAdmissionGate.runExclusive(() =>
      mutexFor(extensionId).runExclusive(async () => {
        if (!db._fileStore.isStrictDurabilitySupported()) throw kernelError("coordination-unavailable");
        let result: T;
        try {
          result = await db.transaction(async (tx) => {
            const pending = await mutation(tx);
            await tx._fileStore.flushStrict();
            return pending;
          });
        } catch (error) {
          if (error instanceof PersonalExtensionCoordinationKernelError) throw error;
          throw kernelError("coordination-unavailable", error);
        }
        afterCommit?.(result);
        return result;
      }),
    );
  };

  const runExtensionLifecycleMutations = async <T>(
    extensionIds: readonly string[],
    mutation: (tx: DB) => Promise<T>,
  ) => {
    if (!Array.isArray(extensionIds) || typeof mutation !== "function") throw kernelError("invalid-request");
    const ids = [...new Set(extensionIds)];
    for (const extensionId of ids) requireIdentifier(extensionId);
    return profileRestoreAdmissionGate.runExclusive(() =>
      runWithExtensionMutexes(ids, async () => {
        return db.transaction(async (tx) => {
          for (const extensionId of ids) {
            const rows = await tx
              .select({ mode: personalExtensionCoordination.mode })
              .from(personalExtensionCoordination)
              .where(eq(personalExtensionCoordination.extensionId, extensionId));
            if (rows[0] && rows[0].mode !== "inactive") {
              throw kernelError("coordination-transition-blocked");
            }
          }
          return mutation(tx);
        });
      }),
    );
  };

  const runExtensionLifecycleMutation = <T>(extensionId: string, mutation: (tx: DB) => Promise<T>) =>
    runExtensionLifecycleMutations([extensionId], mutation);

  const runLegacyInactiveMutation = async <T>(extensionId: string, mutation: (tx: DB) => Promise<T>) => {
    requireIdentifier(extensionId);
    if (typeof mutation !== "function") throw kernelError("invalid-request");
    return profileRestoreAdmissionGate.runExclusive(() =>
      mutexFor(extensionId).runExclusive(async () => {
        try {
          return await db.transaction(async (tx) => {
            const rows = await tx
              .select({ mode: personalExtensionCoordination.mode })
              .from(personalExtensionCoordination)
              .where(eq(personalExtensionCoordination.extensionId, extensionId));
            if (rows[0] && rows[0].mode !== "inactive") throw kernelError("coordination-required");
            return mutation(tx);
          });
        } catch (error) {
          if (error instanceof PersonalExtensionCoordinationKernelError) throw error;
          throw kernelError("coordination-unavailable", error);
        }
      }),
    );
  };

  const runFencedResourceMutation = async <T>(
    context: PersonalExtensionFencedMutationContext,
    resources: readonly PersonalExtensionProtectedResource[],
    callback: (tx: DB) => Promise<T>,
    mutationOptions: PersonalExtensionFencedMutationOptions = {},
  ) => {
    requireIdentifier(context.extensionId);
    requireIdentifier(context.holderSessionId);
    requireIdentifier(context.serverBootId);
    requireIdentifier(context.contentHash);
    requireIdentifier(context.leaseToken);
    requireIdentifier(context.operationHandle);
    requireResourceRevision(context.fence);
    if (typeof callback !== "function") throw kernelError("invalid-request");
    const requestedResources = normalizeProtectedResources(context, resources);
    const dispatchTarget: PersonalExtensionOperationDispatchTarget = {
      kind: "resources",
      resources: requestedResources.map((resource) => ({ ...resource })),
    };

    // Extension-storage writes include the marker and semantic config writes;
    // they are not by themselves evidence that protected lorebook data was
    // dispatched. The first lorebook mutation owns a separate, strict
    // prepared -> dispatching barrier before its callback can run.
    if (requestedResources.some((resource) => resource.kind === "lorebook")) {
      await runStrictMutation(context.extensionId, async (tx) => {
        const row = await readActiveContext(tx, context);
        assertExactAuthority(row, context);
        const monotonicMs = checkedMonotonicNow();
        const wallMs = checkedWallNow();
        const operation = assertOperationLive(row, context, monotonicMs, wallMs);
        if (mutationOptions.operationKind && operation.kind !== mutationOptions.operationKind) {
          throw kernelError("operation-kind-unsupported");
        }
        if (hasHandoff(row) && !operation.drainEligible) throw kernelError("handoff-pending");
        const registry = parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry);
        // A stale caller is rejected while the journal still proves that no
        // protected-data dispatch was admitted.
        assertRequestedResourceRevisions(registry, requestedResources);
        const journalState = await readOperationJournal(tx, context.extensionId, operation);
        const { journal, resourceRevisions } = journalState;
        if (journal.phase === "final") throw kernelError("operation-lost");
        if (
          !resourceRevisions.some(
            (resource) => resource.kind === "extension-storage" && resource.resourceId === context.extensionId,
          )
        ) {
          // The prepared journal alone is not the recovery marker. Require a
          // separately committed extension-storage barrier before protected
          // lorebook data can enter dispatching.
          throw kernelError("coordination-unavailable");
        }
        await assertDurableDispatchMarker(tx, row, journalState, dispatchTarget);
        if (journal.phase === "prepared") {
          const timestamp = new Date(wallMs).toISOString();
          await tx
            .update(personalExtensionOperationJournal)
            .set({ phase: "dispatching", dispatchingAt: timestamp, updatedAt: timestamp })
            .where(eq(personalExtensionOperationJournal.operationDigest, operation.digest));
        }
      });
    }

    return runStrictMutation(context.extensionId, async (tx) => {
      const row = await readActiveContext(tx, context);
      assertExactAuthority(row, context);
      const monotonicMs = checkedMonotonicNow();
      const wallMs = checkedWallNow();
      const operation = assertOperationLive(row, context, monotonicMs, wallMs);
      if (mutationOptions.operationKind && operation.kind !== mutationOptions.operationKind) {
        throw kernelError("operation-kind-unsupported");
      }
      if (hasHandoff(row) && !operation.drainEligible) throw kernelError("handoff-pending");

      const registry = parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry);
      assertRequestedResourceRevisions(registry, requestedResources);
      const journalState = await readOperationJournal(tx, context.extensionId, operation);
      if (journalState.journal.phase === "final") throw kernelError("operation-lost");
      if (
        requestedResources.some((resource) => resource.kind === "lorebook") &&
        journalState.journal.phase !== "dispatching"
      ) {
        throw kernelError("coordination-unavailable");
      }
      if (requestedResources.some((resource) => resource.kind === "lorebook")) {
        // Recheck inside the data transaction as well. Another strict storage
        // commit may have removed or moved the marker after the dispatching
        // barrier but before this callback acquired the extension mutex.
        await assertDurableDispatchMarker(tx, row, journalState, dispatchTarget);
      }
      const nextRegistry: PersonalExtensionProtectedResourceRegistry = {
        version: registry.version,
        extensionStorage: { ...registry.extensionStorage },
        lorebooks: Object.fromEntries(
          Object.entries(registry.lorebooks).map(([lorebookId, resource]) => [lorebookId, { ...resource }]),
        ),
      };
      for (const resource of requestedResources) {
        const registered = registeredResource(nextRegistry, resource)!;
        if (registered.resourceRevision >= Number.MAX_SAFE_INTEGER - 1) {
          throw kernelError("coordination-unavailable");
        }
        registered.resourceRevision += 1;
      }

      const result = await callback(tx);
      const nextSerializedRegistry = serializePersonalExtensionProtectedResourceRegistry(nextRegistry);
      await tx
        .update(personalExtensionCoordination)
        .set({
          protectedLorebookRegistry: nextSerializedRegistry,
          updatedAt: new Date(wallMs).toISOString(),
        })
        .where(
          and(
            eq(personalExtensionCoordination.extensionId, context.extensionId),
            eq(personalExtensionCoordination.serverBootId, context.serverBootId),
            eq(personalExtensionCoordination.fence, context.fence),
            eq(personalExtensionCoordination.leaseTokenDigest, row.leaseTokenDigest),
            eq(personalExtensionCoordination.protectedLorebookRegistry, row.protectedLorebookRegistry),
          ),
        );
      const committedResourceRevisions = requestedResources.map((resource) => ({
        kind: resource.kind,
        resourceId: resource.resourceId,
        presence: "present" as const,
        resourceRevision: registeredResource(nextRegistry, resource)!.resourceRevision,
      }));
      await tx
        .update(personalExtensionOperationJournal)
        .set({
          protectedResourceRevisions: serializeJournalResourceRevisions(
            mergeJournalResourceRevisions(journalState.resourceRevisions, committedResourceRevisions),
          ),
          updatedAt: new Date(wallMs).toISOString(),
        })
        .where(eq(personalExtensionOperationJournal.operationDigest, operation.digest));
      return {
        result,
        resourceRevisions: committedResourceRevisions,
      };
    });
  };

  const runFencedResourceRead = async <T>(
    context: PersonalExtensionLeaseAuthority,
    callback: (db: DB, registry: PersonalExtensionProtectedResourceRegistry) => Promise<T>,
  ) => {
    requireIdentifier(context.extensionId);
    requireIdentifier(context.holderSessionId);
    requireIdentifier(context.serverBootId);
    requireIdentifier(context.contentHash);
    requireIdentifier(context.leaseToken);
    requireResourceRevision(context.fence);
    if (typeof callback !== "function") throw kernelError("invalid-request");
    return mutexFor(context.extensionId).runExclusive(async () => {
      if (!db._fileStore.isStrictDurabilitySupported()) throw kernelError("coordination-unavailable");
      const row = await readActiveContext(db, context);
      assertExactAuthority(row, context);
      assertLeaseLive(row, checkedMonotonicNow());
      const registry = parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry);
      return callback(db, registry);
    });
  };

  const runFencedOperationRead = async <T>(
    context: PersonalExtensionFencedMutationContext,
    operationKind: PersonalExtensionOperationKind,
    callback: (db: DB, registry: PersonalExtensionProtectedResourceRegistry) => Promise<T>,
  ) => {
    requireIdentifier(context.operationHandle);
    if (!isOperationKind(operationKind) || typeof callback !== "function") throw kernelError("invalid-request");
    return runFencedResourceRead(context, async (readDb, registry) => {
      const row = await readActiveContext(readDb, context);
      const operation = assertOperationLive(row, context, checkedMonotonicNow(), checkedWallNow());
      if (operation.kind !== operationKind) throw kernelError("operation-kind-unsupported");
      if (hasHandoff(row) && !operation.drainEligible) throw kernelError("handoff-pending");
      return callback(readDb, registry);
    });
  };

  const assertRegistryTransition = (
    registry: PersonalExtensionProtectedResourceRegistry,
    transition: PersonalExtensionLorebookRegistryTransition,
  ) => {
    const current = registry.lorebooks[transition.resourceId];
    if (transition.action === "bind") {
      if (transition.expectedRevision !== null || current) throw kernelError("resource-revision-conflict");
      return;
    }
    requireResourceRevision(transition.expectedRevision);
    if (!current) throw kernelError("protected-resource-unregistered");
    if (current.resourceRevision !== transition.expectedRevision) throw kernelError("resource-revision-conflict");
  };

  const runFencedLorebookRegistryTransition = async <T>(
    context: PersonalExtensionFencedMutationContext,
    transition: PersonalExtensionLorebookRegistryTransition,
    callback: (tx: DB) => Promise<T>,
  ) => {
    requireIdentifier(context.extensionId);
    requireIdentifier(context.holderSessionId);
    requireIdentifier(context.serverBootId);
    requireIdentifier(context.contentHash);
    requireIdentifier(context.leaseToken);
    requireIdentifier(context.operationHandle);
    requireIdentifier(transition.resourceId);
    requireResourceRevision(context.fence);
    if ((transition.action !== "bind" && transition.action !== "unbind") || typeof callback !== "function") {
      throw kernelError("invalid-request");
    }
    const dispatchTarget: PersonalExtensionOperationDispatchTarget = {
      kind: "registry-transition",
      transition:
        transition.action === "bind"
          ? { action: "bind", resourceId: transition.resourceId, expectedRevision: null }
          : {
              action: "unbind",
              resourceId: transition.resourceId,
              expectedRevision: transition.expectedRevision,
            },
    };

    await runStrictMutation(context.extensionId, async (tx) => {
      const row = await readActiveContext(tx, context);
      assertExactAuthority(row, context);
      const operation = assertOperationLive(row, context, checkedMonotonicNow(), checkedWallNow());
      if (operation.kind !== "mutation") throw kernelError("operation-kind-unsupported");
      if (hasHandoff(row) && !operation.drainEligible) throw kernelError("handoff-pending");
      const registry = parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry);
      assertRegistryTransition(registry, transition);
      const journalState = await readOperationJournal(tx, context.extensionId, operation);
      const { journal, resourceRevisions } = journalState;
      if (journal.phase === "final") throw kernelError("operation-lost");
      if (
        !resourceRevisions.some(
          (resource) =>
            resource.kind === "extension-storage" &&
            resource.resourceId === context.extensionId &&
            resource.presence === "present",
        )
      ) {
        throw kernelError("coordination-unavailable");
      }
      await assertDurableDispatchMarker(tx, row, journalState, dispatchTarget);
      if (journal.phase === "prepared") {
        const timestamp = new Date(checkedWallNow()).toISOString();
        await tx
          .update(personalExtensionOperationJournal)
          .set({ phase: "dispatching", dispatchingAt: timestamp, updatedAt: timestamp })
          .where(eq(personalExtensionOperationJournal.operationDigest, operation.digest));
      }
    });

    return runStrictMutation(context.extensionId, async (tx) => {
      const row = await readActiveContext(tx, context);
      assertExactAuthority(row, context);
      const wallMs = checkedWallNow();
      const operation = assertOperationLive(row, context, checkedMonotonicNow(), wallMs);
      if (operation.kind !== "mutation") throw kernelError("operation-kind-unsupported");
      if (hasHandoff(row) && !operation.drainEligible) throw kernelError("handoff-pending");
      const registry = parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry);
      assertRegistryTransition(registry, transition);
      const journalState = await readOperationJournal(tx, context.extensionId, operation);
      if (journalState.journal.phase !== "dispatching") throw kernelError("coordination-unavailable");
      await assertDurableDispatchMarker(tx, row, journalState, dispatchTarget);

      const result = await callback(tx);
      const nextRegistry: PersonalExtensionProtectedResourceRegistry = {
        version: registry.version,
        extensionStorage: { ...registry.extensionStorage },
        lorebooks: Object.fromEntries(
          Object.entries(registry.lorebooks).map(([lorebookId, resource]) => [lorebookId, { ...resource }]),
        ),
      };
      let committedResource: PersonalExtensionJournalResourceRevision;
      if (transition.action === "bind") {
        nextRegistry.lorebooks[transition.resourceId] = { resourceRevision: 0 };
        committedResource = {
          kind: "lorebook",
          resourceId: transition.resourceId,
          presence: "present",
          resourceRevision: 0,
        };
      } else {
        delete nextRegistry.lorebooks[transition.resourceId];
        committedResource = {
          kind: "lorebook",
          resourceId: transition.resourceId,
          presence: "absent",
          resourceRevision: null,
        };
      }

      await tx
        .update(personalExtensionCoordination)
        .set({
          protectedLorebookRegistry: serializePersonalExtensionProtectedResourceRegistry(nextRegistry),
          updatedAt: new Date(wallMs).toISOString(),
        })
        .where(
          and(
            eq(personalExtensionCoordination.extensionId, context.extensionId),
            eq(personalExtensionCoordination.serverBootId, context.serverBootId),
            eq(personalExtensionCoordination.fence, context.fence),
            eq(personalExtensionCoordination.leaseTokenDigest, row.leaseTokenDigest),
            eq(personalExtensionCoordination.protectedLorebookRegistry, row.protectedLorebookRegistry),
          ),
        );
      await tx
        .update(personalExtensionOperationJournal)
        .set({
          protectedResourceRevisions: serializeJournalResourceRevisions(
            mergeJournalResourceRevisions(journalState.resourceRevisions, [committedResource]),
          ),
          updatedAt: new Date(wallMs).toISOString(),
        })
        .where(eq(personalExtensionOperationJournal.operationDigest, operation.digest));
      return { result, resourceRevision: committedResource.resourceRevision };
    });
  };

  const emptyRegistry = (configRevision = 0): PersonalExtensionProtectedResourceRegistry => ({
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: configRevision },
    lorebooks: {},
  });

  const clearRuntimeAuthority = (extensionId: string) => {
    runtimeLeaseDeadlines.delete(leaseRuntimeKey(extensionId));
    runtimeHandoffDeadlines.delete(handoffRuntimeKey(extensionId));
    for (const key of [...runtimeOperationDeadlines.keys()]) {
      if (key.startsWith(`${serverBootId}\u0000${extensionId}\u0000`)) runtimeOperationDeadlines.delete(key);
    }
  };

  const requireAuthorityClear = (row: PersonalExtensionCoordinationRow) => {
    const operations = parseOperations(row.activeOperations);
    if (operations.length > 0) throw kernelError("operations-active");
    if (hasAnyHandoff(row)) throw kernelError("handoff-pending");
    if (row.leaseTokenDigest !== null || row.holderSessionId !== null || row.expiresAt !== null) {
      throw kernelError("lease-held");
    }
  };

  const activationBarrierMatches = (
    row: PersonalExtensionCoordinationRow,
    barrier: PersonalExtensionActivationBarrier,
  ) =>
    row.mode === "activating" &&
    row.serverBootId === serverBootId &&
    row.contentHash === barrier.snapshot.contentHash &&
    row.configRevision === barrier.snapshot.configRevision &&
    row.protectedLorebookRegistry === serializePersonalExtensionProtectedResourceRegistry(barrier.snapshot.registry);

  const beginActivation = async (
    extensionId: string,
    snapshot: PersonalExtensionActivationSnapshot,
  ): Promise<PersonalExtensionActivationBarrier> => {
    requireIdentifier(extensionId);
    requireIdentifier(snapshot.contentHash);
    requireResourceRevision(snapshot.configRevision);
    if (typeof snapshot.rawStorageValue !== "string") throw kernelError("invalid-request");
    if (snapshot.registry.extensionStorage.resourceRevision !== snapshot.configRevision) {
      throw kernelError("coordination-validation-failed");
    }
    const serializedRegistry = serializePersonalExtensionProtectedResourceRegistry(snapshot.registry);
    parsePersonalExtensionProtectedResourceRegistry(serializedRegistry);

    const previousRow = await runStrictMutation(extensionId, async (tx) => {
      const rows = await tx
        .select()
        .from(personalExtensionCoordination)
        .where(eq(personalExtensionCoordination.extensionId, extensionId));
      const previous = rows[0] ?? null;
      if (previous && previous.mode !== "inactive") throw kernelError("coordination-transition-blocked");
      if (previous) requireAuthorityClear(previous);
      if ((await readUnresolvedOperationJournals(tx, extensionId)).length > 0) {
        throw kernelError("operations-active");
      }
      const timestamp = new Date(checkedWallNow()).toISOString();
      if (previous) {
        await tx
          .update(personalExtensionCoordination)
          .set({
            contentHash: snapshot.contentHash,
            mode: "activating",
            serverBootId,
            configRevision: snapshot.configRevision,
            protectedLorebookRegistry: serializedRegistry,
            updatedAt: timestamp,
          })
          .where(eq(personalExtensionCoordination.extensionId, extensionId));
      } else {
        await tx.insert(personalExtensionCoordination).values({
          extensionId,
          contentHash: snapshot.contentHash,
          mode: "activating",
          serverBootId,
          fence: 0,
          leaseTokenDigest: null,
          holderSessionId: null,
          expiresAt: null,
          configRevision: snapshot.configRevision,
          protectedLorebookRegistry: serializedRegistry,
          handoffRequestId: null,
          handoffRequester: null,
          handoffDeadlineAt: null,
          activeOperations: "[]",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      return previous;
    });
    return { extensionId, snapshot, previousRow };
  };

  const completeActivation = async (
    barrier: PersonalExtensionActivationBarrier,
    validate: (tx: DB) => Promise<PersonalExtensionAdminValidationResult>,
  ) => {
    if (typeof validate !== "function") throw kernelError("invalid-request");
    const committed = await runStrictMutation(
      barrier.extensionId,
      async (tx) => {
        const rows = await tx
          .select()
          .from(personalExtensionCoordination)
          .where(eq(personalExtensionCoordination.extensionId, barrier.extensionId));
        const row = rows[0];
        if (!row || !activationBarrierMatches(row, barrier)) throw kernelError("coordination-transition-blocked");
        requireAuthorityClear(row);

        const validated = await validate(tx);
        const validatedRegistry = serializePersonalExtensionProtectedResourceRegistry(validated.registry);
        if (
          validated.contentHash !== barrier.snapshot.contentHash ||
          validated.configRevision !== barrier.snapshot.configRevision ||
          validated.rawStorageValue !== barrier.snapshot.rawStorageValue ||
          validatedRegistry !== row.protectedLorebookRegistry
        ) {
          throw kernelError("coordination-validation-failed");
        }
        const fence = nextFence(row.fence);
        const timestamp = new Date(checkedWallNow()).toISOString();
        await tx
          .update(personalExtensionCoordination)
          .set({
            mode: "active",
            serverBootId,
            contentHash: validated.contentHash,
            fence,
            leaseTokenDigest: null,
            holderSessionId: null,
            expiresAt: null,
            configRevision: validated.configRevision,
            protectedLorebookRegistry: validatedRegistry,
            handoffRequestId: null,
            handoffRequester: null,
            handoffDeadlineAt: null,
            activeOperations: "[]",
            updatedAt: timestamp,
          })
          .where(eq(personalExtensionCoordination.extensionId, barrier.extensionId));
        return {
          extensionId: barrier.extensionId,
          mode: "active" as const,
          serverBootId,
          contentHash: validated.contentHash,
          fence,
          configRevision: validated.configRevision,
        };
      },
      () => clearRuntimeAuthority(barrier.extensionId),
    );
    return committed;
  };

  const rollbackActivation = async (barrier: PersonalExtensionActivationBarrier) => {
    return runStrictMutation(
      barrier.extensionId,
      async (tx) => {
        const rows = await tx
          .select()
          .from(personalExtensionCoordination)
          .where(eq(personalExtensionCoordination.extensionId, barrier.extensionId));
        const row = rows[0];
        if (!row || !activationBarrierMatches(row, barrier)) throw kernelError("coordination-transition-blocked");
        const timestamp = new Date(checkedWallNow()).toISOString();
        const previous = barrier.previousRow;
        await tx
          .update(personalExtensionCoordination)
          .set(
            previous
              ? {
                  contentHash: previous.contentHash,
                  mode: "inactive",
                  serverBootId: previous.serverBootId,
                  fence: previous.fence,
                  leaseTokenDigest: null,
                  holderSessionId: null,
                  expiresAt: null,
                  configRevision: previous.configRevision,
                  protectedLorebookRegistry: previous.protectedLorebookRegistry,
                  handoffRequestId: null,
                  handoffRequester: null,
                  handoffDeadlineAt: null,
                  activeOperations: "[]",
                  updatedAt: timestamp,
                }
              : {
                  contentHash: "",
                  mode: "inactive",
                  serverBootId,
                  fence: row.fence,
                  leaseTokenDigest: null,
                  holderSessionId: null,
                  expiresAt: null,
                  configRevision: 0,
                  protectedLorebookRegistry: serializePersonalExtensionProtectedResourceRegistry(emptyRegistry()),
                  handoffRequestId: null,
                  handoffRequester: null,
                  handoffDeadlineAt: null,
                  activeOperations: "[]",
                  updatedAt: timestamp,
                },
          )
          .where(eq(personalExtensionCoordination.extensionId, barrier.extensionId));
        return { rolledBack: true as const };
      },
      () => clearRuntimeAuthority(barrier.extensionId),
    );
  };

  const blockActivation = async (barrier: PersonalExtensionActivationBarrier) => {
    return runStrictMutation(
      barrier.extensionId,
      async (tx) => {
        const rows = await tx
          .select()
          .from(personalExtensionCoordination)
          .where(eq(personalExtensionCoordination.extensionId, barrier.extensionId));
        const row = rows[0];
        if (!row || !activationBarrierMatches(row, barrier)) throw kernelError("coordination-transition-blocked");
        const fence = nextFence(row.fence);
        await tx
          .update(personalExtensionCoordination)
          .set({
            mode: "blocked",
            serverBootId,
            fence,
            leaseTokenDigest: null,
            holderSessionId: null,
            expiresAt: null,
            handoffRequestId: null,
            handoffRequester: null,
            handoffDeadlineAt: null,
            activeOperations: "[]",
            updatedAt: new Date(checkedWallNow()).toISOString(),
          })
          .where(eq(personalExtensionCoordination.extensionId, barrier.extensionId));
        return { blocked: true as const, fence };
      },
      () => clearRuntimeAuthority(barrier.extensionId),
    );
  };

  const deactivateCoordination = async (extensionId: string) => {
    requireIdentifier(extensionId);
    await runStrictMutation(extensionId, async (tx) => {
      const rows = await tx
        .select()
        .from(personalExtensionCoordination)
        .where(eq(personalExtensionCoordination.extensionId, extensionId));
      const row = rows[0];
      if (!row || row.mode === "inactive") throw kernelError("coordination-inactive");
      if (row.mode !== "active" && row.mode !== "draining-deactivate") {
        throw kernelError("coordination-transition-blocked");
      }
      if (parseOperations(row.activeOperations).length > 0) throw kernelError("operations-active");
      if ((await readUnresolvedOperationJournals(tx, extensionId)).length > 0) {
        throw kernelError("operations-active");
      }
      if (hasAnyHandoff(row)) throw kernelError("handoff-pending");
      if (row.mode === "active") {
        await tx
          .update(personalExtensionCoordination)
          .set({ mode: "draining-deactivate", serverBootId, updatedAt: new Date(checkedWallNow()).toISOString() })
          .where(eq(personalExtensionCoordination.extensionId, extensionId));
      }
    });

    return runStrictMutation(
      extensionId,
      async (tx) => {
        const rows = await tx
          .select()
          .from(personalExtensionCoordination)
          .where(eq(personalExtensionCoordination.extensionId, extensionId));
        const row = rows[0];
        if (!row || row.mode !== "draining-deactivate") throw kernelError("coordination-transition-blocked");
        if (parseOperations(row.activeOperations).length > 0) throw kernelError("operations-active");
        if ((await readUnresolvedOperationJournals(tx, extensionId)).length > 0) {
          throw kernelError("operations-active");
        }
        if (hasAnyHandoff(row)) throw kernelError("handoff-pending");
        const fence = nextFence(row.fence);
        await tx
          .update(personalExtensionCoordination)
          .set({
            mode: "inactive",
            serverBootId,
            fence,
            leaseTokenDigest: null,
            holderSessionId: null,
            expiresAt: null,
            handoffRequestId: null,
            handoffRequester: null,
            handoffDeadlineAt: null,
            activeOperations: "[]",
            updatedAt: new Date(checkedWallNow()).toISOString(),
          })
          .where(eq(personalExtensionCoordination.extensionId, extensionId));
        return {
          extensionId,
          mode: "inactive" as const,
          serverBootId,
          contentHash: row.contentHash,
          fence,
          configRevision: row.configRevision,
        };
      },
      () => clearRuntimeAuthority(extensionId),
    );
  };

  const recoverBlockedCoordination = async (
    extensionId: string,
    validate: (tx: DB, row: PersonalExtensionCoordinationRow) => Promise<PersonalExtensionAdminValidationResult>,
    proveBlockedJournalRecovery?: PersonalExtensionBlockedJournalRecoveryProof,
  ) => {
    requireIdentifier(extensionId);
    if (typeof validate !== "function") throw kernelError("invalid-request");
    if (proveBlockedJournalRecovery !== undefined && typeof proveBlockedJournalRecovery !== "function") {
      throw kernelError("invalid-request");
    }
    return runStrictMutation(
      extensionId,
      async (tx) => {
        const rows = await tx
          .select()
          .from(personalExtensionCoordination)
          .where(eq(personalExtensionCoordination.extensionId, extensionId));
        const row = rows[0];
        if (!row || row.mode !== "blocked") throw kernelError("coordination-transition-blocked");
        requireAuthorityClear(row);
        const validated = await validate(tx, row);
        if (
          validated.configRevision !== row.configRevision ||
          serializePersonalExtensionProtectedResourceRegistry(validated.registry) !== row.protectedLorebookRegistry
        ) {
          throw kernelError("coordination-validation-failed");
        }
        await clearSafelyClosableBlockedJournals(tx, row, proveBlockedJournalRecovery);
        const fence = nextFence(row.fence);
        await tx
          .update(personalExtensionCoordination)
          .set({
            mode: "inactive",
            serverBootId,
            fence,
            leaseTokenDigest: null,
            holderSessionId: null,
            expiresAt: null,
            handoffRequestId: null,
            handoffRequester: null,
            handoffDeadlineAt: null,
            activeOperations: "[]",
            updatedAt: new Date(checkedWallNow()).toISOString(),
          })
          .where(eq(personalExtensionCoordination.extensionId, extensionId));
        return {
          extensionId,
          mode: "inactive" as const,
          serverBootId,
          contentHash: row.contentHash,
          fence,
          configRevision: row.configRevision,
        };
      },
      () => clearRuntimeAuthority(extensionId),
    );
  };

  const recoverStaleTransitions = async () => {
    const rows = await db.select().from(personalExtensionCoordination);
    const stale = rows.filter(
      (row) =>
        row.serverBootId !== serverBootId &&
        (row.mode === "activating" ||
          row.mode === "draining-deactivate" ||
          row.mode === "restoring" ||
          row.mode === "active"),
    );
    let blocked = 0;
    for (const candidate of stale) {
      const changed = await runStrictMutation(
        candidate.extensionId,
        async (tx) => {
          const currentRows = await tx
            .select()
            .from(personalExtensionCoordination)
            .where(eq(personalExtensionCoordination.extensionId, candidate.extensionId));
          const row = currentRows[0];
          if (!row || row.serverBootId === serverBootId) {
            return false;
          }
          const staleTransition =
            row.mode === "activating" || row.mode === "draining-deactivate" || row.mode === "restoring";
          let interruptedActiveAuthority = false;
          if (row.mode === "active") {
            let hasPersistedOperations = false;
            try {
              hasPersistedOperations = parseOperations(row.activeOperations).length > 0;
            } catch {
              // Malformed persisted authority is itself unsafe to adopt in a
              // fresh process. Move it to operator recovery rather than
              // allowing acquire to erase the evidence.
              hasPersistedOperations = true;
            }
            interruptedActiveAuthority =
              hasPersistedOperations || (await readUnresolvedOperationJournals(tx, row.extensionId)).length > 0;
          }
          if (!staleTransition && !interruptedActiveAuthority) return false;
          await tx
            .update(personalExtensionCoordination)
            .set({
              mode: "blocked",
              serverBootId,
              fence: nextFence(row.fence),
              leaseTokenDigest: null,
              holderSessionId: null,
              expiresAt: null,
              handoffRequestId: null,
              handoffRequester: null,
              handoffDeadlineAt: null,
              activeOperations: "[]",
              updatedAt: new Date(checkedWallNow()).toISOString(),
            })
            .where(eq(personalExtensionCoordination.extensionId, candidate.extensionId));
          return true;
        },
        (didChange) => {
          if (didChange) clearRuntimeAuthority(candidate.extensionId);
        },
      );
      if (changed) blocked += 1;
    }
    return { blocked };
  };

  const getState = async (
    extensionId: string,
    holderSessionId?: string,
  ): Promise<PersonalExtensionCoordinationKernelState | null> => {
    requireIdentifier(extensionId);
    if (holderSessionId !== undefined) requireIdentifier(holderSessionId);

    return mutexFor(extensionId).runExclusive(async () => {
      const [extensionRows, coordinationRows] = await Promise.all([
        db
          .select({
            enabled: installedExtensions.enabled,
            contentHash: installedExtensions.contentHash,
            approvedHash: installedExtensions.approvedHash,
          })
          .from(installedExtensions)
          .where(eq(installedExtensions.id, extensionId)),
        db
          .select()
          .from(personalExtensionCoordination)
          .where(eq(personalExtensionCoordination.extensionId, extensionId)),
      ]);

      const extension = extensionRows[0];
      if (!extension) return null;

      const row = coordinationRows[0];
      const mode = row?.mode ?? "inactive";
      const contentHash = exactApprovedContentHash(extension);
      if (mode === "active" && (!row || contentHash.length === 0 || row.contentHash !== contentHash)) {
        throw kernelError("extension-runtime-changed");
      }

      if (!row) {
        return {
          extensionId,
          serverBootId,
          contentHash,
          mode: "inactive",
          coordinationActive: false,
          fence: 0,
          role: "follower",
          remainingMs: 0,
        };
      }

      if (mode !== "active") {
        return {
          extensionId,
          serverBootId,
          contentHash,
          mode,
          coordinationActive: false,
          fence: row.fence,
          role: "follower",
          remainingMs: 0,
        };
      }

      const monotonicMs = checkedMonotonicNow();
      const runtime = liveLeaseRuntime(row, monotonicMs);
      return {
        extensionId,
        serverBootId,
        contentHash,
        mode,
        coordinationActive: true,
        fence: row.fence,
        role:
          runtime && holderSessionId !== undefined && row.holderSessionId === holderSessionId ? "writer" : "follower",
        remainingMs: runtime ? Math.max(0, Math.floor(runtime.deadlineMs - monotonicMs)) : 0,
      };
    });
  };

  const requestHandoff = async (
    input: PersonalExtensionHandoffRequestInput,
  ): Promise<PersonalExtensionHandoffResponse> => {
    requireIdentifier(input.holderSessionId);
    const committed = await runStrictMutation(
      input.extensionId,
      async (tx) => {
        const row = await readActiveContext(tx, input);
        const monotonicMs = checkedMonotonicNow();
        const wallMs = checkedWallNow();
        const existing = parseHandoff(row);
        if (existing) {
          if (existing.requester !== input.holderSessionId) throw kernelError("handoff-pending");
          const reserved = row.leaseTokenDigest === null && row.holderSessionId === existing.requester;
          if (row.leaseTokenDigest === null && !reserved) throw kernelError("coordination-unavailable");
          const phase: PersonalExtensionHandoffResponse["status"] = reserved ? "reserved" : "draining";
          const runtime = liveHandoffRuntime(row, existing, phase, monotonicMs);
          const remainingMs = runtime
            ? Math.max(0, Math.floor(runtime.deadlineMs - monotonicMs))
            : Math.max(0, Math.floor(Date.parse(existing.deadlineAt) - wallMs));
          return {
            response: {
              requestId: existing.requestId,
              status: phase,
              deadlineAt: existing.deadlineAt,
              remainingMs,
            },
            runtimeHandoff: null,
            reapedKeys: [] as string[],
          };
        }
        if (row.holderSessionId === input.holderSessionId) throw kernelError("invalid-request");
        assertLeaseLive(row, monotonicMs);

        const operations = parseOperations(row.activeOperations);
        const { kept, reapedKeys, reapedOperations } = reapExpiredOperations(
          input.extensionId,
          row.fence,
          operations,
          monotonicMs,
        );
        await clearSafelyReapedPreparedJournals(tx, input.extensionId, reapedOperations);
        let remainingMs = 0;
        for (const operation of kept) {
          const runtime = runtimeOperationDeadlines.get(operationRuntimeKey(input.extensionId, operation.digest));
          if (!runtime || runtime.extensionId !== input.extensionId || runtime.fence !== row.fence) {
            throw kernelError("coordination-unavailable");
          }
          const monotonicRemaining = Math.max(0, Math.floor(runtime.deadlineMs - monotonicMs));
          const wallRemaining = Math.max(0, Math.floor(Date.parse(operation.deadlineAt) - wallMs));
          remainingMs = Math.max(remainingMs, Math.min(monotonicRemaining, wallRemaining));
        }
        const requestId = issueHandoffRequestId();
        const deadlineAt = new Date(wallMs + remainingMs).toISOString();
        const drainingOperations = kept.map((operation) => ({ ...operation, drainEligible: true }));
        await tx
          .update(personalExtensionCoordination)
          .set({
            handoffRequestId: requestId,
            handoffRequester: input.holderSessionId,
            handoffDeadlineAt: deadlineAt,
            activeOperations: JSON.stringify(drainingOperations),
            updatedAt: new Date(wallMs).toISOString(),
          })
          .where(eq(personalExtensionCoordination.extensionId, input.extensionId));
        return {
          response: { requestId, status: "draining" as const, deadlineAt, remainingMs },
          runtimeHandoff: {
            requestId,
            requester: input.holderSessionId,
            fence: row.fence,
            phase: "draining" as const,
            deadlineMs: monotonicMs + remainingMs,
          },
          reapedKeys,
        };
      },
      (result) => {
        for (const key of result.reapedKeys) runtimeOperationDeadlines.delete(key);
        if (result.runtimeHandoff) {
          runtimeHandoffDeadlines.set(handoffRuntimeKey(input.extensionId), result.runtimeHandoff);
          afterHandoffCommitted?.(input.extensionId, result.runtimeHandoff.requestId);
        }
      },
    );
    return committed.response;
  };

  const acquireLease = async (input: PersonalExtensionLeaseAcquireInput): Promise<PersonalExtensionLeaseGrant> => {
    requireIdentifier(input.holderSessionId);
    const committed = await runStrictMutation(
      input.extensionId,
      async (tx) => {
        const row = await readActiveContext(tx, input);
        const monotonicMs = checkedMonotonicNow();
        const wallMs = checkedWallNow();
        if (row.serverBootId !== serverBootId) {
          let hasPersistedOperations = false;
          try {
            hasPersistedOperations = parseOperations(row.activeOperations).length > 0;
          } catch {
            hasPersistedOperations = true;
          }
          const hasUnresolvedJournal = (await readUnresolvedOperationJournals(tx, input.extensionId)).length > 0;
          if (hasPersistedOperations || hasUnresolvedJournal) {
            const fence = nextFence(row.fence);
            await tx
              .update(personalExtensionCoordination)
              .set({
                mode: "blocked",
                serverBootId,
                fence,
                leaseTokenDigest: null,
                holderSessionId: null,
                expiresAt: null,
                handoffRequestId: null,
                handoffRequester: null,
                handoffDeadlineAt: null,
                activeOperations: "[]",
                updatedAt: new Date(wallMs).toISOString(),
              })
              .where(eq(personalExtensionCoordination.extensionId, input.extensionId));
            return { blocked: true as const, fence };
          }
        }
        const handoff = parseHandoff(row);
        const operations = parseOperations(row.activeOperations);
        let fence: number;
        if (handoff) {
          const reserved = row.leaseTokenDigest === null && row.holderSessionId === handoff.requester;
          if (row.leaseTokenDigest === null && !reserved) throw kernelError("coordination-unavailable");
          if (reserved) {
            if (operations.length > 0) throw kernelError("coordination-unavailable");
            const liveReservation = liveHandoffRuntime(row, handoff, "reserved", monotonicMs);
            if (liveReservation) {
              if (input.holderSessionId !== handoff.requester) throw kernelError("handoff-pending");
              fence = row.fence;
            } else {
              // A reservation timeout is only a lazy eligibility change. This
              // acquire owns the next fence transition; no timer callback does.
              fence = nextFence(row.fence);
            }
          } else {
            if (!row.leaseTokenDigest || !row.holderSessionId || row.holderSessionId === handoff.requester) {
              throw kernelError("coordination-unavailable");
            }
            if (isLeaseLive(row, monotonicMs)) throw kernelError("handoff-pending");
            const { kept, reapedOperations } = reapExpiredOperations(
              input.extensionId,
              row.fence,
              operations,
              monotonicMs,
            );
            if (kept.length > 0) {
              // Lease TTL is the dead-writer fallback, but it must not cut
              // across an operation which the server admitted before the
              // handoff. That operation owns its shorter, bounded deadline.
              throw kernelError("handoff-pending");
            }
            await clearSafelyReapedPreparedJournals(tx, input.extensionId, reapedOperations);
            // The old writer did not release. Once its TTL has elapsed, normal
            // acquire is the only fallback and advances the fence exactly once.
            fence = nextFence(row.fence);
          }
        } else {
          if (isLeaseLive(row, monotonicMs)) throw kernelError("lease-held");
          const { kept, reapedOperations } = reapExpiredOperations(
            input.extensionId,
            row.fence,
            operations,
            monotonicMs,
          );
          if (kept.length > 0) {
            // A registered operation remains authoritative through its own
            // shorter, bounded deadline even if lease renewal stopped.
            throw kernelError("operations-active");
          }
          await clearSafelyReapedPreparedJournals(tx, input.extensionId, reapedOperations);
          if ((await readUnresolvedOperationJournals(tx, input.extensionId)).length > 0) {
            const blockedFence = nextFence(row.fence);
            await tx
              .update(personalExtensionCoordination)
              .set({
                mode: "blocked",
                serverBootId,
                fence: blockedFence,
                leaseTokenDigest: null,
                holderSessionId: null,
                expiresAt: null,
                handoffRequestId: null,
                handoffRequester: null,
                handoffDeadlineAt: null,
                activeOperations: "[]",
                updatedAt: new Date(wallMs).toISOString(),
              })
              .where(eq(personalExtensionCoordination.extensionId, input.extensionId));
            return { blocked: true as const, fence: blockedFence };
          }
          fence = nextFence(row.fence);
        }

        const excludedDigests = new Set(operations.map((operation) => operation.digest));
        if (row.leaseTokenDigest) excludedDigests.add(row.leaseTokenDigest);
        const issued = issueUniqueSecret(excludedDigests);
        const expiresAt = new Date(wallMs + leaseTtlMs).toISOString();
        await tx
          .update(personalExtensionCoordination)
          .set({
            serverBootId,
            fence,
            leaseTokenDigest: issued.digest,
            holderSessionId: input.holderSessionId,
            expiresAt,
            activeOperations: "[]",
            handoffRequestId: null,
            handoffRequester: null,
            handoffDeadlineAt: null,
            updatedAt: new Date(wallMs).toISOString(),
          })
          .where(eq(personalExtensionCoordination.extensionId, input.extensionId));

        return {
          blocked: false as const,
          response: {
            leaseToken: issued.secret,
            holderSessionId: input.holderSessionId,
            serverBootId,
            contentHash: row.contentHash,
            fence,
            expiresAt,
            remainingMs: leaseTtlMs,
          },
          runtimeLease: {
            tokenDigest: issued.digest,
            holderSessionId: input.holderSessionId,
            serverBootId,
            fence,
            deadlineMs: monotonicMs + leaseTtlMs,
          },
          clearedOperationKeys: operations.map((operation) => operationRuntimeKey(input.extensionId, operation.digest)),
        };
      },
      (result) => {
        if (result.blocked) {
          clearRuntimeAuthority(input.extensionId);
          return;
        }
        runtimeLeaseDeadlines.set(leaseRuntimeKey(input.extensionId), result.runtimeLease);
        runtimeHandoffDeadlines.delete(handoffRuntimeKey(input.extensionId));
        for (const key of result.clearedOperationKeys) runtimeOperationDeadlines.delete(key);
      },
    );
    if (committed.blocked) throw kernelError("coordination-transition-blocked");
    return committed.response;
  };

  const renewLease = async (input: PersonalExtensionLeaseAuthority): Promise<PersonalExtensionLeaseState> => {
    requireIdentifier(input.holderSessionId);
    const committed = await runStrictMutation(
      input.extensionId,
      async (tx) => {
        const row = await readActiveContext(tx, input);
        assertExactAuthority(row, input);
        if (hasHandoff(row)) throw kernelError("handoff-pending");
        const monotonicMs = checkedMonotonicNow();
        const wallMs = checkedWallNow();
        const operations = parseOperations(row.activeOperations);
        const { kept, reapedKeys, reapedOperations } = reapExpiredOperations(
          input.extensionId,
          row.fence,
          operations,
          monotonicMs,
        );
        await clearSafelyReapedPreparedJournals(tx, input.extensionId, reapedOperations);
        const expiresAt = new Date(wallMs + leaseTtlMs).toISOString();
        await tx
          .update(personalExtensionCoordination)
          .set({
            expiresAt,
            activeOperations: JSON.stringify(kept),
            updatedAt: new Date(wallMs).toISOString(),
          })
          .where(eq(personalExtensionCoordination.extensionId, input.extensionId));
        return {
          response: {
            holderSessionId: input.holderSessionId,
            serverBootId,
            contentHash: row.contentHash,
            fence: row.fence,
            expiresAt,
            remainingMs: leaseTtlMs,
          },
          runtimeLease: {
            tokenDigest: row.leaseTokenDigest!,
            holderSessionId: input.holderSessionId,
            serverBootId,
            fence: row.fence,
            deadlineMs: monotonicMs + leaseTtlMs,
          },
          reapedKeys,
        };
      },
      (result) => {
        runtimeLeaseDeadlines.set(leaseRuntimeKey(input.extensionId), result.runtimeLease);
        for (const key of result.reapedKeys) runtimeOperationDeadlines.delete(key);
      },
    );
    return committed.response;
  };

  const releaseLease = async (input: PersonalExtensionLeaseReleaseInput) => {
    requireIdentifier(input.holderSessionId);
    if (input.handoffRequestId !== undefined) requireHandoffRequestId(input.handoffRequestId);
    const committed = await runStrictMutation(
      input.extensionId,
      async (tx) => {
        const row = await readActiveContext(tx, input);
        assertExactAuthority(row, input);
        const monotonicMs = checkedMonotonicNow();
        const wallMs = checkedWallNow();
        const handoff = parseHandoff(row);
        if (handoff) {
          if (input.handoffRequestId !== handoff.requestId) throw kernelError("handoff-pending");
          if (!row.leaseTokenDigest || !row.holderSessionId || row.holderSessionId === handoff.requester) {
            throw kernelError("coordination-unavailable");
          }
        } else if (input.handoffRequestId !== undefined) {
          throw kernelError("invalid-request");
        }
        const operations = parseOperations(row.activeOperations);
        const { kept, reapedKeys, reapedOperations } = reapExpiredOperations(
          input.extensionId,
          row.fence,
          operations,
          monotonicMs,
        );
        if (kept.length > 0) throw kernelError("operations-active");
        await clearSafelyReapedPreparedJournals(tx, input.extensionId, reapedOperations);
        const fence = nextFence(row.fence);
        const claimDeadlineAt = handoff ? new Date(wallMs + leaseTtlMs).toISOString() : null;
        await tx
          .update(personalExtensionCoordination)
          .set({
            serverBootId,
            fence,
            leaseTokenDigest: null,
            holderSessionId: handoff?.requester ?? null,
            expiresAt: claimDeadlineAt,
            activeOperations: "[]",
            handoffRequestId: handoff?.requestId ?? null,
            handoffRequester: handoff?.requester ?? null,
            handoffDeadlineAt: claimDeadlineAt,
            updatedAt: new Date(wallMs).toISOString(),
          })
          .where(eq(personalExtensionCoordination.extensionId, input.extensionId));
        return {
          fence,
          reapedKeys,
          runtimeHandoff: handoff
            ? {
                requestId: handoff.requestId,
                requester: handoff.requester,
                fence,
                phase: "reserved" as const,
                deadlineMs: monotonicMs + leaseTtlMs,
              }
            : null,
        };
      },
      (result) => {
        runtimeLeaseDeadlines.delete(leaseRuntimeKey(input.extensionId));
        if (result.runtimeHandoff) {
          runtimeHandoffDeadlines.set(handoffRuntimeKey(input.extensionId), result.runtimeHandoff);
        } else {
          runtimeHandoffDeadlines.delete(handoffRuntimeKey(input.extensionId));
        }
        for (const key of result.reapedKeys) runtimeOperationDeadlines.delete(key);
      },
    );
    return { fence: committed.fence, serverBootId, contentHash: input.contentHash };
  };

  const beginOperation = async (
    input: PersonalExtensionOperationBeginInput,
  ): Promise<PersonalExtensionOperationGrant> => {
    requireIdentifier(input.holderSessionId);
    requireTargetEnsembleId(input.targetEnsembleId);
    const committed = await runStrictMutation(
      input.extensionId,
      async (tx) => {
        const row = await readActiveContext(tx, input);
        assertExactAuthority(row, input);
        if (hasHandoff(row)) throw kernelError("handoff-pending");
        if (!isOperationKind(input.kind)) throw kernelError("operation-kind-unsupported");
        const monotonicMs = checkedMonotonicNow();
        assertLeaseLive(row, monotonicMs);
        const wallMs = checkedWallNow();
        const maximumDeadlineMs = operationDeadlinesMs[input.kind];
        const requestedDeadlineMs =
          input.requestedDeadlineMs === undefined
            ? maximumDeadlineMs
            : Math.min(requireFinitePositive(input.requestedDeadlineMs), maximumDeadlineMs);
        const operations = parseOperations(row.activeOperations);
        const { kept, reapedKeys, reapedOperations } = reapExpiredOperations(
          input.extensionId,
          row.fence,
          operations,
          monotonicMs,
        );
        await clearSafelyReapedPreparedJournals(tx, input.extensionId, reapedOperations);
        const unresolvedJournals = await readUnresolvedOperationJournals(tx, input.extensionId);
        const activeDigests = new Set(kept.map((operation) => operation.digest));
        const unresolvedDigests = new Set(unresolvedJournals.map((journal) => journal.operationDigest));
        for (const operation of kept) {
          const activeJournal = await readOperationJournal(tx, input.extensionId, operation);
          if (activeJournal.journal.phase === "final") throw kernelError("coordination-unavailable");
        }
        if (
          unresolvedJournals.some((journal) => !activeDigests.has(journal.operationDigest)) ||
          kept.some((operation) => !unresolvedDigests.has(operation.digest))
        ) {
          // Multiple currently registered operations are valid. What must
          // never be admitted around is orphan recovery evidence (or active
          // authority whose journal disappeared): it no longer belongs to a
          // bounded live operation and must be resolved by the recovery domain.
          throw kernelError("coordination-unavailable");
        }
        const excludedDigests = new Set(kept.map((operation) => operation.digest));
        const journalRows = await tx
          .select({ operationDigest: personalExtensionOperationJournal.operationDigest })
          .from(personalExtensionOperationJournal);
        for (const journal of journalRows) excludedDigests.add(journal.operationDigest);
        if (row.leaseTokenDigest) excludedDigests.add(row.leaseTokenDigest);
        const issued = issueUniqueSecret(excludedDigests);
        const deadlineAt = new Date(wallMs + requestedDeadlineMs).toISOString();
        const operation: PersistedPersonalExtensionOperation = {
          digest: issued.digest,
          kind: input.kind,
          targetEnsembleId: input.targetEnsembleId,
          holderSessionId: input.holderSessionId,
          fence: row.fence,
          startedAt: new Date(wallMs).toISOString(),
          deadlineAt,
          // Only operations already registered when requestHandoff commits are
          // promoted to drain-eligible. New admission is blocked thereafter.
          drainEligible: false,
        };
        const preparedAt = new Date(wallMs).toISOString();
        await tx
          .update(personalExtensionCoordination)
          .set({ activeOperations: JSON.stringify([...kept, operation]), updatedAt: new Date(wallMs).toISOString() })
          .where(eq(personalExtensionCoordination.extensionId, input.extensionId));
        await tx.insert(personalExtensionOperationJournal).values({
          operationDigest: issued.digest,
          extensionId: input.extensionId,
          targetEnsembleId: input.targetEnsembleId,
          operationKind: input.kind,
          fence: row.fence,
          phase: "prepared",
          protectedResourceRevisions: "[]",
          preparedAt,
          dispatchingAt: null,
          finalAt: null,
          updatedAt: preparedAt,
        });
        return {
          response: {
            operationHandle: issued.secret,
            kind: input.kind,
            deadlineAt,
            remainingMs: requestedDeadlineMs,
          },
          runtimeOperation: {
            extensionId: input.extensionId,
            fence: row.fence,
            deadlineMs: monotonicMs + requestedDeadlineMs,
          },
          operationKey: operationRuntimeKey(input.extensionId, issued.digest),
          reapedKeys,
        };
      },
      (result) => {
        for (const key of result.reapedKeys) runtimeOperationDeadlines.delete(key);
        runtimeOperationDeadlines.set(result.operationKey, result.runtimeOperation);
      },
    );
    return committed.response;
  };

  const endOperation = async (
    input: PersonalExtensionOperationEndInput,
    proveConclusive?: PersonalExtensionOperationConclusionProof,
  ) => {
    requireIdentifier(input.holderSessionId);
    const disposition = input.disposition ?? "aborted";
    if (disposition !== "aborted" && disposition !== "conclusive") throw kernelError("invalid-request");
    if (proveConclusive !== undefined && typeof proveConclusive !== "function") throw kernelError("invalid-request");
    const committed = await runStrictMutation(
      input.extensionId,
      async (tx) => {
        const row = await readActiveContext(tx, input);
        assertExactAuthority(row, input);
        const wallMs = checkedWallNow();
        const operations = parseOperations(row.activeOperations);
        const operationIndex = operations.findIndex(
          (operation) =>
            digestMatches(operation.digest, input.operationHandle) &&
            operation.holderSessionId === input.holderSessionId &&
            operation.fence === input.fence,
        );
        if (operationIndex < 0) throw kernelError("operation-lost");
        const operation = operations[operationIndex]!;
        const journalState = await readOperationJournal(tx, input.extensionId, operation);
        const remaining = operations.filter((_, index) => index !== operationIndex);
        let finalized = false;
        if (journalState.journal.phase === "prepared") {
          // A prepared journal authoritatively proves that protected-data
          // dispatch never passed the server barrier, so either disposition
          // can safely clear this row.
          await tx
            .delete(personalExtensionOperationJournal)
            .where(eq(personalExtensionOperationJournal.operationDigest, operation.digest));
        } else if (journalState.journal.phase === "dispatching" && disposition === "conclusive") {
          const registry = parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry);
          const latestRevisionsMatch = journalRevisionsAreCurrent(registry, journalState.resourceRevisions);
          const proofAccepted =
            latestRevisionsMatch &&
            proveConclusive !== undefined &&
            (await proveConclusive(tx, {
              coordination: row,
              journal: journalState.journal,
              resourceRevisions: journalState.resourceRevisions,
            }));
          if (proofAccepted) {
            const timestamp = new Date(wallMs).toISOString();
            await tx
              .update(personalExtensionOperationJournal)
              .set({ phase: "final", finalAt: timestamp, updatedAt: timestamp })
              .where(eq(personalExtensionOperationJournal.operationDigest, operation.digest));
            finalized = true;
          }
        }
        await tx
          .update(personalExtensionCoordination)
          .set({ activeOperations: JSON.stringify(remaining), updatedAt: new Date(wallMs).toISOString() })
          .where(eq(personalExtensionCoordination.extensionId, input.extensionId));
        return {
          operationDigest: operation.digest,
          operationKey: operationRuntimeKey(input.extensionId, operation.digest),
          finalized,
        };
      },
      (result) => runtimeOperationDeadlines.delete(result.operationKey),
    );
    if (committed.finalized) {
      // Keep `final` as a durable crash state before removing the evidence. If
      // this second strict barrier fails, the final journal remains available
      // for a future server-owned replay/cleanup pass.
      await runStrictMutation(input.extensionId, async (tx) => {
        const rows = await tx
          .select({ phase: personalExtensionOperationJournal.phase })
          .from(personalExtensionOperationJournal)
          .where(eq(personalExtensionOperationJournal.operationDigest, committed.operationDigest));
        if (rows[0]?.phase === "final") {
          await tx
            .delete(personalExtensionOperationJournal)
            .where(eq(personalExtensionOperationJournal.operationDigest, committed.operationDigest));
        }
      });
    }
    return { ended: true as const, fence: input.fence, serverBootId, contentHash: input.contentHash };
  };

  return {
    getState,
    acquireLease,
    requestHandoff,
    renewLease,
    releaseLease,
    beginOperation,
    endOperation,
    beginActivation,
    completeActivation,
    rollbackActivation,
    blockActivation,
    deactivateCoordination,
    recoverBlockedCoordination,
    recoverStaleTransitions,
    runExtensionLifecycleMutation,
    runExtensionLifecycleMutations,
    runLegacyInactiveMutation,
    runFencedResourceMutation,
    runFencedResourceRead,
    runFencedOperationRead,
    runFencedLorebookRegistryTransition,
  };
}
