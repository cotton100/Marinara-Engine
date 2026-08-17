// ──────────────────────────────────────────────
// Personal Extension Coordination Wire Schemas
// ──────────────────────────────────────────────
import { z } from "zod";
import { personalExtensionStoragePatchSchema } from "./personal-extension.schema.js";
import {
  activationConditionSchema,
  createLorebookEntrySchema,
  createLorebookSchema,
  lorebookCategorySchema,
  lorebookFilterModeSchema,
  lorebookMatchingSourceSchema,
  lorebookScheduleSchema,
  lorebookScopeSchema,
  selectiveLogicSchema,
  updateLorebookEntrySchema,
  updateLorebookSchema,
} from "./lorebook.schema.js";

export const PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION = 1 as const;
export const PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER = "x-marinara-coordination-holder-session-id" as const;
export const PERSONAL_EXTENSION_COORDINATION_EXTENSION_HEADER = "x-marinara-coordination-extension-id" as const;
export const PERSONAL_EXTENSION_COORDINATION_BOOT_HEADER = "x-marinara-coordination-server-boot-id" as const;
export const PERSONAL_EXTENSION_COORDINATION_CONTENT_HASH_HEADER = "x-marinara-coordination-content-hash" as const;
export const PERSONAL_EXTENSION_COORDINATION_FENCE_HEADER = "x-marinara-coordination-fence" as const;
export const PERSONAL_EXTENSION_COORDINATION_LEASE_TOKEN_HEADER = "x-marinara-coordination-lease-token" as const;

export const PERSONAL_EXTENSION_COORDINATION_CAPABILITIES = [
  "lease-v1",
  "guarded-operation-v1",
  "revisioned-storage-v1",
  "guarded-lorebook-v1",
  "handoff-v1",
  "events-v1",
  "dirty-signal-v1",
] as const;

export const personalExtensionCoordinationModeSchema = z.enum([
  "inactive",
  "activating",
  "active",
  "draining-deactivate",
  "restoring",
  "blocked",
]);

export const personalExtensionCoordinationOperationKindSchema = z.enum(["mutation", "vectorize"]);
export const personalExtensionCoordinationTargetEnsembleIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

export const personalExtensionCoordinationExtensionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export const personalExtensionCoordinationHolderSessionIdSchema = z.string().min(1).max(512);
export const personalExtensionCoordinationBootIdSchema = z.string().min(1).max(512);
export const personalExtensionCoordinationContentHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const personalExtensionCoordinationFenceSchema = z.number().int().nonnegative().safe();
export const personalExtensionCoordinationLeaseTokenSchema = z.string().min(16).max(1024);
export const personalExtensionCoordinationOperationHandleSchema = z.string().min(16).max(1024);
export const personalExtensionCoordinationHandoffRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);

export const personalExtensionCoordinationParamsSchema = z
  .object({ id: personalExtensionCoordinationExtensionIdSchema })
  .strict();
export const personalExtensionCoordinationEmptyQuerySchema = z.object({}).strict();
export const personalExtensionCoordinationAdminRequestSchema = z.object({}).strict();

export const personalExtensionCoordinationAcquireRequestSchema = z
  .object({
    serverBootId: personalExtensionCoordinationBootIdSchema,
    contentHash: personalExtensionCoordinationContentHashSchema,
  })
  .strict();

export const personalExtensionCoordinationLeaseAuthorityRequestSchema =
  personalExtensionCoordinationAcquireRequestSchema
    .extend({
      fence: personalExtensionCoordinationFenceSchema,
      leaseToken: personalExtensionCoordinationLeaseTokenSchema,
    })
    .strict();

export const personalExtensionCoordinationHandoffRequestSchema = personalExtensionCoordinationAcquireRequestSchema;

export const personalExtensionCoordinationReleaseRequestSchema =
  personalExtensionCoordinationLeaseAuthorityRequestSchema
    .extend({ handoffRequestId: personalExtensionCoordinationHandoffRequestIdSchema.optional() })
    .strict();

export const personalExtensionCoordinationOperationBeginRequestSchema =
  personalExtensionCoordinationLeaseAuthorityRequestSchema
    .extend({
      kind: personalExtensionCoordinationOperationKindSchema,
      targetEnsembleId: personalExtensionCoordinationTargetEnsembleIdSchema,
      requestedDeadlineMs: z.number().int().positive().safe().max(600_000).optional(),
    })
    .strict();

export const personalExtensionCoordinationOperationEndRequestSchema =
  personalExtensionCoordinationLeaseAuthorityRequestSchema
    .extend({
      operationHandle: personalExtensionCoordinationOperationHandleSchema,
      disposition: z.enum(["aborted", "conclusive"]).optional(),
    })
    .strict();

export const personalExtensionCoordinationStoragePatchRequestSchema =
  personalExtensionCoordinationLeaseAuthorityRequestSchema
    .extend({
      operationHandle: personalExtensionCoordinationOperationHandleSchema,
      expectedConfigRevision: personalExtensionCoordinationFenceSchema,
      patch: personalExtensionStoragePatchSchema,
    })
    .strict();

export const personalExtensionCoordinationStorageDeleteRequestSchema =
  personalExtensionCoordinationLeaseAuthorityRequestSchema
    .extend({
      operationHandle: personalExtensionCoordinationOperationHandleSchema,
      expectedConfigRevision: personalExtensionCoordinationFenceSchema,
    })
    .strict();

export const personalExtensionCoordinationRevisionedStorageResponseSchema = z
  .object({
    value: personalExtensionStoragePatchSchema,
    configRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

const guardedLorebookMutationBaseSchema = personalExtensionCoordinationLeaseAuthorityRequestSchema
  .extend({
    extensionId: personalExtensionCoordinationExtensionIdSchema,
    operationHandle: personalExtensionCoordinationOperationHandleSchema,
    expectedResourceRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

export const personalExtensionCoordinationLorebookReadAuthoritySchema =
  personalExtensionCoordinationLeaseAuthorityRequestSchema
    .extend({ extensionId: personalExtensionCoordinationExtensionIdSchema })
    .strict();

export const personalExtensionCoordinationLorebookCreateRequestSchema = guardedLorebookMutationBaseSchema
  .omit({ expectedResourceRevision: true })
  .extend({ book: createLorebookSchema })
  .strict();

export const personalExtensionCoordinationLorebookUpdateRequestSchema = guardedLorebookMutationBaseSchema
  .extend({ changes: updateLorebookSchema })
  .strict();

export const personalExtensionCoordinationLorebookDeleteRequestSchema = guardedLorebookMutationBaseSchema;

export const personalExtensionCoordinationLorebookEntryCreateRequestSchema = guardedLorebookMutationBaseSchema
  .extend({ entry: createLorebookEntrySchema.omit({ lorebookId: true }) })
  .strict();

export const personalExtensionCoordinationLorebookEntryUpdateRequestSchema = guardedLorebookMutationBaseSchema
  .extend({ changes: updateLorebookEntrySchema })
  .strict();

export const personalExtensionCoordinationLorebookEntryDeleteRequestSchema = guardedLorebookMutationBaseSchema;

export const personalExtensionCoordinationLorebookVectorizeRequestSchema = guardedLorebookMutationBaseSchema
  .extend({
    connectionId: z.string().min(1).max(512),
    model: z.string().min(1).max(512).optional(),
    onlyMissing: z.boolean().optional(),
  })
  .strict();

export const personalExtensionCoordinationLorebookClearVectorsRequestSchema = guardedLorebookMutationBaseSchema;

export const personalExtensionCoordinationLorebookSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(200),
    description: z.string(),
    category: lorebookCategorySchema,
    imagePath: z.string().nullable(),
    scanDepth: z.number().int().nonnegative().safe(),
    tokenBudget: z.number().int().nonnegative().safe(),
    entryLimit: z.number().int().nonnegative().safe(),
    recursiveScanning: z.boolean(),
    maxRecursionDepth: z.number().int().positive().safe(),
    excludeFromVectorization: z.boolean(),
    vectorQueryDepth: z.number().int().nonnegative().safe(),
    vectorScoreThreshold: z.number().min(0).max(1),
    vectorMaxResults: z.number().int().nonnegative().safe(),
    characterId: z.string().nullable(),
    characterIds: z.array(z.string()),
    personaId: z.string().nullable(),
    personaIds: z.array(z.string()),
    chatId: z.string().nullable(),
    isGlobal: z.boolean(),
    enabled: z.boolean(),
    hiddenFromLibrary: z.boolean(),
    scope: lorebookScopeSchema,
    tags: z.array(z.string()),
    generatedBy: z.enum(["user", "agent", "import"]).nullable(),
    sourceAgentId: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const personalExtensionCoordinationLorebookEntrySchema = z
  .object({
    id: z.string().min(1).max(512),
    lorebookId: z.string().min(1).max(512),
    name: z.string().min(1).max(200),
    content: z.string(),
    description: z.string(),
    keys: z.array(z.string()),
    secondaryKeys: z.array(z.string()),
    enabled: z.boolean(),
    constant: z.boolean(),
    selective: z.boolean(),
    selectiveLogic: selectiveLogicSchema,
    probability: z.number().nullable(),
    scanDepth: z.number().int().nonnegative().nullable(),
    matchWholeWords: z.boolean(),
    caseSensitive: z.boolean(),
    useRegex: z.boolean(),
    characterFilterMode: lorebookFilterModeSchema,
    characterFilterIds: z.array(z.string()),
    characterTagFilterMode: lorebookFilterModeSchema,
    characterTagFilters: z.array(z.string()),
    generationTriggerFilterMode: lorebookFilterModeSchema,
    generationTriggerFilters: z.array(z.string()),
    additionalMatchingSources: z.array(lorebookMatchingSourceSchema),
    position: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(7)]),
    outletName: z.string(),
    depth: z.number().int().nonnegative().safe(),
    order: z.number().int().safe(),
    role: z.enum(["system", "user", "assistant"]),
    sticky: z.number().nullable(),
    cooldown: z.number().nullable(),
    delay: z.number().nullable(),
    ephemeral: z.number().int().nonnegative().nullable(),
    group: z.string(),
    groupWeight: z.number().nullable(),
    folderId: z.string().nullable(),
    locked: z.boolean(),
    preventRecursion: z.boolean(),
    excludeRecursion: z.boolean(),
    delayUntilRecursion: z.boolean(),
    tag: z.string(),
    relationships: z.record(z.string()),
    dynamicState: z.record(z.unknown()),
    activationConditions: z.array(activationConditionSchema),
    schedule: lorebookScheduleSchema.nullable(),
    excludeFromVectorization: z.boolean(),
    embedding: z.array(z.number().finite()).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const personalExtensionCoordinationRevisionedLorebookResponseSchema = z
  .object({
    value: personalExtensionCoordinationLorebookSchema,
    resourceRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

export const personalExtensionCoordinationRevisionedLorebookListResponseSchema = z
  .object({
    items: z.array(personalExtensionCoordinationRevisionedLorebookResponseSchema),
  })
  .strict();

export const personalExtensionCoordinationRevisionedLorebookEntryResponseSchema = z
  .object({
    value: personalExtensionCoordinationLorebookEntrySchema,
    resourceRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

export const personalExtensionCoordinationRevisionedLorebookEntryListResponseSchema = z
  .object({
    items: z.array(personalExtensionCoordinationLorebookEntrySchema),
    resourceRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

export const personalExtensionCoordinationLorebookDeleteResponseSchema = z
  .object({ deleted: z.literal(true), resourceRevision: z.null() })
  .strict();

export const personalExtensionCoordinationLorebookEntryDeleteResponseSchema = z
  .object({
    deleted: z.literal(true),
    resourceRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

export const personalExtensionCoordinationLorebookVectorizeResponseSchema = z
  .object({
    vectorized: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe(),
    skipped: z.number().int().nonnegative().safe(),
    resourceRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

export const personalExtensionCoordinationLorebookClearVectorsResponseSchema = z
  .object({
    cleared: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe(),
    resourceRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

const coordinationStateBase = z
  .object({
    schemaVersion: z.literal(PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION),
    extensionId: personalExtensionCoordinationExtensionIdSchema,
    serverBootId: personalExtensionCoordinationBootIdSchema,
    contentHash: z.union([z.literal(""), personalExtensionCoordinationContentHashSchema]),
    fence: personalExtensionCoordinationFenceSchema,
    remainingMs: z.number().int().nonnegative().safe(),
  })
  .strict();

export const personalExtensionCoordinationStateSchema = z.union([
  coordinationStateBase
    .extend({
      mode: z.literal("active"),
      coordinationActive: z.literal(true),
      capabilities: z.tuple([
        z.literal(PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[0]),
        z.literal(PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[1]),
        z.literal(PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[2]),
        z.literal(PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[3]),
        z.literal(PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[4]),
        z.literal(PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[5]),
        z.literal(PERSONAL_EXTENSION_COORDINATION_CAPABILITIES[6]),
      ]),
      role: z.enum(["writer", "follower"]),
    })
    .strict(),
  coordinationStateBase
    .extend({
      mode: z.enum(["inactive", "activating", "draining-deactivate", "restoring", "blocked"]),
      coordinationActive: z.literal(false),
      capabilities: z.tuple([]),
      role: z.literal("follower"),
      remainingMs: z.literal(0),
    })
    .strict(),
]);

export const personalExtensionCoordinationLeaseGrantSchema = z
  .object({
    leaseToken: personalExtensionCoordinationLeaseTokenSchema,
    holderSessionId: personalExtensionCoordinationHolderSessionIdSchema,
    serverBootId: personalExtensionCoordinationBootIdSchema,
    contentHash: personalExtensionCoordinationContentHashSchema,
    fence: personalExtensionCoordinationFenceSchema,
    expiresAt: z.string().datetime(),
    remainingMs: z.number().int().positive().safe(),
  })
  .strict();

export const personalExtensionCoordinationLeaseStateSchema = personalExtensionCoordinationLeaseGrantSchema
  .omit({ leaseToken: true })
  .strict();

export const personalExtensionCoordinationHandoffResponseSchema = z
  .object({
    requestId: personalExtensionCoordinationHandoffRequestIdSchema,
    status: z.enum(["draining", "reserved"]),
    deadlineAt: z.string().datetime(),
    remainingMs: z.number().int().nonnegative().safe(),
  })
  .strict();

export const personalExtensionCoordinationReleaseResponseSchema = z
  .object({
    fence: personalExtensionCoordinationFenceSchema,
    serverBootId: personalExtensionCoordinationBootIdSchema,
    contentHash: personalExtensionCoordinationContentHashSchema,
  })
  .strict();

export const personalExtensionCoordinationOperationGrantSchema = z
  .object({
    operationHandle: personalExtensionCoordinationOperationHandleSchema,
    kind: personalExtensionCoordinationOperationKindSchema,
    deadlineAt: z.string().datetime(),
    remainingMs: z.number().int().positive().safe(),
  })
  .strict();

export const personalExtensionCoordinationOperationEndResponseSchema = z
  .object({
    ended: z.literal(true),
    fence: personalExtensionCoordinationFenceSchema,
    serverBootId: personalExtensionCoordinationBootIdSchema,
    contentHash: personalExtensionCoordinationContentHashSchema,
  })
  .strict();

export const personalExtensionCoordinationAdminTransitionResponseSchema = z
  .object({
    extensionId: personalExtensionCoordinationExtensionIdSchema,
    mode: z.enum(["active", "inactive"]),
    serverBootId: personalExtensionCoordinationBootIdSchema,
    contentHash: z.union([z.literal(""), personalExtensionCoordinationContentHashSchema]),
    fence: personalExtensionCoordinationFenceSchema,
    configRevision: personalExtensionCoordinationFenceSchema,
  })
  .strict();

export const PERSONAL_EXTENSION_COORDINATION_EVENT_PAYLOAD_MAX_BYTES = 1024 as const;
export const PERSONAL_EXTENSION_COORDINATION_EVENT_REPLAY_LIMIT = 128 as const;
export const PERSONAL_EXTENSION_COORDINATION_SUBSCRIBER_LIMIT = 8 as const;
export const PERSONAL_EXTENSION_COORDINATION_DIRTY_COALESCE_MS = 2_000 as const;
export const PERSONAL_EXTENSION_COORDINATION_DIRTY_RATE_LIMIT = 60 as const;
export const PERSONAL_EXTENSION_COORDINATION_DIRTY_RATE_WINDOW_MS = 60_000 as const;

export const personalExtensionCoordinationDeviceSessionIdSchema = z.string().uuid();
export const personalExtensionCoordinationEventEpochSchema = z.string().uuid();
export const personalExtensionCoordinationEventCursorSchema = z.number().int().nonnegative().safe();
export const personalExtensionCoordinationDirtyChatIdSchema = z.string().trim().min(1).max(256);

const personalExtensionCoordinationEventBaseShape = {
  schemaVersion: z.literal(PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION),
  eventEpoch: personalExtensionCoordinationEventEpochSchema,
  cursor: personalExtensionCoordinationEventCursorSchema,
} as const;

const personalExtensionCoordinationEventUnionSchema = z.union([
  z
    .object({
      ...personalExtensionCoordinationEventBaseShape,
      type: z.literal("lease-changed"),
    })
    .strict(),
  z
    .object({
      ...personalExtensionCoordinationEventBaseShape,
      type: z.literal("handoff-requested"),
      // Public correlation ID used by the old writer when it releases after
      // draining. Holder identities and lease credentials never enter events.
      requestId: personalExtensionCoordinationHandoffRequestIdSchema,
    })
    .strict(),
  z
    .object({
      ...personalExtensionCoordinationEventBaseShape,
      type: z.literal("config-changed"),
      configRevision: personalExtensionCoordinationFenceSchema,
    })
    .strict(),
  z
    .object({
      ...personalExtensionCoordinationEventBaseShape,
      type: z.literal("resource-changed"),
      resourceRevision: personalExtensionCoordinationFenceSchema,
    })
    .strict(),
  z
    .object({
      ...personalExtensionCoordinationEventBaseShape,
      type: z.literal("source-dirty"),
      chatId: personalExtensionCoordinationDirtyChatIdSchema,
    })
    .strict(),
  z
    .object({
      ...personalExtensionCoordinationEventBaseShape,
      type: z.literal("reset"),
    })
    .strict(),
]);

function utf8ByteLength(value: string) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function personalExtensionCoordinationEventPayloadBytes(value: unknown) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : utf8ByteLength(serialized);
}

export const personalExtensionCoordinationEventSchema = personalExtensionCoordinationEventUnionSchema.superRefine(
  (event, context) => {
    if (
      personalExtensionCoordinationEventPayloadBytes(event) > PERSONAL_EXTENSION_COORDINATION_EVENT_PAYLOAD_MAX_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Coordination event payload exceeds the 1 KiB limit",
      });
    }
  },
);

const personalExtensionCoordinationEventCursorQuerySchema = z
  .union([
    personalExtensionCoordinationEventCursorSchema,
    z
      .string()
      .regex(/^(0|[1-9][0-9]{0,15})$/u)
      .transform((value) => Number(value)),
  ])
  .pipe(personalExtensionCoordinationEventCursorSchema);

export const personalExtensionCoordinationEventQuerySchema = z
  .object({
    deviceSessionId: personalExtensionCoordinationDeviceSessionIdSchema,
    eventEpoch: personalExtensionCoordinationEventEpochSchema.optional(),
    cursor: personalExtensionCoordinationEventCursorQuerySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.eventEpoch === undefined) !== (value.cursor === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eventEpoch and cursor must be provided together",
      });
    }
  });

export const personalExtensionCoordinationDirtyRequestSchema = z
  .object({
    deviceSessionId: personalExtensionCoordinationDeviceSessionIdSchema,
    chatId: personalExtensionCoordinationDirtyChatIdSchema,
  })
  .strict();

export const personalExtensionCoordinationDirtyResponseSchema = z
  .object({
    accepted: z.literal(true),
    coalesced: z.boolean(),
    eventEpoch: personalExtensionCoordinationEventEpochSchema,
    cursor: personalExtensionCoordinationEventCursorSchema,
  })
  .strict();

export const PERSONAL_EXTENSION_COORDINATION_ERROR_CODES = [
  "personal-extension-not-found",
  "coordination-inactive",
  "coordination-transition-blocked",
  "coordination-unavailable",
  "coordination-validation-failed",
  "extension-runtime-changed",
  "lease-held",
  "lease-lost",
  "lease-expired",
  "handoff-pending",
  "operation-kind-unsupported",
  "operation-lost",
  "operations-active",
  "coordination-required",
  "storage-revision-conflict",
  "protected-resource-unregistered",
  "resource-revision-conflict",
  "event-subscriber-limit",
  "dirty-rate-limited",
  "invalid-request",
] as const;

export const personalExtensionCoordinationErrorCodeSchema = z.enum(PERSONAL_EXTENSION_COORDINATION_ERROR_CODES);

export type PersonalExtensionCoordinationErrorCode = z.infer<typeof personalExtensionCoordinationErrorCodeSchema>;

export const PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS = Object.freeze({
  "personal-extension-not-found": 404,
  "coordination-inactive": 409,
  "coordination-transition-blocked": 409,
  "coordination-unavailable": 503,
  "coordination-validation-failed": 409,
  "extension-runtime-changed": 412,
  "lease-held": 409,
  "lease-lost": 409,
  "lease-expired": 409,
  "handoff-pending": 409,
  "operation-kind-unsupported": 400,
  "operation-lost": 409,
  "operations-active": 409,
  "coordination-required": 428,
  "storage-revision-conflict": 409,
  "protected-resource-unregistered": 409,
  "resource-revision-conflict": 409,
  "event-subscriber-limit": 429,
  "dirty-rate-limited": 429,
  "invalid-request": 400,
} satisfies Record<PersonalExtensionCoordinationErrorCode, number>);

export const personalExtensionCoordinationErrorResponseSchema = z
  .object({
    code: personalExtensionCoordinationErrorCodeSchema,
    error: z.string().min(1).max(200),
  })
  .strict();

export type PersonalExtensionCoordinationAcquireRequest = z.infer<
  typeof personalExtensionCoordinationAcquireRequestSchema
>;
export type PersonalExtensionCoordinationLeaseAuthorityRequest = z.infer<
  typeof personalExtensionCoordinationLeaseAuthorityRequestSchema
>;
export type PersonalExtensionCoordinationHandoffRequest = z.infer<
  typeof personalExtensionCoordinationHandoffRequestSchema
>;
export type PersonalExtensionCoordinationReleaseRequest = z.infer<
  typeof personalExtensionCoordinationReleaseRequestSchema
>;
export type PersonalExtensionCoordinationOperationBeginRequest = z.infer<
  typeof personalExtensionCoordinationOperationBeginRequestSchema
>;
export type PersonalExtensionCoordinationOperationEndRequest = z.infer<
  typeof personalExtensionCoordinationOperationEndRequestSchema
>;
export type PersonalExtensionCoordinationStoragePatchRequest = z.infer<
  typeof personalExtensionCoordinationStoragePatchRequestSchema
>;
export type PersonalExtensionCoordinationStorageDeleteRequest = z.infer<
  typeof personalExtensionCoordinationStorageDeleteRequestSchema
>;
export type PersonalExtensionCoordinationRevisionedStorageResponse = z.infer<
  typeof personalExtensionCoordinationRevisionedStorageResponseSchema
>;
export type PersonalExtensionCoordinationLorebookReadAuthority = z.infer<
  typeof personalExtensionCoordinationLorebookReadAuthoritySchema
>;
export type PersonalExtensionCoordinationLorebookCreateRequest = z.infer<
  typeof personalExtensionCoordinationLorebookCreateRequestSchema
>;
export type PersonalExtensionCoordinationLorebookUpdateRequest = z.infer<
  typeof personalExtensionCoordinationLorebookUpdateRequestSchema
>;
export type PersonalExtensionCoordinationLorebookDeleteRequest = z.infer<
  typeof personalExtensionCoordinationLorebookDeleteRequestSchema
>;
export type PersonalExtensionCoordinationLorebookEntryCreateRequest = z.infer<
  typeof personalExtensionCoordinationLorebookEntryCreateRequestSchema
>;
export type PersonalExtensionCoordinationLorebookEntryUpdateRequest = z.infer<
  typeof personalExtensionCoordinationLorebookEntryUpdateRequestSchema
>;
export type PersonalExtensionCoordinationLorebookEntryDeleteRequest = z.infer<
  typeof personalExtensionCoordinationLorebookEntryDeleteRequestSchema
>;
export type PersonalExtensionCoordinationLorebookVectorizeRequest = z.infer<
  typeof personalExtensionCoordinationLorebookVectorizeRequestSchema
>;
export type PersonalExtensionCoordinationLorebookClearVectorsRequest = z.infer<
  typeof personalExtensionCoordinationLorebookClearVectorsRequestSchema
>;
export type PersonalExtensionCoordinationLorebook = z.infer<typeof personalExtensionCoordinationLorebookSchema>;
export type PersonalExtensionCoordinationLorebookEntry = z.infer<
  typeof personalExtensionCoordinationLorebookEntrySchema
>;
export type PersonalExtensionCoordinationRevisionedLorebookResponse = z.infer<
  typeof personalExtensionCoordinationRevisionedLorebookResponseSchema
>;
export type PersonalExtensionCoordinationRevisionedLorebookListResponse = z.infer<
  typeof personalExtensionCoordinationRevisionedLorebookListResponseSchema
>;
export type PersonalExtensionCoordinationRevisionedLorebookEntryResponse = z.infer<
  typeof personalExtensionCoordinationRevisionedLorebookEntryResponseSchema
>;
export type PersonalExtensionCoordinationRevisionedLorebookEntryListResponse = z.infer<
  typeof personalExtensionCoordinationRevisionedLorebookEntryListResponseSchema
>;
export type PersonalExtensionCoordinationLorebookDeleteResponse = z.infer<
  typeof personalExtensionCoordinationLorebookDeleteResponseSchema
>;
export type PersonalExtensionCoordinationLorebookEntryDeleteResponse = z.infer<
  typeof personalExtensionCoordinationLorebookEntryDeleteResponseSchema
>;
export type PersonalExtensionCoordinationLorebookVectorizeResponse = z.infer<
  typeof personalExtensionCoordinationLorebookVectorizeResponseSchema
>;
export type PersonalExtensionCoordinationLorebookClearVectorsResponse = z.infer<
  typeof personalExtensionCoordinationLorebookClearVectorsResponseSchema
>;
export type PersonalExtensionCoordinationState = z.infer<typeof personalExtensionCoordinationStateSchema>;
export type PersonalExtensionCoordinationLeaseGrant = z.infer<typeof personalExtensionCoordinationLeaseGrantSchema>;
export type PersonalExtensionCoordinationLeaseState = z.infer<typeof personalExtensionCoordinationLeaseStateSchema>;
export type PersonalExtensionCoordinationHandoffResponse = z.infer<
  typeof personalExtensionCoordinationHandoffResponseSchema
>;
export type PersonalExtensionCoordinationReleaseResponse = z.infer<
  typeof personalExtensionCoordinationReleaseResponseSchema
>;
export type PersonalExtensionCoordinationOperationGrant = z.infer<
  typeof personalExtensionCoordinationOperationGrantSchema
>;
export type PersonalExtensionCoordinationOperationEndResponse = z.infer<
  typeof personalExtensionCoordinationOperationEndResponseSchema
>;
export type PersonalExtensionCoordinationAdminTransitionResponse = z.infer<
  typeof personalExtensionCoordinationAdminTransitionResponseSchema
>;
export type PersonalExtensionCoordinationEvent = z.infer<typeof personalExtensionCoordinationEventSchema>;
export type PersonalExtensionCoordinationEventQuery = z.infer<typeof personalExtensionCoordinationEventQuerySchema>;
export type PersonalExtensionCoordinationDirtyRequest = z.infer<typeof personalExtensionCoordinationDirtyRequestSchema>;
export type PersonalExtensionCoordinationDirtyResponse = z.infer<
  typeof personalExtensionCoordinationDirtyResponseSchema
>;
export type PersonalExtensionCoordinationErrorResponse = z.infer<
  typeof personalExtensionCoordinationErrorResponseSchema
>;
