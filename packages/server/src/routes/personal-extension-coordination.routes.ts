// ──────────────────────────────────────────────
// Personal Extension Coordination Routes
// ──────────────────────────────────────────────
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER,
  PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS,
  personalExtensionCoordinationAcquireRequestSchema,
  personalExtensionCoordinationAdminRequestSchema,
  personalExtensionCoordinationDirtyRequestSchema,
  personalExtensionCoordinationEmptyQuerySchema,
  personalExtensionCoordinationEventQuerySchema,
  personalExtensionCoordinationHandoffRequestSchema,
  personalExtensionCoordinationHolderSessionIdSchema,
  personalExtensionCoordinationLeaseAuthorityRequestSchema,
  personalExtensionCoordinationOperationBeginRequestSchema,
  personalExtensionCoordinationOperationEndRequestSchema,
  personalExtensionCoordinationOperationTransitionToVectorizeRequestSchema,
  personalExtensionCoordinationParamsSchema,
  personalExtensionCoordinationReleaseRequestSchema,
  type PersonalExtensionCoordinationErrorCode,
} from "@marinara-engine/shared";
import { requireCoordinationAdminAccess } from "../middleware/privileged-gate.js";
import {
  PersonalExtensionCoordinationKernelError,
  type PersonalExtensionLeaseAuthority,
} from "../services/extensions/personal-extension-coordination-kernel.service.js";
import {
  getPersonalExtensionCoordinationEventService,
  PersonalExtensionCoordinationEventError,
  PERSONAL_EXTENSION_COORDINATION_EVENT_SWEEP_MS,
  type PersonalExtensionCoordinationEventService,
  type PersonalExtensionCoordinationEventSink,
} from "../services/extensions/personal-extension-coordination-events.service.js";
import {
  getPersonalExtensionCoordinationService,
  PersonalExtensionNotFoundError,
  type PersonalExtensionCoordinationService,
} from "../services/extensions/personal-extension-coordination.service.js";

type CoordinationRouteOptions = {
  service?: PersonalExtensionCoordinationService;
  eventService?: PersonalExtensionCoordinationEventService;
};

const PUBLIC_ERROR_MESSAGES: Record<PersonalExtensionCoordinationErrorCode, string> = {
  "personal-extension-not-found": "Personal Extension not found.",
  "coordination-inactive": "Personal extension coordination is inactive.",
  "coordination-transition-blocked": "Personal extension coordination is unavailable during this transition.",
  "coordination-unavailable": "Personal extension coordination is unavailable.",
  "coordination-validation-failed": "The Personal Extension coordination configuration is not safe to activate.",
  "extension-runtime-changed": "The approved Personal Extension runtime changed.",
  "lease-held": "Another writer lease is active.",
  "lease-lost": "The writer lease no longer matches server authority.",
  "lease-expired": "The writer lease is not currently live.",
  "handoff-pending": "A writer handoff is pending.",
  "operation-kind-unsupported": "The requested coordination operation kind is not supported.",
  "operation-lost": "The coordination operation no longer exists.",
  "operations-active": "Active coordination operations must finish first.",
  "coordination-required": "This Personal Extension requires coordinated storage access.",
  "storage-revision-conflict": "Personal Extension storage changed before this operation could commit.",
  "protected-resource-unregistered": "The protected resource is not registered for this extension.",
  "resource-revision-conflict": "The protected resource changed before this operation could commit.",
  "event-subscriber-limit": "Too many devices are already subscribed to this extension.",
  "dirty-rate-limited": "Too many dirty signals were sent from this device.",
  "invalid-request": "The coordination request is invalid.",
};

function holderSessionId(request: FastifyRequest, required: boolean): string | undefined {
  const raw = request.headers[PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER];
  if (raw === undefined && !required) return undefined;
  return personalExtensionCoordinationHolderSessionIdSchema.parse(raw);
}

function extensionIdFromParams(request: FastifyRequest): string {
  return personalExtensionCoordinationParamsSchema.parse(request.params).id;
}

function extensionId(request: FastifyRequest): string {
  personalExtensionCoordinationEmptyQuerySchema.parse(request.query);
  return extensionIdFromParams(request);
}

function coordinationErrorCode(error: unknown): PersonalExtensionCoordinationErrorCode | null {
  if (error instanceof ZodError) return "invalid-request";
  if (error instanceof PersonalExtensionNotFoundError) return error.code;
  if (error instanceof PersonalExtensionCoordinationKernelError) return error.code;
  if (error instanceof PersonalExtensionCoordinationEventError) return error.code;
  return null;
}

function sendCoordinationError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const knownCode = coordinationErrorCode(error);
  const code = knownCode ?? "coordination-unavailable";
  if (!knownCode) {
    // Do not attach the thrown object or request data: guarded requests can
    // contain raw lease and operation credentials.
    request.log.error("Personal extension coordination request failed unexpectedly");
  }
  return reply.status(PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS[code]).send({
    code,
    error: PUBLIC_ERROR_MESSAGES[code],
  });
}

function authority(
  extensionId: string,
  holder: string,
  input: {
    serverBootId: string;
    contentHash: string;
    fence: number;
    leaseToken: string;
  },
): PersonalExtensionLeaseAuthority {
  return {
    extensionId,
    holderSessionId: holder,
    serverBootId: input.serverBootId,
    contentHash: input.contentHash,
    fence: input.fence,
    leaseToken: input.leaseToken,
  };
}

export async function personalExtensionCoordinationRoutes(
  app: FastifyInstance,
  options: CoordinationRouteOptions = {},
) {
  // Resolve once when Fastify registers the plugin. The authority kernel is
  // app-wide and must never be reconstructed for individual requests.
  const service = options.service ?? getPersonalExtensionCoordinationService(app.db);
  const eventService = options.eventService ?? getPersonalExtensionCoordinationEventService(app.db);

  app.addHook("onClose", async () => {
    eventService.shutdown();
  });

  const adminTransition = (
    action: "activate" | "deactivate" | "recover-blocked",
    transition: (extensionId: string) => Promise<unknown>,
  ) => {
    app.post<{ Params: { id: string }; Body: unknown }>(`/:id/coordination/admin/${action}`, async (request, reply) => {
      if (!requireCoordinationAdminAccess(request, reply, { feature: "Personal extension coordination" })) return;
      try {
        const id = extensionId(request);
        personalExtensionCoordinationAdminRequestSchema.parse(request.body ?? {});
        return await transition(id);
      } catch (error) {
        return sendCoordinationError(error, request, reply);
      }
    });
  };

  adminTransition("activate", (id) => service.activateCoordination(id));
  adminTransition("deactivate", (id) => service.deactivateCoordination(id));
  adminTransition("recover-blocked", (id) => service.recoverBlockedCoordination(id));

  app.get<{ Params: { id: string } }>("/:id/coordination", async (request, reply) => {
    try {
      const id = extensionId(request);
      return await service.getState(id, holderSessionId(request, false));
    } catch (error) {
      return sendCoordinationError(error, request, reply);
    }
  });

  app.get<{ Params: { id: string }; Querystring: unknown }>("/:id/coordination/events", async (request, reply) => {
    let subscription: { close(): void } | null = null;
    let keepaliveTimer: NodeJS.Timeout | null = null;
    let streamStarted = false;
    let streamClosed = false;
    const pendingEvents: Parameters<PersonalExtensionCoordinationEventSink["send"]>[0][] = [];

    const writeEvent = (event: Parameters<PersonalExtensionCoordinationEventSink["send"]>[0]) => {
      if (streamClosed || reply.raw.destroyed || reply.raw.writableEnded) throw new Error("SSE stream closed");
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const closeStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      subscription?.close();
      subscription = null;
      if (streamStarted && !reply.raw.destroyed && !reply.raw.writableEnded) {
        try {
          reply.raw.end();
        } catch {
          // The peer can disconnect between the writable checks and end().
        }
      }
    };
    const sink: PersonalExtensionCoordinationEventSink = {
      send(event) {
        if (!streamStarted) pendingEvents.push(event);
        else writeEvent(event);
      },
      close() {
        closeStream();
      },
    };

    try {
      const id = extensionIdFromParams(request);
      const input = personalExtensionCoordinationEventQuerySchema.parse(request.query);
      subscription = await eventService.subscribe({ extensionId: id, ...input }, sink);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streamStarted = true;
      for (const event of pendingEvents.splice(0)) writeEvent(event);
      reply.raw.write(": connected\n\n");
      keepaliveTimer = setInterval(() => {
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          closeStream();
          return;
        }
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          closeStream();
        }
      }, PERSONAL_EXTENSION_COORDINATION_EVENT_SWEEP_MS);
      keepaliveTimer.unref();
      request.raw.once("aborted", closeStream);
      reply.raw.once("close", closeStream);
      return;
    } catch (error) {
      closeStream();
      if (streamStarted) return;
      return sendCoordinationError(error, request, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/:id/coordination/dirty", async (request, reply) => {
    try {
      const id = extensionId(request);
      const input = personalExtensionCoordinationDirtyRequestSchema.parse(request.body);
      return await eventService.signalDirty({ extensionId: id, ...input });
    } catch (error) {
      return sendCoordinationError(error, request, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/:id/coordination/lease/acquire", async (request, reply) => {
    try {
      const id = extensionId(request);
      const holder = holderSessionId(request, true)!;
      const input = personalExtensionCoordinationAcquireRequestSchema.parse(request.body);
      return await service.acquireLease({
        extensionId: id,
        holderSessionId: holder,
        serverBootId: input.serverBootId,
        contentHash: input.contentHash,
      });
    } catch (error) {
      return sendCoordinationError(error, request, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/:id/coordination/handoff", async (request, reply) => {
    try {
      const id = extensionId(request);
      const holder = holderSessionId(request, true)!;
      const input = personalExtensionCoordinationHandoffRequestSchema.parse(request.body);
      return await service.requestHandoff({
        extensionId: id,
        holderSessionId: holder,
        serverBootId: input.serverBootId,
        contentHash: input.contentHash,
      });
    } catch (error) {
      return sendCoordinationError(error, request, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/:id/coordination/lease/renew", async (request, reply) => {
    try {
      const id = extensionId(request);
      const holder = holderSessionId(request, true)!;
      const input = personalExtensionCoordinationLeaseAuthorityRequestSchema.parse(request.body);
      return await service.renewLease(authority(id, holder, input));
    } catch (error) {
      return sendCoordinationError(error, request, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/:id/coordination/lease/release", async (request, reply) => {
    try {
      const id = extensionId(request);
      const holder = holderSessionId(request, true)!;
      const input = personalExtensionCoordinationReleaseRequestSchema.parse(request.body);
      return await service.releaseLease({
        ...authority(id, holder, input),
        handoffRequestId: input.handoffRequestId,
      });
    } catch (error) {
      return sendCoordinationError(error, request, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/:id/coordination/operations/begin", async (request, reply) => {
    try {
      const id = extensionId(request);
      const holder = holderSessionId(request, true)!;
      const input = personalExtensionCoordinationOperationBeginRequestSchema.parse(request.body);
      return await service.beginOperation({
        ...authority(id, holder, input),
        kind: input.kind,
        targetEnsembleId: input.targetEnsembleId,
        requestedDeadlineMs: input.requestedDeadlineMs,
      });
    } catch (error) {
      return sendCoordinationError(error, request, reply);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/:id/coordination/operations/transition-to-vectorize",
    async (request, reply) => {
      try {
        const id = extensionId(request);
        const holder = holderSessionId(request, true)!;
        const input = personalExtensionCoordinationOperationTransitionToVectorizeRequestSchema.parse(request.body);
        return await service.transitionOperationToVectorize({
          ...authority(id, holder, input),
          operationHandle: input.operationHandle,
          targetEnsembleId: input.targetEnsembleId,
        });
      } catch (error) {
        return sendCoordinationError(error, request, reply);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>("/:id/coordination/operations/end", async (request, reply) => {
    try {
      const id = extensionId(request);
      const holder = holderSessionId(request, true)!;
      const input = personalExtensionCoordinationOperationEndRequestSchema.parse(request.body);
      return await service.endOperation({
        ...authority(id, holder, input),
        operationHandle: input.operationHandle,
        disposition: input.disposition,
      });
    } catch (error) {
      return sendCoordinationError(error, request, reply);
    }
  });
}
