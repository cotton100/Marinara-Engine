import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  PERSONAL_EXTENSION_COORDINATION_DIRTY_COALESCE_MS,
  PERSONAL_EXTENSION_COORDINATION_DIRTY_RATE_LIMIT,
  PERSONAL_EXTENSION_COORDINATION_DIRTY_RATE_WINDOW_MS,
  PERSONAL_EXTENSION_COORDINATION_EVENT_REPLAY_LIMIT,
  PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
  PERSONAL_EXTENSION_COORDINATION_SUBSCRIBER_LIMIT,
  personalExtensionCoordinationDirtyRequestSchema,
  personalExtensionCoordinationDirtyResponseSchema,
  personalExtensionCoordinationEventQuerySchema,
  personalExtensionCoordinationEventSchema,
  personalExtensionCoordinationExtensionIdSchema,
  type PersonalExtensionCoordinationDirtyResponse,
  type PersonalExtensionCoordinationErrorCode,
  type PersonalExtensionCoordinationEvent,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import {
  getPersonalExtensionCoordinationService,
  type PersonalExtensionCoordinationService,
} from "./personal-extension-coordination.service.js";

export const PERSONAL_EXTENSION_COORDINATION_EVENT_SWEEP_MS = 15_000;
const PERSONAL_EXTENSION_COORDINATION_TRACKED_DIRTY_DEVICE_LIMIT = 2_048;
const PERSONAL_EXTENSION_COORDINATION_TRACKED_DIRTY_KEY_LIMIT = 8_192;

export type PersonalExtensionCoordinationEventDraft =
  | { type: "lease-changed" }
  | { type: "handoff-requested"; requestId: string }
  | { type: "config-changed"; configRevision: number }
  | { type: "resource-changed"; resourceRevision: number }
  | { type: "source-dirty"; chatId: string }
  | { type: "reset" };

export type PersonalExtensionCoordinationEventCloseReason =
  | "replaced"
  | "runtime-changed"
  | "write-failed"
  | "shutdown";

export type PersonalExtensionCoordinationEventSink = {
  send(event: PersonalExtensionCoordinationEvent): void;
  close(reason: PersonalExtensionCoordinationEventCloseReason): void;
};

type StreamState = {
  eventEpoch: string;
  cursor: number;
  replay: PersonalExtensionCoordinationEvent[];
};

type Subscriber = {
  extensionId: string;
  deviceSessionId: string;
  sink: PersonalExtensionCoordinationEventSink;
};

export type PersonalExtensionCoordinationEventServiceOptions = {
  coordinationService?: Pick<PersonalExtensionCoordinationService, "getState">;
  now?: () => number;
  randomEventEpoch?: () => string;
  subscriberLimit?: number;
  replayLimit?: number;
  sweepIntervalMs?: number;
};

const EVENT_ERROR_CODES = new Set<PersonalExtensionCoordinationErrorCode>([
  "coordination-inactive",
  "coordination-transition-blocked",
  "coordination-unavailable",
  "event-subscriber-limit",
  "dirty-rate-limited",
]);

export class PersonalExtensionCoordinationEventError extends Error {
  constructor(readonly code: PersonalExtensionCoordinationErrorCode) {
    super(code);
    this.name = "PersonalExtensionCoordinationEventError";
  }
}

function eventError(code: PersonalExtensionCoordinationErrorCode) {
  if (!EVENT_ERROR_CODES.has(code)) return new PersonalExtensionCoordinationEventError("coordination-unavailable");
  return new PersonalExtensionCoordinationEventError(code);
}

export function createPersonalExtensionCoordinationEventService(
  db: DB,
  options: PersonalExtensionCoordinationEventServiceOptions = {},
) {
  const coordination = options.coordinationService ?? getPersonalExtensionCoordinationService(db);
  // Dirty admission is process-local. A monotonic clock prevents wall-clock
  // adjustments from reopening the per-device rate window.
  const now = options.now ?? (() => performance.now());
  const randomEventEpoch = options.randomEventEpoch ?? randomUUID;
  const subscriberLimit = options.subscriberLimit ?? PERSONAL_EXTENSION_COORDINATION_SUBSCRIBER_LIMIT;
  const replayLimit = options.replayLimit ?? PERSONAL_EXTENSION_COORDINATION_EVENT_REPLAY_LIMIT;
  const sweepIntervalMs = options.sweepIntervalMs ?? PERSONAL_EXTENSION_COORDINATION_EVENT_SWEEP_MS;
  const streams = new Map<string, StreamState>();
  const subscribers = new Map<string, Subscriber>();
  const dirtyRequestTimes = new Map<string, number[]>();
  const lastDirtyAt = new Map<string, number>();
  let sweepTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const subscriberKey = (extensionId: string, deviceSessionId: string) =>
    JSON.stringify([extensionId, deviceSessionId]);
  const dirtyKey = (extensionId: string, deviceSessionId: string, chatId: string) =>
    JSON.stringify([extensionId, deviceSessionId, chatId]);

  const checkedNow = () => {
    const value = now();
    if (!Number.isFinite(value)) throw eventError("coordination-unavailable");
    return value;
  };

  const createStream = (): StreamState => ({
    eventEpoch: randomEventEpoch(),
    cursor: 0,
    replay: [],
  });

  const createValidatedStream = () => {
    const stream = createStream();
    // Validate injected epoch generators just as strictly as wire input.
    personalExtensionCoordinationEventSchema.parse({
      schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
      eventEpoch: stream.eventEpoch,
      cursor: 0,
      type: "reset",
    });
    return stream;
  };

  const streamFor = (extensionId: string) => {
    let stream = streams.get(extensionId);
    if (!stream) {
      stream = createValidatedStream();
      streams.set(extensionId, stream);
    }
    return stream;
  };

  const assertApprovedActiveRuntime = async (extensionId: string) => {
    personalExtensionCoordinationExtensionIdSchema.parse(extensionId);
    const state = await coordination.getState(extensionId);
    if (state.mode === "active" && state.coordinationActive) return;
    if (state.mode === "inactive") throw eventError("coordination-inactive");
    throw eventError("coordination-transition-blocked");
  };

  const removeSubscriber = (
    key: string,
    subscriber: Subscriber,
    reason?: PersonalExtensionCoordinationEventCloseReason,
  ) => {
    if (subscribers.get(key) !== subscriber) return;
    subscribers.delete(key);
    if (reason) {
      try {
        subscriber.sink.close(reason);
      } catch {
        // A broken response stream cannot retain a subscriber.
      }
    }
    if (subscribers.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };

  const sweepInvalidSubscribers = async () => {
    const extensionIds = new Set(Array.from(subscribers.values(), (subscriber) => subscriber.extensionId));
    for (const extensionId of extensionIds) {
      try {
        await assertApprovedActiveRuntime(extensionId);
      } catch {
        for (const [key, subscriber] of [...subscribers]) {
          if (subscriber.extensionId === extensionId) removeSubscriber(key, subscriber, "runtime-changed");
        }
      }
    }
  };

  const ensureSweepTimer = () => {
    if (sweepTimer || sweepIntervalMs <= 0 || stopped) return;
    sweepTimer = setInterval(() => {
      void sweepInvalidSubscribers();
    }, sweepIntervalMs);
    sweepTimer.unref();
  };

  const publish = (extensionId: string, draft: PersonalExtensionCoordinationEventDraft) => {
    personalExtensionCoordinationExtensionIdSchema.parse(extensionId);
    if (stopped) throw eventError("coordination-unavailable");
    let stream = streamFor(extensionId);
    if (stream.cursor >= Number.MAX_SAFE_INTEGER) {
      stream = createStream();
      streams.set(extensionId, stream);
      draft = { type: "reset" };
    }
    const event = personalExtensionCoordinationEventSchema.parse({
      schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
      eventEpoch: stream.eventEpoch,
      cursor: stream.cursor + 1,
      ...draft,
    });
    stream.cursor = event.cursor;
    stream.replay.push(event);
    while (stream.replay.length > replayLimit) stream.replay.shift();

    for (const [key, subscriber] of [...subscribers]) {
      if (subscriber.extensionId !== extensionId) continue;
      try {
        subscriber.sink.send(event);
      } catch {
        removeSubscriber(key, subscriber, "write-failed");
      }
    }
    return event;
  };

  /**
   * A profile restore replaces the protected config/resources underneath this
   * process-local stream. Rotate its generation and discard replay before any
   * later activation can subscribe. Existing subscribers are closed without a
   * reset payload: the current CMB treats a received reset as a dirty-sync cue,
   * which is inappropriate after the authoritative runtime became inactive.
   */
  const resetExtensionRuntime = (extensionId: string) => {
    personalExtensionCoordinationExtensionIdSchema.parse(extensionId);
    if (stopped) throw eventError("coordination-unavailable");
    const stream = createValidatedStream();
    streams.set(extensionId, stream);
    const dirtyPrefix = `[${JSON.stringify(extensionId)},`;
    for (const key of lastDirtyAt.keys()) {
      if (key.startsWith(dirtyPrefix)) lastDirtyAt.delete(key);
    }
    const reset = personalExtensionCoordinationEventSchema.parse({
      schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
      eventEpoch: stream.eventEpoch,
      cursor: 0,
      type: "reset",
    });
    for (const [key, subscriber] of [...subscribers]) {
      if (subscriber.extensionId === extensionId) removeSubscriber(key, subscriber, "runtime-changed");
    }
    return reset;
  };

  const replayFor = (stream: StreamState, eventEpoch?: string, cursor?: number) => {
    if (
      eventEpoch === undefined ||
      cursor === undefined ||
      eventEpoch !== stream.eventEpoch ||
      cursor > stream.cursor
    ) {
      return [
        personalExtensionCoordinationEventSchema.parse({
          schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
          eventEpoch: stream.eventEpoch,
          cursor: stream.cursor,
          type: "reset",
        }),
      ];
    }
    const firstAvailableCursor = stream.replay[0]?.cursor ?? stream.cursor + 1;
    if (cursor < firstAvailableCursor - 1) {
      return [
        personalExtensionCoordinationEventSchema.parse({
          schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
          eventEpoch: stream.eventEpoch,
          cursor: stream.cursor,
          type: "reset",
        }),
      ];
    }
    return stream.replay.filter((event) => event.cursor > cursor);
  };

  const subscribe = async (
    input: {
      extensionId: string;
      deviceSessionId: string;
      eventEpoch?: string;
      cursor?: number;
    },
    sink: PersonalExtensionCoordinationEventSink,
  ) => {
    if (stopped) throw eventError("coordination-unavailable");
    personalExtensionCoordinationExtensionIdSchema.parse(input.extensionId);
    const parsed = personalExtensionCoordinationEventQuerySchema.parse({
      deviceSessionId: input.deviceSessionId,
      eventEpoch: input.eventEpoch,
      cursor: input.cursor,
    });
    const admittedStream = streamFor(input.extensionId);
    await assertApprovedActiveRuntime(input.extensionId);
    // resetExtensionRuntime can run while the active-state read is awaiting.
    // Do not let an admission based on the old generation become a subscriber
    // after the reset already closed every old sink.
    if (streams.get(input.extensionId) !== admittedStream) throw eventError("coordination-unavailable");
    const key = subscriberKey(input.extensionId, parsed.deviceSessionId);
    const previous = subscribers.get(key);
    const extensionSubscriberCount = Array.from(subscribers.values()).filter(
      (subscriber) => subscriber.extensionId === input.extensionId,
    ).length;
    if (!previous && extensionSubscriberCount >= subscriberLimit) throw eventError("event-subscriber-limit");
    if (previous) removeSubscriber(key, previous, "replaced");

    const subscriber: Subscriber = {
      extensionId: input.extensionId,
      deviceSessionId: parsed.deviceSessionId,
      sink,
    };
    subscribers.set(key, subscriber);
    ensureSweepTimer();
    try {
      for (const event of replayFor(admittedStream, parsed.eventEpoch, parsed.cursor)) sink.send(event);
    } catch (error) {
      removeSubscriber(key, subscriber, "write-failed");
      throw error;
    }

    let closed = false;
    return {
      close() {
        if (closed) return;
        closed = true;
        removeSubscriber(key, subscriber);
      },
    };
  };

  const signalDirty = async (input: {
    extensionId: string;
    deviceSessionId: string;
    chatId: string;
  }): Promise<PersonalExtensionCoordinationDirtyResponse> => {
    if (stopped) throw eventError("coordination-unavailable");
    const parsed = personalExtensionCoordinationDirtyRequestSchema.parse({
      deviceSessionId: input.deviceSessionId,
      chatId: input.chatId,
    });
    const admittedStream = streamFor(input.extensionId);
    await assertApprovedActiveRuntime(input.extensionId);
    if (streamFor(input.extensionId) !== admittedStream) throw eventError("coordination-unavailable");
    const timestamp = checkedNow();
    if (
      !dirtyRequestTimes.has(parsed.deviceSessionId) &&
      dirtyRequestTimes.size >= PERSONAL_EXTENSION_COORDINATION_TRACKED_DIRTY_DEVICE_LIMIT
    ) {
      for (const [deviceSessionId, requestTimes] of dirtyRequestTimes) {
        const live = requestTimes.filter(
          (requestAt) =>
            requestAt <= timestamp && timestamp - requestAt < PERSONAL_EXTENSION_COORDINATION_DIRTY_RATE_WINDOW_MS,
        );
        if (live.length === 0) dirtyRequestTimes.delete(deviceSessionId);
        else dirtyRequestTimes.set(deviceSessionId, live);
      }
      if (dirtyRequestTimes.size >= PERSONAL_EXTENSION_COORDINATION_TRACKED_DIRTY_DEVICE_LIMIT) {
        throw eventError("dirty-rate-limited");
      }
    }
    const deviceRequests = dirtyRequestTimes.get(parsed.deviceSessionId) ?? [];
    const liveRequests = deviceRequests.filter(
      (requestAt) =>
        requestAt <= timestamp && timestamp - requestAt < PERSONAL_EXTENSION_COORDINATION_DIRTY_RATE_WINDOW_MS,
    );
    if (liveRequests.length >= PERSONAL_EXTENSION_COORDINATION_DIRTY_RATE_LIMIT) {
      dirtyRequestTimes.set(parsed.deviceSessionId, liveRequests);
      throw eventError("dirty-rate-limited");
    }
    liveRequests.push(timestamp);
    dirtyRequestTimes.set(parsed.deviceSessionId, liveRequests);

    const key = dirtyKey(input.extensionId, parsed.deviceSessionId, parsed.chatId);
    const lastAcceptedAt = lastDirtyAt.get(key);
    const stream = admittedStream;
    if (
      lastAcceptedAt !== undefined &&
      timestamp >= lastAcceptedAt &&
      timestamp - lastAcceptedAt < PERSONAL_EXTENSION_COORDINATION_DIRTY_COALESCE_MS
    ) {
      return personalExtensionCoordinationDirtyResponseSchema.parse({
        accepted: true,
        coalesced: true,
        eventEpoch: stream.eventEpoch,
        cursor: stream.cursor,
      });
    }
    if (!lastDirtyAt.has(key) && lastDirtyAt.size >= PERSONAL_EXTENSION_COORDINATION_TRACKED_DIRTY_KEY_LIMIT) {
      for (const [candidateKey, acceptedAt] of lastDirtyAt) {
        if (acceptedAt > timestamp || timestamp - acceptedAt >= PERSONAL_EXTENSION_COORDINATION_DIRTY_COALESCE_MS) {
          lastDirtyAt.delete(candidateKey);
        }
      }
      if (lastDirtyAt.size >= PERSONAL_EXTENSION_COORDINATION_TRACKED_DIRTY_KEY_LIMIT) {
        throw eventError("dirty-rate-limited");
      }
    }
    lastDirtyAt.set(key, timestamp);
    const event = publish(input.extensionId, { type: "source-dirty", chatId: parsed.chatId });
    return personalExtensionCoordinationDirtyResponseSchema.parse({
      accepted: true,
      coalesced: false,
      eventEpoch: event.eventEpoch,
      cursor: event.cursor,
    });
  };

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    for (const [key, subscriber] of [...subscribers]) removeSubscriber(key, subscriber, "shutdown");
    subscribers.clear();
    streams.clear();
    dirtyRequestTimes.clear();
    lastDirtyAt.clear();
  };

  return {
    publish,
    resetExtensionRuntime,
    subscribe,
    signalDirty,
    sweepInvalidSubscribers,
    shutdown,
    subscriberCount(extensionId?: string) {
      if (extensionId === undefined) return subscribers.size;
      return Array.from(subscribers.values()).filter((subscriber) => subscriber.extensionId === extensionId).length;
    },
  };
}

export type PersonalExtensionCoordinationEventService = ReturnType<
  typeof createPersonalExtensionCoordinationEventService
>;

const eventServices = new WeakMap<DB, PersonalExtensionCoordinationEventService>();

export function getPersonalExtensionCoordinationEventService(db: DB) {
  let service = eventServices.get(db);
  if (!service) {
    service = createPersonalExtensionCoordinationEventService(db);
    eventServices.set(db, service);
  }
  return service;
}
