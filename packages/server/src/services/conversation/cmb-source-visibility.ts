import { hasActiveCmbCompression } from "../lorebook/cmb-compression-retrieval.js";

export type CmbSourceRestriction = {
  chatId: string;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
};

type CmbSourceEntry = {
  id: string;
  enabled: string;
  characterFilterMode: string;
  characterFilterIds: string;
  dynamicState: string;
};

type CmbSourceEnsemble = {
  ensembleId: string;
  rpChatId: string;
  groupConvoChatIds: string[];
  members: Array<{ castId: string; characterId: string; dmChatId: string }>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(value: string): unknown {
  if (typeof value !== "string" || value.length > 1_000_000) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stableString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64 || !value.every(stableString)) return null;
  return new Set(value).size === value.length ? value : null;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Read only managed-entry metadata, never memory content or vectors. null means coverage cannot be trusted. */
export function resolveCmbSourceRestrictions(
  entries: readonly CmbSourceEntry[],
  ensemble: CmbSourceEnsemble,
  audienceCharacterIds: readonly string[],
): CmbSourceRestriction[] | null {
  // Bound synchronous JSON work before parsing any row. A Promise timeout
  // cannot interrupt a large parse/loop on the generation event loop.
  if (entries.length > 2048) return null;
  let metadataChars = 0;
  for (const entry of entries) {
    if (typeof entry.dynamicState !== "string" || typeof entry.characterFilterIds !== "string") return null;
    metadataChars += entry.dynamicState.length + entry.characterFilterIds.length;
    if (metadataChars > 4 * 1024 * 1024) return null;
  }
  const membersByCast = new Map(ensemble.members.map((member) => [member.castId, member.characterId]));
  const memberIds = new Set(membersByCast.values());
  if (
    !stableString(ensemble.ensembleId) ||
    ensemble.members.length === 0 ||
    ensemble.members.length > 32 ||
    membersByCast.size !== ensemble.members.length ||
    memberIds.size !== ensemble.members.length ||
    ensemble.members.some((member) => !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(member.castId)) ||
    audienceCharacterIds.length === 0 ||
    audienceCharacterIds.some((id) => !memberIds.has(id))
  ) {
    return null;
  }
  const mappedRoles = new Map<string, string>([
    [ensemble.rpChatId, "rp"],
    ...ensemble.groupConvoChatIds.map((id) => [id, "group"] as const),
    ...ensemble.members.map((member) => [member.dmChatId, "dm"] as const),
  ]);
  if (
    mappedRoles.size !== 1 + ensemble.groupConvoChatIds.length + ensemble.members.length ||
    [...mappedRoles.keys(), ...memberIds].some((id) => !stableString(id))
  ) {
    return null;
  }

  const restrictions: CmbSourceRestriction[] = [];
  const entryIds = new Set<string>();
  for (const entry of entries) {
    const bridge = record(record(parseJson(entry.dynamicState))?.convoMemoryBridge);
    const filters = stringArray(parseJson(entry.characterFilterIds));
    const unknownTo = stringArray(bridge?.unknownToCastIds);
    if (
      !stableString(entry.id) ||
      entryIds.has(entry.id) ||
      (entry.enabled !== "true" && entry.enabled !== "false") ||
      !["any", "include", "exclude"].includes(entry.characterFilterMode) ||
      filters === null ||
      bridge?.schemaVersion !== 1 ||
      bridge.ensembleId !== ensemble.ensembleId ||
      unknownTo === null ||
      unknownTo.some((id) => !membersByCast.has(id)) ||
      !Array.isArray(bridge.rosterBindings) ||
      bridge.rosterBindings.length !== ensemble.members.length ||
      (bridge.ambiguousProvenance !== undefined && typeof bridge.ambiguousProvenance !== "boolean") ||
      (bridge.sourceStatus !== undefined && bridge.sourceStatus !== null && bridge.sourceStatus !== "missing")
    ) {
      return null;
    }
    entryIds.add(entry.id);
    const rosterCastIds = new Set<string>();
    for (const value of bridge.rosterBindings) {
      const binding = record(value);
      if (
        !binding ||
        !stableString(binding.castId) ||
        !stableString(binding.characterId) ||
        rosterCastIds.has(binding.castId) ||
        membersByCast.get(binding.castId) !== binding.characterId
      ) {
        return null;
      }
      rosterCastIds.add(binding.castId);
    }

    // Match the host lorebook filter's comparison keys without rewriting IDs.
    const filterIds = new Set(filters.map((id) => id.trim().toLowerCase()));
    const restricted =
      entry.enabled === "false" ||
      hasActiveCmbCompression(entry.dynamicState) ||
      unknownTo.some((id) => audienceCharacterIds.includes(membersByCast.get(id)!)) ||
      (filters.length > 0 &&
        audienceCharacterIds.some((id) =>
          entry.characterFilterMode === "include"
            ? !filterIds.has(id.trim().toLowerCase())
            : entry.characterFilterMode === "exclude" && filterIds.has(id.trim().toLowerCase()),
        ));
    const source = record(bridge.source);
    if (source?.kind === "manual") {
      if (
        Object.keys(source).length !== 3 ||
        !canonicalTimestamp(source.createdAt) ||
        !canonicalTimestamp(source.lastEditedAt) ||
        Date.parse(source.createdAt) > Date.parse(source.lastEditedAt) ||
        bridge.sourceStatus === "missing"
      ) {
        return null;
      }
      // A manual memory has no corresponding raw chat messages to restrict.
      continue;
    }
    if (
      source?.kind !== "native-memory-chunk" ||
      !canonicalTimestamp(source.firstMessageAt) ||
      !canonicalTimestamp(source.lastMessageAt) ||
      Date.parse(source.firstMessageAt) > Date.parse(source.lastMessageAt) ||
      !Array.isArray(source.occurrences) ||
      source.occurrences.length > 128
    ) {
      return null;
    }
    if (source.occurrences.length === 0) {
      if (bridge.sourceStatus !== "missing" || restricted) return null;
      continue;
    }
    if (bridge.sourceStatus === "missing") return null;
    const sourceIds = new Set<string>();
    for (const value of source.occurrences) {
      const occurrence = record(value);
      if (
        !occurrence ||
        !stableString(occurrence.chatId) ||
        typeof occurrence.chatRole !== "string" ||
        mappedRoles.get(occurrence.chatId) !== occurrence.chatRole
      ) {
        return null;
      }
      sourceIds.add(occurrence.chatId);
    }
    if (!restricted) continue;
    // A former ambiguous source with lost locators cannot safely identify all covered chats.
    if (bridge.ambiguousProvenance === true && sourceIds.size === 1) return null;
    for (const chatId of sourceIds) {
      if (mappedRoles.get(chatId) === "dm") continue;
      restrictions.push({
        chatId,
        // Multiple locators share one canonical time span, not a separate span for every copied source.
        firstMessageAt: sourceIds.size > 1 ? null : source.firstMessageAt,
        lastMessageAt: sourceIds.size > 1 ? null : source.lastMessageAt,
      });
    }
  }
  return restrictions;
}

export function isCmbSourceMessageRestricted(
  restrictions: readonly CmbSourceRestriction[],
  chatId: string,
  createdAt: string,
): boolean {
  return restrictions.some(
    (restriction) =>
      restriction.chatId === chatId &&
      (restriction.firstMessageAt === null ||
        restriction.lastMessageAt === null ||
        !canonicalTimestamp(createdAt) ||
        (Date.parse(createdAt) >= Date.parse(restriction.firstMessageAt) &&
          Date.parse(createdAt) <= Date.parse(restriction.lastMessageAt))),
  );
}
