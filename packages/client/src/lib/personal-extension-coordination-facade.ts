import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  PERSONAL_EXTENSION_COORDINATION_CAPABILITIES,
  PERSONAL_EXTENSION_COORDINATION_BOOT_HEADER,
  PERSONAL_EXTENSION_COORDINATION_CONTENT_HASH_HEADER,
  PERSONAL_EXTENSION_COORDINATION_EXTENSION_HEADER,
  PERSONAL_EXTENSION_COORDINATION_FENCE_HEADER,
  PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER,
  PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS,
  PERSONAL_EXTENSION_COORDINATION_LEASE_TOKEN_HEADER,
  PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
  createLorebookEntrySchema,
  createLorebookSchema,
  personalExtensionCoordinationContentHashSchema,
  personalExtensionCoordinationDirtyRequestSchema,
  personalExtensionCoordinationDirtyResponseSchema,
  personalExtensionCoordinationErrorResponseSchema,
  personalExtensionCoordinationEventQuerySchema,
  personalExtensionCoordinationEventSchema,
  personalExtensionCoordinationExtensionIdSchema,
  personalExtensionCoordinationHandoffResponseSchema,
  personalExtensionCoordinationLeaseGrantSchema,
  personalExtensionCoordinationLorebookClearVectorsResponseSchema,
  personalExtensionCoordinationLorebookEntryDeleteResponseSchema,
  personalExtensionCoordinationLorebookVectorizeResponseSchema,
  personalExtensionCoordinationOperationEndResponseSchema,
  personalExtensionCoordinationOperationGrantSchema,
  personalExtensionCoordinationReleaseResponseSchema,
  personalExtensionCoordinationRevisionedStorageResponseSchema,
  personalExtensionCoordinationRevisionedLorebookEntryListResponseSchema,
  personalExtensionCoordinationRevisionedLorebookEntryResponseSchema,
  personalExtensionCoordinationRevisionedLorebookListResponseSchema,
  personalExtensionCoordinationRevisionedLorebookResponseSchema,
  personalExtensionCoordinationStateSchema,
  personalExtensionStoragePatchSchema,
  updateLorebookEntrySchema,
  updateLorebookSchema,
  type PersonalExtensionCoordinationErrorCode,
  type PersonalExtensionCoordinationEvent,
  type PersonalExtensionCoordinationHandoffResponse,
  type CreateLorebookEntryInput,
  type CreateLorebookInput,
  type PersonalExtensionCoordinationLeaseGrant,
  type PersonalExtensionCoordinationLeaseState,
  type PersonalExtensionCoordinationLorebook,
  type PersonalExtensionCoordinationLorebookClearVectorsResponse,
  type PersonalExtensionCoordinationLorebookEntry,
  type PersonalExtensionCoordinationLorebookVectorizeRequest,
  type PersonalExtensionCoordinationLorebookVectorizeResponse,
  type PersonalExtensionCoordinationDirtyResponse,
  type PersonalExtensionCoordinationOperationGrant,
  type PersonalExtensionCoordinationReleaseResponse,
  type PersonalExtensionCoordinationRevisionedStorageResponse,
  type PersonalExtensionCoordinationState,
  type UpdateLorebookEntryInput,
  type UpdateLorebookInput,
} from "@marinara-engine/shared";

const DEVICE_SESSION_STORAGE_KEY = "marinara.personal-extension-coordination.device-session-id.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TARGET_ENSEMBLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HANDOFF_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const PRIVATE_VALIDATION_LEASE_TOKEN = "private-validation-lease-token";
const PRIVATE_VALIDATION_HOLDER_ID = "private-validation-holder-id";
const PRIVATE_VALIDATION_OPERATION_HANDLE = "private-validation-operation-handle";
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 180_000;
const DEFAULT_VECTOR_TIMEOUT_MS = 600_000;
const EVENT_RECONNECT_DELAY_MS = 1_000;
const EVENT_STREAM_BUFFER_LIMIT = 16 * 1024;

// This module is imported by the host bundle before any full-page Personal
// Extension script is appended. Keep every primitive which can carry raw
// authority as a module-level capture so later page monkeypatches cannot see it.
// Await's PromiseResolve fast path depends on Promise.prototype.constructor
// still identifying the realm intrinsic. If a later same-realm extension can
// replace it, Await falls back through a page-replaceable `.then` and exposes
// fulfilled internal values (including raw authority). Pin the identity before
// any extension runs; configurable must also be false or defineProperty would
// bypass a merely non-writable slot.
const CapturedPromise = globalThis.Promise;
const pristineObjectDefineProperty = Object.defineProperty.bind(Object);
pristineObjectDefineProperty(CapturedPromise.prototype, "constructor", {
  value: CapturedPromise,
  writable: false,
  enumerable: false,
  configurable: false,
});
const capturedFetch = globalThis.fetch;
const pristineFetch = typeof capturedFetch === "function" ? capturedFetch.bind(globalThis) : null;
const pristineResponseText = globalThis.Response?.prototype.text;
const pristineResponseBody = Object.getOwnPropertyDescriptor(globalThis.Response?.prototype ?? {}, "body")?.get;
const pristineResponseOk = Object.getOwnPropertyDescriptor(globalThis.Response?.prototype ?? {}, "ok")?.get;
const pristineResponseStatus = Object.getOwnPropertyDescriptor(globalThis.Response?.prototype ?? {}, "status")?.get;
const pristineJsonParse = JSON.parse.bind(JSON);
const pristineJsonStringify = JSON.stringify.bind(JSON);
const pristineRandomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
const pristineGetRandomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
const CapturedUint8Array = globalThis.Uint8Array;
const capturedAbortSignal = globalThis.AbortSignal;
const CapturedAbortController = globalThis.AbortController;
const pristineAbort = globalThis.AbortController?.prototype.abort;
const pristineAddAbortListener = globalThis.AbortSignal?.prototype.addEventListener;
const pristineRemoveAbortListener = globalThis.AbortSignal?.prototype.removeEventListener;
const capturedSetTimeout = globalThis.setTimeout.bind(globalThis);
const capturedClearTimeout = globalThis.clearTimeout.bind(globalThis);
const pristineEncodeURIComponent = globalThis.encodeURIComponent;
const CapturedTextDecoder = globalThis.TextDecoder;
const pristineTextDecode = globalThis.TextDecoder?.prototype.decode;
const pristineGetReader = globalThis.ReadableStream?.prototype.getReader;
const pristineReaderRead = globalThis.ReadableStreamDefaultReader?.prototype.read;
const pristineReaderCancel = globalThis.ReadableStreamDefaultReader?.prototype.cancel;
const pristineReaderReleaseLock = globalThis.ReadableStreamDefaultReader?.prototype.releaseLock;
const objectCreate = Object.create.bind(Object);
const objectFreeze = Object.freeze.bind(Object);
const objectKeys = Object.keys.bind(Object);
const objectValues = Object.values.bind(Object);
const pristineReflectApply = globalThis.Reflect.apply;
const pristineArrayIsArray = globalThis.Array.isArray.bind(globalThis.Array);
const pristineRegExpTest = globalThis.RegExp.prototype.test;
const CapturedSet = globalThis.Set;
const pristineSetAdd = globalThis.Set.prototype.add;
const pristineSetDelete = globalThis.Set.prototype.delete;
const pristineSetClear = globalThis.Set.prototype.clear;
const pristineSetHas = globalThis.Set.prototype.has;
const pristineSetForEach = globalThis.Set.prototype.forEach;
const pristineSetSize = Object.getOwnPropertyDescriptor(globalThis.Set.prototype, "size")?.get;
const MUTATING_METHODS = new CapturedSet(["POST", "PATCH", "DELETE"]);
const createLorebookEntryInputSchema = createLorebookEntrySchema.omit({ lorebookId: true });

function setAdd<T>(target: Set<T>, value: T): void {
  pristineReflectApply(pristineSetAdd, target, [value]);
}

function setDelete<T>(target: Set<T>, value: T): void {
  pristineReflectApply(pristineSetDelete, target, [value]);
}

function setClear(target: Set<unknown>): void {
  pristineReflectApply(pristineSetClear, target, []);
}

function setHas<T>(target: Set<T>, value: T): boolean {
  return pristineReflectApply(pristineSetHas, target, [value]);
}

function setSize(target: Set<unknown>): number {
  if (typeof pristineSetSize !== "function") throw new Error("Set size getter unavailable");
  return pristineReflectApply(pristineSetSize, target, []) as number;
}

function setForEach<T>(target: Set<T>, visitor: (value: T) => void): void {
  pristineReflectApply(pristineSetForEach, target, [visitor]);
}

function regexTest(pattern: RegExp, value: string): boolean {
  return pristineReflectApply(pristineRegExpTest, pattern, [value]);
}

function stringArrayContains(values: readonly string[], expected: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

let storedDeviceSessionRead: (() => string | null) | null = null;
let storedDeviceSessionWrite: ((value: string) => void) | null = null;
try {
  const storage = globalThis.localStorage;
  storedDeviceSessionRead = storage.getItem.bind(storage, DEVICE_SESSION_STORAGE_KEY);
  storedDeviceSessionWrite = storage.setItem.bind(storage, DEVICE_SESSION_STORAGE_KEY);
} catch {
  // Some embedded/private browsing contexts deny localStorage. The volatile ID
  // remains an identifier only and never grants authority.
}

let volatileDeviceSessionId: string | null = null;

type WireSchema<T> = {
  parse(value: unknown): T;
};

export type PersonalExtensionCoordinationSignalOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationReleaseOptions = Readonly<{
  handoffRequestId?: string;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationDirtyInput = Readonly<{
  chatId: string;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationEventListener = (event: PersonalExtensionCoordinationEvent) => void;

export interface PersonalExtensionCoordinationEventSubscription {
  close(): void;
}

export type PersonalExtensionCoordinationOperationEndOptions = Readonly<{
  disposition?: "aborted" | "conclusive";
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationOperationInput = Readonly<{
  kind: PersonalExtensionCoordinationOperationGrant["kind"];
  targetEnsembleId: string;
  requestedDeadlineMs?: number;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationStoragePatchInput = Readonly<{
  expectedConfigRevision: number;
  patch: Record<string, unknown>;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationStorageDeleteInput = Readonly<{
  expectedConfigRevision: number;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationLorebookIdInput = Readonly<{
  lorebookId: string;
  signal?: AbortSignal;
}>;
export type PersonalExtensionCoordinationLorebookEntryIdInput = Readonly<{
  lorebookId: string;
  entryId: string;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationLorebookCreateInput = Readonly<{
  book: CreateLorebookInput;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationLorebookUpdateInput = Readonly<{
  lorebookId: string;
  changes: UpdateLorebookInput;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationLorebookEntryCreateInput = Readonly<{
  lorebookId: string;
  entry: Omit<CreateLorebookEntryInput, "lorebookId">;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationLorebookEntryUpdateInput = Readonly<{
  lorebookId: string;
  entryId: string;
  changes: UpdateLorebookEntryInput;
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationLorebookEntryDeleteInput = PersonalExtensionCoordinationLorebookEntryIdInput;

export type PersonalExtensionCoordinationLorebookVectorizeInput = Readonly<{
  lorebookId: string;
  connectionId: PersonalExtensionCoordinationLorebookVectorizeRequest["connectionId"];
  model?: PersonalExtensionCoordinationLorebookVectorizeRequest["model"];
  signal?: AbortSignal;
}>;

export type PersonalExtensionCoordinationLorebookClearVectorsInput = PersonalExtensionCoordinationLorebookIdInput;

export interface PersonalExtensionCoordinationOperationCapability {
  readonly kind: PersonalExtensionCoordinationOperationGrant["kind"];
  readonly deadlineAt: string;
  readonly remainingMs: number;
  readonly storage: Readonly<{
    patch(
      input: PersonalExtensionCoordinationStoragePatchInput,
    ): Promise<PersonalExtensionCoordinationRevisionedStorageResponse>;
    delete(
      input: PersonalExtensionCoordinationStorageDeleteInput,
    ): Promise<PersonalExtensionCoordinationRevisionedStorageResponse>;
  }>;
  readonly lorebooks: Readonly<{
    create(input: PersonalExtensionCoordinationLorebookCreateInput): Promise<PersonalExtensionCoordinationLorebook>;
    update(input: PersonalExtensionCoordinationLorebookUpdateInput): Promise<PersonalExtensionCoordinationLorebook>;
    createEntry(
      input: PersonalExtensionCoordinationLorebookEntryCreateInput,
    ): Promise<PersonalExtensionCoordinationLorebookEntry>;
    updateEntry(
      input: PersonalExtensionCoordinationLorebookEntryUpdateInput,
    ): Promise<PersonalExtensionCoordinationLorebookEntry>;
    deleteEntry(input: PersonalExtensionCoordinationLorebookEntryDeleteInput): Promise<void>;
    vectorizeMissing(
      input: PersonalExtensionCoordinationLorebookVectorizeInput,
    ): Promise<Omit<PersonalExtensionCoordinationLorebookVectorizeResponse, "resourceRevision">>;
    clearVectors(
      input: PersonalExtensionCoordinationLorebookClearVectorsInput,
    ): Promise<Omit<PersonalExtensionCoordinationLorebookClearVectorsResponse, "resourceRevision">>;
  }>;
  transitionToVectorize(options?: PersonalExtensionCoordinationSignalOptions): Promise<void>;
  end(options?: PersonalExtensionCoordinationOperationEndOptions): Promise<void>;
}

export interface PersonalExtensionCoordinationFacade {
  readonly version: 1;
  /** Stable per origin storage partition/profile. It is not an authority credential. */
  readonly deviceSessionId: string;
  state(options?: PersonalExtensionCoordinationSignalOptions): Promise<PersonalExtensionCoordinationState>;
  acquire(options?: PersonalExtensionCoordinationSignalOptions): Promise<PersonalExtensionCoordinationState>;
  renew(options?: PersonalExtensionCoordinationSignalOptions): Promise<PersonalExtensionCoordinationState>;
  requestHandoff(
    options?: PersonalExtensionCoordinationSignalOptions,
  ): Promise<PersonalExtensionCoordinationHandoffResponse>;
  release(options?: PersonalExtensionCoordinationReleaseOptions): Promise<PersonalExtensionCoordinationReleaseResponse>;
  readonly events: Readonly<{
    subscribe(
      listener: PersonalExtensionCoordinationEventListener,
      options?: PersonalExtensionCoordinationSignalOptions,
    ): PersonalExtensionCoordinationEventSubscription;
  }>;
  signalDirty(input: PersonalExtensionCoordinationDirtyInput): Promise<PersonalExtensionCoordinationDirtyResponse>;
  readonly storage: Readonly<{
    get(
      options?: PersonalExtensionCoordinationSignalOptions,
    ): Promise<PersonalExtensionCoordinationRevisionedStorageResponse>;
  }>;
  readonly lorebooks: Readonly<{
    list(options?: PersonalExtensionCoordinationSignalOptions): Promise<PersonalExtensionCoordinationLorebook[]>;
    get(input: PersonalExtensionCoordinationLorebookIdInput): Promise<PersonalExtensionCoordinationLorebook>;
    listEntries(
      input: PersonalExtensionCoordinationLorebookIdInput,
    ): Promise<PersonalExtensionCoordinationLorebookEntry[]>;
    getEntry(
      input: PersonalExtensionCoordinationLorebookEntryIdInput,
    ): Promise<PersonalExtensionCoordinationLorebookEntry>;
  }>;
  beginOperation(
    input: PersonalExtensionCoordinationOperationInput,
  ): Promise<PersonalExtensionCoordinationOperationCapability>;
}

export type PersonalExtensionCoordinationFacadeErrorCode = PersonalExtensionCoordinationErrorCode | "request-cancelled";

function facadeErrorStatus(code: PersonalExtensionCoordinationFacadeErrorCode): number | null {
  return code === "request-cancelled" ? null : PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS[code];
}

export class PersonalExtensionCoordinationFacadeError extends Error {
  constructor(
    readonly code: PersonalExtensionCoordinationFacadeErrorCode,
    readonly status: number | null = facadeErrorStatus(code),
  ) {
    super(code === "request-cancelled" ? code : `Personal extension coordination failed (${code})`);
    this.name = "PersonalExtensionCoordinationFacadeError";
  }
}

type LeaseAuthority = {
  leaseToken: string;
  holderSessionId: string;
  serverBootId: string;
  contentHash: string;
  fence: number;
  leaseState: PersonalExtensionCoordinationLeaseState;
};

type FacadePrivateState = {
  extensionId: string;
  contentHash: string;
  deviceSessionId: string;
  holderSessionId: string | null;
  authority: LeaseAuthority | null;
  operations: Set<PersonalExtensionCoordinationOperationCapability>;
  eventHub: CoordinationEventHub | null;
  lorebookRevisions: Record<string, number>;
  accepting: boolean;
  disposed: boolean;
  cleanupPromise: Promise<void> | null;
};

type CoordinationEventListenerNode = {
  listener: PersonalExtensionCoordinationEventListener;
  signal?: AbortSignal;
  abortListener?: () => void;
  closed: boolean;
};

type CoordinationEventListenerSnapshotNode = {
  value: CoordinationEventListenerNode;
  next: CoordinationEventListenerSnapshotNode | null;
};

type CoordinationEventHub = {
  privateState: FacadePrivateState;
  listeners: Set<CoordinationEventListenerNode>;
  requestController: AbortController | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  eventEpoch: string | undefined;
  cursor: number | undefined;
  connecting: boolean;
  stopped: boolean;
};

type OperationPrivateState = {
  facade: PersonalExtensionCoordinationFacade;
  operationHandle: string;
  targetEnsembleId: string;
  kind: PersonalExtensionCoordinationOperationGrant["kind"];
  deadlineAt: string;
  remainingMs: number;
  transitionPromise: Promise<void> | null;
  active: boolean;
};

type CleanupOperationNode = {
  operationHandle: string;
  next: CleanupOperationNode | null;
};

const issuedRuntimeEpochs = new WeakSet<object>();
const facadePrivateStates = new WeakMap<PersonalExtensionCoordinationFacade, FacadePrivateState>();
const operationPrivateStates = new WeakMap<PersonalExtensionCoordinationOperationCapability, OperationPrivateState>();
const issuedRuntimeEpochHas = issuedRuntimeEpochs.has.bind(issuedRuntimeEpochs);
const issuedRuntimeEpochAdd = issuedRuntimeEpochs.add.bind(issuedRuntimeEpochs);
const facadePrivateGet = facadePrivateStates.get.bind(facadePrivateStates);
const facadePrivateSet = facadePrivateStates.set.bind(facadePrivateStates);
const operationPrivateGet = operationPrivateStates.get.bind(operationPrivateStates);
const operationPrivateSet = operationPrivateStates.set.bind(operationPrivateStates);
const operationPrivateDelete = operationPrivateStates.delete.bind(operationPrivateStates);

function fail(code: PersonalExtensionCoordinationErrorCode): never {
  throw new PersonalExtensionCoordinationFacadeError(code);
}

function makeUuid(): string {
  let value = pristineRandomUuid?.().toLowerCase();
  if (!value && pristineGetRandomValues && CapturedUint8Array) {
    const bytes = new CapturedUint8Array(16);
    pristineGetRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = "0123456789abcdef";
    let encoded = "";
    for (let index = 0; index < bytes.length; index += 1) {
      if (index === 4 || index === 6 || index === 8 || index === 10) encoded += "-";
      const byte = bytes[index]!;
      encoded += hex[byte >> 4]! + hex[byte & 0x0f]!;
    }
    value = encoded;
  }
  if (!value || !regexTest(UUID_PATTERN, value)) fail("coordination-unavailable");
  return value;
}

function getDeviceSessionId(): string {
  try {
    const existing = storedDeviceSessionRead?.()?.trim().toLowerCase();
    if (existing && regexTest(UUID_PATTERN, existing)) return existing;
    const generated = makeUuid();
    storedDeviceSessionWrite?.(generated);
    const persisted = storedDeviceSessionRead?.()?.trim().toLowerCase();
    if (persisted && regexTest(UUID_PATTERN, persisted)) return persisted;
    volatileDeviceSessionId ??= generated;
    return volatileDeviceSessionId;
  } catch {
    volatileDeviceSessionId ??= makeUuid();
    return volatileDeviceSessionId;
  }
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  // Object.values returns a dense array. Index it directly so a later
  // Array.prototype iterator monkeypatch cannot observe a raw lease grant or
  // operation handle while the closed response is frozen.
  const children = objectValues(value as Record<string, unknown>);
  for (let index = 0; index < children.length; index += 1) deepFreeze(children[index]);
  return objectFreeze(value);
}

function fixedInput<T extends Record<string, unknown>>(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = [],
): T {
  try {
    const candidate = value === undefined ? {} : value;
    if (!candidate || typeof candidate !== "object" || pristineArrayIsArray(candidate)) fail("invalid-request");
    const keys = objectKeys(candidate);
    for (let index = 0; index < keys.length; index += 1) {
      if (!stringArrayContains(allowedKeys, keys[index]!)) fail("invalid-request");
    }
    for (let index = 0; index < requiredKeys.length; index += 1) {
      if (!stringArrayContains(keys, requiredKeys[index]!)) fail("invalid-request");
    }
    return candidate as T;
  } catch (error) {
    if (error instanceof PersonalExtensionCoordinationFacadeError) throw error;
    fail("invalid-request");
  }
}

function readSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!capturedAbortSignal || !(value instanceof capturedAbortSignal)) fail("invalid-request");
  return value;
}

function signalOptions(value: unknown): { signal?: AbortSignal } {
  const parsed = fixedInput<{ signal?: unknown }>(value, ["signal"]);
  const signal = readSignal(parsed.signal);
  return signal ? { signal } : {};
}

function releaseOptions(value: unknown): { handoffRequestId?: string; signal?: AbortSignal } {
  const parsed = fixedInput<{ handoffRequestId?: unknown; signal?: unknown }>(value, ["handoffRequestId", "signal"]);
  const signal = readSignal(parsed.signal);
  if (
    parsed.handoffRequestId !== undefined &&
    (typeof parsed.handoffRequestId !== "string" || !regexTest(HANDOFF_REQUEST_ID_PATTERN, parsed.handoffRequestId))
  ) {
    fail("invalid-request");
  }
  return {
    ...(parsed.handoffRequestId === undefined ? {} : { handoffRequestId: parsed.handoffRequestId }),
    ...(signal ? { signal } : {}),
  };
}

function genericUnavailable(): PersonalExtensionCoordinationFacadeError {
  return new PersonalExtensionCoordinationFacadeError("coordination-unavailable");
}

function requestCancelled(): PersonalExtensionCoordinationFacadeError {
  return new PersonalExtensionCoordinationFacadeError("request-cancelled");
}

function responseOk(response: Response): boolean {
  if (typeof pristineResponseOk !== "function") throw genericUnavailable();
  return pristineReflectApply(pristineResponseOk, response, []) as boolean;
}

function responseStatus(response: Response): number {
  if (typeof pristineResponseStatus !== "function") throw genericUnavailable();
  return pristineReflectApply(pristineResponseStatus, response, []) as number;
}

async function responsePayload(response: Response): Promise<unknown> {
  if (typeof pristineResponseText !== "function") throw genericUnavailable();
  let text: string;
  try {
    text = await pristineReflectApply(pristineResponseText, response, []);
  } catch {
    throw genericUnavailable();
  }
  try {
    return pristineJsonParse(text);
  } catch {
    throw genericUnavailable();
  }
}

function boundedSignal(callerSignal: AbortSignal | undefined, timeoutMs: number) {
  if (callerSignal?.aborted) throw requestCancelled();
  if (
    !CapturedAbortController ||
    typeof pristineAbort !== "function" ||
    typeof pristineAddAbortListener !== "function" ||
    typeof pristineRemoveAbortListener !== "function"
  ) {
    throw genericUnavailable();
  }
  const controller = new CapturedAbortController();
  const abortFromCaller = () => pristineReflectApply(pristineAbort, controller, []);
  if (callerSignal) {
    pristineReflectApply(pristineAddAbortListener, callerSignal, ["abort", abortFromCaller, { once: true }]);
  }
  const timer = capturedSetTimeout(() => {
    pristineReflectApply(pristineAbort, controller, []);
  }, timeoutMs);
  return {
    signal: controller.signal,
    callerAborted: () => callerSignal?.aborted === true,
    cleanup() {
      capturedClearTimeout(timer);
      if (callerSignal) {
        pristineReflectApply(pristineRemoveAbortListener, callerSignal, ["abort", abortFromCaller]);
      }
    },
  };
}

async function guardedRequest<T>(
  privateState: FacadePrivateState,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  schema: WireSchema<T>,
  options: {
    body?: unknown;
    signal?: AbortSignal;
    holderSessionId?: string;
    url?: string;
    authorityHeaders?: LeaseAuthority;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  if (!pristineFetch) throw genericUnavailable();
  // Callers build this options bag as an object literal, so it inherits from
  // Object.prototype. Every member we do not read as an own property (url,
  // authorityHeaders, timeoutMs, …) would otherwise reach a page-installed
  // accessor with `this` bound to a bag that carries the lease token and the
  // operation handle. Re-key it onto a null prototype using own keys only, then
  // read exclusively from the copy.
  const secureOptions = objectCreate(null) as typeof options;
  {
    const optionKeys = objectKeys(options as Record<string, unknown>);
    for (let index = 0; index < optionKeys.length; index += 1) {
      const key = optionKeys[index]! as keyof typeof options;
      (secureOptions as Record<string, unknown>)[key as string] = (options as Record<string, unknown>)[key as string];
    }
  }
  options = secureOptions;
  const headers = objectCreate(null) as Record<string, string>;
  headers.Accept = "application/json";
  if (options.holderSessionId) {
    headers[PERSONAL_EXTENSION_COORDINATION_HOLDER_HEADER] = options.holderSessionId;
  }
  if (options.authorityHeaders) {
    headers[PERSONAL_EXTENSION_COORDINATION_EXTENSION_HEADER] = privateState.extensionId;
    headers[PERSONAL_EXTENSION_COORDINATION_BOOT_HEADER] = options.authorityHeaders.serverBootId;
    headers[PERSONAL_EXTENSION_COORDINATION_CONTENT_HASH_HEADER] = options.authorityHeaders.contentHash;
    headers[PERSONAL_EXTENSION_COORDINATION_FENCE_HEADER] = String(options.authorityHeaders.fence);
    headers[PERSONAL_EXTENSION_COORDINATION_LEASE_TOKEN_HEADER] = options.authorityHeaders.leaseToken;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    try {
      // A captured JSON.stringify alone is insufficient: hostile full-page
      // code can add Object.prototype.toJSON after module load. A null-prototype
      // root prevents that callback from ever receiving the authority envelope.
      const wireBody = objectCreate(null) as Record<string, unknown>;
      const keys = objectKeys(options.body as Record<string, unknown>);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        wireBody[key] = (options.body as Record<string, unknown>)[key];
      }
      body = pristineJsonStringify(wireBody);
    } catch {
      throw new PersonalExtensionCoordinationFacadeError("invalid-request");
    }
    headers["Content-Type"] = "application/json";
  }
  if (setHas(MUTATING_METHODS, method)) headers[CSRF_HEADER] = CSRF_HEADER_VALUE;

  const deadline = boundedSignal(options.signal, options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS);
  let response: Response;
  try {
    // RequestInit is a WebIDL dictionary: conversion performs [[Get]] for every
    // member, including the ones we never set. An object literal inherits from
    // Object.prototype, so a page-installed accessor on `referrer`, `mode`,
    // `priority`, … would run with `this` bound to this init and could read the
    // authority headers back out. A null-prototype init keeps those lookups
    // from ever reaching the prototype chain.
    const init = objectCreate(null) as RequestInit;
    init.method = method;
    init.headers = objectFreeze(headers);
    init.body = body;
    init.signal = deadline.signal;
    init.cache = "no-store";
    init.credentials = "same-origin";
    init.redirect = "error";
    response = await pristineFetch(
      options.url ?? `/api/personal-extensions/${privateState.extensionId}/coordination${path}`,
      init,
    );
  } catch {
    deadline.cleanup();
    if (deadline.callerAborted()) throw requestCancelled();
    throw genericUnavailable();
  }

  let payload: unknown;
  try {
    payload = await responsePayload(response);
  } catch (error) {
    if (deadline.callerAborted()) throw requestCancelled();
    throw error;
  } finally {
    deadline.cleanup();
  }
  const status = responseStatus(response);
  if (!responseOk(response)) {
    try {
      const parsed = personalExtensionCoordinationErrorResponseSchema.parse(payload);
      if (status !== PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS[parsed.code]) {
        throw genericUnavailable();
      }
      throw new PersonalExtensionCoordinationFacadeError(parsed.code, status);
    } catch (error) {
      if (error instanceof PersonalExtensionCoordinationFacadeError) throw error;
      throw genericUnavailable();
    }
  }
  try {
    return deepFreeze(schema.parse(payload));
  } catch {
    throw genericUnavailable();
  }
}

class CoordinationEventProtocolError extends Error {}

async function coordinationFailureFromResponse(response: Response) {
  try {
    const payload = await responsePayload(response);
    const parsed = personalExtensionCoordinationErrorResponseSchema.parse(payload);
    const status = responseStatus(response);
    if (status !== PERSONAL_EXTENSION_COORDINATION_HTTP_STATUS[parsed.code]) throw genericUnavailable();
    return new PersonalExtensionCoordinationFacadeError(parsed.code, status);
  } catch (error) {
    return error instanceof PersonalExtensionCoordinationFacadeError ? error : genericUnavailable();
  }
}

function closeCoordinationEventListener(hub: CoordinationEventHub, node: CoordinationEventListenerNode) {
  if (node.closed) return;
  node.closed = true;
  if (node.signal && node.abortListener && typeof pristineRemoveAbortListener === "function") {
    pristineReflectApply(pristineRemoveAbortListener, node.signal, ["abort", node.abortListener]);
  }
  setDelete(hub.listeners, node);
  if (setSize(hub.listeners) === 0) stopCoordinationEventHub(hub);
}

function stopCoordinationEventHub(hub: CoordinationEventHub) {
  if (hub.stopped) return;
  hub.stopped = true;
  if (hub.reconnectTimer) {
    capturedClearTimeout(hub.reconnectTimer);
    hub.reconnectTimer = null;
  }
  if (hub.requestController && typeof pristineAbort === "function") {
    try {
      pristineReflectApply(pristineAbort, hub.requestController, []);
    } catch {
      // Closing a hint stream remains best-effort.
    }
  }
  if (hub.reader && typeof pristineReaderCancel === "function") {
    try {
      void pristineReflectApply(pristineReaderCancel, hub.reader, []).catch(() => undefined);
    } catch {
      // The stream may already have closed between the state check and cancel.
    }
  }
  setForEach(hub.listeners, (node) => {
    node.closed = true;
    if (node.signal && node.abortListener && typeof pristineRemoveAbortListener === "function") {
      pristineReflectApply(pristineRemoveAbortListener, node.signal, ["abort", node.abortListener]);
    }
  });
  setClear(hub.listeners);
  if (hub.privateState.eventHub === hub) hub.privateState.eventHub = null;
}

function scheduleCoordinationEventReconnect(hub: CoordinationEventHub) {
  if (hub.stopped || setSize(hub.listeners) === 0 || hub.reconnectTimer) return;
  hub.reconnectTimer = capturedSetTimeout(() => {
    hub.reconnectTimer = null;
    void connectCoordinationEventHub(hub);
  }, EVENT_RECONNECT_DELAY_MS);
}

function coordinationEventUrl(hub: CoordinationEventHub) {
  const queryInput = objectCreate(null) as {
    deviceSessionId: string;
    eventEpoch: string | undefined;
    cursor: number | undefined;
  };
  queryInput.deviceSessionId = hub.privateState.deviceSessionId;
  // Keep optional fields as explicit own slots too. Zod's refinement reads
  // them from its parsed record, and an omitted field there would otherwise
  // fall through to Object.prototype even though this input itself is null-proto.
  queryInput.eventEpoch = hub.eventEpoch;
  queryInput.cursor = hub.cursor;
  const parsedQuery = personalExtensionCoordinationEventQuerySchema.parse(queryInput);
  // Schema output is an ordinary object and optional keys may be absent. Copy
  // it back to an own-slot record before reading those keys so a page-installed
  // Object.prototype getter cannot re-enter after validation either.
  const query = objectCreate(null) as {
    deviceSessionId: string;
    eventEpoch: string | undefined;
    cursor: number | undefined;
  };
  query.deviceSessionId = parsedQuery.deviceSessionId;
  query.eventEpoch = hub.eventEpoch === undefined ? undefined : parsedQuery.eventEpoch;
  query.cursor = hub.eventEpoch === undefined ? undefined : parsedQuery.cursor;
  let url = `/api/personal-extensions/${hub.privateState.extensionId}/coordination/events?deviceSessionId=${pristineEncodeURIComponent(query.deviceSessionId)}`;
  if (query.eventEpoch !== undefined && query.cursor !== undefined) {
    url += `&eventEpoch=${pristineEncodeURIComponent(query.eventEpoch)}&cursor=${String(query.cursor)}`;
  }
  return url;
}

function dispatchCoordinationEvent(hub: CoordinationEventHub, data: string) {
  let event: PersonalExtensionCoordinationEvent;
  try {
    event = deepFreeze(personalExtensionCoordinationEventSchema.parse(pristineJsonParse(data)));
  } catch {
    throw new CoordinationEventProtocolError();
  }

  if (event.type === "reset") {
    hub.eventEpoch = event.eventEpoch;
    hub.cursor = event.cursor;
  } else {
    if (hub.eventEpoch !== event.eventEpoch || hub.cursor === undefined || event.cursor > hub.cursor + 1) {
      throw new CoordinationEventProtocolError();
    }
    if (event.cursor <= hub.cursor) return;
    hub.cursor = event.cursor;
  }

  // Snapshot with a host-owned linked list. An array or Set iterator here
  // would let later full-page code capture another extension's callback and
  // use it as a confused deputy.
  const snapshot: {
    head: CoordinationEventListenerSnapshotNode | null;
    tail: CoordinationEventListenerSnapshotNode | null;
  } = { head: null, tail: null };
  setForEach(hub.listeners, (node) => {
    const item: CoordinationEventListenerSnapshotNode = { value: node, next: null };
    if (snapshot.tail) snapshot.tail.next = item;
    else snapshot.head = item;
    snapshot.tail = item;
  });
  let item = snapshot.head;
  while (item) {
    const node = item.value;
    item = item.next;
    if (node.closed) continue;
    try {
      node.listener(event);
    } catch {
      // Extension listeners are isolated from the host-owned hint transport.
    }
  }
}

function consumeCoordinationEventFrames(hub: CoordinationEventHub, buffer: string) {
  let boundary = buffer.indexOf("\n\n");
  while (boundary >= 0) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const data = frame
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data) dispatchCoordinationEvent(hub, data);
    boundary = buffer.indexOf("\n\n");
  }
  if (buffer.length > EVENT_STREAM_BUFFER_LIMIT) throw new CoordinationEventProtocolError();
  return buffer;
}

async function connectCoordinationEventHub(hub: CoordinationEventHub) {
  if (hub.stopped || hub.connecting || setSize(hub.listeners) === 0) return;
  if (
    !pristineFetch ||
    !CapturedAbortController ||
    typeof pristineAbort !== "function" ||
    typeof pristineResponseBody !== "function" ||
    typeof pristineGetReader !== "function" ||
    typeof pristineReaderRead !== "function" ||
    !CapturedTextDecoder ||
    typeof pristineTextDecode !== "function"
  ) {
    stopCoordinationEventHub(hub);
    return;
  }

  hub.connecting = true;
  const controller = new CapturedAbortController();
  hub.requestController = controller;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let terminal = false;
  let connectionAccepted = false;
  try {
    const headers = objectCreate(null) as Record<string, string>;
    headers.Accept = "text/event-stream";
    // Null-prototype init: see guardedRequest — absent RequestInit members are
    // still [[Get]] during dictionary conversion.
    const init = objectCreate(null) as RequestInit;
    init.method = "GET";
    init.headers = objectFreeze(headers);
    init.signal = controller.signal;
    init.cache = "no-store";
    init.credentials = "same-origin";
    init.redirect = "error";
    const response = await pristineFetch(coordinationEventUrl(hub), init);
    if (hub.stopped) return;
    if (!responseOk(response)) {
      const error = await coordinationFailureFromResponse(response);
      terminal = error.code !== "coordination-unavailable";
      throw error;
    }

    const body = pristineReflectApply(pristineResponseBody, response, []) as ReadableStream<Uint8Array> | null;
    if (!body) throw new CoordinationEventProtocolError();
    reader = pristineReflectApply(pristineGetReader, body, []) as ReadableStreamDefaultReader<Uint8Array>;
    hub.reader = reader;
    connectionAccepted = true;
    const decoder = new CapturedTextDecoder();
    let buffer = "";
    while (!hub.stopped) {
      const chunk = await pristineReflectApply(pristineReaderRead, reader, []);
      if (chunk.done) {
        buffer += pristineReflectApply(pristineTextDecode, decoder, []);
        consumeCoordinationEventFrames(hub, buffer);
        break;
      }
      buffer += pristineReflectApply(pristineTextDecode, decoder, [chunk.value, { stream: true }]);
      buffer = consumeCoordinationEventFrames(hub, buffer);
    }
  } catch (error) {
    if (error instanceof CoordinationEventProtocolError) {
      hub.eventEpoch = undefined;
      hub.cursor = undefined;
    }
    if (!connectionAccepted) {
      // An unavailable server or a transport failure before the stream is
      // accepted is transient. Keep the bounded reconnect path alive so an
      // existing subscription can recover without a panel/runtime restart.
      // Closed protocol failures and the subscriber cap remain terminal;
      // CMB's authoritative polling owns that fallback.
      terminal =
        error instanceof CoordinationEventProtocolError ||
        (error instanceof PersonalExtensionCoordinationFacadeError &&
          error.code !== "coordination-unavailable" &&
          error.code !== "request-cancelled");
    }
  } finally {
    if (reader && typeof pristineReaderReleaseLock === "function") {
      try {
        pristineReflectApply(pristineReaderReleaseLock, reader, []);
      } catch {
        // A concurrently cancelled stream may already have released its lock.
      }
    }
    if (hub.reader === reader) hub.reader = null;
    if (hub.requestController === controller) hub.requestController = null;
    hub.connecting = false;
  }

  if (terminal) stopCoordinationEventHub(hub);
  else scheduleCoordinationEventReconnect(hub);
}

function subscribeToCoordinationEvents(
  facade: PersonalExtensionCoordinationFacade,
  listener: PersonalExtensionCoordinationEventListener,
  options?: PersonalExtensionCoordinationSignalOptions,
): PersonalExtensionCoordinationEventSubscription {
  const privateState = privateStateFor(facade);
  if (!privateState.accepting) fail("coordination-unavailable");
  if (typeof listener !== "function") fail("invalid-request");
  const { signal } = signalOptions(options);
  if (signal?.aborted) throw requestCancelled();
  if (signal && typeof pristineAddAbortListener !== "function") fail("coordination-unavailable");

  let hub = privateState.eventHub;
  if (!hub || hub.stopped) {
    hub = {
      privateState,
      listeners: new CapturedSet(),
      requestController: null,
      reader: null,
      reconnectTimer: null,
      eventEpoch: undefined,
      cursor: undefined,
      connecting: false,
      stopped: false,
    };
    privateState.eventHub = hub;
  }
  const node: CoordinationEventListenerNode = { listener, signal, closed: false };
  const close = () => closeCoordinationEventListener(hub!, node);
  if (signal) {
    node.abortListener = close;
    pristineReflectApply(pristineAddAbortListener!, signal, ["abort", close, { once: true }]);
  }
  setAdd(hub.listeners, node);
  void connectCoordinationEventHub(hub);
  return deepFreeze({ close });
}

function privateStateFor(facade: PersonalExtensionCoordinationFacade): FacadePrivateState {
  const privateState = facadePrivateGet(facade);
  if (!privateState || privateState.disposed) fail("coordination-unavailable");
  return privateState;
}

function authorityFor(privateState: FacadePrivateState): LeaseAuthority {
  if (!privateState.authority) fail("lease-lost");
  return privateState.authority;
}

function holderSessionIdFor(privateState: FacadePrivateState): string {
  privateState.holderSessionId ??= makeUuid();
  return privateState.holderSessionId;
}

function exactPrivateRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || pristineArrayIsArray(value)) throw genericUnavailable();
  const keys = objectKeys(value);
  if (keys.length !== expectedKeys.length) throw genericUnavailable();
  for (let index = 0; index < keys.length; index += 1) {
    if (!stringArrayContains(expectedKeys, keys[index]!)) throw genericUnavailable();
  }
  return value as Record<string, unknown>;
}

function privateString(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw genericUnavailable();
  return value;
}

function parsePrivateLeaseGrant(value: unknown): PersonalExtensionCoordinationLeaseGrant {
  const source = exactPrivateRecord(value, [
    "leaseToken",
    "holderSessionId",
    "serverBootId",
    "contentHash",
    "fence",
    "expiresAt",
    "remainingMs",
  ]);
  const leaseToken = privateString(source.leaseToken, 16, 1024);
  const holderSessionId = privateString(source.holderSessionId, 1, 512);
  // Zod's object parser uses live page-realm Object/Array prototypes. Feed it
  // placeholders only, then combine the manually validated private scalars in
  // host-owned object literals. No page hook receives raw authority.
  const parsed = personalExtensionCoordinationLeaseGrantSchema.parse({
    leaseToken: PRIVATE_VALIDATION_LEASE_TOKEN,
    holderSessionId: PRIVATE_VALIDATION_HOLDER_ID,
    serverBootId: source.serverBootId,
    contentHash: source.contentHash,
    fence: source.fence,
    expiresAt: source.expiresAt,
    remainingMs: source.remainingMs,
  });
  return {
    leaseToken,
    holderSessionId,
    serverBootId: parsed.serverBootId,
    contentHash: parsed.contentHash,
    fence: parsed.fence,
    expiresAt: parsed.expiresAt,
    remainingMs: parsed.remainingMs,
  };
}

function parsePrivateOperationGrant(value: unknown): PersonalExtensionCoordinationOperationGrant {
  const source = exactPrivateRecord(value, ["operationHandle", "kind", "deadlineAt", "remainingMs"]);
  const operationHandle = privateString(source.operationHandle, 16, 1024);
  const parsed = personalExtensionCoordinationOperationGrantSchema.parse({
    operationHandle: PRIVATE_VALIDATION_OPERATION_HANDLE,
    kind: source.kind,
    deadlineAt: source.deadlineAt,
    remainingMs: source.remainingMs,
  });
  return {
    operationHandle,
    kind: parsed.kind,
    deadlineAt: parsed.deadlineAt,
    remainingMs: parsed.remainingMs,
  };
}

function parsePrivateLeaseState(value: unknown): PersonalExtensionCoordinationLeaseState {
  const source = exactPrivateRecord(value, [
    "holderSessionId",
    "serverBootId",
    "contentHash",
    "fence",
    "expiresAt",
    "remainingMs",
  ]);
  const holderSessionId = privateString(source.holderSessionId, 1, 512);
  const parsed = personalExtensionCoordinationLeaseGrantSchema.parse({
    leaseToken: PRIVATE_VALIDATION_LEASE_TOKEN,
    holderSessionId: PRIVATE_VALIDATION_HOLDER_ID,
    serverBootId: source.serverBootId,
    contentHash: source.contentHash,
    fence: source.fence,
    expiresAt: source.expiresAt,
    remainingMs: source.remainingMs,
  });
  return {
    holderSessionId,
    serverBootId: parsed.serverBootId,
    contentHash: parsed.contentHash,
    fence: parsed.fence,
    expiresAt: parsed.expiresAt,
    remainingMs: parsed.remainingMs,
  };
}

const privateLeaseGrantSchema: WireSchema<PersonalExtensionCoordinationLeaseGrant> = objectFreeze({
  parse: parsePrivateLeaseGrant,
});
const privateOperationGrantSchema: WireSchema<PersonalExtensionCoordinationOperationGrant> = objectFreeze({
  parse: parsePrivateOperationGrant,
});
const privateLeaseStateSchema: WireSchema<PersonalExtensionCoordinationLeaseState> = objectFreeze({
  parse: parsePrivateLeaseState,
});

function leaseIdentityBody(serverBootId: string, contentHash: string): Record<string, unknown> {
  const body = objectCreate(null) as Record<string, unknown>;
  body.serverBootId = serverBootId;
  body.contentHash = contentHash;
  return body;
}

function authorityBody(authority: LeaseAuthority): Record<string, unknown> {
  const body = objectCreate(null) as Record<string, unknown>;
  body.serverBootId = authority.serverBootId;
  body.contentHash = authority.contentHash;
  body.fence = authority.fence;
  body.leaseToken = authority.leaseToken;
  return body;
}

function operationAuthorityBody(authority: LeaseAuthority, operationHandle: string): Record<string, unknown> {
  const body = authorityBody(authority);
  body.operationHandle = operationHandle;
  return body;
}

function nonnegativeSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid-request");
  return value;
}

function operationKind(value: unknown): PersonalExtensionCoordinationOperationGrant["kind"] {
  if (value !== "mutation" && value !== "vectorize") fail("invalid-request");
  return value;
}

function targetEnsembleId(value: unknown): string {
  if (typeof value !== "string" || !regexTest(TARGET_ENSEMBLE_ID_PATTERN, value)) fail("invalid-request");
  return value;
}

function requestedDeadlineMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 600_000) {
    fail("invalid-request");
  }
  return value;
}

function publicWriterState(
  privateState: FacadePrivateState,
  authority: LeaseAuthority,
): PersonalExtensionCoordinationState {
  return deepFreeze(
    personalExtensionCoordinationStateSchema.parse({
      schemaVersion: PERSONAL_EXTENSION_COORDINATION_SCHEMA_VERSION,
      extensionId: privateState.extensionId,
      serverBootId: authority.serverBootId,
      contentHash: authority.contentHash,
      fence: authority.fence,
      remainingMs: authority.leaseState.remainingMs,
      mode: "active",
      coordinationActive: true,
      capabilities: PERSONAL_EXTENSION_COORDINATION_CAPABILITIES,
      role: "writer",
    }),
  );
}

function invalidateAuthority(privateState: FacadePrivateState) {
  setForEach(privateState.operations, (capability) => {
    const operation = operationPrivateGet(capability);
    if (operation) operation.active = false;
    operationPrivateDelete(capability);
  });
  setClear(privateState.operations);
  privateState.authority = null;
  privateState.holderSessionId = null;
}

function terminalAuthorityError(error: unknown): boolean {
  return (
    error instanceof PersonalExtensionCoordinationFacadeError &&
    (error.code === "lease-lost" ||
      error.code === "lease-expired" ||
      error.code === "extension-runtime-changed" ||
      error.code === "coordination-inactive" ||
      error.code === "coordination-transition-blocked")
  );
}

function closedIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) fail("invalid-request");
  return value;
}

function encodedIdentifier(value: unknown): string {
  return pristineEncodeURIComponent(closedIdentifier(value));
}

function cachedLorebookRevision(privateState: FacadePrivateState, lorebookId: string): number {
  const revision = privateState.lorebookRevisions[lorebookId];
  if (!Number.isSafeInteger(revision) || revision < 0) fail("coordination-unavailable");
  return revision;
}

function rememberLorebookRevision(privateState: FacadePrivateState, lorebookId: string, revision: number) {
  privateState.lorebookRevisions[lorebookId] = revision;
}

async function lorebookRequest<T>(
  privateState: FacadePrivateState,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  schema: WireSchema<T>,
  options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const authority = authorityFor(privateState);
  try {
    return await guardedRequest(privateState, "", method, schema, {
      ...options,
      url: `/api/lorebooks${path}`,
      holderSessionId: authority.holderSessionId,
      authorityHeaders: authority,
    });
  } catch (error) {
    if (terminalAuthorityError(error)) invalidateAuthority(privateState);
    throw error instanceof PersonalExtensionCoordinationFacadeError ? error : genericUnavailable();
  }
}

async function listLorebooks(
  facade: PersonalExtensionCoordinationFacade,
  options?: PersonalExtensionCoordinationSignalOptions,
) {
  const privateState = privateStateFor(facade);
  const { signal } = signalOptions(options);
  const response = await lorebookRequest(
    privateState,
    "/coordination",
    "GET",
    personalExtensionCoordinationRevisionedLorebookListResponseSchema,
    { signal },
  );
  for (const item of response.items) rememberLorebookRevision(privateState, item.value.id, item.resourceRevision);
  return deepFreeze(response.items.map((item) => item.value));
}

async function getLorebook(
  facade: PersonalExtensionCoordinationFacade,
  input: PersonalExtensionCoordinationLorebookIdInput,
) {
  const privateState = privateStateFor(facade);
  const parsed = fixedInput<{ lorebookId: unknown; signal?: unknown }>(input, ["lorebookId", "signal"], ["lorebookId"]);
  const lorebookId = closedIdentifier(parsed.lorebookId);
  const signal = readSignal(parsed.signal);
  const response = await lorebookRequest(
    privateState,
    `/${encodedIdentifier(lorebookId)}/coordination`,
    "GET",
    personalExtensionCoordinationRevisionedLorebookResponseSchema,
    { signal },
  );
  if (response.value.id !== lorebookId) throw genericUnavailable();
  rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
  return response.value;
}

async function listLorebookEntries(
  facade: PersonalExtensionCoordinationFacade,
  input: PersonalExtensionCoordinationLorebookIdInput,
) {
  const privateState = privateStateFor(facade);
  const parsed = fixedInput<{ lorebookId: unknown; signal?: unknown }>(input, ["lorebookId", "signal"], ["lorebookId"]);
  const lorebookId = closedIdentifier(parsed.lorebookId);
  const signal = readSignal(parsed.signal);
  const response = await lorebookRequest(
    privateState,
    `/${encodedIdentifier(lorebookId)}/coordination/entries`,
    "GET",
    personalExtensionCoordinationRevisionedLorebookEntryListResponseSchema,
    { signal },
  );
  if (response.items.some((entry) => entry.lorebookId !== lorebookId)) throw genericUnavailable();
  rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
  return response.items;
}

async function getLorebookEntry(
  facade: PersonalExtensionCoordinationFacade,
  input: PersonalExtensionCoordinationLorebookEntryIdInput,
) {
  const privateState = privateStateFor(facade);
  const parsed = fixedInput<{ lorebookId: unknown; entryId: unknown; signal?: unknown }>(
    input,
    ["lorebookId", "entryId", "signal"],
    ["lorebookId", "entryId"],
  );
  const lorebookId = closedIdentifier(parsed.lorebookId);
  const entryId = closedIdentifier(parsed.entryId);
  const signal = readSignal(parsed.signal);
  const response = await lorebookRequest(
    privateState,
    `/${encodedIdentifier(lorebookId)}/coordination/entries/${encodedIdentifier(entryId)}`,
    "GET",
    personalExtensionCoordinationRevisionedLorebookEntryResponseSchema,
    { signal },
  );
  if (response.value.id !== entryId || response.value.lorebookId !== lorebookId) throw genericUnavailable();
  rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
  return response.value;
}

async function getState(
  facade: PersonalExtensionCoordinationFacade,
  options?: PersonalExtensionCoordinationSignalOptions,
) {
  const privateState = privateStateFor(facade);
  const { signal } = signalOptions(options);
  const state = await guardedRequest(privateState, "", "GET", personalExtensionCoordinationStateSchema, {
    signal,
    holderSessionId: privateState.holderSessionId ?? undefined,
  });
  if (state.extensionId !== privateState.extensionId) throw genericUnavailable();
  if (state.mode === "active" && state.contentHash !== privateState.contentHash) {
    invalidateAuthority(privateState);
    fail("extension-runtime-changed");
  }
  const authority = privateState.authority;
  if (
    authority &&
    (state.mode !== "active" ||
      state.role !== "writer" ||
      state.serverBootId !== authority.serverBootId ||
      state.contentHash !== authority.contentHash ||
      state.fence !== authority.fence)
  ) {
    invalidateAuthority(privateState);
  }
  return state;
}

async function acquireLease(
  facade: PersonalExtensionCoordinationFacade,
  options?: PersonalExtensionCoordinationSignalOptions,
) {
  const privateState = privateStateFor(facade);
  if (!privateState.accepting) fail("coordination-unavailable");
  const { signal } = signalOptions(options);
  if (privateState.authority) return publicWriterState(privateState, privateState.authority);

  const state = await getState(facade, { signal });
  if (state.mode !== "active") {
    fail(state.mode === "inactive" ? "coordination-inactive" : "coordination-transition-blocked");
  }
  const holderSessionId = holderSessionIdFor(privateState);
  const body = leaseIdentityBody(state.serverBootId, privateState.contentHash);
  try {
    const grant = await guardedRequest(privateState, "/lease/acquire", "POST", privateLeaseGrantSchema, {
      body,
      signal,
      holderSessionId,
    });
    if (
      grant.holderSessionId !== holderSessionId ||
      grant.serverBootId !== state.serverBootId ||
      grant.contentHash !== privateState.contentHash
    ) {
      throw genericUnavailable();
    }
    const leaseState: PersonalExtensionCoordinationLeaseState = deepFreeze({
      holderSessionId: grant.holderSessionId,
      serverBootId: grant.serverBootId,
      contentHash: grant.contentHash,
      fence: grant.fence,
      expiresAt: grant.expiresAt,
      remainingMs: grant.remainingMs,
    });
    const nextAuthority: LeaseAuthority = {
      leaseToken: grant.leaseToken,
      holderSessionId,
      serverBootId: grant.serverBootId,
      contentHash: grant.contentHash,
      fence: grant.fence,
      leaseState,
    };
    const writerState = publicWriterState(privateState, nextAuthority);
    privateState.authority = nextAuthority;
    return writerState;
  } catch (error) {
    if (
      !(error instanceof PersonalExtensionCoordinationFacadeError) ||
      (error.code !== "lease-held" && error.code !== "handoff-pending")
    ) {
      privateState.holderSessionId = null;
    }
    throw error instanceof PersonalExtensionCoordinationFacadeError ? error : genericUnavailable();
  }
}

async function requestHandoff(
  facade: PersonalExtensionCoordinationFacade,
  options?: PersonalExtensionCoordinationSignalOptions,
) {
  const privateState = privateStateFor(facade);
  if (!privateState.accepting || privateState.authority) fail("invalid-request");
  const { signal } = signalOptions(options);
  const state = await getState(facade, { signal });
  if (state.mode !== "active") {
    fail(state.mode === "inactive" ? "coordination-inactive" : "coordination-transition-blocked");
  }
  const holderSessionId = holderSessionIdFor(privateState);
  const body = leaseIdentityBody(state.serverBootId, privateState.contentHash);
  try {
    return await guardedRequest(privateState, "/handoff", "POST", personalExtensionCoordinationHandoffResponseSchema, {
      body,
      signal,
      holderSessionId,
      timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS,
    });
  } catch (error) {
    if (terminalAuthorityError(error)) invalidateAuthority(privateState);
    throw error instanceof PersonalExtensionCoordinationFacadeError ? error : genericUnavailable();
  }
}

async function renewLease(
  facade: PersonalExtensionCoordinationFacade,
  options?: PersonalExtensionCoordinationSignalOptions,
) {
  const privateState = privateStateFor(facade);
  const { signal } = signalOptions(options);
  const authority = authorityFor(privateState);
  const body = authorityBody(authority);
  try {
    const renewed = await guardedRequest(privateState, "/lease/renew", "POST", privateLeaseStateSchema, {
      body,
      signal,
      holderSessionId: authority.holderSessionId,
    });
    if (
      renewed.holderSessionId !== authority.holderSessionId ||
      renewed.serverBootId !== authority.serverBootId ||
      renewed.contentHash !== authority.contentHash ||
      renewed.fence !== authority.fence
    ) {
      invalidateAuthority(privateState);
      throw genericUnavailable();
    }
    authority.leaseState = renewed;
    return publicWriterState(privateState, authority);
  } catch (error) {
    if (terminalAuthorityError(error)) invalidateAuthority(privateState);
    throw error;
  }
}

async function releaseLease(
  facade: PersonalExtensionCoordinationFacade,
  options?: PersonalExtensionCoordinationReleaseOptions,
) {
  const privateState = privateStateFor(facade);
  const { signal, handoffRequestId } = releaseOptions(options);
  const authority = authorityFor(privateState);
  const body = authorityBody(authority);
  if (handoffRequestId !== undefined) body.handoffRequestId = handoffRequestId;
  try {
    const released = await guardedRequest(
      privateState,
      "/lease/release",
      "POST",
      personalExtensionCoordinationReleaseResponseSchema,
      { body, signal, holderSessionId: authority.holderSessionId },
    );
    if (
      released.serverBootId !== authority.serverBootId ||
      released.contentHash !== authority.contentHash ||
      released.fence <= authority.fence
    ) {
      throw genericUnavailable();
    }
    invalidateAuthority(privateState);
    return released;
  } catch (error) {
    if (terminalAuthorityError(error)) invalidateAuthority(privateState);
    throw error;
  }
}

async function signalDirty(
  facade: PersonalExtensionCoordinationFacade,
  input: PersonalExtensionCoordinationDirtyInput,
) {
  const privateState = privateStateFor(facade);
  if (!privateState.accepting) fail("coordination-unavailable");
  const parsed = fixedInput<{ chatId: unknown; signal?: unknown }>(input, ["chatId", "signal"], ["chatId"]);
  const signal = readSignal(parsed.signal);
  let body;
  try {
    body = personalExtensionCoordinationDirtyRequestSchema.parse({
      deviceSessionId: privateState.deviceSessionId,
      chatId: parsed.chatId,
    });
  } catch {
    fail("invalid-request");
  }
  return guardedRequest(privateState, "/dirty", "POST", personalExtensionCoordinationDirtyResponseSchema, {
    body,
    signal,
    timeoutMs: DEFAULT_READ_TIMEOUT_MS,
  });
}

function operationStateFor(capability: PersonalExtensionCoordinationOperationCapability) {
  const operation = operationPrivateGet(capability);
  if (!operation || !operation.active) fail("operation-lost");
  const privateState = privateStateFor(operation.facade);
  const authority = authorityFor(privateState);
  return { operation, privateState, authority };
}

function requireOperationKind(
  operation: OperationPrivateState,
  expectedKind: PersonalExtensionCoordinationOperationGrant["kind"],
) {
  if (operation.kind !== expectedKind) fail("operation-kind-unsupported");
}

async function transitionOperationToVectorize(
  capability: PersonalExtensionCoordinationOperationCapability,
  options?: PersonalExtensionCoordinationSignalOptions,
): Promise<void> {
  const { operation, privateState, authority } = operationStateFor(capability);
  const { signal } = signalOptions(options);
  if (signal?.aborted) throw requestCancelled();
  if (operation.kind === "vectorize") return;
  if (operation.transitionPromise) {
    await operation.transitionPromise;
    return;
  }
  const body = operationAuthorityBody(authority, operation.operationHandle);
  body.targetEnsembleId = operation.targetEnsembleId;
  let transitionPromise!: Promise<void>;
  transitionPromise = (async () => {
    try {
      const grant = await guardedRequest(
        privateState,
        "/operations/transition-to-vectorize",
        "POST",
        privateOperationGrantSchema,
        { body, signal, holderSessionId: authority.holderSessionId, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
      );
      if (grant.operationHandle !== operation.operationHandle || grant.kind !== "vectorize") {
        throw genericUnavailable();
      }
      operation.kind = grant.kind;
      operation.deadlineAt = grant.deadlineAt;
      operation.remainingMs = grant.remainingMs;
    } catch (error) {
      if (error instanceof PersonalExtensionCoordinationFacadeError && error.code === "operation-lost") {
        operation.active = false;
        operationPrivateDelete(capability);
        setDelete(privateState.operations, capability);
      } else if (terminalAuthorityError(error)) {
        invalidateAuthority(privateState);
      }
      throw error instanceof PersonalExtensionCoordinationFacadeError ? error : genericUnavailable();
    } finally {
      if (operation.transitionPromise === transitionPromise) operation.transitionPromise = null;
    }
  })();
  operation.transitionPromise = transitionPromise;
  await transitionPromise;
}

async function endOperation(
  capability: PersonalExtensionCoordinationOperationCapability,
  options?: PersonalExtensionCoordinationOperationEndOptions,
) {
  const { operation, privateState, authority } = operationStateFor(capability);
  const parsed = fixedInput<{ disposition?: unknown; signal?: unknown }>(options ?? {}, ["disposition", "signal"], []);
  const signal = readSignal(parsed.signal);
  if (parsed.disposition !== undefined && parsed.disposition !== "aborted" && parsed.disposition !== "conclusive") {
    fail("invalid-request");
  }
  const body = operationAuthorityBody(authority, operation.operationHandle);
  if (parsed.disposition !== undefined) body.disposition = parsed.disposition;
  try {
    const ended = await guardedRequest(
      privateState,
      "/operations/end",
      "POST",
      personalExtensionCoordinationOperationEndResponseSchema,
      { body, signal, holderSessionId: authority.holderSessionId, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
    );
    if (
      ended.serverBootId !== authority.serverBootId ||
      ended.contentHash !== authority.contentHash ||
      ended.fence !== authority.fence
    ) {
      throw genericUnavailable();
    }
    operation.active = false;
    operationPrivateDelete(capability);
    setDelete(privateState.operations, capability);
  } catch (error) {
    if (error instanceof PersonalExtensionCoordinationFacadeError && error.code === "operation-lost") {
      operation.active = false;
      operationPrivateDelete(capability);
      setDelete(privateState.operations, capability);
    } else if (terminalAuthorityError(error)) {
      invalidateAuthority(privateState);
    }
    throw error;
  }
}

function createOperationCapability(
  facade: PersonalExtensionCoordinationFacade,
  grant: PersonalExtensionCoordinationOperationGrant & { operationHandle: string },
  operationTargetEnsembleId: string,
) {
  const storage = {
    async patch(input: PersonalExtensionCoordinationStoragePatchInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      const parsed = fixedInput<{
        expectedConfigRevision: unknown;
        patch: unknown;
        signal?: unknown;
      }>(input, ["expectedConfigRevision", "patch", "signal"], ["expectedConfigRevision", "patch"]);
      const signal = readSignal(parsed.signal);
      const expectedConfigRevision = nonnegativeSafeInteger(parsed.expectedConfigRevision);
      let patch: Record<string, unknown>;
      try {
        patch = personalExtensionStoragePatchSchema.parse(parsed.patch);
      } catch {
        fail("invalid-request");
      }
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.expectedConfigRevision = expectedConfigRevision;
      body.patch = patch;
      try {
        return await guardedRequest(
          privateState,
          "/storage",
          "PATCH",
          personalExtensionCoordinationRevisionedStorageResponseSchema,
          { body, signal, holderSessionId: authority.holderSessionId, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
        );
      } catch (error) {
        if (terminalAuthorityError(error)) invalidateAuthority(privateState);
        throw error instanceof PersonalExtensionCoordinationFacadeError ? error : genericUnavailable();
      }
    },
    async delete(input: PersonalExtensionCoordinationStorageDeleteInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      const parsed = fixedInput<{ expectedConfigRevision: unknown; signal?: unknown }>(
        input,
        ["expectedConfigRevision", "signal"],
        ["expectedConfigRevision"],
      );
      const signal = readSignal(parsed.signal);
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.expectedConfigRevision = nonnegativeSafeInteger(parsed.expectedConfigRevision);
      try {
        return await guardedRequest(
          privateState,
          "/storage",
          "DELETE",
          personalExtensionCoordinationRevisionedStorageResponseSchema,
          { body, signal, holderSessionId: authority.holderSessionId, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
        );
      } catch (error) {
        if (terminalAuthorityError(error)) invalidateAuthority(privateState);
        throw error instanceof PersonalExtensionCoordinationFacadeError ? error : genericUnavailable();
      }
    },
  };
  const lorebooks = {
    async create(input: PersonalExtensionCoordinationLorebookCreateInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      requireOperationKind(operation, "mutation");
      const parsed = fixedInput<{ book: unknown; signal?: unknown }>(input, ["book", "signal"], ["book"]);
      const signal = readSignal(parsed.signal);
      let book: CreateLorebookInput;
      try {
        book = createLorebookSchema.parse(parsed.book);
      } catch {
        fail("invalid-request");
      }
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.extensionId = privateState.extensionId;
      body.book = book;
      const response = await lorebookRequest(
        privateState,
        "/coordination",
        "POST",
        personalExtensionCoordinationRevisionedLorebookResponseSchema,
        { body, signal, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
      );
      rememberLorebookRevision(privateState, response.value.id, response.resourceRevision);
      return response.value;
    },

    async update(input: PersonalExtensionCoordinationLorebookUpdateInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      requireOperationKind(operation, "mutation");
      const parsed = fixedInput<{ lorebookId: unknown; changes: unknown; signal?: unknown }>(
        input,
        ["lorebookId", "changes", "signal"],
        ["lorebookId", "changes"],
      );
      const lorebookId = closedIdentifier(parsed.lorebookId);
      const signal = readSignal(parsed.signal);
      let changes: UpdateLorebookInput;
      try {
        changes = updateLorebookSchema.parse(parsed.changes);
      } catch (error) {
        if (error instanceof PersonalExtensionCoordinationFacadeError) throw error;
        fail("invalid-request");
      }
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.extensionId = privateState.extensionId;
      body.expectedResourceRevision = cachedLorebookRevision(privateState, lorebookId);
      body.changes = changes;
      const response = await lorebookRequest(
        privateState,
        `/${encodedIdentifier(lorebookId)}/coordination`,
        "PATCH",
        personalExtensionCoordinationRevisionedLorebookResponseSchema,
        { body, signal, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
      );
      if (response.value.id !== lorebookId) throw genericUnavailable();
      rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
      return response.value;
    },

    async createEntry(input: PersonalExtensionCoordinationLorebookEntryCreateInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      requireOperationKind(operation, "mutation");
      const parsed = fixedInput<{ lorebookId: unknown; entry: unknown; signal?: unknown }>(
        input,
        ["lorebookId", "entry", "signal"],
        ["lorebookId", "entry"],
      );
      const lorebookId = closedIdentifier(parsed.lorebookId);
      const signal = readSignal(parsed.signal);
      let entry: Omit<CreateLorebookEntryInput, "lorebookId">;
      try {
        entry = createLorebookEntryInputSchema.parse(parsed.entry);
      } catch (error) {
        if (error instanceof PersonalExtensionCoordinationFacadeError) throw error;
        fail("invalid-request");
      }
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.extensionId = privateState.extensionId;
      body.expectedResourceRevision = cachedLorebookRevision(privateState, lorebookId);
      body.entry = entry;
      const response = await lorebookRequest(
        privateState,
        `/${encodedIdentifier(lorebookId)}/coordination/entries`,
        "POST",
        personalExtensionCoordinationRevisionedLorebookEntryResponseSchema,
        { body, signal, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
      );
      if (response.value.lorebookId !== lorebookId) throw genericUnavailable();
      rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
      return response.value;
    },

    async updateEntry(input: PersonalExtensionCoordinationLorebookEntryUpdateInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      requireOperationKind(operation, "mutation");
      const parsed = fixedInput<{
        lorebookId: unknown;
        entryId: unknown;
        changes: unknown;
        signal?: unknown;
      }>(input, ["lorebookId", "entryId", "changes", "signal"], ["lorebookId", "entryId", "changes"]);
      const lorebookId = closedIdentifier(parsed.lorebookId);
      const entryId = closedIdentifier(parsed.entryId);
      const signal = readSignal(parsed.signal);
      let changes: UpdateLorebookEntryInput;
      try {
        changes = updateLorebookEntrySchema.parse(parsed.changes);
      } catch (error) {
        if (error instanceof PersonalExtensionCoordinationFacadeError) throw error;
        fail("invalid-request");
      }
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.extensionId = privateState.extensionId;
      body.expectedResourceRevision = cachedLorebookRevision(privateState, lorebookId);
      body.changes = changes;
      const response = await lorebookRequest(
        privateState,
        `/${encodedIdentifier(lorebookId)}/coordination/entries/${encodedIdentifier(entryId)}`,
        "PATCH",
        personalExtensionCoordinationRevisionedLorebookEntryResponseSchema,
        { body, signal, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
      );
      if (response.value.id !== entryId || response.value.lorebookId !== lorebookId) throw genericUnavailable();
      rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
      return response.value;
    },

    async deleteEntry(input: PersonalExtensionCoordinationLorebookEntryDeleteInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      requireOperationKind(operation, "mutation");
      const parsed = fixedInput<{ lorebookId: unknown; entryId: unknown; signal?: unknown }>(
        input,
        ["lorebookId", "entryId", "signal"],
        ["lorebookId", "entryId"],
      );
      const lorebookId = closedIdentifier(parsed.lorebookId);
      const entryId = closedIdentifier(parsed.entryId);
      const signal = readSignal(parsed.signal);
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.extensionId = privateState.extensionId;
      body.expectedResourceRevision = cachedLorebookRevision(privateState, lorebookId);
      const response = await lorebookRequest(
        privateState,
        `/${encodedIdentifier(lorebookId)}/coordination/entries/${encodedIdentifier(entryId)}`,
        "DELETE",
        personalExtensionCoordinationLorebookEntryDeleteResponseSchema,
        { body, signal, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
      );
      rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
    },

    async vectorizeMissing(input: PersonalExtensionCoordinationLorebookVectorizeInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      requireOperationKind(operation, "vectorize");
      const parsed = fixedInput<{
        lorebookId: unknown;
        connectionId: unknown;
        model?: unknown;
        signal?: unknown;
      }>(input, ["lorebookId", "connectionId", "model", "signal"], ["lorebookId", "connectionId"]);
      const lorebookId = closedIdentifier(parsed.lorebookId);
      const signal = readSignal(parsed.signal);
      const connectionId = closedIdentifier(parsed.connectionId);
      const model = parsed.model === undefined ? undefined : closedIdentifier(parsed.model);
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.extensionId = privateState.extensionId;
      body.expectedResourceRevision = cachedLorebookRevision(privateState, lorebookId);
      body.connectionId = connectionId;
      if (model !== undefined) body.model = model;
      body.onlyMissing = true;
      const response = await lorebookRequest(
        privateState,
        `/${encodedIdentifier(lorebookId)}/coordination/vectorize`,
        "POST",
        personalExtensionCoordinationLorebookVectorizeResponseSchema,
        { body, signal, timeoutMs: DEFAULT_VECTOR_TIMEOUT_MS },
      );
      rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
      return deepFreeze({ vectorized: response.vectorized, total: response.total, skipped: response.skipped });
    },

    async clearVectors(input: PersonalExtensionCoordinationLorebookClearVectorsInput) {
      const { operation, privateState, authority } = operationStateFor(capability);
      requireOperationKind(operation, "vectorize");
      const parsed = fixedInput<{ lorebookId: unknown; signal?: unknown }>(
        input,
        ["lorebookId", "signal"],
        ["lorebookId"],
      );
      const lorebookId = closedIdentifier(parsed.lorebookId);
      const signal = readSignal(parsed.signal);
      const body = operationAuthorityBody(authority, operation.operationHandle);
      body.extensionId = privateState.extensionId;
      body.expectedResourceRevision = cachedLorebookRevision(privateState, lorebookId);
      const response = await lorebookRequest(
        privateState,
        `/${encodedIdentifier(lorebookId)}/coordination/vectors`,
        "DELETE",
        personalExtensionCoordinationLorebookClearVectorsResponseSchema,
        { body, signal, timeoutMs: DEFAULT_VECTOR_TIMEOUT_MS },
      );
      rememberLorebookRevision(privateState, lorebookId, response.resourceRevision);
      return deepFreeze({ cleared: response.cleared, total: response.total });
    },
  };
  const publicGrantState = {
    kind: grant.kind,
    deadlineAt: grant.deadlineAt,
    remainingMs: grant.remainingMs,
  };
  const capability: PersonalExtensionCoordinationOperationCapability = {
    get kind() {
      return operationPrivateGet(capability)?.kind ?? publicGrantState.kind;
    },
    get deadlineAt() {
      return operationPrivateGet(capability)?.deadlineAt ?? publicGrantState.deadlineAt;
    },
    get remainingMs() {
      return operationPrivateGet(capability)?.remainingMs ?? publicGrantState.remainingMs;
    },
    storage,
    lorebooks,
    async transitionToVectorize(options?: PersonalExtensionCoordinationSignalOptions) {
      await transitionOperationToVectorize(capability, options);
      const operation = operationPrivateGet(capability);
      if (!operation?.active || operation.kind !== "vectorize") fail("operation-lost");
      publicGrantState.kind = operation.kind;
      publicGrantState.deadlineAt = operation.deadlineAt;
      publicGrantState.remainingMs = operation.remainingMs;
    },
    end: (options?: PersonalExtensionCoordinationOperationEndOptions) => endOperation(capability, options),
  };
  operationPrivateSet(capability, {
    facade,
    operationHandle: grant.operationHandle,
    targetEnsembleId: operationTargetEnsembleId,
    kind: grant.kind,
    deadlineAt: grant.deadlineAt,
    remainingMs: grant.remainingMs,
    transitionPromise: null,
    active: true,
  });
  deepFreeze(capability);
  const privateState = facadePrivateGet(facade);
  if (!privateState) fail("coordination-unavailable");
  setAdd(privateState.operations, capability);
  return capability;
}

async function beginOperation(
  facade: PersonalExtensionCoordinationFacade,
  input: PersonalExtensionCoordinationOperationInput,
) {
  const privateState = privateStateFor(facade);
  if (!privateState.accepting) fail("coordination-unavailable");
  const authority = authorityFor(privateState);
  const parsed = fixedInput<{
    kind: unknown;
    targetEnsembleId: unknown;
    requestedDeadlineMs?: unknown;
    signal?: unknown;
  }>(input, ["kind", "targetEnsembleId", "requestedDeadlineMs", "signal"], ["kind", "targetEnsembleId"]);
  const signal = readSignal(parsed.signal);
  const kind = operationKind(parsed.kind);
  const operationTargetEnsembleId = targetEnsembleId(parsed.targetEnsembleId);
  const body = authorityBody(authority);
  body.kind = kind;
  body.targetEnsembleId = operationTargetEnsembleId;
  const deadline = requestedDeadlineMs(parsed.requestedDeadlineMs);
  if (deadline !== undefined) body.requestedDeadlineMs = deadline;
  try {
    const grant = await guardedRequest(privateState, "/operations/begin", "POST", privateOperationGrantSchema, {
      body,
      signal,
      holderSessionId: authority.holderSessionId,
      timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS,
    });
    if (grant.kind !== kind) throw genericUnavailable();
    return createOperationCapability(facade, grant, operationTargetEnsembleId);
  } catch (error) {
    if (terminalAuthorityError(error)) invalidateAuthority(privateState);
    throw error instanceof PersonalExtensionCoordinationFacadeError ? error : genericUnavailable();
  }
}

async function getRevisionedStorage(
  facade: PersonalExtensionCoordinationFacade,
  options?: PersonalExtensionCoordinationSignalOptions,
) {
  const privateState = privateStateFor(facade);
  const { signal } = signalOptions(options);
  return guardedRequest(privateState, "/storage", "GET", personalExtensionCoordinationRevisionedStorageResponseSchema, {
    signal,
    holderSessionId: privateState.holderSessionId ?? undefined,
  });
}

async function disposePrivateState(privateState: FacadePrivateState) {
  if (privateState.cleanupPromise) return privateState.cleanupPromise;
  privateState.accepting = false;
  privateState.disposed = true;
  if (privateState.eventHub) stopCoordinationEventHub(privateState.eventHub);
  const authority = privateState.authority;
  const activeOperations: { head: CleanupOperationNode | null } = { head: null };
  setForEach(privateState.operations, (capability) => {
    const operation = operationPrivateGet(capability);
    if (!operation?.active) return;
    operation.active = false;
    operationPrivateDelete(capability);
    activeOperations.head = { operationHandle: operation.operationHandle, next: activeOperations.head };
  });
  setClear(privateState.operations);

  privateState.cleanupPromise = (async () => {
    if (!authority) return;
    let operation = activeOperations.head;
    while (operation) {
      try {
        const body = operationAuthorityBody(authority, operation.operationHandle);
        body.disposition = "aborted";
        await guardedRequest(
          privateState,
          "/operations/end",
          "POST",
          personalExtensionCoordinationOperationEndResponseSchema,
          { body, holderSessionId: authority.holderSessionId, timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS },
        );
      } catch {
        // The server deadline and fence remain the final authority boundary.
      }
      operation = operation.next;
    }
    try {
      const body = authorityBody(authority);
      await guardedRequest(privateState, "/lease/release", "POST", personalExtensionCoordinationReleaseResponseSchema, {
        body,
        holderSessionId: authority.holderSessionId,
      });
    } catch {
      // Cleanup is best-effort; expiry/fencing closes a lost response safely.
    } finally {
      privateState.authority = null;
      privateState.holderSessionId = null;
    }
  })();
  return privateState.cleanupPromise;
}

export function issuePersonalExtensionCoordinationFacade(options: {
  runtimeEpoch: object;
  extensionId: string;
  contentHash: string;
}): {
  facade: PersonalExtensionCoordinationFacade;
  beginCleanup(): void;
  cleanup(): Promise<void>;
} {
  if (
    !options.runtimeEpoch ||
    (typeof options.runtimeEpoch !== "object" && typeof options.runtimeEpoch !== "function")
  ) {
    fail("invalid-request");
  }
  if (issuedRuntimeEpochHas(options.runtimeEpoch)) fail("invalid-request");
  let extensionId: string;
  let contentHash: string;
  try {
    extensionId = personalExtensionCoordinationExtensionIdSchema.parse(options.extensionId);
    contentHash = personalExtensionCoordinationContentHashSchema.parse(options.contentHash);
  } catch {
    fail("invalid-request");
  }
  issuedRuntimeEpochAdd(options.runtimeEpoch);
  const deviceSessionId = getDeviceSessionId();

  const storage = {
    get: (requestOptions?: PersonalExtensionCoordinationSignalOptions) => getRevisionedStorage(facade, requestOptions),
  };
  const lorebooks = {
    list: (requestOptions?: PersonalExtensionCoordinationSignalOptions) => listLorebooks(facade, requestOptions),
    get: (input: PersonalExtensionCoordinationLorebookIdInput) => getLorebook(facade, input),
    listEntries: (input: PersonalExtensionCoordinationLorebookIdInput) => listLorebookEntries(facade, input),
    getEntry: (input: PersonalExtensionCoordinationLorebookEntryIdInput) => getLorebookEntry(facade, input),
  };
  const events = {
    subscribe: (
      listener: PersonalExtensionCoordinationEventListener,
      requestOptions?: PersonalExtensionCoordinationSignalOptions,
    ) => subscribeToCoordinationEvents(facade, listener, requestOptions),
  };
  const facade: PersonalExtensionCoordinationFacade = deepFreeze({
    version: 1 as const,
    deviceSessionId,
    state: (requestOptions?: PersonalExtensionCoordinationSignalOptions) => getState(facade, requestOptions),
    acquire: (requestOptions?: PersonalExtensionCoordinationSignalOptions) => acquireLease(facade, requestOptions),
    renew: (requestOptions?: PersonalExtensionCoordinationSignalOptions) => renewLease(facade, requestOptions),
    requestHandoff: (requestOptions?: PersonalExtensionCoordinationSignalOptions) =>
      requestHandoff(facade, requestOptions),
    release: (requestOptions?: PersonalExtensionCoordinationReleaseOptions) => releaseLease(facade, requestOptions),
    events,
    signalDirty: (input: PersonalExtensionCoordinationDirtyInput) => signalDirty(facade, input),
    storage,
    lorebooks,
    beginOperation: (input: PersonalExtensionCoordinationOperationInput) => beginOperation(facade, input),
  });
  const privateState: FacadePrivateState = {
    extensionId,
    contentHash,
    deviceSessionId,
    holderSessionId: null,
    authority: null,
    operations: new CapturedSet(),
    eventHub: null,
    lorebookRevisions: objectCreate(null) as Record<string, number>,
    accepting: true,
    disposed: false,
    cleanupPromise: null,
  };
  facadePrivateSet(facade, privateState);

  return deepFreeze({
    facade,
    beginCleanup() {
      privateState.accepting = false;
      if (privateState.eventHub) stopCoordinationEventHub(privateState.eventHub);
    },
    cleanup: () => disposePrivateState(privateState),
  });
}
