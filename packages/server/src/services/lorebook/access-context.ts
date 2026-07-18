import type { Lorebook, LorebookEntry } from "@marinara-engine/shared";
import { filterRelevantLorebooks } from "./index.js";
import { filterLorebookEntriesForPromptContext, type LorebookPromptContext } from "./keyword-scanner.js";

export type LorebookAccessContext = LorebookPromptContext & {
  chatId: string;
  characterIds: string[];
  personaId: string | null;
  activeLorebookIds: string[];
  excludedLorebookIds: string[];
  excludedSourceAgentIds: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStrictStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = normalizeRequiredString(item);
    if (!entry) return null;
    if (seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
  }
  return normalized;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function lorebookEntryMatchesCharacterWriteScope(
  entry: Pick<LorebookEntry, "characterFilterMode" | "characterFilterIds">,
  characterFilterIds: readonly string[],
): boolean {
  const expectedIds = Array.from(new Set(characterFilterIds));
  const entryIds = Array.from(
    new Set((entry.characterFilterIds ?? []).filter((id): id is string => typeof id === "string" && !!id)),
  );
  if (expectedIds.length > 0) {
    return entry.characterFilterMode === "include" && sameStringSet(entryIds, expectedIds);
  }
  return entryIds.length === 0 && entry.characterFilterMode !== "include" && entry.characterFilterMode !== "exclude";
}

export function normalizeLorebookPromptContext(value: unknown): LorebookPromptContext | null {
  if (!isRecord(value)) return null;
  const activeCharacterIds = normalizeStrictStringArray(value.activeCharacterIds);
  const activeCharacterTags = normalizeStrictStringArray(value.activeCharacterTags);
  const generationTriggers = normalizeStrictStringArray(value.generationTriggers);
  if (!activeCharacterIds || !activeCharacterTags || !generationTriggers) return null;
  return { activeCharacterIds, activeCharacterTags, generationTriggers };
}

export function normalizeLorebookAccessContext(value: unknown): LorebookAccessContext | null {
  if (!isRecord(value)) return null;
  const promptContext = normalizeLorebookPromptContext(value);
  const chatId = normalizeRequiredString(value.chatId);
  const characterIds = normalizeStrictStringArray(value.characterIds);
  const activeLorebookIds = normalizeStrictStringArray(value.activeLorebookIds);
  const excludedLorebookIds = normalizeStrictStringArray(value.excludedLorebookIds);
  const excludedSourceAgentIds = normalizeStrictStringArray(value.excludedSourceAgentIds);
  const personaId = value.personaId === null ? null : normalizeRequiredString(value.personaId);
  if (
    !promptContext ||
    !chatId ||
    !characterIds ||
    !activeLorebookIds ||
    !excludedLorebookIds ||
    !excludedSourceAgentIds ||
    (value.personaId !== null && !personaId)
  ) {
    return null;
  }
  const characterIdSet = new Set(characterIds);
  if (promptContext.activeCharacterIds.some((id) => !characterIdSet.has(id))) return null;
  return {
    ...promptContext,
    chatId,
    characterIds,
    personaId,
    activeLorebookIds,
    excludedLorebookIds,
    excludedSourceAgentIds,
  };
}

export function lorebookPromptContextsEqual(left: LorebookPromptContext, right: LorebookPromptContext): boolean {
  return (
    sameStringSet(left.activeCharacterIds, right.activeCharacterIds) &&
    sameStringSet(left.activeCharacterTags, right.activeCharacterTags) &&
    sameStringSet(left.generationTriggers, right.generationTriggers)
  );
}

export function normalizeLorebookCharacterFilterIds(
  value: unknown,
  accessContext?: LorebookAccessContext,
): string[] | null {
  const normalized = normalizeStrictStringArray(value);
  if (!normalized) return null;
  if (!accessContext) return normalized;
  const allowedIds = new Set(accessContext.activeCharacterIds);
  return normalized.every((id) => allowedIds.has(id)) ? normalized : null;
}

type LorebookScopeRecord = Pick<
  Lorebook,
  | "id"
  | "name"
  | "enabled"
  | "scanDepth"
  | "tokenBudget"
  | "entryLimit"
  | "recursiveScanning"
  | "maxRecursionDepth"
  | "vectorScoreThreshold"
  | "vectorMaxResults"
  | "isGlobal"
  | "characterId"
  | "characterIds"
  | "personaId"
  | "personaIds"
  | "chatId"
  | "scope"
  | "sourceAgentId"
>;

function lorebookFilters(context: LorebookAccessContext) {
  return {
    chatId: context.chatId,
    characterIds: context.characterIds,
    personaId: context.personaId,
    activeLorebookIds: context.activeLorebookIds,
    excludedLorebookIds: context.excludedLorebookIds,
    excludedSourceAgentIds: context.excludedSourceAgentIds,
  };
}

export function filterAccessibleLorebooks<T extends LorebookScopeRecord>(
  books: readonly T[],
  context: LorebookAccessContext,
  options: { requireEnabled?: boolean } = {},
): T[] {
  const candidates = options.requireEnabled === false ? books.map((book) => ({ ...book, enabled: true })) : [...books];
  const accessibleIds = new Set(
    filterRelevantLorebooks(candidates as unknown as Lorebook[], lorebookFilters(context)).map((book) => book.id),
  );
  return books.filter((book) => accessibleIds.has(book.id));
}

export function lorebookIsWritableInAccessContext(book: LorebookScopeRecord, context: LorebookAccessContext): boolean {
  return filterAccessibleLorebooks([book], context, { requireEnabled: false }).length === 1;
}

export function filterAccessibleLorebookEntries<T extends LorebookEntry>(
  entries: readonly T[],
  context: LorebookAccessContext,
  entryStateOverrides: Record<string, { enabled?: boolean; ephemeral?: number | null }> = {},
): T[] {
  return filterLorebookEntriesForPromptContext(entries, context).filter((entry) => {
    const override = entryStateOverrides[entry.id];
    if ((override?.enabled ?? entry.enabled) === false) return false;
    return (override?.ephemeral ?? entry.ephemeral) !== 0;
  });
}
