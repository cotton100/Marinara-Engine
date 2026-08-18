import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  personalExtensionCoordinationLorebookEntrySchema,
  personalExtensionCoordinationLorebookSchema,
  personalExtensionCoordinationRevisionedLorebookResponseSchema,
} from "../../packages/shared/dist/index.js";

const EXTENSION_ID = "coordination-facade-fixture";
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;
const SERVER_BOOT_ID = "coordination-facade-boot";
const RAW_LEASE_TOKEN = "raw-lease-token-must-stay-private";
const RAW_OPERATION_HANDLE = "raw-operation-handle-must-stay-private";
const HANDOFF_REQUEST_ID = "handoff-request-fixture-0001";
const EVENT_EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EVENT_EPOCH_B = "22222222-2222-4222-8222-222222222222";
const LOREBOOK_ID = "protected-lorebook";
const CREATED_LOREBOOK_ID = "created-protected-lorebook";
const ENTRY_ID = "protected-entry";
const trustedJsonStringify = JSON.stringify.bind(JSON);
const nativeSetTimeout = globalThis.setTimeout;
const nativeReflectApply = Reflect.apply;
const nativeFunctionCall = Function.prototype.call;
const nativeArrayPush = Array.prototype.push;
const nativeArrayIterator = Array.prototype[Symbol.iterator];
const nativeObjectKeys = Object.keys;
const nativeObjectEntries = Object.entries;
const nativeObjectValues = Object.values;
const nativeObjectHasOwn = Object.hasOwn;
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const nativeObjectDefineProperty = Object.defineProperty;
const NativePromise = globalThis.Promise;
const nativePromiseThen = NativePromise.prototype.then;
const nativePromiseConstructorDescriptor = nativeObjectGetOwnPropertyDescriptor(
  NativePromise.prototype,
  "constructor",
)!;
const nativePromiseThenDescriptor = nativeObjectGetOwnPropertyDescriptor(NativePromise.prototype, "then")!;
// Every RequestInit dictionary member a browser reads during conversion.
const REQUEST_INIT_DICTIONARY_MEMBERS = [
  "method",
  "headers",
  "body",
  "referrer",
  "referrerPolicy",
  "mode",
  "credentials",
  "cache",
  "redirect",
  "integrity",
  "keepalive",
  "signal",
  "window",
  "duplex",
  "priority",
] as const;
const NativeSet = globalThis.Set;
const nativeSetAdd = Set.prototype.add;
const nativeSetDelete = Set.prototype.delete;
const nativeSetClear = Set.prototype.clear;
const nativeSetHas = Set.prototype.has;
const nativeSetForEach = Set.prototype.forEach;
const nativeSetIterator = Set.prototype[Symbol.iterator];
const nativeSetSizeDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, "size")!;
const nativeMapGet = Map.prototype.get;
const nativeMapSet = Map.prototype.set;
const nativeMapDelete = Map.prototype.delete;
const nativeMapClear = Map.prototype.clear;
const nativeMapHas = Map.prototype.has;
const nativeMapForEach = Map.prototype.forEach;
const nativeMapIterator = Map.prototype[Symbol.iterator];
const nativeMapSizeDescriptor = Object.getOwnPropertyDescriptor(Map.prototype, "size")!;
const nativeWeakMapGet = WeakMap.prototype.get;
const nativeWeakMapSet = WeakMap.prototype.set;
const nativeWeakMapDelete = WeakMap.prototype.delete;
const nativeResponseOkDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, "ok")!;
const nativeResponseStatusDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, "status")!;
const nativeResponseBodyDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, "body")!;
const nativeResponseText = Response.prototype.text;
const observedTimeouts: number[] = [];
let accelerateNextDeadline = false;

function hostArrayPush<T>(target: T[], ...values: T[]) {
  return nativeReflectApply(nativeArrayPush, target, values);
}

globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  const delay = Number(timeout ?? 0);
  hostArrayPush(observedTimeouts, delay);
  const effectiveDelay = accelerateNextDeadline || delay === 1_000 ? Math.min(delay, 5) : delay;
  accelerateNextDeadline = false;
  return nativeSetTimeout(handler, effectiveDelay, ...args);
}) as typeof setTimeout;

function lorebookFixture(id = LOREBOOK_ID, name = "Protected book") {
  return {
    id,
    name,
    description: "",
    category: "uncategorized",
    imagePath: null,
    scanDepth: 2,
    tokenBudget: 2048,
    entryLimit: 100,
    recursiveScanning: false,
    maxRecursionDepth: 3,
    excludeFromVectorization: false,
    vectorQueryDepth: 3,
    vectorScoreThreshold: 0.35,
    vectorMaxResults: 10,
    characterId: null,
    characterIds: [],
    personaId: null,
    personaIds: [],
    chatId: null,
    isGlobal: false,
    enabled: true,
    hiddenFromLibrary: false,
    scope: { mode: "all", chatIds: [] },
    tags: [],
    generatedBy: null,
    sourceAgentId: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

function entryFixture(name = "Protected entry") {
  return {
    id: ENTRY_ID,
    lorebookId: LOREBOOK_ID,
    name,
    content: "memory",
    description: "",
    keys: [],
    secondaryKeys: [],
    enabled: true,
    constant: false,
    selective: false,
    selectiveLogic: "and",
    probability: null,
    scanDepth: null,
    matchWholeWords: false,
    caseSensitive: false,
    useRegex: false,
    characterFilterMode: "any",
    characterFilterIds: [],
    characterTagFilterMode: "any",
    characterTagFilters: [],
    generationTriggerFilterMode: "any",
    generationTriggerFilters: [],
    additionalMatchingSources: [],
    position: 0,
    outletName: "",
    depth: 4,
    order: 100,
    role: "system",
    sticky: null,
    cooldown: null,
    delay: null,
    ephemeral: null,
    group: "",
    groupWeight: null,
    folderId: null,
    locked: false,
    preventRecursion: true,
    excludeRecursion: false,
    delayUntilRecursion: false,
    tag: "",
    relationships: {},
    dynamicState: {},
    activationConditions: [],
    schedule: null,
    excludeFromVectorization: false,
    embedding: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

assert.equal(
  personalExtensionCoordinationLorebookSchema.safeParse(lorebookFixture()).success,
  true,
  "the facade regression must use the exact closed lorebook response shape",
);
assert.equal(
  personalExtensionCoordinationLorebookEntrySchema.safeParse(entryFixture()).success,
  true,
  "the facade regression must use the exact closed lorebook entry response shape",
);

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(key);
  }

  setItem(key: string, value: string) {
    this.#values.set(key, value);
  }
}

type TrustedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
};

type EventResponseFixture =
  | { kind: "events"; events: unknown[]; close: boolean }
  | { kind: "error"; code: "coordination-unavailable" | "event-subscriber-limit" };

const trustedRequests: TrustedRequest[] = [];
const pageFetchRequests: Array<{ input: unknown; init: unknown }> = [];
let malformedState = false;
let buildingTrustedResponse = false;
let blockNextRequest = false;
let lorebookRevision = 7;
let createdLorebookRevision = 0;
let dirtyRateLimited = false;
let leaseHeldOnce = false;
let eventStreamCancellations = 0;
const eventResponseFixtures: EventResponseFixture[] = [];
const transportTimeline: string[] = [];

function eventually(check: () => boolean, message: string) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(message));
        return;
      }
      nativeSetTimeout(poll, 5);
    };
    poll();
  });
}

const trustedFetch: typeof fetch = async (input, init = {}) => {
  // A real browser converts RequestInit as a WebIDL dictionary, which performs
  // [[Get]] for EVERY member — including the ones the caller left unset. Model
  // that here so an init object inheriting from a polluted Object.prototype is
  // caught by this fixture instead of only in a browser.
  for (const member of REQUEST_INIT_DICTIONARY_MEMBERS) {
    void (init as Record<string, unknown>)[member];
  }
  const url = String(input);
  const method = String(init.method ?? "GET").toUpperCase();
  // Model native fetch's header capture without routing the trusted request
  // envelope back through the page-polluted Object/Array prototypes.
  const headers = Object.create(null) as Record<string, string>;
  const sourceHeaders = (init.headers ?? {}) as Record<string, unknown>;
  const sourceHeaderKeys = nativeObjectKeys(sourceHeaders);
  for (let index = 0; index < sourceHeaderKeys.length; index += 1) {
    const key = sourceHeaderKeys[index]!;
    headers[key.toLowerCase()] = String(sourceHeaders[key]);
  }
  const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  hostArrayPush(trustedRequests, { url, method, headers, body });
  hostArrayPush(transportTimeline, `${method} ${url}`);

  if (blockNextRequest) {
    blockNextRequest = false;
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(new Error("fixture request aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("fixture request aborted")), { once: true });
    });
  }

  const json = (status: number, value: unknown) => {
    buildingTrustedResponse = true;
    try {
      return new Response(trustedJsonStringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    } finally {
      buildingTrustedResponse = false;
    }
  };

  if (url.startsWith(`/api/personal-extensions/${EXTENSION_ID}/coordination/events?`) && method === "GET") {
    assert.equal(headers.accept, "text/event-stream");
    assert.equal("x-marinara-coordination-holder-session-id" in headers, false);
    assert.equal("x-marinara-coordination-lease-token" in headers, false);
    const fixture = eventResponseFixtures.shift();
    if (!fixture) throw new Error("unexpected coordination event subscription");
    if (fixture.kind === "error") {
      return json(fixture.code === "event-subscriber-limit" ? 429 : 503, {
        code: fixture.code,
        error: "Event subscription unavailable.",
      });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of fixture.events) {
          controller.enqueue(encoder.encode(`data: ${trustedJsonStringify(event)}\n\n`));
        }
        if (fixture.close) controller.close();
      },
      cancel() {
        eventStreamCancellations += 1;
        hostArrayPush(transportTimeline, "event-stream-cancelled");
      },
    });
    buildingTrustedResponse = true;
    try {
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    } finally {
      buildingTrustedResponse = false;
    }
  }

  if (url.startsWith("/api/lorebooks")) {
    assert.equal(headers["x-marinara-coordination-extension-id"], EXTENSION_ID);
    assert.equal(headers["x-marinara-coordination-holder-session-id"]?.length, 36);
    assert.equal(headers["x-marinara-coordination-server-boot-id"], SERVER_BOOT_ID);
    assert.equal(headers["x-marinara-coordination-content-hash"], CONTENT_HASH);
    assert.equal(headers["x-marinara-coordination-fence"], "1");
    if (headers["x-marinara-coordination-lease-token"] !== RAW_LEASE_TOKEN) {
      throw new Error("trusted transport received the wrong lease token");
    }

    if (url === "/api/lorebooks/coordination" && method === "GET") {
      return json(200, { items: [{ value: lorebookFixture(), resourceRevision: lorebookRevision }] });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination` && method === "GET") {
      return json(200, { value: lorebookFixture(), resourceRevision: lorebookRevision });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination/entries` && method === "GET") {
      return json(200, { items: [entryFixture()], resourceRevision: lorebookRevision });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination/entries/${ENTRY_ID}` && method === "GET") {
      return json(200, { value: entryFixture(), resourceRevision: lorebookRevision });
    }
    if (url === "/api/lorebooks/coordination" && method === "POST") {
      const payload = {
        value: lorebookFixture(CREATED_LOREBOOK_ID, String((body?.book as { name?: unknown })?.name ?? "Created")),
        resourceRevision: createdLorebookRevision,
      };
      assert.equal(
        personalExtensionCoordinationRevisionedLorebookResponseSchema.safeParse(payload).success,
        true,
        "the fake create response must satisfy the exact closed wire schema",
      );
      return json(200, payload);
    }
    if (url === `/api/lorebooks/${CREATED_LOREBOOK_ID}/coordination` && method === "PATCH") {
      assert.equal(body?.expectedResourceRevision, createdLorebookRevision);
      createdLorebookRevision += 1;
      return json(200, {
        value: lorebookFixture(CREATED_LOREBOOK_ID, String((body?.changes as { name?: unknown })?.name ?? "Updated")),
        resourceRevision: createdLorebookRevision,
      });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination` && method === "PATCH") {
      assert.equal(body?.expectedResourceRevision, lorebookRevision);
      lorebookRevision += 1;
      return json(200, {
        value: lorebookFixture(LOREBOOK_ID, String((body?.changes as { name?: unknown })?.name ?? "Updated")),
        resourceRevision: lorebookRevision,
      });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination/entries` && method === "POST") {
      assert.equal(body?.expectedResourceRevision, lorebookRevision);
      lorebookRevision += 1;
      return json(200, {
        value: entryFixture(String((body?.entry as { name?: unknown })?.name ?? "Created entry")),
        resourceRevision: lorebookRevision,
      });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination/entries/${ENTRY_ID}` && method === "PATCH") {
      assert.equal(body?.expectedResourceRevision, lorebookRevision);
      lorebookRevision += 1;
      return json(200, {
        value: entryFixture(String((body?.changes as { name?: unknown })?.name ?? "Updated entry")),
        resourceRevision: lorebookRevision,
      });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination/entries/${ENTRY_ID}` && method === "DELETE") {
      assert.equal(body?.expectedResourceRevision, lorebookRevision);
      lorebookRevision += 1;
      return json(200, { deleted: true, resourceRevision: lorebookRevision });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination/vectorize` && method === "POST") {
      assert.equal(body?.expectedResourceRevision, lorebookRevision);
      assert.equal(body?.onlyMissing, true);
      lorebookRevision += 1;
      return json(200, { vectorized: 1, total: 1, skipped: 0, resourceRevision: lorebookRevision });
    }
    if (url === `/api/lorebooks/${LOREBOOK_ID}/coordination/vectors` && method === "DELETE") {
      assert.equal(body?.expectedResourceRevision, lorebookRevision);
      lorebookRevision += 1;
      return json(200, { cleared: 1, total: 1, resourceRevision: lorebookRevision });
    }
  }

  if (url.endsWith("/coordination") && method === "GET") {
    if (malformedState) {
      malformedState = false;
      return json(200, {
        schemaVersion: 1,
        extensionId: EXTENSION_ID,
        serverBootId: SERVER_BOOT_ID,
        contentHash: CONTENT_HASH,
        fence: 0,
        remainingMs: 0,
        mode: "active",
        coordinationActive: true,
        capabilities: [
          "lease-v1",
          "guarded-operation-v1",
          "revisioned-storage-v1",
          "guarded-lorebook-v1",
          "handoff-v1",
          "events-v1",
          "dirty-signal-v1",
        ],
        role: "follower",
        unexpected: RAW_LEASE_TOKEN,
      });
    }
    return json(200, {
      schemaVersion: 1,
      extensionId: EXTENSION_ID,
      serverBootId: SERVER_BOOT_ID,
      contentHash: CONTENT_HASH,
      fence: body?.fence ?? 0,
      remainingMs: 0,
      mode: "active",
      coordinationActive: true,
      capabilities: [
        "lease-v1",
        "guarded-operation-v1",
        "revisioned-storage-v1",
        "guarded-lorebook-v1",
        "handoff-v1",
        "events-v1",
        "dirty-signal-v1",
      ],
      role: "follower",
    });
  }
  if (url.endsWith("/coordination/lease/acquire") && method === "POST") {
    const holderSessionId = headers["x-marinara-coordination-holder-session-id"];
    if (!holderSessionId) throw new Error("trusted transport received no holder session ID");
    if (leaseHeldOnce) {
      leaseHeldOnce = false;
      return json(409, { code: "lease-held", error: "Another writer is active." });
    }
    return json(200, {
      leaseToken: RAW_LEASE_TOKEN,
      holderSessionId,
      serverBootId: SERVER_BOOT_ID,
      contentHash: CONTENT_HASH,
      fence: 1,
      expiresAt: "2026-08-16T00:01:00.000Z",
      remainingMs: 60_000,
    });
  }
  if (url.endsWith("/coordination/handoff") && method === "POST") {
    assert.equal(body?.serverBootId, SERVER_BOOT_ID);
    assert.equal(body?.contentHash, CONTENT_HASH);
    assert.equal(headers["x-marinara-coordination-holder-session-id"]?.length, 36);
    return json(200, {
      requestId: HANDOFF_REQUEST_ID,
      status: "draining",
      deadlineAt: "2026-08-16T00:00:30.000Z",
      remainingMs: 30_000,
    });
  }
  if (url.endsWith("/coordination/lease/renew") && method === "POST") {
    return json(200, {
      holderSessionId: headers["x-marinara-coordination-holder-session-id"],
      serverBootId: SERVER_BOOT_ID,
      contentHash: CONTENT_HASH,
      fence: body?.fence,
      expiresAt: "2026-08-16T00:02:00.000Z",
      remainingMs: 60_000,
    });
  }
  if (url.endsWith("/coordination/lease/release") && method === "POST") {
    return json(200, {
      fence: Number(body?.fence) + 1,
      serverBootId: SERVER_BOOT_ID,
      contentHash: CONTENT_HASH,
    });
  }
  if (url.endsWith("/coordination/dirty") && method === "POST") {
    if (dirtyRateLimited) {
      return json(429, { code: "dirty-rate-limited", error: "Too many dirty signals." });
    }
    return json(200, { accepted: true, coalesced: false, eventEpoch: EVENT_EPOCH_A, cursor: 1 });
  }
  if (url.endsWith("/coordination/storage") && method === "GET") {
    return json(200, { value: { ensemble: "fixture" }, configRevision: 4 });
  }
  if (url.endsWith("/coordination/operations/begin") && method === "POST") {
    return json(200, {
      operationHandle: RAW_OPERATION_HANDLE,
      kind: body?.kind,
      deadlineAt: "2026-08-16T00:03:00.000Z",
      remainingMs: 180_000,
    });
  }
  if (url.endsWith("/coordination/operations/transition-to-vectorize") && method === "POST") {
    assert.equal(body?.operationHandle, RAW_OPERATION_HANDLE);
    assert.equal(body?.targetEnsembleId, "ensemble-facade");
    return json(200, {
      operationHandle: RAW_OPERATION_HANDLE,
      kind: "vectorize",
      deadlineAt: "2026-08-16T00:10:00.000Z",
      remainingMs: 600_000,
    });
  }
  if (url.endsWith("/coordination/operations/end") && method === "POST") {
    return json(200, {
      ended: true,
      fence: body?.fence,
      serverBootId: SERVER_BOOT_ID,
      contentHash: CONTENT_HASH,
    });
  }
  if (url.endsWith("/coordination/storage") && (method === "PATCH" || method === "DELETE")) {
    return json(200, {
      value: method === "PATCH" ? { coordinated: true } : {},
      configRevision: Number(body?.expectedConfigRevision) + 1,
    });
  }
  return json(404, { code: "personal-extension-not-found", error: "Not found." });
};

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});
Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: trustedFetch });

const { PersonalExtensionCoordinationFacadeError, issuePersonalExtensionCoordinationFacade } =
  await import("../../packages/client/src/lib/personal-extension-coordination-facade.js");
globalThis.setTimeout = nativeSetTimeout;
const hardenedPromiseConstructorDescriptor = nativeObjectGetOwnPropertyDescriptor(
  NativePromise.prototype,
  "constructor",
)!;
assert.equal(hardenedPromiseConstructorDescriptor.value, NativePromise);
assert.equal(hardenedPromiseConstructorDescriptor.writable, false);
assert.equal(hardenedPromiseConstructorDescriptor.configurable, false);

// Full-page extension code runs in the page realm after this host module has
// captured its primitives. Pollute every collection/object path that could
// otherwise receive the host-owned facade, listener callback, lease response,
// or operation capability.
const prototypeObservedValues: unknown[] = [];
const prototypeObservedUuidStacks: Array<{ value: string; stack?: string }> = [];
let prototypeObservedRawAuthority = false;
let requestInitPrototypeGetterFired = false;
let requestInitPrototypeGetterStack: string | undefined;
let prototypeRawAuthorityStack: string | undefined;
let responsePrototypeGetterObserved = false;
let responsePrototypeGetterStack: string | undefined;
let sensitiveFunctionCallObserved = false;
let promiseConstructorHookInstalled = false;
let promiseObservedRawAuthority = false;
let promiseRawAuthorityStack: string | undefined;
let eventHubPrototypeGetterFired = false;
let eventQueryPrototypeGetterFired = false;
let eventQueryPrototypeGetterStack: string | undefined;

function observePrototypeValue(value: unknown, depth = 0): void {
  hostArrayPush(prototypeObservedValues, value);
  if (typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value)) {
    hostArrayPush(prototypeObservedUuidStacks, { value, stack: new Error("UUID observed").stack });
  }
  if (value === RAW_LEASE_TOKEN || value === RAW_OPERATION_HANDLE) {
    prototypeObservedRawAuthority = true;
    prototypeRawAuthorityStack ??= new Error("raw authority observed").stack;
  }
  if (depth >= 4 || ((typeof value !== "object" || value === null) && typeof value !== "function")) return;
  let keys: string[];
  try {
    keys = nativeObjectKeys(value);
  } catch {
    return;
  }
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = nativeObjectGetOwnPropertyDescriptor(value, keys[index]!);
    if (descriptor && "value" in descriptor) observePrototypeValue(descriptor.value, depth + 1);
  }
}

function observeAwaitedValue(value: unknown, depth = 0): void {
  if (value === RAW_LEASE_TOKEN || value === RAW_OPERATION_HANDLE) {
    promiseObservedRawAuthority = true;
    promiseRawAuthorityStack ??= new Error("raw authority observed through Promise.prototype.then").stack;
  }
  if (depth >= 4 || ((typeof value !== "object" || value === null) && typeof value !== "function")) return;
  let keys: string[];
  try {
    keys = nativeObjectKeys(value);
  } catch {
    return;
  }
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = nativeObjectGetOwnPropertyDescriptor(value, keys[index]!);
    if (descriptor && "value" in descriptor) observeAwaitedValue(descriptor.value, depth + 1);
  }
}

// A full-page extension starts after the host module but in the same realm. If
// it can make native promises appear foreign to Await, PromiseResolve falls
// back to the now-hostile `.then` and hands every fulfilled internal value to
// the extension hook.
class HostilePromise<T> extends NativePromise<T> {}
try {
  nativeObjectDefineProperty(NativePromise.prototype, "constructor", {
    ...nativePromiseConstructorDescriptor,
    value: HostilePromise,
  });
  promiseConstructorHookInstalled = true;
} catch {
  // The host is expected to have made this intrinsic boundary immutable.
}
nativeObjectDefineProperty(NativePromise.prototype, "then", {
  ...nativePromiseThenDescriptor,
  value(this: Promise<unknown>, onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
    const observedFulfilled = (value: unknown) => {
      observeAwaitedValue(value);
      return typeof onFulfilled === "function" ? nativeReflectApply(onFulfilled, undefined, [value]) : value;
    };
    return nativeReflectApply(nativePromiseThen, this, [observedFulfilled, onRejected]);
  },
});

function observeSetContents(target: Set<unknown>): void {
  observePrototypeValue(target);
  nativeReflectApply(nativeSetForEach, target, [(value: unknown) => observePrototypeValue(value)]);
}

function observeMapContents(target: Map<unknown, unknown>): void {
  observePrototypeValue(target);
  nativeReflectApply(nativeMapForEach, target, [
    (value: unknown, key: unknown) => {
      observePrototypeValue(key);
      observePrototypeValue(value);
    },
  ]);
}

const HostileSet = new Proxy(NativeSet, {
  construct(target, args, newTarget) {
    for (let index = 0; index < args.length; index += 1) observePrototypeValue(args[index]);
    return Reflect.construct(target, args, newTarget);
  },
});
globalThis.Set = HostileSet as SetConstructor;

Set.prototype.add = function (value: unknown) {
  observeSetContents(this);
  observePrototypeValue(value);
  return nativeReflectApply(nativeSetAdd, this, [value]);
} as typeof Set.prototype.add;
Set.prototype.delete = function (value: unknown) {
  observeSetContents(this);
  observePrototypeValue(value);
  return nativeReflectApply(nativeSetDelete, this, [value]);
} as typeof Set.prototype.delete;
Set.prototype.clear = function () {
  observeSetContents(this);
  return nativeReflectApply(nativeSetClear, this, []);
};
Set.prototype.has = function (value: unknown) {
  observeSetContents(this);
  observePrototypeValue(value);
  return nativeReflectApply(nativeSetHas, this, [value]);
} as typeof Set.prototype.has;
Set.prototype.forEach = function (callback: (...args: unknown[]) => unknown, thisArg?: unknown) {
  observeSetContents(this);
  observePrototypeValue(callback);
  return nativeReflectApply(nativeSetForEach, this, [callback, thisArg]);
} as typeof Set.prototype.forEach;
Set.prototype[Symbol.iterator] = function () {
  observeSetContents(this);
  return nativeReflectApply(nativeSetIterator, this, []);
};
Object.defineProperty(Set.prototype, "size", {
  ...nativeSetSizeDescriptor,
  get(this: Set<unknown>) {
    observeSetContents(this);
    return nativeReflectApply(nativeSetSizeDescriptor.get!, this, []);
  },
});

Map.prototype.get = function (key: unknown) {
  observeMapContents(this);
  observePrototypeValue(key);
  return nativeReflectApply(nativeMapGet, this, [key]);
} as typeof Map.prototype.get;
Map.prototype.set = function (key: unknown, value: unknown) {
  observeMapContents(this);
  observePrototypeValue(key);
  observePrototypeValue(value);
  return nativeReflectApply(nativeMapSet, this, [key, value]);
} as typeof Map.prototype.set;
Map.prototype.delete = function (key: unknown) {
  observeMapContents(this);
  observePrototypeValue(key);
  return nativeReflectApply(nativeMapDelete, this, [key]);
} as typeof Map.prototype.delete;
Map.prototype.clear = function () {
  observeMapContents(this);
  return nativeReflectApply(nativeMapClear, this, []);
};
Map.prototype.has = function (key: unknown) {
  observeMapContents(this);
  observePrototypeValue(key);
  return nativeReflectApply(nativeMapHas, this, [key]);
} as typeof Map.prototype.has;
Map.prototype.forEach = function (callback: (...args: unknown[]) => unknown, thisArg?: unknown) {
  observeMapContents(this);
  observePrototypeValue(callback);
  return nativeReflectApply(nativeMapForEach, this, [callback, thisArg]);
} as typeof Map.prototype.forEach;
Map.prototype[Symbol.iterator] = function () {
  observeMapContents(this);
  return nativeReflectApply(nativeMapIterator, this, []);
};
Object.defineProperty(Map.prototype, "size", {
  ...nativeMapSizeDescriptor,
  get(this: Map<unknown, unknown>) {
    observeMapContents(this);
    return nativeReflectApply(nativeMapSizeDescriptor.get!, this, []);
  },
});

WeakMap.prototype.get = function (key: object) {
  observePrototypeValue(key);
  const value = nativeReflectApply(nativeWeakMapGet, this, [key]);
  observePrototypeValue(value);
  return value;
};
WeakMap.prototype.set = function (key: object, value: unknown) {
  observePrototypeValue(key);
  observePrototypeValue(value);
  return nativeReflectApply(nativeWeakMapSet, this, [key, value]);
} as typeof WeakMap.prototype.set;
WeakMap.prototype.delete = function (key: object) {
  observePrototypeValue(key);
  const value = nativeReflectApply(nativeWeakMapGet, this, [key]);
  observePrototypeValue(value);
  return nativeReflectApply(nativeWeakMapDelete, this, [key]);
};

Array.prototype.push = function (...values: unknown[]) {
  observePrototypeValue(this);
  for (let index = 0; index < values.length; index += 1) observePrototypeValue(values[index]);
  return nativeReflectApply(nativeArrayPush, this, values);
};
Array.prototype[Symbol.iterator] = function () {
  observePrototypeValue(this);
  for (let index = 0; index < this.length; index += 1) observePrototypeValue(this[index]);
  return nativeReflectApply(nativeArrayIterator, this, []);
};

Object.keys = ((value: object) => {
  observePrototypeValue(value);
  return nativeObjectKeys(value);
}) as typeof Object.keys;
Object.entries = ((value: object) => {
  observePrototypeValue(value);
  return nativeObjectEntries(value);
}) as typeof Object.entries;
Object.values = ((value: object) => {
  observePrototypeValue(value);
  return nativeObjectValues(value);
}) as typeof Object.values;

const originalLeaseTokenDescriptor = nativeObjectGetOwnPropertyDescriptor(Object.prototype, "leaseToken");
const originalOperationHandleDescriptor = nativeObjectGetOwnPropertyDescriptor(Object.prototype, "operationHandle");
const originalHolderSessionIdDescriptor = nativeObjectGetOwnPropertyDescriptor(Object.prototype, "holderSessionId");
const originalObjectToJson = Object.prototype.toJSON;
const originalEventEpochDescriptor = nativeObjectGetOwnPropertyDescriptor(Object.prototype, "eventEpoch");
const originalCursorDescriptor = nativeObjectGetOwnPropertyDescriptor(Object.prototype, "cursor");
for (const key of ["leaseToken", "operationHandle", "holderSessionId"] as const) {
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get() {
      return undefined;
    },
    set(value: unknown) {
      observePrototypeValue(value);
    },
  });
}
for (const [key, hostileValue] of [
  ["eventEpoch", "99999999-9999-4999-8999-999999999999"],
  ["cursor", 9_999_999],
] as const) {
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get(this: Record<string, unknown>) {
      if (nativeObjectHasOwn(this, "privateState") && nativeObjectHasOwn(this, "listeners")) {
        eventHubPrototypeGetterFired = true;
      }
      if (nativeObjectHasOwn(this, "deviceSessionId")) {
        eventQueryPrototypeGetterFired = true;
        eventQueryPrototypeGetterStack ??= new Error(`host event query inherited ${key}`).stack;
      }
      return hostileValue;
    },
    set(this: object, value: unknown) {
      nativeObjectDefineProperty(this, key, { configurable: true, enumerable: true, writable: true, value });
    },
  });
}
// RequestInit is a WebIDL dictionary: converting it performs [[Get]] for every
// member the caller did not set. An init object that inherits from
// Object.prototype therefore hands `this` — headers and body included — to any
// accessor a hostile page installed for those member names.
const REQUEST_INIT_FLAGGED_MEMBERS = [
  // WebIDL RequestInit members the host never sets. Ordinary objects are never
  // read for these, so a single [[Get]] proves a host request init reached
  // Object.prototype.
  "referrer",
  "referrerPolicy",
  "mode",
  "integrity",
  "keepalive",
  "window",
  "duplex",
  "priority",
] as const;
// Internal secret-bearing option bags the facade passes between its own
// functions. These names are common enough that firing alone proves nothing —
// what matters is whether the receiver carried authority.
const FACADE_OPTION_OBSERVED_MEMBERS = ["authorityHeaders", "timeoutMs", "url"] as const;
const REQUEST_INIT_ABSENT_MEMBERS = [...REQUEST_INIT_FLAGGED_MEMBERS, ...FACADE_OPTION_OBSERVED_MEMBERS] as const;
const originalRequestInitMemberDescriptors = REQUEST_INIT_ABSENT_MEMBERS.map(
  (key) => [key, nativeObjectGetOwnPropertyDescriptor(Object.prototype, key)] as const,
);
for (const key of REQUEST_INIT_ABSENT_MEMBERS) {
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get(this: unknown) {
      if (!buildingTrustedResponse) {
        // Firing at all means a host request init reached Object.prototype. That
        // is the defect, whether or not this particular init carried authority —
        // so record it separately from the value-based observation.
        if ((REQUEST_INIT_FLAGGED_MEMBERS as readonly string[]).includes(key)) requestInitPrototypeGetterFired = true;
        if ((REQUEST_INIT_FLAGGED_MEMBERS as readonly string[]).includes(key))
          requestInitPrototypeGetterStack ??= new Error(`host request bag member "${key}" reached Object.prototype`)
            .stack;
        observePrototypeValue(this);
      }
      return undefined;
    },
    set(this: object, value: unknown) {
      observePrototypeValue(value);
      // These are ordinary property names elsewhere in the codebase ("mode",
      // "priority", …). Keep assignment behaving like a normal data property so
      // the fixture only observes, never rewrites unrelated objects.
      nativeObjectDefineProperty(this, key, { configurable: true, enumerable: true, writable: true, value });
    },
  });
}

Object.defineProperty(Object.prototype, "toJSON", {
  configurable: true,
  value(this: Record<string, unknown>) {
    if (buildingTrustedResponse) return this;
    observePrototypeValue(this);
    const copy = Object.create(null) as Record<string, unknown>;
    const keys = nativeObjectKeys(this);
    for (let index = 0; index < keys.length; index += 1) copy[keys[index]!] = this[keys[index]!];
    return copy;
  },
});

for (const [key, descriptor] of [
  ["ok", nativeResponseOkDescriptor],
  ["status", nativeResponseStatusDescriptor],
  ["body", nativeResponseBodyDescriptor],
] as const) {
  Object.defineProperty(Response.prototype, key, {
    ...descriptor,
    get(this: Response) {
      if (!buildingTrustedResponse) {
        responsePrototypeGetterObserved = true;
        responsePrototypeGetterStack ??= new Error(`Response.${key} observed`).stack;
      }
      observePrototypeValue(this);
      return nativeReflectApply(descriptor.get!, this, []);
    },
  });
}
Response.prototype.text = function () {
  if (!buildingTrustedResponse) {
    responsePrototypeGetterObserved = true;
    responsePrototypeGetterStack ??= new Error("Response.text observed").stack;
  }
  observePrototypeValue(this);
  return nativeReflectApply(nativeResponseText, this, []);
};

Function.prototype.call = function (thisArg: unknown, ...args: unknown[]) {
  if (
    this === nativeSetAdd ||
    this === nativeSetDelete ||
    this === nativeSetClear ||
    this === nativeSetHas ||
    this === nativeSetForEach ||
    this === nativeResponseText ||
    this === nativeResponseOkDescriptor.get ||
    this === nativeResponseStatusDescriptor.get ||
    this === nativeResponseBodyDescriptor.get
  ) {
    sensitiveFunctionCallObserved = true;
  }
  observePrototypeValue(thisArg);
  for (let index = 0; index < args.length; index += 1) observePrototypeValue(args[index]);
  const forwarded: unknown[] = [];
  forwarded[0] = thisArg;
  for (let index = 0; index < args.length; index += 1) forwarded[index + 1] = args[index];
  return nativeReflectApply(nativeFunctionCall, this, forwarded);
};

// Full-page code runs after the host module has captured its transport. A page
// monkeypatch must never observe guarded URLs, authority bodies, or headers.
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  pageFetchRequests.push({ input, init });
  throw new Error("page fetch must not be used by the host facade");
}) as typeof fetch;
const fakeDocument = { documentElement: { innerHTML: "<main>fixture</main>" }, body: { textContent: "fixture" } };
Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
const capturedLogs: unknown[][] = [];
const originalConsole = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
console.debug = (...args: unknown[]) => {
  capturedLogs.push(args);
};
console.info = (...args: unknown[]) => {
  capturedLogs.push(args);
};
console.warn = (...args: unknown[]) => {
  capturedLogs.push(args);
};
console.error = (...args: unknown[]) => {
  capturedLogs.push(args);
};

const runtimeEpoch = Object.freeze({ id: "runtime-epoch-a" });
const first = issuePersonalExtensionCoordinationFacade({
  runtimeEpoch,
  extensionId: EXTENSION_ID,
  contentHash: CONTENT_HASH,
});
const facade = first.facade;

assert.equal(Object.isFrozen(facade), true);
assert.equal(Object.isFrozen(facade.storage), true);
assert.equal(Object.isFrozen(facade.lorebooks), true);
assert.equal(Object.isFrozen(facade.events), true);
assert.equal(Object.isFrozen(facade.state), true);
assert.match(facade.deviceSessionId, /^[0-9a-f-]{36}$/u);
assert.throws(
  () =>
    issuePersonalExtensionCoordinationFacade({
      runtimeEpoch,
      extensionId: EXTENSION_ID,
      contentHash: CONTENT_HASH,
    }),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "invalid-request",
  "one runtime epoch must never receive a second facade",
);

const initialState = await facade.state();
assert.equal(initialState.role, "follower");
leaseHeldOnce = true;
await assert.rejects(
  facade.acquire(),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "lease-held",
  "a follower must receive the closed lease-held code before requesting handoff",
);
const rejectedAcquireRequest = trustedRequests.findLast((request) =>
  request.url.endsWith("/coordination/lease/acquire"),
);
const handoff = await facade.requestHandoff();
assert.deepEqual(handoff, {
  requestId: HANDOFF_REQUEST_ID,
  status: "draining",
  deadlineAt: "2026-08-16T00:00:30.000Z",
  remainingMs: 30_000,
});
assert.equal(nativeObjectHasOwn(handoff, "holderSessionId"), false);
const writerState = await facade.acquire();
assert.deepEqual(writerState, {
  schemaVersion: 1,
  extensionId: EXTENSION_ID,
  serverBootId: SERVER_BOOT_ID,
  contentHash: CONTENT_HASH,
  fence: 1,
  remainingMs: 60_000,
  mode: "active",
  coordinationActive: true,
  capabilities: [
    "lease-v1",
    "guarded-operation-v1",
    "revisioned-storage-v1",
    "guarded-lorebook-v1",
    "handoff-v1",
    "events-v1",
    "dirty-signal-v1",
  ],
  role: "writer",
});
assert.equal(nativeObjectHasOwn(writerState, "leaseToken"), false);
assert.equal(nativeObjectHasOwn(writerState, "holderSessionId"), false);
const handoffRequest = trustedRequests.find((request) => request.url.endsWith("/coordination/handoff"));
const firstSuccessfulAcquireRequest = trustedRequests.findLast((request) =>
  request.url.endsWith("/coordination/lease/acquire"),
);
assert.equal(
  handoffRequest?.headers["x-marinara-coordination-holder-session-id"],
  rejectedAcquireRequest?.headers["x-marinara-coordination-holder-session-id"],
  "lease-held must retain the private prospective tenure for handoff",
);
assert.equal(
  handoffRequest?.headers["x-marinara-coordination-holder-session-id"],
  firstSuccessfulAcquireRequest?.headers["x-marinara-coordination-holder-session-id"],
  "handoff and the reserved acquire must share one private writer-tenure identifier",
);
assert.deepEqual(await facade.renew(), writerState);

assert.deepEqual(await facade.signalDirty({ chatId: "chat-dirty-fixture" }), {
  accepted: true,
  coalesced: false,
  eventEpoch: EVENT_EPOCH_A,
  cursor: 1,
});
const dirtyRequest = trustedRequests.findLast((request) => request.url.endsWith("/coordination/dirty"));
assert.deepEqual(dirtyRequest?.body, {
  deviceSessionId: facade.deviceSessionId,
  chatId: "chat-dirty-fixture",
});
assert.equal("x-marinara-coordination-holder-session-id" in (dirtyRequest?.headers ?? {}), false);
assert.equal("x-marinara-coordination-lease-token" in (dirtyRequest?.headers ?? {}), false);
dirtyRateLimited = true;
await assert.rejects(
  facade.signalDirty({ chatId: "chat-rate-limited" }),
  (error) =>
    error instanceof PersonalExtensionCoordinationFacadeError &&
    error.code === "dirty-rate-limited" &&
    error.status === 429,
  "dirty rate limiting must retain its closed 429 fallback code",
);
dirtyRateLimited = false;

eventResponseFixtures.push(
  {
    kind: "events",
    close: true,
    events: [
      { schemaVersion: 1, eventEpoch: EVENT_EPOCH_A, cursor: 0, type: "reset" },
      { schemaVersion: 1, eventEpoch: EVENT_EPOCH_A, cursor: 1, type: "source-dirty", chatId: "chat-a" },
    ],
  },
  {
    kind: "events",
    close: false,
    events: [
      { schemaVersion: 1, eventEpoch: EVENT_EPOCH_B, cursor: 4, type: "reset" },
      { schemaVersion: 1, eventEpoch: EVENT_EPOCH_B, cursor: 5, type: "source-dirty", chatId: "chat-b" },
    ],
  },
);
const firstEventListener: unknown[] = [];
const secondEventListener: unknown[] = [];
const firstEventCallback = (event: unknown) => firstEventListener.push(event);
const firstEventSubscription = facade.events.subscribe(firstEventCallback);
const eventAbort = new AbortController();
const secondEventSubscription = facade.events.subscribe((event) => secondEventListener.push(event), {
  signal: eventAbort.signal,
});
assert.equal(Object.isFrozen(firstEventSubscription), true);
assert.equal(Object.isFrozen(firstEventSubscription.close), true);
await eventually(
  () => firstEventListener.length === 4 && secondEventListener.length === 4,
  "the event facade did not replay and reconnect",
);
assert.equal(
  firstEventListener.every((event) => Object.isFrozen(event)),
  true,
);
assert.deepEqual(
  firstEventListener.map((event) => (event as { type: string }).type),
  ["reset", "source-dirty", "reset", "source-dirty"],
);
const eventRequests = trustedRequests.filter((request) => request.url.includes("/coordination/events?"));
assert.equal(eventRequests.length, 2, "multiple listeners must share one host-owned SSE connection");
const replayUrl = new URL(eventRequests[1]!.url, "http://marinara.invalid");
assert.equal(replayUrl.searchParams.get("deviceSessionId"), facade.deviceSessionId);
assert.equal(replayUrl.searchParams.get("eventEpoch"), EVENT_EPOCH_A);
assert.equal(replayUrl.searchParams.get("cursor"), "1");
firstEventSubscription.close();
eventAbort.abort();
secondEventSubscription.close();
await eventually(() => eventStreamCancellations >= 1, "closing the last listener did not cancel the SSE reader");

eventResponseFixtures.push({ kind: "error", code: "event-subscriber-limit" });
const beforeLimitRequests = trustedRequests.filter((request) => request.url.includes("/coordination/events?")).length;
const limitedSubscription = facade.events.subscribe(() => undefined);
await eventually(
  () =>
    trustedRequests.filter((request) => request.url.includes("/coordination/events?")).length ===
    beforeLimitRequests + 1,
  "the subscriber-limit fixture was not requested",
);
await new Promise<void>((resolve) => nativeSetTimeout(resolve, 25));
assert.equal(
  trustedRequests.filter((request) => request.url.includes("/coordination/events?")).length,
  beforeLimitRequests + 1,
  "event-subscriber-limit must close the hint stream instead of reconnecting in a 429 loop",
);
limitedSubscription.close();

eventResponseFixtures.push({ kind: "error", code: "coordination-unavailable" });
eventResponseFixtures.push({
  kind: "events",
  close: false,
  events: [{ schemaVersion: 1, eventEpoch: EVENT_EPOCH_B, cursor: 1, type: "reset" }],
});
const beforeUnavailableRequests = trustedRequests.filter((request) =>
  request.url.includes("/coordination/events?"),
).length;
const unavailableSubscription = facade.events.subscribe(() => undefined);
await eventually(
  () =>
    trustedRequests.filter((request) => request.url.includes("/coordination/events?")).length ===
    beforeUnavailableRequests + 2,
  "the unavailable event fixture did not reconnect",
);
assert.equal(
  trustedRequests.filter((request) => request.url.includes("/coordination/events?")).length,
  beforeUnavailableRequests + 2,
  "an initial 503 must reconnect exactly once to the succeeding stream",
);
unavailableSubscription.close();

const alreadyAbortedEvents = new AbortController();
alreadyAbortedEvents.abort();
const eventRequestsBeforeCancelledSubscribe = trustedRequests.filter((request) =>
  request.url.includes("/coordination/events?"),
).length;
assert.throws(
  () => facade.events.subscribe(() => undefined, { signal: alreadyAbortedEvents.signal }),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "request-cancelled",
);
assert.equal(
  trustedRequests.filter((request) => request.url.includes("/coordination/events?")).length,
  eventRequestsBeforeCancelledSubscribe,
);

blockNextRequest = true;
const abortController = new AbortController();
const abortedStateRequest = facade.state({ signal: abortController.signal });
abortController.abort();
await assert.rejects(
  abortedStateRequest,
  (error) =>
    error instanceof PersonalExtensionCoordinationFacadeError &&
    error.code === "request-cancelled" &&
    error.status === null &&
    error.message === "request-cancelled",
  "an explicit AbortSignal cancellation must remain distinct from coordination unavailability",
);
assert.deepEqual(
  await facade.renew(),
  writerState,
  "cancelling one request must not discard the still-live private lease authority",
);
assert.deepEqual(await facade.storage.get(), { value: { ensemble: "fixture" }, configRevision: 4 });
assert.deepEqual(await facade.lorebooks.list(), [lorebookFixture()]);
assert.deepEqual(await facade.lorebooks.get({ lorebookId: LOREBOOK_ID }), lorebookFixture());
assert.deepEqual(await facade.lorebooks.listEntries({ lorebookId: LOREBOOK_ID }), [entryFixture()]);
assert.deepEqual(await facade.lorebooks.getEntry({ lorebookId: LOREBOOK_ID, entryId: ENTRY_ID }), entryFixture());
blockNextRequest = true;
accelerateNextDeadline = true;
await assert.rejects(
  facade.lorebooks.get({ lorebookId: LOREBOOK_ID }),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "coordination-unavailable",
  "the 60 second host read deadline must fail closed without caller cancellation",
);

const operation = await facade.beginOperation({ kind: "mutation", targetEnsembleId: "ensemble-facade" });
assert.equal(
  trustedRequests.findLast((request) => request.url.endsWith("/coordination/operations/begin"))?.body?.targetEnsembleId,
  "ensemble-facade",
);
assert.equal(Object.isFrozen(operation), true);
assert.equal(Object.isFrozen(operation.storage), true);
assert.equal(Object.isFrozen(operation.lorebooks), true);
assert.equal(Object.isFrozen(operation.storage.patch), true);
assert.equal(Object.isFrozen(operation.transitionToVectorize), true);
assert.equal(nativeObjectHasOwn(operation, "operationHandle"), false);
const beforePrematureVectorize = trustedRequests.length;
await assert.rejects(
  operation.lorebooks.vectorizeMissing({ lorebookId: LOREBOOK_ID, connectionId: "embedding-fixture" }),
  (error) =>
    error instanceof PersonalExtensionCoordinationFacadeError
    && error.code === "operation-kind-unsupported",
  "a mutation capability must reject vector dispatch before the explicit transition",
);
assert.equal(trustedRequests.length, beforePrematureVectorize);
assert.deepEqual(await operation.storage.patch({ expectedConfigRevision: 4, patch: { coordinated: true } }), {
  value: { coordinated: true },
  configRevision: 5,
});
assert.deepEqual(await operation.storage.delete({ expectedConfigRevision: 5 }), {
  value: {},
  configRevision: 6,
});
const createdBook = await operation.lorebooks.create({ book: { name: "Created book" } });
assert.equal(createdBook.id, CREATED_LOREBOOK_ID);
assert.equal("resourceRevision" in createdBook, false);
const updatedCreatedBook = await operation.lorebooks.update({
  lorebookId: CREATED_LOREBOOK_ID,
  changes: { name: "Created book updated" },
});
assert.equal(updatedCreatedBook.name, "Created book updated");
blockNextRequest = true;
accelerateNextDeadline = true;
await assert.rejects(
  operation.lorebooks.update({ lorebookId: LOREBOOK_ID, changes: { name: "timeout" } }),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "coordination-unavailable",
  "the 180 second mutation deadline must abort a stalled guarded request",
);
assert.equal(
  (await operation.lorebooks.update({ lorebookId: LOREBOOK_ID, changes: { name: "Updated protected book" } })).name,
  "Updated protected book",
);
assert.equal(
  (await operation.lorebooks.createEntry({ lorebookId: LOREBOOK_ID, entry: { name: "Created entry" } })).name,
  "Created entry",
);
assert.equal(
  (
    await operation.lorebooks.updateEntry({
      lorebookId: LOREBOOK_ID,
      entryId: ENTRY_ID,
      changes: { name: "Updated entry" },
    })
  ).name,
  "Updated entry",
);
assert.equal(await operation.lorebooks.deleteEntry({ lorebookId: LOREBOOK_ID, entryId: ENTRY_ID }), undefined);

const initialOperationDeadlineAt = operation.deadlineAt;
const initialOperationRemainingMs = operation.remainingMs;
blockNextRequest = true;
const transitionAbort = new AbortController();
const cancelledTransition = operation.transitionToVectorize({ signal: transitionAbort.signal });
transitionAbort.abort();
await assert.rejects(
  cancelledTransition,
  (error) =>
    error instanceof PersonalExtensionCoordinationFacadeError
    && error.code === "request-cancelled",
  "an interrupted transition must remain retryable without exposing or replacing its handle",
);
assert.equal(operation.kind, "mutation");
assert.equal(operation.deadlineAt, initialOperationDeadlineAt);
assert.equal(operation.remainingMs, initialOperationRemainingMs);

const transitionRequestCount = trustedRequests.filter((request) =>
  request.url.endsWith("/coordination/operations/transition-to-vectorize"),
).length;
assert.equal(await operation.transitionToVectorize(), undefined);
assert.equal(operation.kind, "vectorize");
assert.equal(operation.deadlineAt, "2026-08-16T00:10:00.000Z");
assert.equal(operation.remainingMs, 600_000);
assert.equal(
  trustedRequests.findLast((request) =>
    request.url.endsWith("/coordination/operations/transition-to-vectorize"),
  )?.body?.targetEnsembleId,
  "ensemble-facade",
);
assert.equal(await operation.transitionToVectorize(), undefined);
assert.equal(
  trustedRequests.filter((request) =>
    request.url.endsWith("/coordination/operations/transition-to-vectorize"),
  ).length,
  transitionRequestCount + 1,
  "a completed local transition must be an idempotent no-op",
);

const beforePostTransitionMutation = trustedRequests.length;
await assert.rejects(
  operation.lorebooks.createEntry({ lorebookId: LOREBOOK_ID, entry: { name: "too late" } }),
  (error) =>
    error instanceof PersonalExtensionCoordinationFacadeError
    && error.code === "operation-kind-unsupported",
  "the same capability must reject CRUD after it narrows to vectorize",
);
assert.equal(trustedRequests.length, beforePostTransitionMutation);
assert.deepEqual(
  await operation.lorebooks.vectorizeMissing({
    lorebookId: LOREBOOK_ID,
    connectionId: "embedding-fixture",
  }),
  { vectorized: 1, total: 1, skipped: 0 },
);
await operation.end({ disposition: "conclusive" });
assert.equal(
  trustedRequests.findLast((request) => request.url.endsWith("/coordination/operations/end"))?.body?.disposition,
  "conclusive",
);

const vectorOperation = await facade.beginOperation({ kind: "vectorize", targetEnsembleId: "ensemble-facade" });
const beforeDirectVectorNoOp = trustedRequests.length;
assert.equal(await vectorOperation.transitionToVectorize(), undefined);
assert.equal(trustedRequests.length, beforeDirectVectorNoOp);
await assert.rejects(
  vectorOperation.lorebooks.deleteEntry({ lorebookId: LOREBOOK_ID, entryId: ENTRY_ID }),
  (error) =>
    error instanceof PersonalExtensionCoordinationFacadeError
    && error.code === "operation-kind-unsupported",
);
assert.equal(trustedRequests.length, beforeDirectVectorNoOp);
blockNextRequest = true;
accelerateNextDeadline = true;
await assert.rejects(
  vectorOperation.lorebooks.vectorizeMissing({ lorebookId: LOREBOOK_ID, connectionId: "embedding-fixture" }),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "coordination-unavailable",
  "the 600 second vector deadline must abort stalled provider work",
);
assert.deepEqual(
  await vectorOperation.lorebooks.vectorizeMissing({
    lorebookId: LOREBOOK_ID,
    connectionId: "embedding-fixture",
  }),
  { vectorized: 1, total: 1, skipped: 0 },
);
assert.deepEqual(await vectorOperation.lorebooks.clearVectors({ lorebookId: LOREBOOK_ID }), {
  cleared: 1,
  total: 1,
});
await vectorOperation.end({ disposition: "conclusive" });
assert.equal(observedTimeouts.includes(60_000), true);
assert.equal(observedTimeouts.includes(180_000), true);
assert.equal(observedTimeouts.includes(600_000), true);

Function.prototype.call = nativeFunctionCall;
globalThis.Set = NativeSet;
Set.prototype.add = nativeSetAdd;
Set.prototype.delete = nativeSetDelete;
Set.prototype.clear = nativeSetClear;
Set.prototype.has = nativeSetHas;
Set.prototype.forEach = nativeSetForEach;
Set.prototype[Symbol.iterator] = nativeSetIterator;
Object.defineProperty(Set.prototype, "size", nativeSetSizeDescriptor);
Map.prototype.get = nativeMapGet;
Map.prototype.set = nativeMapSet;
Map.prototype.delete = nativeMapDelete;
Map.prototype.clear = nativeMapClear;
Map.prototype.has = nativeMapHas;
Map.prototype.forEach = nativeMapForEach;
Map.prototype[Symbol.iterator] = nativeMapIterator;
Object.defineProperty(Map.prototype, "size", nativeMapSizeDescriptor);
WeakMap.prototype.get = nativeWeakMapGet;
WeakMap.prototype.set = nativeWeakMapSet;
WeakMap.prototype.delete = nativeWeakMapDelete;
Array.prototype.push = nativeArrayPush;
Array.prototype[Symbol.iterator] = nativeArrayIterator;
Object.keys = nativeObjectKeys;
Object.entries = nativeObjectEntries;
Object.values = nativeObjectValues;
for (const [key, descriptor] of [
  ["leaseToken", originalLeaseTokenDescriptor],
  ["operationHandle", originalOperationHandleDescriptor],
  ["holderSessionId", originalHolderSessionIdDescriptor],
  ["eventEpoch", originalEventEpochDescriptor],
  ["cursor", originalCursorDescriptor],
] as const) {
  if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
  else delete (Object.prototype as Record<string, unknown>)[key];
}
for (const [key, descriptor] of originalRequestInitMemberDescriptors) {
  if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
  else delete (Object.prototype as Record<string, unknown>)[key];
}
if (originalObjectToJson === undefined) delete Object.prototype.toJSON;
else Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: originalObjectToJson });
Object.defineProperty(Response.prototype, "ok", nativeResponseOkDescriptor);
Object.defineProperty(Response.prototype, "status", nativeResponseStatusDescriptor);
Object.defineProperty(Response.prototype, "body", nativeResponseBodyDescriptor);
Response.prototype.text = nativeResponseText;
nativeObjectDefineProperty(NativePromise.prototype, "then", nativePromiseThenDescriptor);
if (promiseConstructorHookInstalled) {
  nativeObjectDefineProperty(NativePromise.prototype, "constructor", nativePromiseConstructorDescriptor);
}

function prototypeObservedIdentity(value: unknown): boolean {
  for (let index = 0; index < prototypeObservedValues.length; index += 1) {
    if (prototypeObservedValues[index] === value) return true;
  }
  return false;
}

const privateHolderSessionId = trustedRequests.findLast((request) =>
  request.url.endsWith("/coordination/lease/acquire"),
)?.headers["x-marinara-coordination-holder-session-id"];
const holderObservationStack = prototypeObservedUuidStacks.find((item) => item.value === privateHolderSessionId)?.stack;
assert.equal(
  prototypeObservedRawAuthority,
  false,
  `page prototype hooks must not observe raw authority\n${prototypeRawAuthorityStack ?? ""}`,
);
assert.equal(
  promiseObservedRawAuthority,
  false,
  `page Promise hooks must not observe raw authority\n${promiseRawAuthorityStack ?? ""}`,
);
assert.equal(
  promiseConstructorHookInstalled,
  false,
  "the host must pin Promise.prototype.constructor before any full-page extension starts",
);
assert.equal(eventHubPrototypeGetterFired, false, "the host event hub must own its replay slots");
assert.equal(
  eventQueryPrototypeGetterFired,
  false,
  `the host event query must not inherit replay slots\n${eventQueryPrototypeGetterStack ?? ""}`,
);

assert.equal(
  requestInitPrototypeGetterFired,
  false,
  `host request bags must never reach Object.prototype (${requestInitPrototypeGetterStack ?? "no stack"})`,
);

assert.equal(
  prototypeObservedIdentity(privateHolderSessionId),
  false,
  `page hooks must not observe the holder ID\n${holderObservationStack ?? ""}`,
);
assert.equal(prototypeObservedIdentity(facade), false, "page hooks must not observe the facade capability");
assert.equal(prototypeObservedIdentity(operation), false, "page hooks must not observe an operation capability");
assert.equal(prototypeObservedIdentity(vectorOperation), false, "page hooks must not observe a vector capability");
assert.equal(prototypeObservedIdentity(firstEventCallback), false, "page hooks must not observe listener callbacks");
assert.equal(
  responsePrototypeGetterObserved,
  false,
  `page Response getters must not observe authority responses\n${responsePrototypeGetterStack ?? ""}`,
);
assert.equal(sensitiveFunctionCallObserved, false, "page Function.call must not receive captured host primitives");

const serializedPublicObjects = JSON.stringify({
  facade,
  writerState,
  operation,
  initialState,
  handoff,
  firstEventSubscription,
});
assert.doesNotMatch(serializedPublicObjects, /raw-lease-token|raw-operation-handle/u);
assert.doesNotMatch(serializedPublicObjects, /resourceRevision/u);
assert.doesNotMatch(JSON.stringify(fakeDocument), /raw-lease-token|raw-operation-handle/u);

const beforeRejectedCalls = trustedRequests.length;
await assert.rejects(
  facade.state({ signal: undefined, url: "/api/arbitrary" } as never),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "invalid-request",
);
await assert.rejects(
  facade.beginOperation({ kind: "arbitrary" } as never),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "invalid-request",
);
assert.equal(trustedRequests.length, beforeRejectedCalls, "rejected arguments must dispatch no request");

malformedState = true;
await assert.rejects(
  facade.state(),
  (error) =>
    error instanceof PersonalExtensionCoordinationFacadeError &&
    error.code === "coordination-unavailable" &&
    !error.message.includes(RAW_LEASE_TOKEN),
  "unknown success bodies must fail closed without echoing raw data",
);

// Leave one operation live: host cleanup must invalidate it synchronously,
// best-effort end it, and only then release the lease.
const cleanupOperation = await facade.beginOperation({
  kind: "mutation",
  targetEnsembleId: "ensemble-facade-cleanup",
});
eventResponseFixtures.push({
  kind: "events",
  close: false,
  events: [{ schemaVersion: 1, eventEpoch: EVENT_EPOCH_B, cursor: 6, type: "reset" }],
});
const cleanupEvents: unknown[] = [];
facade.events.subscribe((event) => cleanupEvents.push(event));
await eventually(() => cleanupEvents.length === 1, "cleanup event stream did not become active");
const cleanupCancellationCount = eventStreamCancellations;
const cleanupTimelineStart = transportTimeline.length;
first.beginCleanup();
await eventually(
  () => eventStreamCancellations === cleanupCancellationCount + 1,
  "beginCleanup did not stop stale event delivery before extension cleanup",
);
assert.throws(
  () => facade.events.subscribe(() => undefined),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "coordination-unavailable",
);
const cleanupPromise = first.cleanup();
await assert.rejects(
  cleanupOperation.storage.patch({ expectedConfigRevision: 6, patch: { stale: true } }),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "operation-lost",
);
await cleanupPromise;
assert.equal(
  eventStreamCancellations,
  cleanupCancellationCount + 1,
  "host cleanup must synchronously cancel the stale runtime's event stream",
);
await assert.rejects(
  facade.acquire(),
  (error) => error instanceof PersonalExtensionCoordinationFacadeError && error.code === "coordination-unavailable",
);

const cleanupTail = trustedRequests.slice(-2).map(({ url, method }) => `${method} ${url}`);
assert.deepEqual(cleanupTail, [
  `POST /api/personal-extensions/${EXTENSION_ID}/coordination/operations/end`,
  `POST /api/personal-extensions/${EXTENSION_ID}/coordination/lease/release`,
]);
const cleanupTimeline = transportTimeline.slice(cleanupTimelineStart);
assert.ok(
  cleanupTimeline.indexOf("event-stream-cancelled") <
    cleanupTimeline.indexOf(`POST /api/personal-extensions/${EXTENSION_ID}/coordination/operations/end`),
  "event delivery must stop before cleanup drains operation authority",
);
assert.equal(
  trustedRequests.findLast((request) => request.url.endsWith("/coordination/operations/end"))?.body?.disposition,
  "aborted",
  "cleanup must never request a conclusive journal disposition",
);

const second = issuePersonalExtensionCoordinationFacade({
  runtimeEpoch: Object.freeze({ id: "runtime-epoch-b" }),
  extensionId: EXTENSION_ID,
  contentHash: CONTENT_HASH,
});
assert.equal(
  second.facade.deviceSessionId,
  facade.deviceSessionId,
  "device ID must be stable in one storage partition",
);
await second.facade.acquire();
const acquireRequests = trustedRequests.filter(({ url }) => url.endsWith("/coordination/lease/acquire"));
assert.equal(acquireRequests.length, 3);
assert.equal(
  acquireRequests[0]?.headers["x-marinara-coordination-holder-session-id"],
  acquireRequests[1]?.headers["x-marinara-coordination-holder-session-id"],
);
assert.notEqual(
  acquireRequests[1]?.headers["x-marinara-coordination-holder-session-id"],
  acquireRequests[2]?.headers["x-marinara-coordination-holder-session-id"],
  "each writer tenure must mint a new holder ID",
);
await second.facade.release({ handoffRequestId: HANDOFF_REQUEST_ID });
assert.equal(
  trustedRequests.findLast((request) => request.url.endsWith("/coordination/lease/release"))?.body?.handoffRequestId,
  HANDOFF_REQUEST_ID,
  "release must carry only the public handoff correlation ID when the writer drains",
);
await second.cleanup();

assert.equal(pageFetchRequests.length, 0, "page-monkeypatched fetch must observe no host facade request");
const dispatchedEventUrls = trustedRequests
  .filter(({ url }) => url.includes("/coordination/events?"))
  .map(({ url }) => new URL(url, "http://marinara.invalid"));
assert.ok(dispatchedEventUrls.length >= 4);
for (const url of dispatchedEventUrls) {
  assert.equal(url.pathname, `/api/personal-extensions/${EXTENSION_ID}/coordination/events`);
  assert.equal(url.searchParams.get("deviceSessionId"), facade.deviceSessionId);
  assert.equal(
    [...url.searchParams.keys()].every((key) => ["deviceSessionId", "eventEpoch", "cursor"].includes(key)),
    true,
    "SSE reconnects must keep a closed query allowlist",
  );
  assert.equal(url.searchParams.has("eventEpoch"), url.searchParams.has("cursor"));
}
assert.deepEqual(
  [
    ...new Set(trustedRequests.filter(({ url }) => !url.includes("/coordination/events?")).map(({ url }) => url)),
  ].sort(),
  [
    `/api/personal-extensions/${EXTENSION_ID}/coordination`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/dirty`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/handoff`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/lease/acquire`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/lease/release`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/lease/renew`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/operations/begin`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/operations/end`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/operations/transition-to-vectorize`,
    `/api/personal-extensions/${EXTENSION_ID}/coordination/storage`,
    "/api/lorebooks/coordination",
    `/api/lorebooks/${LOREBOOK_ID}/coordination`,
    `/api/lorebooks/${LOREBOOK_ID}/coordination/entries`,
    `/api/lorebooks/${LOREBOOK_ID}/coordination/entries/${ENTRY_ID}`,
    `/api/lorebooks/${LOREBOOK_ID}/coordination/vectorize`,
    `/api/lorebooks/${LOREBOOK_ID}/coordination/vectors`,
    `/api/lorebooks/${CREATED_LOREBOOK_ID}/coordination`,
  ].sort(),
  "the facade must dispatch only its closed route allowlist",
);
assert.equal(
  trustedRequests.every(({ headers }) => !Object.keys(headers).some((name) => name.includes("admin"))),
  true,
  "the facade must never attach unrelated privileged headers",
);
assert.equal(
  trustedRequests.filter(({ method }) => method !== "GET").every(({ headers }) => headers["x-marinara-csrf"] === "1"),
  true,
  "mutating requests must inherit Marinara's CSRF contract",
);

const injectorSource = readFileSync(
  new URL("../../packages/client/src/components/layout/PersonalExtensionInjector.tsx", import.meta.url),
  "utf8",
);
assert.match(
  injectorSource,
  /if \(active\.started\)[\s\S]*active\.started = true;[\s\S]*loadApprovedFullPageExtensionModule\(\{[\s\S]*createApi: \(\) => createFullPageExtensionApi\(active\)/u,
  "the full-page host entrypoint must claim each runtime exactly once before invoking extension code",
);
assert.match(
  injectorSource,
  /if \(!options\.isCurrent\(\)\) return false;[\s\S]*\(main as \(api: Api\) => unknown\)\(options\.createApi\(\)\)/u,
  "a runtime removed before its startup microtask must not receive a live facade",
);
assert.match(
  injectorSource,
  /function createFullPageExtensionApi\(active:[\s\S]*issuePersonalExtensionCoordinationFacade\(\{[\s\S]*runtimeEpoch: pristineObjectFreeze\(\{\}\)[\s\S]*hostWeakMapSet\(fullPageCoordination, active, coordination\)[\s\S]*coordination: coordination\.facade/u,
  "the one-shot full-page API must inject the host-owned facade",
);
assert.match(
  injectorSource,
  /const coordination = hostWeakMapGet\(fullPageCoordination, fullPage\)[\s\S]*coordination\.beginCleanup\(\)[\s\S]*while \(cleanupNode\)[\s\S]*await coordination\.cleanup\(\)/u,
  "cleanup must close new admission before extension callbacks and release host authority afterward",
);

console.debug = originalConsole.debug;
console.info = originalConsole.info;
console.warn = originalConsole.warn;
console.error = originalConsole.error;
delete (globalThis as { document?: unknown }).document;
assert.doesNotMatch(JSON.stringify(capturedLogs), /raw-lease-token|raw-operation-handle/u);

console.info("Personal Extension coordination facade regression passed.");
