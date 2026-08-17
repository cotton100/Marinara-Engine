import { useEffect } from "react";
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  type PersonalClientExtensionRuntime,
  type PersonalExtensionCharacterSnapshot,
  type PersonalExtensionContextSnapshot,
  type PersonalExtensionPersonaSnapshot,
} from "@marinara-engine/shared";
import { usePersonalExtensionRuntime } from "../../hooks/use-personal-extensions";
import {
  createPersonalExtensionContextSnapshot,
  personalExtensionContextKey,
} from "../../lib/personal-extension-context";
import {
  registerPersonalExtensionContribution,
  removePersonalExtensionContribution,
  removePersonalExtensionContributions,
  setPersonalExtensionContributionDispatcher,
} from "../../lib/personal-extension-contributions";
import {
  issuePersonalExtensionCoordinationFacade,
  type PersonalExtensionCoordinationFacade,
} from "../../lib/personal-extension-coordination-facade";
import { useChatStore } from "../../stores/chat.store";

// This module is evaluated before any approved full-page extension starts.
// Keep the primitives which protect host-only runtime records as lexical
// captures: a previously started full-page extension may replace page globals
// and collection prototypes, but it must not be able to observe a later
// extension's coordination facade through those replacements.
const pristineObjectFreeze = Object.freeze.bind(Object);
const pristineReflectApply = Reflect.apply;
const pristineEncodeURIComponent = globalThis.encodeURIComponent;
const CapturedMap = Map;
const CapturedSet = Set;
const CapturedWeakMap = WeakMap;
const pristineMapGet = Map.prototype.get;
const pristineMapSet = Map.prototype.set;
const pristineMapDelete = Map.prototype.delete;
const pristineMapForEach = Map.prototype.forEach;
const pristineSetAdd = Set.prototype.add;
const pristineSetDelete = Set.prototype.delete;
const pristineSetForEach = Set.prototype.forEach;
const pristineWeakMapGet = WeakMap.prototype.get;
const pristineWeakMapSet = WeakMap.prototype.set;
const pristineWeakMapDelete = WeakMap.prototype.delete;

function hostMapGet<K, V>(map: Map<K, V>, key: K) {
  return pristineReflectApply(pristineMapGet, map, [key]) as V | undefined;
}

function hostMapSet<K, V>(map: Map<K, V>, key: K, value: V) {
  pristineReflectApply(pristineMapSet, map, [key, value]);
}

function hostMapDelete<K, V>(map: Map<K, V>, key: K) {
  return pristineReflectApply(pristineMapDelete, map, [key]) as boolean;
}

function hostMapForEach<K, V>(map: Map<K, V>, callback: (value: V, key: K) => void) {
  pristineReflectApply(pristineMapForEach, map, [
    (value: V, key: K) => {
      callback(value, key);
    },
  ]);
}

function hostWeakMapGet<K extends object, V>(map: WeakMap<K, V>, key: K) {
  return pristineReflectApply(pristineWeakMapGet, map, [key]) as V | undefined;
}

function hostWeakMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V) {
  pristineReflectApply(pristineWeakMapSet, map, [key, value]);
}

function hostWeakMapDelete<K extends object, V>(map: WeakMap<K, V>, key: K) {
  pristineReflectApply(pristineWeakMapDelete, map, [key]);
}

function hostSetAdd<T>(set: Set<T>, value: T) {
  pristineReflectApply(pristineSetAdd, set, [value]);
}

function hostSetDelete<T>(set: Set<T>, value: T) {
  pristineReflectApply(pristineSetDelete, set, [value]);
}

function hostSetForEach<T>(set: Set<T>, callback: (value: T) => void) {
  pristineReflectApply(pristineSetForEach, set, [
    (value: T) => {
      callback(value);
    },
  ]);
}

type ActiveClientExtension = {
  contentHash: string;
  extension: PersonalClientExtensionRuntime;
  iframe: HTMLIFrameElement;
};

type FullPageExtensionIdentity = {
  id: string;
  name: string;
  contentHash: string;
};

type FullPageExtensionApi = {
  version: 1;
  extension: Readonly<FullPageExtensionIdentity>;
  coordination: PersonalExtensionCoordinationFacade;
  log: Readonly<Pick<Console, "debug" | "info" | "warn" | "error">>;
  storage: Readonly<{
    get: () => Promise<Record<string, unknown>>;
    patch: (value: Record<string, unknown>) => Promise<Record<string, unknown>>;
    clear: () => Promise<void>;
  }>;
  setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => number;
  clearTimeout: (timerId: number) => void;
  setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => number;
  clearInterval: (timerId: number) => void;
  onCleanup: (cleanup: () => unknown) => void;
};

type ActiveFullPageExtension = {
  identity: Readonly<FullPageExtensionIdentity>;
  style: HTMLLinkElement | null;
  started: boolean;
  cleanupHead: FullPageCleanupNode | null;
  timeoutIds: Set<number>;
  intervalIds: Set<number>;
};

type FullPageCleanupNode = {
  cleanup: () => unknown;
  next: FullPageCleanupNode | null;
};

type FullPageExtensionModule = {
  extensionId?: unknown;
  contentHash?: unknown;
  default?: unknown;
};

type ExpectedClientExtension = Readonly<{
  executionMode: PersonalClientExtensionRuntime["executionMode"];
  contentHash: string;
}>;

function snapshotFullPageIdentity(extension: PersonalClientExtensionRuntime) {
  try {
    const id = extension.id;
    const name = extension.name;
    const contentHash = extension.contentHash;
    if (typeof id !== "string" || typeof name !== "string" || typeof contentHash !== "string") return null;
    return pristineObjectFreeze({ id, name, contentHash });
  } catch {
    return null;
  }
}

export function approvedFullPageRuntimeUrl(identity: Readonly<FullPageExtensionIdentity>) {
  return `/api/personal-extensions/${pristineEncodeURIComponent(identity.id)}/page-runtime.js?hash=${pristineEncodeURIComponent(identity.contentHash)}`;
}

function approvedFullPageStyleUrl(identity: Readonly<FullPageExtensionIdentity>) {
  return `/api/personal-extensions/${pristineEncodeURIComponent(identity.id)}/page-style.css?hash=${pristineEncodeURIComponent(identity.contentHash)}`;
}

type SandboxMessage = {
  channel?: string;
  type?:
    | "ready"
    | "error"
    | "log"
    | "storage"
    | "ui-window-open"
    | "ui-window-close"
    | "ui-resize"
    | "ui-contribution-register"
    | "ui-contribution-update"
    | "ui-contribution-remove";
  contentHash?: string;
  requestId?: string;
  action?: "get" | "patch" | "delete";
  payload?: unknown;
  contribution?: unknown;
  contributionId?: unknown;
  level?: "debug" | "info" | "warn" | "error";
  args?: unknown[];
  message?: string;
  width?: number;
  height?: number;
};

// The sandbox iframe is a hidden 0×0 element until the extension opens a
// window; then it becomes a small floating panel docked bottom-right. It never
// covers Marinara's page — the rest of the app stays visible and interactive.
function setSandboxIframeHidden(iframe: HTMLIFrameElement) {
  iframe.hidden = true;
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.removeAttribute("style");
}

function sizeSandboxPanel(iframe: HTMLIFrameElement, width?: number, height?: number) {
  const maxW = Math.max(240, Math.min(window.innerWidth - 32, 420));
  const maxH = Math.round(window.innerHeight * 0.7);
  const w = Math.max(240, Math.min(typeof width === "number" ? width : 340, maxW));
  const h = Math.max(80, Math.min(typeof height === "number" ? height : 240, maxH));
  iframe.hidden = false;
  iframe.removeAttribute("aria-hidden");
  iframe.tabIndex = 0;
  Object.assign(iframe.style, {
    position: "fixed",
    right: "1rem",
    bottom: "1rem",
    top: "auto",
    left: "auto",
    width: `${w}px`,
    height: `${h}px`,
    maxWidth: "calc(100vw - 2rem)",
    maxHeight: "70vh",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
    background: "transparent",
    overflow: "hidden",
    zIndex: "2147483000",
    colorScheme: "normal",
  });
}

// Forward Marinara's resolved accent/surface colors so the in-iframe window
// matches the current theme. Only color strings cross the boundary.
function postSandboxTheme(iframe: HTMLIFrameElement) {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  iframe.contentWindow?.postMessage(
    {
      channel: "marinara-personal-extension",
      type: "ui-theme",
      theme: {
        accent: read("--primary", "#a855f7"),
        accentText: read("--primary-foreground", "#ffffff"),
        surface: read("--card", "#18181b"),
        text: read("--foreground", "#f4f4f5"),
        border: read("--border", "rgba(127,127,127,0.35)"),
        muted: read("--secondary", "rgba(127,127,127,0.15)"),
      },
    },
    "*",
  );
}

function readPersonalExtensionContext(): PersonalExtensionContextSnapshot {
  const { activeChatId, activeChat } = useChatStore.getState();
  const characterIds = activeChatId && activeChat?.id === activeChatId ? activeChat.characterIds : [];
  const personaId = activeChatId && activeChat?.id === activeChatId ? activeChat.personaId : null;
  return createPersonalExtensionContextSnapshot(activeChatId, characterIds, personaId);
}

function sendSandboxContext(active: ActiveClientExtension, context: PersonalExtensionContextSnapshot) {
  const canReadPersona = active.extension.capabilities.includes("read_active_persona");
  active.iframe.contentWindow?.postMessage(
    {
      channel: "marinara-personal-extension",
      type: "context-update",
      contentHash: active.contentHash,
      context: {
        ...context,
        personaId: canReadPersona ? context.personaId : null,
        persona: canReadPersona ? context.persona : null,
      },
    },
    "*",
  );
}

async function postSandboxContext(active: ActiveClientExtension, context = readPersonalExtensionContext()) {
  sendSandboxContext(active, context);
  if (
    !context.chatId ||
    !active.extension.capabilities.some(
      (capability) => capability === "read_active_characters" || capability === "read_active_persona",
    )
  ) {
    return;
  }
  try {
    const response = await extensionFetch(active.extension.id, "context", {
      method: "POST",
      body: JSON.stringify({ chatId: context.chatId }),
    });
    if (!response.ok) throw new Error(`Context read failed (${response.status})`);
    const records = (await response.json()) as {
      characters?: PersonalExtensionCharacterSnapshot[];
      persona?: PersonalExtensionPersonaSnapshot | null;
    };
    if (
      activeExtensions.get(active.extension.id) !== active ||
      personalExtensionContextKey(readPersonalExtensionContext()) !== personalExtensionContextKey(context)
    ) {
      return;
    }
    sendSandboxContext(active, {
      ...context,
      characters: Array.isArray(records.characters) ? records.characters : [],
      persona: records.persona && typeof records.persona === "object" ? records.persona : null,
    });
  } catch (error) {
    console.warn(`[Personal Extension ${active.extension.name}] active record context could not be loaded`, error);
  }
}

const activeExtensions = new Map<string, ActiveClientExtension>();
const activeFullPageExtensions = new Map<string, ActiveFullPageExtension>();
const fullPageCoordination = new CapturedWeakMap<
  ActiveFullPageExtension,
  ReturnType<typeof issuePersonalExtensionCoordinationFacade>
>();

function extensionFetch(id: string, path: string, init: RequestInit = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  return fetch(`/api/personal-extensions/${encodeURIComponent(id)}/${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}

async function cleanupExtension(id: string) {
  const active = hostMapGet(activeExtensions, id);
  hostMapDelete(activeExtensions, id);
  removePersonalExtensionContributions(id);
  if (active) {
    active.iframe.contentWindow?.postMessage({ channel: "marinara-personal-extension", type: "stop" }, "*");
    active.iframe.remove();
  }

  const fullPage = hostMapGet(activeFullPageExtensions, id);
  hostMapDelete(activeFullPageExtensions, id);
  if (!fullPage) return;
  const coordination = hostWeakMapGet(fullPageCoordination, fullPage);
  hostWeakMapDelete(fullPageCoordination, fullPage);
  if (coordination) {
    try {
      coordination.beginCleanup();
    } catch (error) {
      console.warn(`[Personal Extension ${fullPage.identity.name}] cleanup start failed`, error);
    }
  }
  fullPage.style?.remove();
  hostSetForEach(fullPage.timeoutIds, (timerId) => window.clearTimeout(timerId));
  hostSetForEach(fullPage.intervalIds, (timerId) => window.clearInterval(timerId));
  let cleanupNode = fullPage.cleanupHead;
  fullPage.cleanupHead = null;
  while (cleanupNode) {
    const cleanup = cleanupNode.cleanup;
    try {
      await cleanup();
    } catch (error) {
      console.warn(`[Personal Extension ${fullPage.identity.name}] cleanup failed`, error);
    }
    cleanupNode = cleanupNode.next;
  }
  if (coordination) {
    try {
      await coordination.cleanup();
    } catch (error) {
      console.warn(`[Personal Extension ${fullPage.identity.name}] host cleanup failed`, error);
    }
  }
  window.dispatchEvent(
    new CustomEvent("marinara-personal-extension-stopped", {
      detail: { id: fullPage.identity.id, contentHash: fullPage.identity.contentHash },
    }),
  );
}

const STORAGE_ACTIONS = new Set<SandboxMessage["action"]>(["get", "patch", "delete"]);
const LOG_LEVELS = new Set<NonNullable<SandboxMessage["level"]>>(["debug", "info", "warn", "error"]);

function createFullPageExtensionApi(active: ActiveFullPageExtension): FullPageExtensionApi {
  const coordination = issuePersonalExtensionCoordinationFacade({
    runtimeEpoch: pristineObjectFreeze({}),
    extensionId: active.identity.id,
    contentHash: active.identity.contentHash,
  });
  hostWeakMapSet(fullPageCoordination, active, coordination);
  const extension = pristineObjectFreeze({
    id: active.identity.id,
    name: active.identity.name,
    contentHash: active.identity.contentHash,
  });
  const storage = pristineObjectFreeze({
    async get() {
      const response = await extensionFetch(active.identity.id, "storage");
      if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
      return ((await response.json()) as { value?: Record<string, unknown> }).value ?? {};
    },
    async patch(value: Record<string, unknown>) {
      const response = await extensionFetch(active.identity.id, "storage", {
        method: "PATCH",
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error(`Storage update failed (${response.status})`);
      return ((await response.json()) as { value?: Record<string, unknown> }).value ?? {};
    },
    async clear() {
      const response = await extensionFetch(active.identity.id, "storage", { method: "DELETE" });
      if (!response.ok) throw new Error(`Storage clear failed (${response.status})`);
    },
  });
  const api: FullPageExtensionApi = {
    version: 1,
    extension,
    coordination: coordination.facade,
    log: pristineObjectFreeze({
      debug: console.debug.bind(console, `[Personal Extension ${active.identity.name}]`),
      info: console.info.bind(console, `[Personal Extension ${active.identity.name}]`),
      warn: console.warn.bind(console, `[Personal Extension ${active.identity.name}]`),
      error: console.error.bind(console, `[Personal Extension ${active.identity.name}]`),
    }),
    storage,
    setTimeout(callback, delay, ...args) {
      const timerId = window.setTimeout(() => {
        hostSetDelete(active.timeoutIds, timerId);
        callback(...args);
      }, delay);
      hostSetAdd(active.timeoutIds, timerId);
      return timerId;
    },
    clearTimeout(timerId) {
      hostSetDelete(active.timeoutIds, timerId);
      window.clearTimeout(timerId);
    },
    setInterval(callback, delay, ...args) {
      const timerId = window.setInterval(callback, delay, ...args);
      hostSetAdd(active.intervalIds, timerId);
      return timerId;
    },
    clearInterval(timerId) {
      hostSetDelete(active.intervalIds, timerId);
      window.clearInterval(timerId);
    },
    onCleanup(cleanup) {
      if (typeof cleanup !== "function") throw new TypeError("onCleanup requires a function");
      active.cleanupHead = { cleanup, next: active.cleanupHead };
    },
  };
  return pristineObjectFreeze(api);
}

async function handleStorage(active: ActiveClientExtension, message: SandboxMessage) {
  // Never infer DELETE from an unknown action: a malformed message must be
  // rejected, not silently mapped onto a destructive request.
  if (!message.requestId || !STORAGE_ACTIONS.has(message.action)) {
    active.iframe.contentWindow?.postMessage(
      {
        channel: "marinara-personal-extension",
        type: "storage-result",
        requestId: message.requestId,
        ok: false,
        error: "Storage request was rejected by the host",
      },
      "*",
    );
    return;
  }
  try {
    let value: Record<string, unknown> = {};
    if (message.action === "get") {
      const response = await extensionFetch(active.extension.id, "storage");
      if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
      value = ((await response.json()) as { value?: Record<string, unknown> }).value ?? {};
    } else if (message.action === "patch") {
      const response = await extensionFetch(active.extension.id, "storage", {
        method: "PATCH",
        body: JSON.stringify(message.payload ?? {}),
      });
      if (!response.ok) throw new Error(`Storage update failed (${response.status})`);
      value = ((await response.json()) as { value?: Record<string, unknown> }).value ?? {};
    } else {
      const response = await extensionFetch(active.extension.id, "storage", { method: "DELETE" });
      if (!response.ok) throw new Error(`Storage delete failed (${response.status})`);
    }
    active.iframe.contentWindow?.postMessage(
      {
        channel: "marinara-personal-extension",
        type: "storage-result",
        requestId: message.requestId,
        ok: true,
        value,
      },
      "*",
    );
  } catch (error) {
    active.iframe.contentWindow?.postMessage(
      {
        channel: "marinara-personal-extension",
        type: "storage-result",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      "*",
    );
  }
}

type FullPageModuleLoadOptions<Api> = Readonly<{
  runtimeUrl: string;
  identity: Readonly<FullPageExtensionIdentity>;
  isCurrent: () => boolean;
  createApi: () => Api;
  registerCleanup: (cleanup: () => unknown) => void;
  onLateCleanupError: (error: unknown) => void;
}>;

// Dynamic import keeps the runtime's `main` binding and the API handoff inside
// this host module. Unlike the retired window dispatcher, no earlier
// full-page extension can wrap a public property and receive a later API.
export async function loadApprovedFullPageExtensionModule<Api>(options: FullPageModuleLoadOptions<Api>) {
  let runtime: FullPageExtensionModule;
  try {
    runtime = (await import(/* @vite-ignore */ options.runtimeUrl)) as FullPageExtensionModule;
  } catch (error) {
    if (!options.isCurrent()) return false;
    throw new Error("Full-page extension runtime could not be loaded", { cause: error });
  }
  if (!options.isCurrent()) return false;

  const main = runtime.default;
  if (
    runtime.extensionId !== options.identity.id ||
    runtime.contentHash !== options.identity.contentHash ||
    typeof main !== "function"
  ) {
    throw new Error("Full-page extension identity did not match the approved runtime");
  }

  // There is deliberately no await or page-visible intermediary between the
  // last stale check, API issuance, and the lexical module call.
  if (!options.isCurrent()) return false;
  const cleanup = await (main as (api: Api) => unknown)(options.createApi());
  const stale = !options.isCurrent();
  if (typeof cleanup === "function") {
    if (stale) {
      try {
        await cleanup();
      } catch (error) {
        options.onLateCleanupError(error);
      }
    } else {
      options.registerCleanup(cleanup as () => unknown);
    }
  }
  return !stale;
}

async function startFullPageExtension(active: ActiveFullPageExtension) {
  if (active.started) throw new Error("Full-page extension runtime was already started");
  active.started = true;
  const identity = active.identity;
  try {
    const ready = await loadApprovedFullPageExtensionModule({
      runtimeUrl: approvedFullPageRuntimeUrl(identity),
      identity,
      isCurrent: () => hostMapGet(activeFullPageExtensions, identity.id) === active,
      createApi: () => createFullPageExtensionApi(active),
      registerCleanup: (cleanup) => {
        active.cleanupHead = { cleanup, next: active.cleanupHead };
      },
      onLateCleanupError: (error) => {
        console.warn(`[Personal Extension ${identity.name}] late cleanup failed`, error);
      },
    });
    if (!ready) return;
    window.dispatchEvent(
      new CustomEvent("marinara-personal-extension-ready", {
        detail: { id: identity.id, contentHash: identity.contentHash },
      }),
    );
  } catch (error) {
    const current = hostMapGet(activeFullPageExtensions, identity.id) === active;
    if (!current) return;
    console.error(`[Personal Extension ${identity.name}] failed`, error);
    await cleanupExtension(identity.id);
    window.dispatchEvent(
      new CustomEvent("marinara-personal-extension-error", {
        detail: {
          id: identity.id,
          contentHash: identity.contentHash,
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );
  }
}

export function PersonalExtensionInjector() {
  const { data: extensions = [] } = usePersonalExtensionRuntime();

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const active = [...activeExtensions.values()].find(
        (candidate) => candidate.iframe.contentWindow === event.source,
      );
      if (!active || event.origin !== "null") return;
      const message = event.data as SandboxMessage;
      if (!message || message.channel !== "marinara-personal-extension") return;
      if (
        (message.type === "ui-contribution-register" || message.type === "ui-contribution-update") &&
        message.contentHash === active.contentHash
      ) {
        registerPersonalExtensionContribution(active.extension, message.contribution);
        return;
      }
      if (message.type === "ui-contribution-remove" && message.contentHash === active.contentHash) {
        removePersonalExtensionContribution(active.extension.id, active.contentHash, message.contributionId);
        return;
      }
      if (message.type === "storage") {
        void handleStorage(active, message);
        return;
      }
      if (message.type === "ui-window-open") {
        sizeSandboxPanel(active.iframe, message.width, message.height);
        postSandboxTheme(active.iframe);
        return;
      }
      if (message.type === "ui-resize") {
        if (!active.iframe.hidden) sizeSandboxPanel(active.iframe, message.width, message.height);
        return;
      }
      if (message.type === "ui-window-close") {
        setSandboxIframeHidden(active.iframe);
        return;
      }
      if (message.type === "log" && LOG_LEVELS.has(message.level as NonNullable<SandboxMessage["level"]>)) {
        const args = Array.isArray(message.args) ? message.args : [];
        console[message.level as NonNullable<SandboxMessage["level"]>](
          `[Personal Extension ${active.extension.name}]`,
          ...args,
        );
        return;
      }
      if (message.type === "ready" && message.contentHash === active.contentHash) {
        window.dispatchEvent(
          new CustomEvent("marinara-personal-extension-ready", {
            detail: { id: active.extension.id, contentHash: active.contentHash },
          }),
        );
        return;
      }
      if (message.type === "error") {
        console.error(`[Personal Extension ${active.extension.name}] failed`, message.message);
        window.dispatchEvent(
          new CustomEvent("marinara-personal-extension-error", {
            detail: {
              id: active.extension.id,
              contentHash: active.contentHash,
              message: message.message ?? "Sandboxed browser extension failed",
            },
          }),
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    let previousContextKey = personalExtensionContextKey(readPersonalExtensionContext());
    return useChatStore.subscribe(() => {
      const context = readPersonalExtensionContext();
      const nextContextKey = personalExtensionContextKey(context);
      if (nextContextKey === previousContextKey) return;
      previousContextKey = nextContextKey;
      for (const active of activeExtensions.values()) void postSandboxContext(active, context);
    });
  }, []);

  useEffect(() => {
    const expected = new CapturedMap<string, ExpectedClientExtension>();
    for (let index = 0; index < extensions.length; index += 1) {
      const extension = extensions[index]!;
      try {
        const id = extension.id;
        const executionMode = extension.executionMode;
        const contentHash = extension.contentHash;
        if (
          typeof id !== "string" ||
          (executionMode !== "full-page" && executionMode !== "sandboxed") ||
          typeof contentHash !== "string"
        ) {
          continue;
        }
        hostMapSet(expected, id, pristineObjectFreeze({ executionMode, contentHash }));
      } catch {
        // A malformed or accessor-backed runtime record is never executable.
      }
    }
    for (const [id, active] of activeExtensions) {
      const next = hostMapGet(expected, id);
      if (!next || next.executionMode !== "sandboxed" || next.contentHash !== active.contentHash) {
        void cleanupExtension(id);
      }
    }
    hostMapForEach(activeFullPageExtensions, (active, id) => {
      const next = hostMapGet(expected, id);
      if (!next || next.executionMode !== "full-page" || next.contentHash !== active.identity.contentHash) {
        void cleanupExtension(id);
      }
    });

    for (let index = 0; index < extensions.length; index += 1) {
      const extension = extensions[index]!;
      let executionMode: PersonalClientExtensionRuntime["executionMode"];
      try {
        executionMode = extension.executionMode;
      } catch {
        continue;
      }
      if (executionMode === "full-page") {
        const identity = snapshotFullPageIdentity(extension);
        if (!identity) continue;
        const active = hostMapGet(activeFullPageExtensions, identity.id);
        if (active?.identity.contentHash === identity.contentHash && active.identity.name === identity.name) {
          continue;
        }
        if (active) void cleanupExtension(identity.id);
        let includeStyle = false;
        try {
          includeStyle = Boolean(extension.styleUrl);
        } catch {
          continue;
        }
        const style = includeStyle ? document.createElement("link") : null;
        if (style) {
          style.rel = "stylesheet";
          style.href = approvedFullPageStyleUrl(identity);
          style.dataset.personalExtensionFullPageStyle = identity.id;
          document.head.appendChild(style);
        }
        const nextActive: ActiveFullPageExtension = {
          identity,
          style,
          started: false,
          cleanupHead: null,
          timeoutIds: new CapturedSet(),
          intervalIds: new CapturedSet(),
        };
        hostMapSet(activeFullPageExtensions, identity.id, nextActive);
        void startFullPageExtension(nextActive);
        continue;
      }
      const active = activeExtensions.get(extension.id);
      if (active?.contentHash === extension.contentHash) continue;
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("aria-hidden", "true");
      iframe.tabIndex = -1;
      iframe.hidden = true;
      iframe.src = extension.runtimeUrl;
      iframe.dataset.personalExtensionSandbox = extension.id;
      iframe.referrerPolicy = "no-referrer";
      const nextActive = {
        contentHash: extension.contentHash,
        extension,
        iframe,
      };
      activeExtensions.set(extension.id, nextActive);
      iframe.addEventListener("load", () => void postSandboxContext(nextActive), { once: true });
      document.body.appendChild(iframe);
      setPersonalExtensionContributionDispatcher(extension, (message) => {
        iframe.contentWindow?.postMessage({ channel: "marinara-personal-extension", ...message }, "*");
      });
    }
  }, [extensions]);

  useEffect(
    () => () => {
      hostMapForEach(activeFullPageExtensions, (_active, id) => void cleanupExtension(id));
      for (const id of activeExtensions.keys()) void cleanupExtension(id);
    },
    [],
  );

  return null;
}
