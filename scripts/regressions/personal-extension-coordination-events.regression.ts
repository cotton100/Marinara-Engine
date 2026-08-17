import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER,
  PERSONAL_EXTENSION_COORDINATION_EVENT_PAYLOAD_MAX_BYTES,
  personalExtensionCoordinationDirtyRequestSchema,
  personalExtensionCoordinationEventPayloadBytes,
  personalExtensionCoordinationEventSchema,
} from "../../packages/shared/src/index.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { installedExtensions, personalExtensionCoordination } from "../../packages/server/src/db/schema/index.js";
import { csrfProtectionHook } from "../../packages/server/src/middleware/csrf-protection.js";
import { personalExtensionCoordinationRoutes } from "../../packages/server/src/routes/personal-extension-coordination.routes.js";
import {
  createPersonalExtensionCoordinationEventService,
  PersonalExtensionCoordinationEventError,
  type PersonalExtensionCoordinationEventService,
  type PersonalExtensionCoordinationEventCloseReason,
  type PersonalExtensionCoordinationEventSink,
} from "../../packages/server/src/services/extensions/personal-extension-coordination-events.service.js";
import { createPersonalExtensionCoordinationService } from "../../packages/server/src/services/extensions/personal-extension-coordination.service.js";

const EXTENSION_ID = "coordination-events-extension";
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const DEVICE_A = "10000000-0000-4000-8000-000000000001";
const DEVICE_B = "10000000-0000-4000-8000-000000000002";
const EVENT_EPOCH = "20000000-0000-4000-8000-000000000001";
const RESET_EVENT_EPOCH_A = "20000000-0000-4000-8000-00000000000a";
const RESET_EVENT_EPOCH_B = "20000000-0000-4000-8000-00000000000b";
const RESET_EVENT_EPOCH_C = "20000000-0000-4000-8000-00000000000c";
const RESET_EVENT_EPOCH_D = "20000000-0000-4000-8000-00000000000d";
const PUBLIC_HANDOFF_ID = "handoff-public-request-0001";
const RAW_MEMORY = "RAW_MEMORY_BODY_MUST_NOT_LEAK";
const RAW_TOKEN = "RAW_LEASE_TOKEN_MUST_NOT_LEAK";
const RAW_RESOURCE_ID = "RAW_LOREBOOK_ID_MUST_NOT_LEAK";
const RAW_ENTRY_ID = "RAW_ENTRY_ID_MUST_NOT_LEAK";

function sink() {
  const events: unknown[] = [];
  const closeReasons: PersonalExtensionCoordinationEventCloseReason[] = [];
  const value: PersonalExtensionCoordinationEventSink = {
    send(event) {
      events.push(event);
    },
    close(reason) {
      closeReasons.push(reason);
    },
  };
  return { value, events, closeReasons };
}

function assertEventPayloadSafe(event: unknown) {
  const serialized = JSON.stringify(event);
  assert.ok(
    personalExtensionCoordinationEventPayloadBytes(event) <= PERSONAL_EXTENSION_COORDINATION_EVENT_PAYLOAD_MAX_BYTES,
  );
  assert.equal(serialized.includes(RAW_MEMORY), false);
  assert.equal(serialized.includes(RAW_TOKEN), false);
  assert.equal(serialized.includes("operationHandle"), false);
  assert.equal(serialized.includes("leaseToken"), false);
  assert.equal(serialized.includes(RAW_RESOURCE_ID), false);
  assert.equal(serialized.includes(RAW_ENTRY_ID), false);
}

const exactEvent = {
  schemaVersion: 1,
  eventEpoch: EVENT_EPOCH,
  cursor: 1,
  type: "handoff-requested",
  requestId: PUBLIC_HANDOFF_ID,
} as const;
assert.deepEqual(personalExtensionCoordinationEventSchema.parse(exactEvent), exactEvent);
assertEventPayloadSafe(exactEvent);
assert.throws(() => personalExtensionCoordinationEventSchema.parse({ ...exactEvent, content: RAW_MEMORY }));
assert.throws(() => personalExtensionCoordinationEventSchema.parse({ ...exactEvent, leaseToken: RAW_TOKEN }));
assert.throws(() =>
  personalExtensionCoordinationEventSchema.parse({
    schemaVersion: 1,
    eventEpoch: EVENT_EPOCH,
    cursor: 1,
    type: "source-dirty",
    chatId: "x".repeat(257),
  }),
);
assert.throws(() =>
  personalExtensionCoordinationDirtyRequestSchema.parse({
    deviceSessionId: DEVICE_A,
    chatId: "chat-a",
    entry: RAW_MEMORY,
  }),
);

const storageDir = mkdtempSync(join(tmpdir(), "marinara-coordination-events-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;
const fileDb = await createFileNativeDB({ fileOperations: { writeFile, flushDirectory: async () => {} } });
const db = fileDb as unknown as DB;
let nowMs = 10_000;
const timestamp = "2026-08-16T00:00:00.000Z";
await db.insert(installedExtensions).values({
  id: EXTENSION_ID,
  name: "Coordination events fixture",
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
  serverBootId: "events-fixture-boot",
  configRevision: 7,
  protectedLorebookRegistry: JSON.stringify({
    version: 1,
    extensionStorage: { resourceRevision: 7 },
    lorebooks: { "book-a": { resourceRevision: 11 } },
  }),
  activeOperations: "[]",
  createdAt: timestamp,
  updatedAt: timestamp,
});

let eventService: PersonalExtensionCoordinationEventService;
let failEventPublication = false;
const coordinationService = createPersonalExtensionCoordinationService(db, {
  serverBootId: "events-fixture-boot",
  eventPublisher: {
    publish(extensionId, draft) {
      if (failEventPublication) throw new Error("simulated post-commit event publication failure");
      return eventService.publish(extensionId, draft);
    },
  },
});
eventService = createPersonalExtensionCoordinationEventService(db, {
  coordinationService,
  now: () => nowMs,
  randomEventEpoch: () => EVENT_EPOCH,
  replayLimit: 3,
  sweepIntervalMs: 0,
});

async function expectEventCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PersonalExtensionCoordinationEventError);
    assert.equal(error.code, code);
    return true;
  });
}

try {
  {
    let runtimeActive = true;
    let deferredState: Promise<never> | undefined;
    let resolveDeferredState: ((value: never) => void) | undefined;
    let stateReads = 0;
    const epochs = [RESET_EVENT_EPOCH_A, RESET_EVENT_EPOCH_B, RESET_EVENT_EPOCH_C, RESET_EVENT_EPOCH_D];
    const resetService = createPersonalExtensionCoordinationEventService(db, {
      coordinationService: {
        async getState() {
          stateReads += 1;
          if (deferredState) return deferredState;
          return {
            mode: runtimeActive ? "active" : "inactive",
            coordinationActive: runtimeActive,
          } as never;
        },
      },
      randomEventEpoch: () => {
        const epoch = epochs.shift();
        assert.ok(epoch, "reset regression exhausted its deterministic event epochs");
        return epoch;
      },
      replayLimit: 3,
      sweepIntervalMs: 0,
    });

    try {
      const oldRuntimeSink = sink();
      await resetService.subscribe({ extensionId: EXTENSION_ID, deviceSessionId: DEVICE_A }, oldRuntimeSink.value);
      assert.deepEqual(oldRuntimeSink.events, [
        {
          schemaVersion: 1,
          eventEpoch: RESET_EVENT_EPOCH_A,
          cursor: 0,
          type: "reset",
        },
      ]);
      const oldRuntimeEvent = resetService.publish(EXTENSION_ID, { type: "config-changed", configRevision: 7 });
      assert.equal(oldRuntimeEvent.eventEpoch, RESET_EVENT_EPOCH_A);
      assert.equal(oldRuntimeEvent.cursor, 1);

      runtimeActive = false;
      const rotatedReset = resetService.resetExtensionRuntime(EXTENSION_ID);
      assert.deepEqual(rotatedReset, {
        schemaVersion: 1,
        eventEpoch: RESET_EVENT_EPOCH_B,
        cursor: 0,
        type: "reset",
      });
      assert.deepEqual(oldRuntimeSink.closeReasons, ["runtime-changed"]);
      assert.equal(
        oldRuntimeSink.events.length,
        2,
        "runtime reset must close an old sink without sending it a reset payload",
      );
      assert.equal(resetService.subscriberCount(EXTENSION_ID), 0);

      await expectEventCode(
        resetService.subscribe(
          {
            extensionId: EXTENSION_ID,
            deviceSessionId: DEVICE_A,
            eventEpoch: RESET_EVENT_EPOCH_A,
            cursor: oldRuntimeEvent.cursor,
          },
          sink().value,
        ),
        "coordination-inactive",
      );

      runtimeActive = true;
      const reactivatedSink = sink();
      const reactivated = await resetService.subscribe(
        {
          extensionId: EXTENSION_ID,
          deviceSessionId: DEVICE_A,
          eventEpoch: RESET_EVENT_EPOCH_A,
          cursor: oldRuntimeEvent.cursor,
        },
        reactivatedSink.value,
      );
      assert.deepEqual(reactivatedSink.events, [rotatedReset]);

      const emptyReplaySink = sink();
      const emptyReplay = await resetService.subscribe(
        {
          extensionId: EXTENSION_ID,
          deviceSessionId: DEVICE_B,
          eventEpoch: RESET_EVENT_EPOCH_B,
          cursor: 0,
        },
        emptyReplaySink.value,
      );
      assert.deepEqual(emptyReplaySink.events, [], "rotating the epoch must discard the old replay buffer");
      emptyReplay.close();

      const firstNewRuntimeEvent = resetService.publish(EXTENSION_ID, { type: "lease-changed" });
      assert.equal(firstNewRuntimeEvent.eventEpoch, RESET_EVENT_EPOCH_B);
      assert.equal(firstNewRuntimeEvent.cursor, 1);
      assert.deepEqual(reactivatedSink.events, [rotatedReset, firstNewRuntimeEvent]);
      reactivated.close();

      deferredState = new Promise<never>((resolve) => {
        resolveDeferredState = resolve;
      });
      const readsBeforeRace = stateReads;
      const racedSink = sink();
      const racedSubscription = resetService.subscribe(
        {
          extensionId: EXTENSION_ID,
          deviceSessionId: DEVICE_B,
          eventEpoch: RESET_EVENT_EPOCH_B,
          cursor: firstNewRuntimeEvent.cursor,
        },
        racedSink.value,
      );
      assert.equal(stateReads, readsBeforeRace + 1, "subscribe must reach the deferred runtime-state read");
      resetService.resetExtensionRuntime(EXTENSION_ID);
      resolveDeferredState?.({ mode: "active", coordinationActive: true } as never);
      await expectEventCode(racedSubscription, "coordination-unavailable");
      assert.deepEqual(racedSink.events, []);
      assert.deepEqual(racedSink.closeReasons, []);
      assert.equal(resetService.subscriberCount(EXTENSION_ID), 0, "a subscribe-vs-reset race must leave no ghost sink");

      deferredState = new Promise<never>((resolve) => {
        resolveDeferredState = resolve;
      });
      const dirtyReadsBeforeRace = stateReads;
      const racedDirty = resetService.signalDirty({
        extensionId: EXTENSION_ID,
        deviceSessionId: DEVICE_A,
        chatId: "dirty-vs-reset",
      });
      assert.equal(stateReads, dirtyReadsBeforeRace + 1, "dirty admission must reach the deferred runtime-state read");
      const dirtyRaceReset = resetService.resetExtensionRuntime(EXTENSION_ID);
      assert.equal(dirtyRaceReset.eventEpoch, RESET_EVENT_EPOCH_D);
      resolveDeferredState?.({ mode: "active", coordinationActive: true } as never);
      await expectEventCode(racedDirty, "coordination-unavailable");
      const firstAfterDirtyRace = resetService.publish(EXTENSION_ID, { type: "lease-changed" });
      assert.equal(firstAfterDirtyRace.eventEpoch, RESET_EVENT_EPOCH_D);
      assert.equal(firstAfterDirtyRace.cursor, 1, "a stale dirty request must not seed the post-reset replay stream");
    } finally {
      resetService.shutdown();
    }
  }

  const firstSink = sink();
  const firstSubscription = await eventService.subscribe(
    { extensionId: EXTENSION_ID, deviceSessionId: DEVICE_A },
    firstSink.value,
  );
  assert.equal(firstSink.events.length, 1);
  assert.equal((firstSink.events[0] as { type: string }).type, "reset");
  assert.equal(eventService.subscriberCount(EXTENSION_ID), 1);

  const configEvent = eventService.publish(EXTENSION_ID, { type: "config-changed", configRevision: 7 });
  const handoffEvent = eventService.publish(EXTENSION_ID, {
    type: "handoff-requested",
    requestId: PUBLIC_HANDOFF_ID,
  });
  assertEventPayloadSafe(configEvent);
  assertEventPayloadSafe(handoffEvent);
  assert.equal(JSON.stringify(handoffEvent).includes(PUBLIC_HANDOFF_ID), true);
  assert.throws(() =>
    eventService.publish(EXTENSION_ID, {
      type: "source-dirty",
      chatId: "chat-a",
      content: RAW_MEMORY,
    } as never),
  );
  assert.throws(() =>
    eventService.publish(EXTENSION_ID, {
      type: "resource-changed",
      resourceRevision: 11,
      resourceId: RAW_RESOURCE_ID,
      entryId: RAW_ENTRY_ID,
    } as never),
  );

  const replacementSink = sink();
  const replacement = await eventService.subscribe(
    {
      extensionId: EXTENSION_ID,
      deviceSessionId: DEVICE_A,
      eventEpoch: configEvent.eventEpoch,
      cursor: configEvent.cursor,
    },
    replacementSink.value,
  );
  assert.deepEqual(firstSink.closeReasons, ["replaced"]);
  assert.deepEqual(
    replacementSink.events.map((event) => (event as { cursor: number }).cursor),
    [handoffEvent.cursor],
  );
  firstSubscription.close();
  replacement.close();
  assert.equal(eventService.subscriberCount(EXTENSION_ID), 0);

  const capSubscriptions: { close(): void }[] = [];
  for (let index = 0; index < 8; index += 1) {
    capSubscriptions.push(
      await eventService.subscribe({ extensionId: EXTENSION_ID, deviceSessionId: randomUUID() }, sink().value),
    );
  }
  await expectEventCode(
    eventService.subscribe({ extensionId: EXTENSION_ID, deviceSessionId: randomUUID() }, sink().value),
    "event-subscriber-limit",
  );
  assert.equal(eventService.subscriberCount(EXTENSION_ID), 8);
  for (const subscription of capSubscriptions) subscription.close();

  const replayStart = eventService.publish(EXTENSION_ID, { type: "lease-changed" });
  eventService.publish(EXTENSION_ID, { type: "resource-changed", resourceRevision: 11 });
  eventService.publish(EXTENSION_ID, { type: "source-dirty", chatId: "chat-replay-a" });
  const replayEnd = eventService.publish(EXTENSION_ID, { type: "source-dirty", chatId: "chat-replay-b" });
  const replaySink = sink();
  const replaySubscription = await eventService.subscribe(
    {
      extensionId: EXTENSION_ID,
      deviceSessionId: DEVICE_B,
      eventEpoch: replayEnd.eventEpoch,
      cursor: replayEnd.cursor - 1,
    },
    replaySink.value,
  );
  assert.deepEqual(
    replaySink.events.map((event) => (event as { cursor: number }).cursor),
    [replayEnd.cursor],
  );
  replaySubscription.close();
  const gapSink = sink();
  const gapSubscription = await eventService.subscribe(
    {
      extensionId: EXTENSION_ID,
      deviceSessionId: DEVICE_B,
      eventEpoch: replayStart.eventEpoch,
      cursor: replayStart.cursor - 1,
    },
    gapSink.value,
  );
  assert.equal((gapSink.events[0] as { type: string }).type, "reset");
  assert.equal((gapSink.events[0] as { cursor: number }).cursor, replayEnd.cursor);
  gapSubscription.close();

  const beforeRows = await db
    .select({
      configRevision: personalExtensionCoordination.configRevision,
      protectedLorebookRegistry: personalExtensionCoordination.protectedLorebookRegistry,
    })
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  const firstDirty = await eventService.signalDirty({
    extensionId: EXTENSION_ID,
    deviceSessionId: DEVICE_A,
    chatId: "chat-a",
  });
  const coalescedDirty = await eventService.signalDirty({
    extensionId: EXTENSION_ID,
    deviceSessionId: DEVICE_A,
    chatId: "chat-a",
  });
  assert.equal(firstDirty.coalesced, false);
  assert.equal(coalescedDirty.coalesced, true);
  assert.equal(coalescedDirty.cursor, firstDirty.cursor);
  nowMs += 2_000;
  const laterDirty = await eventService.signalDirty({
    extensionId: EXTENSION_ID,
    deviceSessionId: DEVICE_A,
    chatId: "chat-a",
  });
  assert.equal(laterDirty.coalesced, false);
  assert.equal(laterDirty.cursor, firstDirty.cursor + 1);

  const rateDevice = "10000000-0000-4000-8000-000000000003";
  for (let index = 0; index < 60; index += 1) {
    await eventService.signalDirty({ extensionId: EXTENSION_ID, deviceSessionId: rateDevice, chatId: "rate-chat" });
  }
  await expectEventCode(
    eventService.signalDirty({ extensionId: EXTENSION_ID, deviceSessionId: rateDevice, chatId: "rate-chat" }),
    "dirty-rate-limited",
  );
  const afterRows = await db
    .select({
      configRevision: personalExtensionCoordination.configRevision,
      protectedLorebookRegistry: personalExtensionCoordination.protectedLorebookRegistry,
    })
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, EXTENSION_ID));
  assert.deepEqual(afterRows, beforeRows, "dirty hints must mutate zero protected revisions");

  const routeEventService = {
    ...eventService,
    async subscribe(
      input: Parameters<typeof eventService.subscribe>[0],
      eventSink: PersonalExtensionCoordinationEventSink,
    ) {
      const subscription = await eventService.subscribe(input, eventSink);
      setImmediate(() => eventSink.close("shutdown"));
      return subscription;
    },
  };
  const app = Fastify();
  app.decorate("db", db);
  app.addHook("onRequest", csrfProtectionHook);
  await app.register(personalExtensionCoordinationRoutes, {
    prefix: "/api/personal-extensions",
    service: coordinationService,
    eventService: routeEventService,
  });

  const routeBase = `/api/personal-extensions/${EXTENSION_ID}/coordination`;
  const csrfHeaders = {
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    "sec-fetch-site": "same-site",
  };
  const publicationSink = sink();
  const publicationSubscription = await eventService.subscribe(
    { extensionId: EXTENSION_ID, deviceSessionId: DEVICE_A },
    publicationSink.value,
  );
  const holderHeaders = (holderSessionId: string) => ({
    ...csrfHeaders,
    [CSRF_HEADER]: CSRF_HEADER_VALUE,
    [PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER]: holderSessionId,
  });
  const acquireBody = { serverBootId: "events-fixture-boot", contentHash: CONTENT_HASH };
  const firstAcquire = await app.inject({
    method: "POST",
    url: `${routeBase}/lease/acquire`,
    headers: holderHeaders(DEVICE_A),
    payload: acquireBody,
  });
  assert.equal(firstAcquire.statusCode, 200, firstAcquire.body);
  const firstLease = firstAcquire.json() as {
    serverBootId: string;
    contentHash: string;
    fence: number;
    leaseToken: string;
  };
  assert.equal((publicationSink.events.at(-1) as { type: string }).type, "lease-changed");

  const handoff = await app.inject({
    method: "POST",
    url: `${routeBase}/handoff`,
    headers: holderHeaders(DEVICE_B),
    payload: acquireBody,
  });
  assert.equal(handoff.statusCode, 200, handoff.body);
  const handoffResult = handoff.json() as { requestId: string };
  assert.deepEqual(publicationSink.events.at(-1), {
    schemaVersion: 1,
    eventEpoch: EVENT_EPOCH,
    cursor: (publicationSink.events.at(-1) as { cursor: number }).cursor,
    type: "handoff-requested",
    requestId: handoffResult.requestId,
  });
  const afterFirstHandoff = publicationSink.events.length;
  const repeatedHandoff = await app.inject({
    method: "POST",
    url: `${routeBase}/handoff`,
    headers: holderHeaders(DEVICE_B),
    payload: acquireBody,
  });
  assert.equal(repeatedHandoff.statusCode, 200, repeatedHandoff.body);
  assert.equal(publicationSink.events.length, afterFirstHandoff, "idempotent handoff reads must not republish");

  const releaseBody = {
    serverBootId: firstLease.serverBootId,
    contentHash: firstLease.contentHash,
    fence: firstLease.fence,
    leaseToken: firstLease.leaseToken,
    handoffRequestId: handoffResult.requestId,
  };
  const released = await app.inject({
    method: "POST",
    url: `${routeBase}/lease/release`,
    headers: holderHeaders(DEVICE_A),
    payload: releaseBody,
  });
  assert.equal(released.statusCode, 200, released.body);
  assert.equal((publicationSink.events.at(-1) as { type: string }).type, "lease-changed");

  const reservedAcquire = await app.inject({
    method: "POST",
    url: `${routeBase}/lease/acquire`,
    headers: holderHeaders(DEVICE_B),
    payload: acquireBody,
  });
  assert.equal(reservedAcquire.statusCode, 200, reservedAcquire.body);
  const reservedLease = reservedAcquire.json() as typeof firstLease;
  assert.equal((publicationSink.events.at(-1) as { type: string }).type, "lease-changed");

  const beforeFailedPublication = publicationSink.events.length;
  failEventPublication = true;
  const isolatedRelease = await app.inject({
    method: "POST",
    url: `${routeBase}/lease/release`,
    headers: holderHeaders(DEVICE_B),
    payload: {
      serverBootId: reservedLease.serverBootId,
      contentHash: reservedLease.contentHash,
      fence: reservedLease.fence,
      leaseToken: reservedLease.leaseToken,
    },
  });
  failEventPublication = false;
  assert.equal(isolatedRelease.statusCode, 200, isolatedRelease.body);
  assert.equal(publicationSink.events.length, beforeFailedPublication, "publisher failure must not forge an event");
  const committedAfterPublishFailure = await coordinationService.getState(EXTENSION_ID, DEVICE_B);
  assert.equal(committedAfterPublishFailure.role, "follower", "publisher failure must not reverse the durable release");
  publicationSubscription.close();

  const missingCsrf = await app.inject({
    method: "POST",
    url: `${routeBase}/dirty`,
    headers: csrfHeaders,
    payload: { deviceSessionId: DEVICE_B, chatId: "route-chat" },
  });
  assert.equal(missingCsrf.statusCode, 403);
  assert.equal(missingCsrf.json().code, "CSRF_MISSING_HEADER");
  const unknownDirtyField = await app.inject({
    method: "POST",
    url: `${routeBase}/dirty`,
    headers: { ...csrfHeaders, [CSRF_HEADER]: CSRF_HEADER_VALUE },
    payload: { deviceSessionId: DEVICE_B, chatId: "route-chat", content: RAW_MEMORY },
  });
  assert.equal(unknownDirtyField.statusCode, 400);
  assert.equal(unknownDirtyField.json().code, "invalid-request");
  const acceptedDirty = await app.inject({
    method: "POST",
    url: `${routeBase}/dirty`,
    headers: { ...csrfHeaders, [CSRF_HEADER]: CSRF_HEADER_VALUE },
    payload: { deviceSessionId: DEVICE_B, chatId: "route-chat" },
  });
  assert.equal(acceptedDirty.statusCode, 200);
  assert.equal(acceptedDirty.json().accepted, true);

  const invalidSse = await app.inject({
    method: "GET",
    url: `${routeBase}/events?deviceSessionId=${DEVICE_B}&unknown=1`,
  });
  assert.equal(invalidSse.statusCode, 400);
  assert.equal(invalidSse.json().code, "invalid-request");
  const sse = await app.inject({
    method: "GET",
    url: `${routeBase}/events?deviceSessionId=${DEVICE_B}`,
  });
  assert.equal(sse.statusCode, 200);
  assert.match(String(sse.headers["content-type"]), /^text\/event-stream/u);
  assert.match(sse.body, /"type":"reset"/u);
  assert.equal(sse.body.includes(RAW_MEMORY), false);
  assert.equal(sse.body.includes(RAW_TOKEN), false);
  assert.equal(eventService.subscriberCount(EXTENSION_ID), 0, "closed SSE routes must remove their listener");

  const hashChangedSink = sink();
  await eventService.subscribe({ extensionId: EXTENSION_ID, deviceSessionId: DEVICE_A }, hashChangedSink.value);
  await db
    .update(installedExtensions)
    .set({ approvedHash: "different-approved-hash", updatedAt: "2026-08-16T00:01:00.000Z" })
    .where(eq(installedExtensions.id, EXTENSION_ID));
  await eventService.sweepInvalidSubscribers();
  assert.deepEqual(hashChangedSink.closeReasons, ["runtime-changed"]);
  assert.equal(eventService.subscriberCount(EXTENSION_ID), 0);

  await db
    .update(installedExtensions)
    .set({ approvedHash: CONTENT_HASH, updatedAt: "2026-08-16T00:02:00.000Z" })
    .where(eq(installedExtensions.id, EXTENSION_ID));
  const disabledSink = sink();
  await eventService.subscribe({ extensionId: EXTENSION_ID, deviceSessionId: DEVICE_A }, disabledSink.value);
  await db
    .update(installedExtensions)
    .set({ enabled: "false", updatedAt: "2026-08-16T00:03:00.000Z" })
    .where(eq(installedExtensions.id, EXTENSION_ID));
  await eventService.sweepInvalidSubscribers();
  assert.deepEqual(disabledSink.closeReasons, ["runtime-changed"]);
  assert.equal(eventService.subscriberCount(EXTENSION_ID), 0);

  await db
    .update(installedExtensions)
    .set({ enabled: "true", updatedAt: "2026-08-16T00:04:00.000Z" })
    .where(eq(installedExtensions.id, EXTENSION_ID));
  const shutdownSink = sink();
  await eventService.subscribe({ extensionId: EXTENSION_ID, deviceSessionId: DEVICE_A }, shutdownSink.value);
  await app.close();
  assert.deepEqual(shutdownSink.closeReasons, ["shutdown"]);
  assert.equal(eventService.subscriberCount(), 0);

  console.log("personal-extension-coordination events regression: PASS");
} finally {
  eventService.shutdown();
  await fileDb._fileStore.close();
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}
