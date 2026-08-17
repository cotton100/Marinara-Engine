// ──────────────────────────────────────────────
// Service: Personal Extension Coordination
// ──────────────────────────────────────────────
import {
  PERSONAL_EXTENSION_COORDINATION_CAPABILITIES,
  PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION as SHARED_COORDINATION_SCHEMA_VERSION,
  type PersonalExtensionCoordinationState,
} from "@marinara-engine/shared";
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import {
  installedExtensions,
  personalExtensionCoordination,
  type PersonalExtensionCoordinationRow,
} from "../../db/schema/index.js";
import {
  createPersonalExtensionCoordinationKernel,
  PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID,
  type PersonalExtensionCoordinationKernelOptions,
  type PersonalExtensionHandoffRequestInput,
  type PersonalExtensionLeaseAcquireInput,
  type PersonalExtensionLeaseAuthority,
  type PersonalExtensionLeaseReleaseInput,
  type PersonalExtensionFencedMutationContext,
  type PersonalExtensionFencedMutationOptions,
  type PersonalExtensionLorebookRegistryTransition,
  type PersonalExtensionOperationBeginInput,
  type PersonalExtensionOperationEndInput,
  type PersonalExtensionOperationKind,
  type PersonalExtensionProtectedResourceRegistry,
  type PersonalExtensionProtectedResource,
} from "./personal-extension-coordination-kernel.service.js";
import {
  createPersonalExtensionCoordinationAdminService,
  proveCmbOperationConclusiveState,
  proveCmbOperationDispatchMarker,
} from "./personal-extension-coordination-admin.service.js";
import {
  getPersonalExtensionCoordinationEventService,
  type PersonalExtensionCoordinationEventDraft,
} from "./personal-extension-coordination-events.service.js";

export const PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION = SHARED_COORDINATION_SCHEMA_VERSION;

export type InactivePersonalExtensionCoordinationState = {
  schemaVersion: typeof PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION;
  extensionId: string;
  serverBootId: string;
  contentHash: string;
  mode: "inactive";
  coordinationActive: false;
  capabilities: readonly [];
};

type PersonalExtensionCoordinationEventPublisher = {
  publish(extensionId: string, draft: PersonalExtensionCoordinationEventDraft): unknown;
};

export type PersonalExtensionCoordinationServiceOptions = Omit<
  PersonalExtensionCoordinationKernelOptions,
  "proveDispatchMarker" | "afterHandoffCommitted"
> & {
  eventPublisher?: PersonalExtensionCoordinationEventPublisher;
};

export class PersonalExtensionCoordinationUnavailableError extends Error {
  readonly code = "coordination-unavailable";

  constructor() {
    super("Personal extension coordination is not inactive.");
  }
}

export class PersonalExtensionNotFoundError extends Error {
  readonly code = "personal-extension-not-found" as const;

  constructor() {
    super("Personal Extension not found.");
    this.name = "PersonalExtensionNotFoundError";
  }
}

function approvedContentHash(row: { contentHash: string; approvedHash: string | null } | undefined) {
  if (!row || row.contentHash !== row.approvedHash) return "";
  return row.contentHash;
}

function isUnregisteredCoordinationTable(error: unknown) {
  return (
    error instanceof Error && error.message === "[file-storage] Unsupported table: personal_extension_coordination"
  );
}

export function createPersonalExtensionCoordinationService(
  db: DB,
  options: PersonalExtensionCoordinationServiceOptions = {},
) {
  const { eventPublisher: injectedEventPublisher, ...kernelOptions } = options;
  // The boot ID belongs to this server process, not to a request or a stored row.
  const serverBootId = kernelOptions.serverBootId ?? PERSONAL_EXTENSION_COORDINATION_PROCESS_BOOT_ID;
  const publishAfterCommit = (extensionId: string, draft: PersonalExtensionCoordinationEventDraft) => {
    try {
      (injectedEventPublisher ?? getPersonalExtensionCoordinationEventService(db)).publish(extensionId, draft);
    } catch {
      // Publication is only a content-free wake-up hint. The durable mutation
      // remains authoritative and bounded polling is the recovery path.
      logger.warn(
        "[personal-extension-coordination] Post-commit event publication failed; polling fallback remains active",
      );
    }
  };
  const kernel = createPersonalExtensionCoordinationKernel(db, {
    ...kernelOptions,
    // This proof is server-owned and cannot be replaced through service test
    // options or a page-controlled request.
    proveDispatchMarker: proveCmbOperationDispatchMarker,
    afterHandoffCommitted(extensionId, requestId) {
      publishAfterCommit(extensionId, { type: "handoff-requested", requestId });
    },
  });
  const admin = createPersonalExtensionCoordinationAdminService(db, kernelOptions);

  const getPersistedRow = async (extensionId: string): Promise<PersonalExtensionCoordinationRow | null> => {
    try {
      const rows = await db
        .select()
        .from(personalExtensionCoordination)
        .where(eq(personalExtensionCoordination.extensionId, extensionId));
      return rows[0] ?? null;
    } catch (error) {
      // FILE_BACKED_TABLES registration is intentionally owned by the strict
      // persistence slice. Before it lands, there cannot be a persisted row.
      if (isUnregisteredCoordinationTable(error)) return null;
      throw error;
    }
  };

  const requireKnownExtension = async (extensionId: string) => {
    const rows = await db
      .select({ id: installedExtensions.id })
      .from(installedExtensions)
      .where(eq(installedExtensions.id, extensionId));
    if (!rows[0]) throw new PersonalExtensionNotFoundError();
  };

  const getState = async (
    extensionId: string,
    holderSessionId?: string,
  ): Promise<PersonalExtensionCoordinationState> => {
    const state = await kernel.getState(extensionId, holderSessionId);
    if (!state) throw new PersonalExtensionNotFoundError();
    if (state.mode === "active") {
      return {
        schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
        ...state,
        capabilities: [
          PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[0],
          PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[1],
          PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[2],
          PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[3],
          PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[4],
          PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[5],
          PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[6],
        ],
      };
    }
    return {
      schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
      ...state,
      coordinationActive: false,
      role: "follower",
      remainingMs: 0,
      capabilities: [],
    };
  };

  return {
    getPersistedRow,
    getState,
    async getInactiveState(extensionId: string): Promise<InactivePersonalExtensionCoordinationState> {
      const persisted = await getPersistedRow(extensionId);
      if (persisted && persisted.mode !== "inactive") {
        throw new PersonalExtensionCoordinationUnavailableError();
      }
      const rows = await db
        .select({ contentHash: installedExtensions.contentHash, approvedHash: installedExtensions.approvedHash })
        .from(installedExtensions)
        .where(eq(installedExtensions.id, extensionId));

      return {
        schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
        extensionId,
        serverBootId,
        // The persisted row records the authority it last observed, but it is
        // never the approval authority. Extension updates can make that value
        // stale while coordination is inactive.
        contentHash: approvedContentHash(rows[0]),
        mode: "inactive",
        coordinationActive: false,
        capabilities: [],
      };
    },
    async acquireLease(input: PersonalExtensionLeaseAcquireInput) {
      await requireKnownExtension(input.extensionId);
      const committed = await kernel.acquireLease(input);
      publishAfterCommit(input.extensionId, { type: "lease-changed" });
      return committed;
    },
    async requestHandoff(input: PersonalExtensionHandoffRequestInput) {
      await requireKnownExtension(input.extensionId);
      return kernel.requestHandoff(input);
    },
    async renewLease(input: PersonalExtensionLeaseAuthority) {
      await requireKnownExtension(input.extensionId);
      return kernel.renewLease(input);
    },
    async releaseLease(input: PersonalExtensionLeaseReleaseInput) {
      await requireKnownExtension(input.extensionId);
      const committed = await kernel.releaseLease(input);
      publishAfterCommit(input.extensionId, { type: "lease-changed" });
      return committed;
    },
    async beginOperation(input: PersonalExtensionOperationBeginInput) {
      await requireKnownExtension(input.extensionId);
      return kernel.beginOperation(input);
    },
    async endOperation(input: PersonalExtensionOperationEndInput) {
      await requireKnownExtension(input.extensionId);
      return kernel.endOperation(input, proveCmbOperationConclusiveState);
    },
    async activateCoordination(extensionId: string) {
      await requireKnownExtension(extensionId);
      const committed = await admin.activateCoordination(extensionId);
      publishAfterCommit(extensionId, { type: "lease-changed" });
      return committed;
    },
    async deactivateCoordination(extensionId: string) {
      const committed = await admin.deactivateCoordination(extensionId);
      publishAfterCommit(extensionId, { type: "lease-changed" });
      return committed;
    },
    async recoverBlockedCoordination(extensionId: string) {
      const committed = await admin.recoverBlockedCoordination(extensionId);
      publishAfterCommit(extensionId, { type: "lease-changed" });
      return committed;
    },
    recoverStaleTransitions() {
      return admin.recoverStaleTransitions();
    },
    async runLegacyInactiveMutation<T>(extensionId: string, mutation: (tx: DB) => Promise<T>) {
      await requireKnownExtension(extensionId);
      return kernel.runLegacyInactiveMutation(extensionId, mutation);
    },
    async runFencedResourceMutation<T>(
      context: PersonalExtensionFencedMutationContext,
      resources: readonly PersonalExtensionProtectedResource[],
      callback: (tx: DB) => Promise<T>,
      mutationOptions: PersonalExtensionFencedMutationOptions = {},
    ) {
      await requireKnownExtension(context.extensionId);
      const committed = await kernel.runFencedResourceMutation(context, resources, callback, mutationOptions);
      for (const resource of committed.resourceRevisions) {
        if (resource.kind === "extension-storage") {
          publishAfterCommit(context.extensionId, {
            type: "config-changed",
            configRevision: resource.resourceRevision,
          });
        } else {
          publishAfterCommit(context.extensionId, {
            type: "resource-changed",
            resourceRevision: resource.resourceRevision,
          });
        }
      }
      return committed;
    },
    async runFencedResourceRead<T>(
      context: PersonalExtensionLeaseAuthority,
      callback: (readDb: DB, registry: PersonalExtensionProtectedResourceRegistry) => Promise<T>,
    ) {
      await requireKnownExtension(context.extensionId);
      return kernel.runFencedResourceRead(context, callback);
    },
    async runFencedOperationRead<T>(
      context: PersonalExtensionFencedMutationContext,
      operationKind: PersonalExtensionOperationKind,
      callback: (readDb: DB, registry: PersonalExtensionProtectedResourceRegistry) => Promise<T>,
    ) {
      await requireKnownExtension(context.extensionId);
      return kernel.runFencedOperationRead(context, operationKind, callback);
    },
    async runFencedLorebookRegistryTransition<T>(
      context: PersonalExtensionFencedMutationContext,
      transition: PersonalExtensionLorebookRegistryTransition,
      callback: (tx: DB) => Promise<T>,
    ) {
      await requireKnownExtension(context.extensionId);
      const committed = await kernel.runFencedLorebookRegistryTransition(context, transition, callback);
      // Unbind has no live revision after commit. Its last admitted revision is
      // still sufficient as a content-free invalidation hint; readers always
      // confirm current state with GET.
      publishAfterCommit(context.extensionId, {
        type: "resource-changed",
        resourceRevision: committed.resourceRevision ?? transition.expectedRevision ?? 0,
      });
      return committed;
    },
  };
}

export type PersonalExtensionCoordinationService = ReturnType<typeof createPersonalExtensionCoordinationService>;

const coordinationServices = new WeakMap<DB, PersonalExtensionCoordinationService>();

export function getPersonalExtensionCoordinationService(db: DB) {
  let service = coordinationServices.get(db);
  if (!service) {
    service = createPersonalExtensionCoordinationService(db);
    coordinationServices.set(db, service);
  }
  return service;
}
