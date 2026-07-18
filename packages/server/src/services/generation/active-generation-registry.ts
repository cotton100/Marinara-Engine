export type ActiveGenerationRecord = {
  abortController: AbortController;
  backendUrl: string | null;
  purpose: "generation" | "mutation" | "deletion";
};

export type ActiveGenerationRegistry = Map<string, ActiveGenerationRecord>;

export type ActiveGenerationLease = {
  abortController: AbortController;
  setBackendUrl(value: string | null): boolean;
  release(): boolean;
};

export type ActiveGenerationGroupLease = {
  chatIds: readonly string[];
  release(): boolean;
};

export function createActiveGenerationRegistry(): ActiveGenerationRegistry {
  return new Map<string, ActiveGenerationRecord>();
}

export function requireActiveGenerationRegistry(host: { activeGenerations?: unknown }): ActiveGenerationRegistry {
  if (!(host.activeGenerations instanceof Map)) {
    throw new Error("Active generation registry is not initialized on the shared route parent");
  }
  return host.activeGenerations as ActiveGenerationRegistry;
}

export function acquireActiveGenerationLease(
  registry: ActiveGenerationRegistry,
  chatId: string,
  abortController = new AbortController(),
): ActiveGenerationLease | null {
  return acquireOwnedLease(registry, chatId, "generation", abortController);
}

export function acquireChatMutationLease(
  registry: ActiveGenerationRegistry,
  chatId: string,
  abortController = new AbortController(),
): ActiveGenerationLease | null {
  return acquireOwnedLease(registry, chatId, "mutation", abortController);
}

function acquireOwnedLease(
  registry: ActiveGenerationRegistry,
  chatId: string,
  purpose: "generation" | "mutation",
  abortController: AbortController,
): ActiveGenerationLease | null {
  if (registry.has(chatId)) return null;
  registry.set(chatId, { abortController, backendUrl: null, purpose });

  return createOwnedLease(registry, chatId, abortController);
}

function createOwnedLease(
  registry: ActiveGenerationRegistry,
  chatId: string,
  abortController: AbortController,
): ActiveGenerationLease {
  return {
    abortController,
    setBackendUrl: (backendUrl) => {
      const current = registry.get(chatId);
      if (current?.abortController !== abortController) return false;
      registry.set(chatId, { ...current, backendUrl });
      return true;
    },
    release: () => {
      const current = registry.get(chatId);
      if (current?.abortController !== abortController) return false;
      registry.delete(chatId);
      return true;
    },
  };
}

/**
 * Abort an in-flight generation and atomically replace its ownership with a
 * deletion tombstone. The tombstone stays registered until its lease owner
 * releases it after durable chat removal, so the displaced generation's late
 * finally block cannot reopen the same-chat generation slot.
 */
export function takeOverActiveGenerationLease(
  registry: ActiveGenerationRegistry,
  chatId: string,
  abortController = new AbortController(),
): ActiveGenerationLease | null {
  const current = registry.get(chatId);
  if (current?.purpose === "deletion" || current?.purpose === "mutation") return null;

  current?.abortController.abort();
  registry.set(chatId, { abortController, backendUrl: null, purpose: "deletion" });
  return createOwnedLease(registry, chatId, abortController);
}

/**
 * Atomically take deletion ownership of every chat in a stable group snapshot.
 * The preflight is deliberately synchronous: if any member already has a
 * deletion tombstone, no existing generation is aborted and the registry is
 * left untouched.
 */
export function takeOverActiveGenerationLeases(
  registry: ActiveGenerationRegistry,
  chatIds: readonly string[],
): ActiveGenerationGroupLease | null {
  const canonicalChatIds = Array.from(new Set(chatIds.filter(Boolean))).sort();
  if (
    canonicalChatIds.some((chatId) => {
      const purpose = registry.get(chatId)?.purpose;
      return purpose === "deletion" || purpose === "mutation";
    })
  ) {
    return null;
  }

  const owners = canonicalChatIds.map((chatId) => ({ chatId, abortController: new AbortController() }));
  for (const owner of owners) {
    registry.get(owner.chatId)?.abortController.abort();
    registry.set(owner.chatId, {
      abortController: owner.abortController,
      backendUrl: null,
      purpose: "deletion",
    });
  }

  return {
    chatIds: canonicalChatIds,
    release: () => {
      let releasedAll = true;
      for (const owner of owners) {
        const current = registry.get(owner.chatId);
        if (current?.abortController !== owner.abortController || current.purpose !== "deletion") {
          releasedAll = false;
          continue;
        }
        registry.delete(owner.chatId);
      }
      return releasedAll;
    },
  };
}

export type MessageMutationLeaseResult<TMessage extends { chatId: string }> =
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "ready"; lease: ActiveGenerationLease; message: TMessage };

export async function acquireMessageMutationLease<TMessage extends { chatId: string }>(
  registry: ActiveGenerationRegistry,
  requestedChatId: string,
  messageId: string,
  getMessage: (messageId: string) => Promise<TMessage | null | undefined>,
): Promise<MessageMutationLeaseResult<TMessage>> {
  const message = await getMessage(messageId);
  if (!message || message.chatId !== requestedChatId) return { kind: "not_found" };

  const lease = acquireChatMutationLease(registry, message.chatId);
  if (!lease) return { kind: "busy" };
  return { kind: "ready", lease, message };
}
