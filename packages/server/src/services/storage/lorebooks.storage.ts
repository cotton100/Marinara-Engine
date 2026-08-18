// ──────────────────────────────────────────────
// Storage: Lorebooks
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import { eq, desc, and, like, inArray, asc, or } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import {
  characters,
  lorebooks,
  lorebookCharacterLinks,
  lorebookEntries,
  lorebookFolders,
  lorebookPersonaLinks,
  personalExtensionCoordination,
  personas,
} from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import {
  LIMITS,
  normalizeLorebookCategory,
  type CreateLorebookInput,
  type UpdateLorebookInput,
  type CreateLorebookEntryInput,
  type UpdateLorebookEntryInput,
  type BulkUpdateLorebookEntriesInput,
  type CreateLorebookFolderInput,
  type LorebookEntry,
  type UpdateLorebookFolderInput,
} from "@marinara-engine/shared";
import { collectEffectivelyDisabledFolderIds, collectFolderSubtreeIds } from "@marinara-engine/shared";
import { normalizeTimestampOverrides, type TimestampOverrides } from "../import/import-timestamps.js";
import { toPaginatedList } from "../../utils/list-pagination.js";
import {
  parsePersonalExtensionProtectedResourceRegistry,
  PersonalExtensionCoordinationKernelError,
  type PersonalExtensionFencedMutationContext,
  type PersonalExtensionLeaseAuthority,
  type PersonalExtensionProtectedResourceRegistry,
  type PersonalExtensionProtectedResource,
} from "../extensions/personal-extension-coordination-kernel.service.js";
import { getPersonalExtensionCoordinationService } from "../extensions/personal-extension-coordination.service.js";

function normalizeLorebookEntryLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return LIMITS.LOREBOOK_ENTRY_LIMIT_DEFAULT;
  return Math.max(LIMITS.LOREBOOK_ENTRY_LIMIT_MIN, Math.min(LIMITS.LOREBOOK_ENTRY_LIMIT_MAX, Math.trunc(parsed)));
}

function normalizeNonNegativeLorebookInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

function normalizeLorebookMaxRecursionDepth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(10, Math.trunc(parsed)));
}

function normalizeLorebookVectorQueryDepth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return LIMITS.LOREBOOK_VECTOR_QUERY_DEPTH_DEFAULT;
  return Math.max(0, Math.min(LIMITS.LOREBOOK_VECTOR_QUERY_DEPTH_MAX, Math.trunc(parsed)));
}

function normalizeLorebookVectorScoreThreshold(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return LIMITS.LOREBOOK_VECTOR_SCORE_THRESHOLD_DEFAULT;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeLorebookVectorMaxResults(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return LIMITS.LOREBOOK_VECTOR_MAX_RESULTS_DEFAULT;
  return Math.max(
    LIMITS.LOREBOOK_VECTOR_MAX_RESULTS_MIN,
    Math.min(LIMITS.LOREBOOK_VECTOR_MAX_RESULTS_MAX, Math.trunc(parsed)),
  );
}

function resolveTimestamps(overrides?: TimestampOverrides | null) {
  const normalized = normalizeTimestampOverrides(overrides);
  const createdAt = normalized?.createdAt ?? now();
  return {
    createdAt,
    updatedAt: normalized?.updatedAt ?? createdAt,
  };
}

function uniqueStrings(values: unknown): string[] {
  const raw = Array.isArray(values) ? values : [];
  return Array.from(
    new Set(raw.map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value.length > 0)),
  );
}

function resolveLinkIds(arrayValue: unknown, singleValue: unknown): string[] {
  const fromArray = uniqueStrings(arrayValue);
  if (fromArray.length > 0) return fromArray;
  return uniqueStrings(typeof singleValue === "string" ? [singleValue] : []);
}

function parseLorebookScope(value: unknown): { mode: "all" | "disabled" | "specific"; chatIds: string[] } {
  const raw = (() => {
    if (value && typeof value === "object") return value as Record<string, unknown>;
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    return {};
  })();
  const mode = raw.mode === "disabled" || raw.mode === "specific" ? raw.mode : "all";
  return {
    mode,
    chatIds: uniqueStrings(Array.isArray(raw.chatIds) ? raw.chatIds : []),
  };
}

function isLorebookScopeActiveForChat(value: unknown, chatId?: string | null): boolean {
  const scope = parseLorebookScope(value);
  if (scope.mode === "disabled") return false;
  if (scope.mode === "specific") return !!chatId && scope.chatIds.includes(chatId);
  return true;
}

type LorebookScopeFilters = {
  activeLorebookIds?: string[];
  characterIds?: string[];
  personaId?: string | null;
  chatId?: string;
};

type LinkedLorebook = {
  id: string;
};

function activeLorebookMatchesFilters(book: LinkedLorebook, filters: LorebookScopeFilters): boolean {
  return filters.activeLorebookIds?.includes(book.id) === true;
}

/** Parse DB row booleans ("true"/"false") → real booleans and JSON strings → objects. */
function parseLorebookRow(row: Record<string, unknown>) {
  const characterIds = resolveLinkIds(row.characterIds, row.characterId);
  const personaIds = resolveLinkIds(row.personaIds, row.personaId);
  return {
    ...row,
    category: normalizeLorebookCategory(row.category),
    scanDepth: normalizeNonNegativeLorebookInteger(row.scanDepth, 2),
    tokenBudget: normalizeNonNegativeLorebookInteger(row.tokenBudget, 2048),
    recursiveScanning: row.recursiveScanning === "true",
    entryLimit: normalizeLorebookEntryLimit(row.entryLimit),
    maxRecursionDepth: normalizeLorebookMaxRecursionDepth(row.maxRecursionDepth),
    excludeFromVectorization: row.excludeFromVectorization === "true",
    vectorQueryDepth: normalizeLorebookVectorQueryDepth(row.vectorQueryDepth),
    vectorScoreThreshold: normalizeLorebookVectorScoreThreshold(row.vectorScoreThreshold),
    vectorMaxResults: normalizeLorebookVectorMaxResults(row.vectorMaxResults),
    isGlobal: row.isGlobal === "true",
    enabled: row.enabled === "true",
    hiddenFromLibrary: row.hiddenFromLibrary === "true",
    scope: parseLorebookScope(row.scope),
    imagePath: row.imagePath || null,
    generatedBy: row.generatedBy || null,
    sourceAgentId: row.sourceAgentId || null,
    characterId: characterIds[0] ?? null,
    characterIds,
    personaId: personaIds[0] ?? null,
    personaIds,
    chatId: row.chatId || null,
    tags: JSON.parse((row.tags as string) || "[]"),
  };
}

function parseStringArray(value: unknown): string[] {
  const normalize = (items: unknown[]) =>
    items
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  if (Array.isArray(value)) return normalize(value);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalize(parsed) : [];
  } catch {
    return [];
  }
}

function parseEntryRow(row: Record<string, unknown>) {
  return {
    ...row,
    enabled: row.enabled === "true",
    constant: row.constant === "true",
    selective: row.selective === "true",
    matchWholeWords: row.matchWholeWords === "true",
    caseSensitive: row.caseSensitive === "true",
    useRegex: row.useRegex === "true",
    locked: row.locked === "true",
    preventRecursion: row.preventRecursion === "true",
    excludeRecursion: row.excludeRecursion === "true",
    delayUntilRecursion: row.delayUntilRecursion === "true",
    excludeFromVectorization: row.excludeFromVectorization === "true",
    folderId: (row.folderId as string | null | undefined) ?? null,
    keys: parseStringArray(row.keys),
    secondaryKeys: parseStringArray(row.secondaryKeys),
    characterFilterMode: row.characterFilterMode || "any",
    characterFilterIds: parseStringArray(row.characterFilterIds),
    characterTagFilterMode: row.characterTagFilterMode || "any",
    characterTagFilters: parseStringArray(row.characterTagFilters),
    generationTriggerFilterMode: row.generationTriggerFilterMode || "any",
    generationTriggerFilters: parseStringArray(row.generationTriggerFilters),
    additionalMatchingSources: parseStringArray(row.additionalMatchingSources),
    relationships: JSON.parse((row.relationships as string) || "{}"),
    dynamicState: JSON.parse((row.dynamicState as string) || "{}"),
    activationConditions: JSON.parse((row.activationConditions as string) || "[]"),
    schedule: row.schedule ? JSON.parse(row.schedule as string) : null,
    embedding: row.embedding ? JSON.parse(row.embedding as string) : null,
    embeddingSpaceId: (row.embeddingSpaceId as string | null | undefined) ?? null,
  };
}

function lorebookEntryVectorFingerprint(entry: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: entry.id,
        lorebookId: entry.lorebookId,
        name: entry.name,
        // Mirrors buildLorebookEntryEmbeddingText: description is embedded, so
        // a description edit between snapshot and commit must invalidate.
        description: entry.description,
        content: entry.content,
        keys: entry.keys,
        secondaryKeys: entry.secondaryKeys,
        excludeFromVectorization: entry.excludeFromVectorization,
      }),
      "utf8",
    )
    .digest("hex");
}

function hasStoredEmbedding(entry: { embedding?: unknown }): entry is { embedding: number[] } {
  return Array.isArray(entry.embedding) && entry.embedding.length > 0;
}

function knownEmbeddingSpaceId(entry: { embeddingSpaceId?: unknown }): string | null {
  return typeof entry.embeddingSpaceId === "string" && entry.embeddingSpaceId.trim() ? entry.embeddingSpaceId : null;
}

function parseFolderRow(row: Record<string, unknown>) {
  return {
    ...row,
    enabled: row.enabled === "true",
    parentFolderId: (row.parentFolderId as string | null | undefined) ?? null,
  };
}

type LorebookRow = typeof lorebooks.$inferSelect;
type LorebookListPageOptions = {
  limit: number;
  offset: number;
  search?: string;
  sort?: string;
  category?: string;
  active?: {
    lorebookIds: string[];
    characterIds: string[];
    personaId?: string | null;
    chatId?: string | null;
  };
};

function likePattern(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? `%${trimmed}%` : "";
}

function lorebookOrder(sort: string | undefined) {
  switch (sort) {
    case "name-desc":
      return [desc(lorebooks.name), asc(lorebooks.id)];
    case "newest":
      return [desc(lorebooks.createdAt), asc(lorebooks.id)];
    case "oldest":
      return [asc(lorebooks.createdAt), asc(lorebooks.id)];
    case "tokens":
      return [desc(lorebooks.tokenBudget), asc(lorebooks.id)];
    case "name-asc":
    default:
      return [asc(lorebooks.name), asc(lorebooks.id)];
  }
}

function parseCharacterName(row: typeof characters.$inferSelect) {
  try {
    const parsed = JSON.parse(row.data) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Unknown";
  } catch {
    return "Unknown";
  }
}

async function hydrateLorebookRows(db: DB, rows: LorebookRow[], options: { includeLinkedNames?: boolean } = {}) {
  if (rows.length === 0) return [];
  const bookIds = rows.map((row) => row.id);
  const [characterRows, personaRows] = await Promise.all([
    db
      .select()
      .from(lorebookCharacterLinks)
      .where(inArray(lorebookCharacterLinks.lorebookId, bookIds))
      .orderBy(asc(lorebookCharacterLinks.lorebookId), asc(lorebookCharacterLinks.characterId)),
    db
      .select()
      .from(lorebookPersonaLinks)
      .where(inArray(lorebookPersonaLinks.lorebookId, bookIds))
      .orderBy(asc(lorebookPersonaLinks.lorebookId), asc(lorebookPersonaLinks.personaId)),
  ]);
  const characterIdsByBook = new Map<string, string[]>();
  for (const link of characterRows) {
    const ids = characterIdsByBook.get(link.lorebookId) ?? [];
    ids.push(link.characterId);
    characterIdsByBook.set(link.lorebookId, ids);
  }
  const personaIdsByBook = new Map<string, string[]>();
  for (const link of personaRows) {
    const ids = personaIdsByBook.get(link.lorebookId) ?? [];
    ids.push(link.personaId);
    personaIdsByBook.set(link.lorebookId, ids);
  }
  const characterNameById = new Map<string, string>();
  const personaNameById = new Map<string, string>();
  if (options.includeLinkedNames) {
    const characterIds = Array.from(new Set(characterRows.map((link) => link.characterId)));
    const personaIds = Array.from(new Set(personaRows.map((link) => link.personaId)));
    const [linkedCharacters, linkedPersonas] = await Promise.all([
      characterIds.length > 0 ? db.select().from(characters).where(inArray(characters.id, characterIds)) : [],
      personaIds.length > 0 ? db.select().from(personas).where(inArray(personas.id, personaIds)) : [],
    ]);
    for (const character of linkedCharacters) {
      characterNameById.set(character.id, parseCharacterName(character));
    }
    for (const persona of linkedPersonas) {
      personaNameById.set(persona.id, persona.comment ? `${persona.name} - ${persona.comment}` : persona.name);
    }
  }
  return rows.map((row) => {
    const characterIds = characterIdsByBook.get(row.id) ?? [];
    const personaIds = personaIdsByBook.get(row.id) ?? [];
    const hydratedRow: Record<string, unknown> = {
      ...(row as Record<string, unknown>),
      characterIds,
      personaIds,
    };
    if (options.includeLinkedNames) {
      hydratedRow.characterNames = characterIds.map((id) => characterNameById.get(id) ?? id);
      hydratedRow.personaNames = personaIds.map((id) => personaNameById.get(id) ?? id);
    }
    return parseLorebookRow(hydratedRow);
  });
}

async function syncLorebookLinks(
  db: Pick<DB, "delete" | "insert">,
  lorebookId: string,
  characterIds: string[],
  personaIds: string[],
) {
  const timestamp = now();
  await db.delete(lorebookCharacterLinks).where(eq(lorebookCharacterLinks.lorebookId, lorebookId));
  await db.delete(lorebookPersonaLinks).where(eq(lorebookPersonaLinks.lorebookId, lorebookId));
  if (characterIds.length > 0) {
    await db.insert(lorebookCharacterLinks).values(
      characterIds.map((characterId) => ({
        id: newId(),
        lorebookId,
        characterId,
        createdAt: timestamp,
      })),
    );
  }
  if (personaIds.length > 0) {
    await db.insert(lorebookPersonaLinks).values(
      personaIds.map((personaId) => ({
        id: newId(),
        lorebookId,
        personaId,
        createdAt: timestamp,
      })),
    );
  }
}

export function createLorebooksStorage(db: DB) {
  const protectedOwnerForBook = async (lorebookId: string, readDb: DB = db) => {
    const rows = await readDb
      .select({
        extensionId: personalExtensionCoordination.extensionId,
        mode: personalExtensionCoordination.mode,
        protectedLorebookRegistry: personalExtensionCoordination.protectedLorebookRegistry,
      })
      .from(personalExtensionCoordination);
    for (const row of rows) {
      // A coordination row may carry a provisional registry while activation
      // is being validated, or while a writer drains/restores/blocks. Only an
      // explicitly inactive row reopens legacy writers.
      if (row.mode === "inactive") continue;
      const registry = parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry);
      if (registry.lorebooks[lorebookId]) return row.extensionId;
    }
    return null;
  };

  const assertLegacyBookWritable = async (lorebookId: string, readDb: DB = db) => {
    if (await protectedOwnerForBook(lorebookId, readDb)) {
      throw new PersonalExtensionCoordinationKernelError("coordination-required");
    }
  };

  const runLegacyBookMutation = async <T>(lorebookId: string, callback: (tx: DB) => Promise<T>) =>
    db.transaction(async (tx) => {
      // The route-level check is only a fast rejection. This check and the
      // write must share the transaction that serializes coordination
      // activation, otherwise activation can win between them.
      await assertLegacyBookWritable(lorebookId, tx);
      return callback(tx);
    });

  const registeredLorebookRevision = (registry: PersonalExtensionProtectedResourceRegistry, lorebookId: string) => {
    const registered = registry.lorebooks[lorebookId];
    if (!registered) throw new PersonalExtensionCoordinationKernelError("protected-resource-unregistered");
    return registered.resourceRevision;
  };

  const resolveEntryLorebookId = async (entryId: string, readDb: DB = db) => {
    const rows = await readDb
      .select({ lorebookId: lorebookEntries.lorebookId })
      .from(lorebookEntries)
      .where(eq(lorebookEntries.id, entryId));
    return rows[0]?.lorebookId ?? null;
  };

  const runFencedLorebookMutation = async <T>(
    context: PersonalExtensionFencedMutationContext,
    resources: readonly PersonalExtensionProtectedResource[],
    callback: (tx: DB) => Promise<T>,
  ) => {
    if (resources.length === 0 || resources.some((resource) => resource.kind !== "lorebook")) {
      throw new PersonalExtensionCoordinationKernelError("invalid-request");
    }
    return getPersonalExtensionCoordinationService(db).runFencedResourceMutation(context, resources, async (tx) => {
      const ids = resources.map((resource) => resource.resourceId);
      const rows = await tx.select({ id: lorebooks.id }).from(lorebooks).where(inArray(lorebooks.id, ids));
      if (new Set(rows.map((row) => row.id)).size !== new Set(ids).size) {
        throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
      }
      // This is the first-dispatch hook for the future operation journal. The
      // caller has already supplied a live, fenced operation; journal wiring
      // must happen before `callback` without moving external work into tx.
      return callback(tx);
    });
  };

  const removeLorebookInTransaction = async (tx: DB, id: string) => {
    await tx.delete(lorebookCharacterLinks).where(eq(lorebookCharacterLinks.lorebookId, id));
    await tx.delete(lorebookPersonaLinks).where(eq(lorebookPersonaLinks.lorebookId, id));
    await tx.delete(lorebooks).where(eq(lorebooks.id, id));
  };

  const removeLorebookEntryInTransaction = async (tx: DB, id: string, lorebookId: string) => {
    await tx.delete(lorebookEntries).where(and(eq(lorebookEntries.id, id), eq(lorebookEntries.lorebookId, lorebookId)));
  };

  const assertFolderBelongsToLorebook = async (
    lorebookId: string,
    folderId: string | null | undefined,
    readDb: DB = db,
  ) => {
    if (folderId === null || folderId === undefined) return;
    const folderRows = await readDb
      .select({ lorebookId: lorebookFolders.lorebookId })
      .from(lorebookFolders)
      .where(eq(lorebookFolders.id, folderId));
    const folderRow = folderRows[0];
    if (!folderRow || folderRow.lorebookId !== lorebookId) {
      throw new Error("folderId does not belong to this lorebook");
    }
  };

  const insertLorebookInTransaction = async (
    tx: DB,
    id: string,
    input: CreateLorebookInput,
    timestampOverrides?: TimestampOverrides | null,
  ) => {
    const timestamp = resolveTimestamps(timestampOverrides);
    const characterIds = resolveLinkIds(input.characterIds, input.characterId);
    const personaIds = resolveLinkIds(input.personaIds, input.personaId);
    await tx.insert(lorebooks).values({
      id,
      name: input.name,
      description: input.description ?? "",
      category: input.category ?? "uncategorized",
      imagePath: input.imagePath ?? null,
      scanDepth: input.scanDepth ?? 2,
      tokenBudget: input.tokenBudget ?? 2048,
      entryLimit: normalizeLorebookEntryLimit(input.entryLimit),
      recursiveScanning: String(input.recursiveScanning ?? false),
      maxRecursionDepth: input.maxRecursionDepth ?? 3,
      excludeFromVectorization: String(input.excludeFromVectorization ?? true),
      vectorQueryDepth: normalizeLorebookVectorQueryDepth(input.vectorQueryDepth),
      vectorScoreThreshold: normalizeLorebookVectorScoreThreshold(input.vectorScoreThreshold),
      vectorMaxResults: normalizeLorebookVectorMaxResults(input.vectorMaxResults),
      characterId: characterIds[0] ?? null,
      personaId: personaIds[0] ?? null,
      chatId: input.chatId ?? null,
      isGlobal: String(input.isGlobal ?? false),
      enabled: String(input.enabled ?? true),
      hiddenFromLibrary: String(input.hiddenFromLibrary ?? false),
      scope: JSON.stringify(parseLorebookScope(input.scope)),
      tags: input.tags ? JSON.stringify(input.tags) : "[]",
      generatedBy: input.generatedBy ?? null,
      sourceAgentId: input.sourceAgentId ?? null,
      createdAt: timestamp.createdAt,
      updatedAt: timestamp.updatedAt,
    });
    await syncLorebookLinks(tx, id, characterIds, personaIds);
    const rows = await tx.select().from(lorebooks).where(eq(lorebooks.id, id));
    return (await hydrateLorebookRows(tx, rows))[0] ?? null;
  };

  const updateLorebookInTransaction = async (tx: DB, id: string, input: UpdateLorebookInput) => {
    const updates: Record<string, unknown> = { updatedAt: now() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.category !== undefined) updates.category = input.category;
    if (input.imagePath !== undefined) updates.imagePath = input.imagePath;
    if (input.scanDepth !== undefined) updates.scanDepth = input.scanDepth;
    if (input.tokenBudget !== undefined) updates.tokenBudget = input.tokenBudget;
    if (input.entryLimit !== undefined) updates.entryLimit = normalizeLorebookEntryLimit(input.entryLimit);
    if (input.recursiveScanning !== undefined) updates.recursiveScanning = String(input.recursiveScanning);
    if (input.maxRecursionDepth !== undefined) updates.maxRecursionDepth = input.maxRecursionDepth;
    if (input.excludeFromVectorization !== undefined)
      updates.excludeFromVectorization = String(input.excludeFromVectorization);
    if (input.vectorQueryDepth !== undefined)
      updates.vectorQueryDepth = normalizeLorebookVectorQueryDepth(input.vectorQueryDepth);
    if (input.vectorScoreThreshold !== undefined)
      updates.vectorScoreThreshold = normalizeLorebookVectorScoreThreshold(input.vectorScoreThreshold);
    if (input.vectorMaxResults !== undefined)
      updates.vectorMaxResults = normalizeLorebookVectorMaxResults(input.vectorMaxResults);
    const shouldUpdateCharacterLinks = input.characterIds !== undefined || input.characterId !== undefined;
    const shouldUpdatePersonaLinks = input.personaIds !== undefined || input.personaId !== undefined;
    const currentRows = await tx.select().from(lorebooks).where(eq(lorebooks.id, id));
    const current = (await hydrateLorebookRows(tx, currentRows))[0] ?? null;
    if (!current) return null;
    const currentCharacterIds = (current.characterIds as string[] | undefined) ?? [];
    const currentPersonaIds = (current.personaIds as string[] | undefined) ?? [];
    const nextCharacterIds = shouldUpdateCharacterLinks
      ? resolveLinkIds(input.characterIds, input.characterId)
      : currentCharacterIds;
    const nextPersonaIds = shouldUpdatePersonaLinks
      ? resolveLinkIds(input.personaIds, input.personaId)
      : currentPersonaIds;
    if (shouldUpdateCharacterLinks) updates.characterId = nextCharacterIds[0] ?? null;
    if (shouldUpdatePersonaLinks) updates.personaId = nextPersonaIds[0] ?? null;
    if (input.chatId !== undefined) updates.chatId = input.chatId;
    if (input.isGlobal !== undefined) updates.isGlobal = String(input.isGlobal);
    if (input.enabled !== undefined) updates.enabled = String(input.enabled);
    if (input.hiddenFromLibrary !== undefined) updates.hiddenFromLibrary = String(input.hiddenFromLibrary);
    if (shouldUpdateCharacterLinks || shouldUpdatePersonaLinks) {
      // Upstream 2.4.2 (#4775): a book that loses its final owner is deactivated
      // and revealed instead of lingering as an enabled, hidden orphan.
      const nextChatId = input.chatId !== undefined ? input.chatId : (current.chatId as string | null | undefined);
      const nextIsGlobal = input.isGlobal !== undefined ? input.isGlobal : current.isGlobal === true;
      const lostFinalOwner =
        (currentCharacterIds.length > 0 || currentPersonaIds.length > 0) &&
        nextCharacterIds.length === 0 &&
        nextPersonaIds.length === 0 &&
        !nextChatId &&
        !nextIsGlobal;
      if (lostFinalOwner) {
        if (input.enabled === undefined) updates.enabled = "false";
        if (input.hiddenFromLibrary === undefined) updates.hiddenFromLibrary = "false";
      }
    }
    if (input.scope !== undefined) updates.scope = JSON.stringify(parseLorebookScope(input.scope));
    if (input.tags !== undefined) updates.tags = JSON.stringify(input.tags);
    if (input.generatedBy !== undefined) updates.generatedBy = input.generatedBy;
    if (input.sourceAgentId !== undefined) updates.sourceAgentId = input.sourceAgentId;
    await tx.update(lorebooks).set(updates).where(eq(lorebooks.id, id));
    if (shouldUpdateCharacterLinks || shouldUpdatePersonaLinks) {
      await syncLorebookLinks(tx, id, nextCharacterIds, nextPersonaIds);
    }
    const rows = await tx.select().from(lorebooks).where(eq(lorebooks.id, id));
    return (await hydrateLorebookRows(tx, rows))[0] ?? null;
  };

  const insertLorebookEntryInTransaction = async (tx: DB, id: string, input: CreateLorebookEntryInput) => {
    const timestamp = now();
    const requestedFolderId = input.folderId ?? null;
    await assertFolderBelongsToLorebook(input.lorebookId, requestedFolderId, tx);
    await tx.insert(lorebookEntries).values({
      id,
      lorebookId: input.lorebookId,
      folderId: requestedFolderId,
      name: input.name,
      content: input.content ?? "",
      description: input.description ?? "",
      keys: JSON.stringify(input.keys ?? []),
      secondaryKeys: JSON.stringify(input.secondaryKeys ?? []),
      enabled: String(input.enabled ?? true),
      constant: String(input.constant ?? false),
      selective: String(input.selective ?? false),
      selectiveLogic: input.selectiveLogic ?? "and",
      probability: input.probability ?? null,
      scanDepth: input.scanDepth ?? null,
      matchWholeWords: String(input.matchWholeWords ?? false),
      caseSensitive: String(input.caseSensitive ?? false),
      useRegex: String(input.useRegex ?? false),
      characterFilterMode: input.characterFilterMode ?? "any",
      characterFilterIds: JSON.stringify(input.characterFilterIds ?? []),
      characterTagFilterMode: input.characterTagFilterMode ?? "any",
      characterTagFilters: JSON.stringify(input.characterTagFilters ?? []),
      generationTriggerFilterMode: input.generationTriggerFilterMode ?? "any",
      generationTriggerFilters: JSON.stringify(input.generationTriggerFilters ?? []),
      additionalMatchingSources: JSON.stringify(input.additionalMatchingSources ?? []),
      position: input.position ?? 0,
      outletName: input.outletName ?? "",
      depth: input.depth ?? 0,
      order: input.order ?? 100,
      role: input.role ?? "system",
      sticky: input.sticky ?? null,
      cooldown: input.cooldown ?? null,
      delay: input.delay ?? null,
      ephemeral: input.ephemeral ?? null,
      group: input.group ?? "",
      groupWeight: input.groupWeight ?? null,
      tag: input.tag ?? "",
      relationships: JSON.stringify(input.relationships ?? {}),
      dynamicState: JSON.stringify(input.dynamicState ?? {}),
      activationConditions: JSON.stringify(input.activationConditions ?? []),
      schedule: input.schedule ? JSON.stringify(input.schedule) : null,
      locked: String(input.locked ?? false),
      preventRecursion: String(input.preventRecursion ?? true),
      excludeRecursion: String(input.excludeRecursion ?? false),
      delayUntilRecursion: String(input.delayUntilRecursion ?? false),
      excludeFromVectorization: String(input.excludeFromVectorization ?? false),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const rows = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, id));
    return rows[0] ? parseEntryRow(rows[0] as Record<string, unknown>) : null;
  };

  const updateLorebookEntryInTransaction = async (
    tx: DB,
    lorebookId: string,
    id: string,
    input: UpdateLorebookEntryInput,
  ) => {
    const rows = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, id));
    const current = rows[0];
    if (!current || current.lorebookId !== lorebookId) return null;
    const updates: Record<string, unknown> = { updatedAt: now() };
    // Must cover EXACTLY the fields buildLorebookEntryEmbeddingText embeds
    // (name, description, keys, secondary keys, content) — description was
    // omitted, so editing only the description left a stale embedding.
    const shouldClearEmbedding =
      input.name !== undefined ||
      input.description !== undefined ||
      input.content !== undefined ||
      input.keys !== undefined ||
      input.secondaryKeys !== undefined ||
      input.excludeFromVectorization === true;
    if (input.name !== undefined) updates.name = input.name;
    if (input.content !== undefined) updates.content = input.content;
    if (input.description !== undefined) updates.description = input.description;
    if (input.folderId !== undefined) {
      await assertFolderBelongsToLorebook(lorebookId, input.folderId, tx);
      updates.folderId = input.folderId;
    }
    if (input.keys !== undefined) updates.keys = JSON.stringify(input.keys);
    if (input.secondaryKeys !== undefined) updates.secondaryKeys = JSON.stringify(input.secondaryKeys);
    if (input.enabled !== undefined) updates.enabled = String(input.enabled);
    if (input.constant !== undefined) updates.constant = String(input.constant);
    if (input.selective !== undefined) updates.selective = String(input.selective);
    if (input.selectiveLogic !== undefined) updates.selectiveLogic = input.selectiveLogic;
    if (input.probability !== undefined) updates.probability = input.probability;
    if (input.scanDepth !== undefined) updates.scanDepth = input.scanDepth;
    if (input.matchWholeWords !== undefined) updates.matchWholeWords = String(input.matchWholeWords);
    if (input.caseSensitive !== undefined) updates.caseSensitive = String(input.caseSensitive);
    if (input.useRegex !== undefined) updates.useRegex = String(input.useRegex);
    if (input.characterFilterMode !== undefined) updates.characterFilterMode = input.characterFilterMode;
    if (input.characterFilterIds !== undefined) updates.characterFilterIds = JSON.stringify(input.characterFilterIds);
    if (input.characterTagFilterMode !== undefined) updates.characterTagFilterMode = input.characterTagFilterMode;
    if (input.characterTagFilters !== undefined)
      updates.characterTagFilters = JSON.stringify(input.characterTagFilters);
    if (input.generationTriggerFilterMode !== undefined)
      updates.generationTriggerFilterMode = input.generationTriggerFilterMode;
    if (input.generationTriggerFilters !== undefined)
      updates.generationTriggerFilters = JSON.stringify(input.generationTriggerFilters);
    if (input.additionalMatchingSources !== undefined)
      updates.additionalMatchingSources = JSON.stringify(input.additionalMatchingSources);
    if (input.position !== undefined) updates.position = input.position;
    if (input.outletName !== undefined) updates.outletName = input.outletName;
    if (input.depth !== undefined) updates.depth = input.depth;
    if (input.order !== undefined) updates.order = input.order;
    if (input.role !== undefined) updates.role = input.role;
    if (input.sticky !== undefined) updates.sticky = input.sticky;
    if (input.cooldown !== undefined) updates.cooldown = input.cooldown;
    if (input.delay !== undefined) updates.delay = input.delay;
    if (input.ephemeral !== undefined) updates.ephemeral = input.ephemeral;
    if (input.group !== undefined) updates.group = input.group;
    if (input.groupWeight !== undefined) updates.groupWeight = input.groupWeight;
    if (input.tag !== undefined) updates.tag = input.tag;
    if (input.relationships !== undefined) updates.relationships = JSON.stringify(input.relationships);
    if (input.dynamicState !== undefined) updates.dynamicState = JSON.stringify(input.dynamicState);
    if (input.activationConditions !== undefined)
      updates.activationConditions = JSON.stringify(input.activationConditions);
    if (input.schedule !== undefined) updates.schedule = input.schedule ? JSON.stringify(input.schedule) : null;
    if (input.locked !== undefined) updates.locked = String(input.locked);
    if (input.preventRecursion !== undefined) updates.preventRecursion = String(input.preventRecursion);
    if (input.excludeRecursion !== undefined) updates.excludeRecursion = String(input.excludeRecursion);
    if (input.delayUntilRecursion !== undefined) updates.delayUntilRecursion = String(input.delayUntilRecursion);
    if (input.excludeFromVectorization !== undefined)
      updates.excludeFromVectorization = String(input.excludeFromVectorization);
    if (shouldClearEmbedding) {
      updates.embedding = null;
      updates.embeddingSpaceId = null;
    }
    await tx
      .update(lorebookEntries)
      .set(updates)
      .where(and(eq(lorebookEntries.id, id), eq(lorebookEntries.lorebookId, lorebookId)));
    const updatedRows = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, id));
    return updatedRows[0] ? parseEntryRow(updatedRows[0] as Record<string, unknown>) : null;
  };

  return {
    runFencedLorebookMutation,
    assertLegacyWritable: assertLegacyBookWritable,
    async listFenced(context: PersonalExtensionLeaseAuthority) {
      return getPersonalExtensionCoordinationService(db).runFencedResourceRead(context, async (readDb, registry) => {
        const registered = Object.entries(registry.lorebooks);
        if (registered.length === 0) return [];
        const rows = await readDb
          .select()
          .from(lorebooks)
          .where(
            inArray(
              lorebooks.id,
              registered.map(([lorebookId]) => lorebookId),
            ),
          );
        const values = await hydrateLorebookRows(readDb, rows);
        const byId = new Map(values.map((value) => [String((value as unknown as { id: string }).id), value]));
        return registered.map(([lorebookId, resource]) => {
          const value = byId.get(lorebookId);
          if (!value) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
          return { value, resourceRevision: resource.resourceRevision };
        });
      });
    },

    async getByIdFenced(context: PersonalExtensionLeaseAuthority, lorebookId: string) {
      return getPersonalExtensionCoordinationService(db).runFencedResourceRead(context, async (readDb, registry) => {
        const resourceRevision = registeredLorebookRevision(registry, lorebookId);
        const rows = await readDb.select().from(lorebooks).where(eq(lorebooks.id, lorebookId));
        const value = (await hydrateLorebookRows(readDb, rows))[0];
        if (!value) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
        return { value, resourceRevision };
      });
    },

    async listEntriesFenced(context: PersonalExtensionLeaseAuthority, lorebookId: string) {
      return getPersonalExtensionCoordinationService(db).runFencedResourceRead(context, async (readDb, registry) => {
        const resourceRevision = registeredLorebookRevision(registry, lorebookId);
        const bookRows = await readDb.select({ id: lorebooks.id }).from(lorebooks).where(eq(lorebooks.id, lorebookId));
        if (!bookRows[0]) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
        const rows = await readDb
          .select()
          .from(lorebookEntries)
          .where(eq(lorebookEntries.lorebookId, lorebookId))
          .orderBy(lorebookEntries.order);
        return {
          items: rows.map((row) => parseEntryRow(row as Record<string, unknown>)),
          resourceRevision,
        };
      });
    },

    async getEntryFenced(context: PersonalExtensionLeaseAuthority, lorebookId: string, entryId: string) {
      return getPersonalExtensionCoordinationService(db).runFencedResourceRead(context, async (readDb, registry) => {
        const resourceRevision = registeredLorebookRevision(registry, lorebookId);
        const rows = await readDb.select().from(lorebookEntries).where(eq(lorebookEntries.id, entryId));
        const row = rows[0];
        if (!row || row.lorebookId !== lorebookId) {
          throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
        }
        return { value: parseEntryRow(row as Record<string, unknown>), resourceRevision };
      });
    },

    async createFenced(context: PersonalExtensionFencedMutationContext, input: CreateLorebookInput) {
      const id = newId();
      const committed = await getPersonalExtensionCoordinationService(db).runFencedLorebookRegistryTransition(
        context,
        { action: "bind", resourceId: id, expectedRevision: null },
        async (tx) => {
          const existing = await tx.select({ id: lorebooks.id }).from(lorebooks).where(eq(lorebooks.id, id));
          if (existing[0]) throw new PersonalExtensionCoordinationKernelError("resource-revision-conflict");
          const value = await insertLorebookInTransaction(tx, id, input);
          if (!value) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
          return value;
        },
      );
      if (committed.resourceRevision === null) {
        throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
      }
      return { value: committed.result, resourceRevision: committed.resourceRevision };
    },

    async updateFenced(
      context: PersonalExtensionFencedMutationContext,
      lorebookId: string,
      expectedResourceRevision: number,
      input: UpdateLorebookInput,
    ) {
      const committed = await getPersonalExtensionCoordinationService(db).runFencedResourceMutation(
        context,
        [{ kind: "lorebook", resourceId: lorebookId, expectedRevision: expectedResourceRevision }],
        async (tx) => {
          const value = await updateLorebookInTransaction(tx, lorebookId, input);
          if (!value) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
          return value;
        },
        { operationKind: "mutation" },
      );
      return { value: committed.result, resourceRevision: committed.resourceRevisions[0]!.resourceRevision };
    },

    async createEntryFenced(
      context: PersonalExtensionFencedMutationContext,
      lorebookId: string,
      expectedResourceRevision: number,
      input: Omit<CreateLorebookEntryInput, "lorebookId">,
    ) {
      const entryId = newId();
      const committed = await getPersonalExtensionCoordinationService(db).runFencedResourceMutation(
        context,
        [{ kind: "lorebook", resourceId: lorebookId, expectedRevision: expectedResourceRevision }],
        async (tx) => {
          const value = await insertLorebookEntryInTransaction(tx, entryId, { ...input, lorebookId });
          if (!value) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
          return value;
        },
        { operationKind: "mutation" },
      );
      return { value: committed.result, resourceRevision: committed.resourceRevisions[0]!.resourceRevision };
    },

    async updateEntryFenced(
      context: PersonalExtensionFencedMutationContext,
      lorebookId: string,
      entryId: string,
      expectedResourceRevision: number,
      input: UpdateLorebookEntryInput,
    ) {
      const committed = await getPersonalExtensionCoordinationService(db).runFencedResourceMutation(
        context,
        [{ kind: "lorebook", resourceId: lorebookId, expectedRevision: expectedResourceRevision }],
        async (tx) => {
          const value = await updateLorebookEntryInTransaction(tx, lorebookId, entryId, input);
          if (!value) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
          return value;
        },
        { operationKind: "mutation" },
      );
      return { value: committed.result, resourceRevision: committed.resourceRevisions[0]!.resourceRevision };
    },

    async getVectorizationSnapshotFenced(
      context: PersonalExtensionFencedMutationContext,
      lorebookId: string,
      onlyMissing: boolean,
    ) {
      return getPersonalExtensionCoordinationService(db).runFencedOperationRead(
        context,
        "vectorize",
        async (readDb, registry) => {
          const resourceRevision = registeredLorebookRevision(registry, lorebookId);
          const bookRows = await readDb.select().from(lorebooks).where(eq(lorebooks.id, lorebookId));
          const book = (await hydrateLorebookRows(readDb, bookRows))[0];
          if (!book) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
          const entryRows = await readDb
            .select()
            .from(lorebookEntries)
            .where(eq(lorebookEntries.lorebookId, lorebookId))
            .orderBy(lorebookEntries.order);
          const allEntries = entryRows.map((row) =>
            parseEntryRow(row as Record<string, unknown>),
          ) as unknown as LorebookEntry[];
          const vectorizable = book.excludeFromVectorization
            ? []
            : allEntries.filter((entry) => !entry.excludeFromVectorization);
          // Upstream 2.4.3 records an embeddingSpaceId with every vector and
          // rejects recall from an unknown space. Vectors written before that
          // (no space id) are therefore stale, not "present": treat them as
          // missing so a coordinated vectorize repairs them instead of refusing.
          const entries = onlyMissing
            ? vectorizable.filter((entry) => !hasStoredEmbedding(entry) || knownEmbeddingSpaceId(entry) === null)
            : vectorizable;
          const knownSpaceEntries = vectorizable.filter(
            (entry) => hasStoredEmbedding(entry) && knownEmbeddingSpaceId(entry) !== null,
          );
          return {
            book,
            entries: entries.map((entry) => ({
              value: entry,
              fingerprint: lorebookEntryVectorFingerprint(entry as unknown as Record<string, unknown>),
            })),
            total: allEntries.length,
            existingEmbeddingDimension:
              knownSpaceEntries
                .map((entry) => entry.embedding)
                .find((embedding): embedding is number[] => Array.isArray(embedding) && embedding.length > 0)?.length ??
              null,
            existingEmbeddingSpaceIds: [
              ...new Set(knownSpaceEntries.map((entry) => knownEmbeddingSpaceId(entry) as string)),
            ],
            resourceRevision,
          };
        },
      );
    },

    async commitEntryEmbeddingsFenced(
      context: PersonalExtensionFencedMutationContext,
      lorebookId: string,
      expectedResourceRevision: number,
      entries: readonly { entryId: string; fingerprint: string; embedding: number[] }[],
      embeddingSpaceId: string,
    ) {
      if (!embeddingSpaceId.trim()) throw new PersonalExtensionCoordinationKernelError("invalid-request");
      const committed = await getPersonalExtensionCoordinationService(db).runFencedResourceMutation(
        context,
        [{ kind: "lorebook", resourceId: lorebookId, expectedRevision: expectedResourceRevision }],
        async (tx) => {
          for (const entry of entries) {
            const rows = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.id, entry.entryId));
            const row = rows[0];
            if (!row || row.lorebookId !== lorebookId) {
              throw new PersonalExtensionCoordinationKernelError("resource-revision-conflict");
            }
            const parsed = parseEntryRow(row as Record<string, unknown>);
            if (lorebookEntryVectorFingerprint(parsed as unknown as Record<string, unknown>) !== entry.fingerprint) {
              throw new PersonalExtensionCoordinationKernelError("resource-revision-conflict");
            }
          }
          const timestamp = now();
          for (const entry of entries) {
            await tx
              .update(lorebookEntries)
              .set({ embedding: JSON.stringify(entry.embedding), embeddingSpaceId, updatedAt: timestamp })
              .where(and(eq(lorebookEntries.id, entry.entryId), eq(lorebookEntries.lorebookId, lorebookId)));
          }
          return entries.length;
        },
        { operationKind: "vectorize" },
      );
      return {
        updated: committed.result,
        resourceRevision: committed.resourceRevisions[0]!.resourceRevision,
      };
    },

    async clearEntryEmbeddingsFenced(
      context: PersonalExtensionFencedMutationContext,
      lorebookId: string,
      expectedResourceRevision: number,
    ) {
      const committed = await getPersonalExtensionCoordinationService(db).runFencedResourceMutation(
        context,
        [{ kind: "lorebook", resourceId: lorebookId, expectedRevision: expectedResourceRevision }],
        async (tx) => {
          const rows = await tx.select().from(lorebookEntries).where(eq(lorebookEntries.lorebookId, lorebookId));
          const cleared = rows.filter((row) => typeof row.embedding === "string" && row.embedding.length > 0).length;
          await tx
            .update(lorebookEntries)
            .set({ embedding: null, embeddingSpaceId: null, updatedAt: now() })
            .where(eq(lorebookEntries.lorebookId, lorebookId));
          return { cleared, total: rows.length };
        },
        { operationKind: "vectorize" },
      );
      return { ...committed.result, resourceRevision: committed.resourceRevisions[0]!.resourceRevision };
    },
    // ── Lorebooks ──

    async list() {
      const rows = await db.select().from(lorebooks).orderBy(desc(lorebooks.updatedAt));
      return hydrateLorebookRows(db, rows);
    },

    async listByCategory(category: string) {
      const rows = await db
        .select()
        .from(lorebooks)
        .where(eq(lorebooks.category, category))
        .orderBy(desc(lorebooks.updatedAt));
      return hydrateLorebookRows(db, rows);
    },

    async listPage(options: LorebookListPageOptions) {
      const clauses = [eq(lorebooks.hiddenFromLibrary, "false")];
      if (options.category) clauses.push(eq(lorebooks.category, options.category));
      const pattern = likePattern(options.search);
      if (pattern) {
        clauses.push(
          or(
            like(lorebooks.name, pattern),
            like(lorebooks.description, pattern),
            like(lorebooks.category, pattern),
            like(lorebooks.tags, pattern),
            like(lorebooks.generatedBy, pattern),
          ),
        );
      }

      if (options.active) {
        clauses.push(eq(lorebooks.enabled, "true"));
        const activeLorebookIds = new Set(options.active.lorebookIds);
        if (options.active.characterIds.length > 0) {
          const linkedCharacters = await db
            .select({ lorebookId: lorebookCharacterLinks.lorebookId })
            .from(lorebookCharacterLinks)
            .where(inArray(lorebookCharacterLinks.characterId, options.active.characterIds));
          for (const link of linkedCharacters) activeLorebookIds.add(link.lorebookId);
        }
        if (options.active.personaId) {
          const linkedPersonas = await db
            .select({ lorebookId: lorebookPersonaLinks.lorebookId })
            .from(lorebookPersonaLinks)
            .where(eq(lorebookPersonaLinks.personaId, options.active.personaId));
          for (const link of linkedPersonas) activeLorebookIds.add(link.lorebookId);
        }
        const activeClauses = [eq(lorebooks.isGlobal, "true")];
        if (activeLorebookIds.size > 0) activeClauses.push(inArray(lorebooks.id, Array.from(activeLorebookIds)));
        if (options.active.characterIds.length > 0) {
          activeClauses.push(inArray(lorebooks.characterId, options.active.characterIds));
        }
        if (options.active.personaId) activeClauses.push(eq(lorebooks.personaId, options.active.personaId));
        if (options.active.chatId) activeClauses.push(eq(lorebooks.chatId, options.active.chatId));
        clauses.push(or(...activeClauses));
      }

      const whereClause = clauses.length > 0 ? and(...clauses) : undefined;
      const rows = await (whereClause
        ? db
            .select()
            .from(lorebooks)
            .where(whereClause)
            .orderBy(...lorebookOrder(options.sort))
            .limit(options.limit + 1)
            .offset(options.offset)
        : db
            .select()
            .from(lorebooks)
            .orderBy(...lorebookOrder(options.sort))
            .limit(options.limit + 1)
            .offset(options.offset));
      const items = await hydrateLorebookRows(db, rows.slice(0, options.limit), { includeLinkedNames: true });
      return {
        ...toPaginatedList(rows, options.limit, options.offset),
        items,
      };
    },

    async listByCharacter(characterId: string) {
      const all = (await this.list()) as Array<{ characterIds?: string[]; characterId?: string | null }>;
      return all.filter((row) => row.characterIds?.includes(characterId) || row.characterId === characterId);
    },

    async listByPersona(personaId: string) {
      const all = (await this.list()) as Array<{ personaIds?: string[]; personaId?: string | null }>;
      return all.filter((row) => row.personaIds?.includes(personaId) || row.personaId === personaId);
    },

    async listByChat(chatId: string) {
      const rows = await db
        .select()
        .from(lorebooks)
        .where(eq(lorebooks.chatId, chatId))
        .orderBy(desc(lorebooks.updatedAt));
      return hydrateLorebookRows(db, rows);
    },

    async getById(id: string) {
      const rows = await db.select().from(lorebooks).where(eq(lorebooks.id, id));
      return (await hydrateLorebookRows(db, rows))[0] ?? null;
    },

    async create(input: CreateLorebookInput, timestampOverrides?: TimestampOverrides | null) {
      const id = newId();
      return runLegacyBookMutation(id, (tx) => insertLorebookInTransaction(tx, id, input, timestampOverrides));
    },

    async update(id: string, input: UpdateLorebookInput) {
      await assertLegacyBookWritable(id);
      return runLegacyBookMutation(id, (tx) => updateLorebookInTransaction(tx, id, input));
    },

    async remove(id: string) {
      await assertLegacyBookWritable(id);
      await runLegacyBookMutation(id, (tx) => removeLorebookInTransaction(tx, id));
    },

    async removeFenced(context: PersonalExtensionFencedMutationContext, id: string, expectedResourceRevision: number) {
      return getPersonalExtensionCoordinationService(db).runFencedLorebookRegistryTransition(
        context,
        { action: "unbind", resourceId: id, expectedRevision: expectedResourceRevision },
        async (tx) => {
          const rows = await tx.select({ id: lorebooks.id }).from(lorebooks).where(eq(lorebooks.id, id));
          if (!rows[0]) throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
          await removeLorebookInTransaction(tx, id);
          return { deleted: true as const };
        },
      );
    },

    // ── Entries ──

    async listEntries(lorebookId: string) {
      const rows = await db
        .select()
        .from(lorebookEntries)
        .where(eq(lorebookEntries.lorebookId, lorebookId))
        .orderBy(lorebookEntries.order);
      return rows.map((r) => parseEntryRow(r as Record<string, unknown>));
    },

    /** Get all entries across multiple lorebooks (for prompt injection). */
    async listEntriesByLorebooks(lorebookIds: string[]) {
      if (lorebookIds.length === 0) return [];
      const rows = await db
        .select()
        .from(lorebookEntries)
        .where(inArray(lorebookEntries.lorebookId, lorebookIds))
        .orderBy(lorebookEntries.order);
      return rows.map((r) => parseEntryRow(r as Record<string, unknown>));
    },

    /**
     * Resolve explicitly attached entries without requiring normal character/persona/global scope.
     * Disabled books, entries, folders, chat exclusions, and excluded agent sources still win.
     */
    async listEligibleEntriesByIds(
      entryIds: string[],
      filters?: { excludedLorebookIds?: string[]; excludedSourceAgentIds?: string[] },
    ): Promise<LorebookEntry[]> {
      const requestedIds = uniqueStrings(entryIds).slice(0, LIMITS.MAX_LOREBOOK_ENTRIES);
      if (requestedIds.length === 0) return [];

      const entryRows = await db
        .select()
        .from(lorebookEntries)
        .where(and(inArray(lorebookEntries.id, requestedIds), eq(lorebookEntries.enabled, "true")));
      if (entryRows.length === 0) return [];

      const candidateBookIds = uniqueStrings(entryRows.map((row) => row.lorebookId));
      const enabledBookRows = await db
        .select()
        .from(lorebooks)
        .where(and(inArray(lorebooks.id, candidateBookIds), eq(lorebooks.enabled, "true")));
      const enabledBooks = (await hydrateLorebookRows(db, enabledBookRows)) as unknown as Array<{
        id: string;
        sourceAgentId?: string | null;
      }>;
      const excludedLorebookIds = new Set(filters?.excludedLorebookIds ?? []);
      const excludedSourceAgentIds = new Set(filters?.excludedSourceAgentIds ?? []);
      const allowedBookIds = new Set(
        enabledBooks
          .filter(
            (book) =>
              !excludedLorebookIds.has(book.id) &&
              !(book.sourceAgentId && excludedSourceAgentIds.has(book.sourceAgentId)),
          )
          .map((book) => book.id),
      );
      if (allowedBookIds.size === 0) return [];

      const folderRows = await db
        .select({
          id: lorebookFolders.id,
          parentFolderId: lorebookFolders.parentFolderId,
          enabled: lorebookFolders.enabled,
        })
        .from(lorebookFolders)
        .where(inArray(lorebookFolders.lorebookId, Array.from(allowedBookIds)));
      const disabledFolderIds = collectEffectivelyDisabledFolderIds(
        folderRows.map((row) => ({
          id: row.id,
          parentFolderId: row.parentFolderId,
          enabled: row.enabled === "true",
        })),
      );
      const requestedOrder = new Map(requestedIds.map((id, index) => [id, index]));
      const parsedEntries = entryRows.map((row) => parseEntryRow(row as Record<string, unknown>)) as Array<
        ReturnType<typeof parseEntryRow> & { id: string; lorebookId: string; folderId: string | null }
      >;
      return parsedEntries
        .filter(
          (entry) =>
            allowedBookIds.has(entry.lorebookId) &&
            (!entry.folderId || !disabledFolderIds.has(entry.folderId as string)),
        )
        .sort(
          (left, right) => (requestedOrder.get(left.id) ?? 0) - (requestedOrder.get(right.id) ?? 0),
        ) as unknown as LorebookEntry[];
    },

    /**
     * Get all enabled entries from lorebooks that are relevant for a given context.
     * A lorebook is relevant if it's enabled AND one of:
     *  - `isGlobal` is true
     *  - Its ID is in `activeLorebookIds`
     *  - Its `characterId` matches one of the chat's active characters
     *  - Its `personaId` matches the chat's active persona
     *  - Its `chatId` matches the current chat
     * When no filters are provided, returns entries from ALL enabled lorebooks (legacy behavior).
     *
     * Folder gate: an entry whose `folderId` points at a disabled folder is
     * excluded here, regardless of the entry's own `enabled` flag. The entry's
     * own flag is preserved in the database — re-enabling the folder restores
     * each entry's previous individual setting. Entries with a NULL `folderId`
     * (root-level entries) are unaffected.
     */
    async listActiveEntries(filters?: {
      activeLorebookIds?: string[];
      characterIds?: string[];
      personaId?: string | null;
      chatId?: string;
      excludedLorebookIds?: string[];
      excludedSourceAgentIds?: string[];
    }) {
      const enabledBookRows = await db.select().from(lorebooks).where(eq(lorebooks.enabled, "true"));
      const enabledBooks = (await hydrateLorebookRows(db, enabledBookRows)) as unknown as Array<{
        id: string;
        isGlobal: boolean;
        characterId?: string | null;
        characterIds?: string[];
        personaId?: string | null;
        personaIds?: string[];
        chatId?: string | null;
        scope?: unknown;
        sourceAgentId?: string | null;
        excludeFromVectorization?: boolean;
      }>;

      let relevantBooks = enabledBooks.filter((b) => isLorebookScopeActiveForChat(b.scope, filters?.chatId));
      if (filters) {
        const excludedLorebookIds = new Set(filters.excludedLorebookIds ?? []);
        const excludedSourceAgentIds = new Set(filters.excludedSourceAgentIds ?? []);
        relevantBooks = relevantBooks.filter((b) => {
          if (excludedLorebookIds.has(b.id)) return false;
          if (b.sourceAgentId && excludedSourceAgentIds.has(b.sourceAgentId)) return false;
          // Globally active lorebooks bypass all scope filters
          if (b.isGlobal) return true;
          // Explicitly added to this chat.
          if (activeLorebookMatchesFilters(b, filters)) return true;
          // Belongs to one of the active characters
          if ((b.characterIds ?? []).some((id) => filters.characterIds?.includes(id))) return true;
          if (b.characterId && filters.characterIds?.includes(b.characterId)) return true;
          // Belongs to the active persona
          if (filters.personaId && (b.personaIds ?? []).includes(filters.personaId)) return true;
          if (b.personaId && b.personaId === filters.personaId) return true;
          // Belongs to this chat
          if (b.chatId && b.chatId === filters.chatId) return true;
          return false;
        });
      }

      const bookIds = relevantBooks.map((b) => b.id);
      if (bookIds.length === 0) return [];
      const excludedVectorBookIds = new Set(
        relevantBooks.filter((book) => book.excludeFromVectorization).map((book) => book.id),
      );

      // Build the *effectively* disabled-folder ID set: a folder is gated if it
      // OR any ancestor is disabled (folders can nest). Fetch all folders for the
      // relevant books and resolve ancestry in memory — per-book folder counts are
      // small and this keeps the existing query shape.
      const folderRows = await db
        .select({
          id: lorebookFolders.id,
          parentFolderId: lorebookFolders.parentFolderId,
          enabled: lorebookFolders.enabled,
        })
        .from(lorebookFolders)
        .where(inArray(lorebookFolders.lorebookId, bookIds));
      const disabledFolderIds = collectEffectivelyDisabledFolderIds(
        folderRows.map((r) => ({ id: r.id, parentFolderId: r.parentFolderId, enabled: r.enabled === "true" })),
      );

      const rows = await db
        .select()
        .from(lorebookEntries)
        .where(and(inArray(lorebookEntries.lorebookId, bookIds), eq(lorebookEntries.enabled, "true")))
        .orderBy(lorebookEntries.order);
      const parsed = rows.map((r) => {
        const entry = parseEntryRow(r as Record<string, unknown>);
        const lorebookId = String((entry as Record<string, unknown>).lorebookId ?? "");
        return excludedVectorBookIds.has(lorebookId) ? { ...entry, excludeFromVectorization: true } : entry;
      });
      if (disabledFolderIds.size === 0) return parsed;
      return parsed.filter((e) => !e.folderId || !disabledFolderIds.has(e.folderId as string));
    },

    async getEntry(id: string) {
      const rows = await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, id));
      const row = rows[0];
      return row ? parseEntryRow(row as Record<string, unknown>) : null;
    },

    async createEntry(input: CreateLorebookEntryInput) {
      await assertLegacyBookWritable(input.lorebookId);
      const id = newId();
      return runLegacyBookMutation(input.lorebookId, (tx) => insertLorebookEntryInTransaction(tx, id, input));
    },

    async updateEntry(id: string, input: UpdateLorebookEntryInput) {
      const entryLorebookId = await resolveEntryLorebookId(id);
      if (entryLorebookId) await assertLegacyBookWritable(entryLorebookId);
      if (!entryLorebookId) return null;
      return runLegacyBookMutation(entryLorebookId, async (tx) => {
        const currentLorebookId = await resolveEntryLorebookId(id, tx);
        if (currentLorebookId !== entryLorebookId) return null;
        return updateLorebookEntryInTransaction(tx, entryLorebookId, id, input);
      });
    },

    async bulkUpdateEntries(
      lorebookId: string,
      entryIds: string[],
      changes: BulkUpdateLorebookEntriesInput["changes"],
    ) {
      await assertLegacyBookWritable(lorebookId);
      return runLegacyBookMutation(lorebookId, async (tx) => {
        const uniqueEntryIds = Array.from(new Set(entryIds));
        const rows = await tx
          .select({ id: lorebookEntries.id })
          .from(lorebookEntries)
          .where(and(eq(lorebookEntries.lorebookId, lorebookId), inArray(lorebookEntries.id, uniqueEntryIds)));
        if (rows.length !== uniqueEntryIds.length) {
          throw new Error("One or more selected entries do not belong to this lorebook");
        }

        if (changes.folderId !== undefined) {
          await assertFolderBelongsToLorebook(lorebookId, changes.folderId, tx);
        }

        const updates: Record<string, unknown> = { updatedAt: now() };
        if (changes.enabled !== undefined) updates.enabled = String(changes.enabled);
        if (changes.constant !== undefined) updates.constant = String(changes.constant);
        if (changes.selective !== undefined) updates.selective = String(changes.selective);
        if (changes.selectiveLogic !== undefined) updates.selectiveLogic = changes.selectiveLogic;
        if (changes.probability !== undefined) updates.probability = changes.probability;
        if (changes.scanDepth !== undefined) updates.scanDepth = changes.scanDepth;
        if (changes.matchWholeWords !== undefined) updates.matchWholeWords = String(changes.matchWholeWords);
        if (changes.caseSensitive !== undefined) updates.caseSensitive = String(changes.caseSensitive);
        if (changes.useRegex !== undefined) updates.useRegex = String(changes.useRegex);
        if (changes.characterFilterMode !== undefined) updates.characterFilterMode = changes.characterFilterMode;
        if (changes.characterFilterIds !== undefined)
          updates.characterFilterIds = JSON.stringify(changes.characterFilterIds);
        if (changes.characterTagFilterMode !== undefined)
          updates.characterTagFilterMode = changes.characterTagFilterMode;
        if (changes.characterTagFilters !== undefined)
          updates.characterTagFilters = JSON.stringify(changes.characterTagFilters);
        if (changes.generationTriggerFilterMode !== undefined)
          updates.generationTriggerFilterMode = changes.generationTriggerFilterMode;
        if (changes.generationTriggerFilters !== undefined)
          updates.generationTriggerFilters = JSON.stringify(changes.generationTriggerFilters);
        if (changes.additionalMatchingSources !== undefined)
          updates.additionalMatchingSources = JSON.stringify(changes.additionalMatchingSources);
        if (changes.position !== undefined) updates.position = changes.position;
        if (changes.outletName !== undefined) updates.outletName = changes.outletName;
        if (changes.depth !== undefined) updates.depth = changes.depth;
        if (changes.order !== undefined) updates.order = changes.order;
        if (changes.role !== undefined) updates.role = changes.role;
        if (changes.sticky !== undefined) updates.sticky = changes.sticky;
        if (changes.cooldown !== undefined) updates.cooldown = changes.cooldown;
        if (changes.delay !== undefined) updates.delay = changes.delay;
        if (changes.ephemeral !== undefined) updates.ephemeral = changes.ephemeral;
        if (changes.group !== undefined) updates.group = changes.group;
        if (changes.groupWeight !== undefined) updates.groupWeight = changes.groupWeight;
        if (changes.folderId !== undefined) updates.folderId = changes.folderId;
        if (changes.tag !== undefined) updates.tag = changes.tag;
        if (changes.locked !== undefined) updates.locked = String(changes.locked);
        if (changes.preventRecursion !== undefined) updates.preventRecursion = String(changes.preventRecursion);
        if (changes.excludeRecursion !== undefined) updates.excludeRecursion = String(changes.excludeRecursion);
        if (changes.delayUntilRecursion !== undefined)
          updates.delayUntilRecursion = String(changes.delayUntilRecursion);
        if (changes.excludeFromVectorization !== undefined)
          updates.excludeFromVectorization = String(changes.excludeFromVectorization);
        if (changes.excludeFromVectorization === true) {
          updates.embedding = null;
          updates.embeddingSpaceId = null;
        }

        await tx
          .update(lorebookEntries)
          .set(updates)
          .where(and(eq(lorebookEntries.lorebookId, lorebookId), inArray(lorebookEntries.id, uniqueEntryIds)));
        return { updated: rows.length };
      });
    },

    /** Update just the embedding vector for an entry. */
    async updateEntryEmbedding(id: string, embedding: number[] | null, embeddingSpaceId: string | null = null) {
      const entryLorebookId = await resolveEntryLorebookId(id);
      if (entryLorebookId) await assertLegacyBookWritable(entryLorebookId);
      if (!entryLorebookId) return;
      await runLegacyBookMutation(entryLorebookId, async (tx) => {
        if ((await resolveEntryLorebookId(id, tx)) !== entryLorebookId) return;
        await tx
          .update(lorebookEntries)
          .set({
            embedding: embedding ? JSON.stringify(embedding) : null,
            embeddingSpaceId: embedding ? embeddingSpaceId : null,
            updatedAt: now(),
          })
          .where(and(eq(lorebookEntries.id, id), eq(lorebookEntries.lorebookId, entryLorebookId)));
      });
    },

    /** Remove every stored embedding vector for entries in one lorebook. */
    async clearEntryEmbeddings(lorebookId: string) {
      await assertLegacyBookWritable(lorebookId);
      await runLegacyBookMutation(lorebookId, async (tx) => {
        await tx
          .update(lorebookEntries)
          .set({ embedding: null, embeddingSpaceId: null, updatedAt: now() })
          .where(eq(lorebookEntries.lorebookId, lorebookId));
      });
    },

    /** Bulk create entries (for imports and AI generation). */
    async bulkCreateEntries(lorebookId: string, entries: Omit<CreateLorebookEntryInput, "lorebookId">[]) {
      await assertLegacyBookWritable(lorebookId);
      return runLegacyBookMutation(lorebookId, async (tx) => {
        const results = [];
        for (const entry of entries) {
          await assertFolderBelongsToLorebook(lorebookId, entry.folderId ?? null, tx);
        }
        for (const entry of entries) {
          results.push(await insertLorebookEntryInTransaction(tx, newId(), { ...entry, lorebookId }));
        }
        return results;
      });
    },

    /**
     * Reorder entries inside a single container.
     *
     * `folderId` (undefined = legacy, null = root, string = inside that
     * folder) scopes the reorder so that dragging within one container does
     * not renumber entries in another. When `folderId` is undefined we keep
     * the legacy behavior of renumbering every entry in the lorebook.
     *
     * Renumbering uses (index + 1) * 10 within the container, so each
     * container's order space starts back at 10 — that's intentional and
     * matches the user-facing "each folder is its own container" semantic
     * (a folder at the top can hold high-Order entries without affecting
     * root entries below it).
     */
    async reorderEntries(lorebookId: string, entryIds: string[], folderId?: string | null) {
      await assertLegacyBookWritable(lorebookId);
      return runLegacyBookMutation(lorebookId, async (tx) => {
        const rows = await tx
          .select()
          .from(lorebookEntries)
          .where(eq(lorebookEntries.lorebookId, lorebookId))
          .orderBy(lorebookEntries.order);
        const allEntries = rows.map((row) => parseEntryRow(row as Record<string, unknown>)) as unknown as Array<
          Record<string, unknown>
        >;
        const inScope =
          folderId === undefined
            ? allEntries
            : allEntries.filter((row) => ((row.folderId as string | null | undefined) ?? null) === folderId);

        const scopeEntries = inScope.map((row) => ({
          id: String(row.id),
          order: typeof row.order === "number" ? row.order : Number(row.order ?? 0),
        }));
        const orderById = new Map(scopeEntries.map((entry) => [entry.id, entry.order]));
        const scopeIds = new Set(scopeEntries.map((entry) => entry.id));
        const orderedIds = entryIds.filter((id, index, ids) => scopeIds.has(id) && ids.indexOf(id) === index);
        const missingIds = scopeEntries
          .map((entry) => entry.id)
          .filter((id) => !orderedIds.includes(id))
          .sort((leftId, rightId) => (orderById.get(leftId) ?? 0) - (orderById.get(rightId) ?? 0));
        const timestamp = now();

        for (const [index, id] of [...orderedIds, ...missingIds].entries()) {
          await tx
            .update(lorebookEntries)
            .set({ order: (index + 1) * 10, updatedAt: timestamp })
            .where(and(eq(lorebookEntries.id, id), eq(lorebookEntries.lorebookId, lorebookId)));
        }

        const updatedRows = await tx
          .select()
          .from(lorebookEntries)
          .where(eq(lorebookEntries.lorebookId, lorebookId))
          .orderBy(lorebookEntries.order);
        return updatedRows.map((row) => parseEntryRow(row as Record<string, unknown>));
      });
    },

    async removeEntry(id: string) {
      const entryLorebookId = await resolveEntryLorebookId(id);
      if (entryLorebookId) await assertLegacyBookWritable(entryLorebookId);
      if (!entryLorebookId) return;
      await runLegacyBookMutation(entryLorebookId, async (tx) => {
        if ((await resolveEntryLorebookId(id, tx)) !== entryLorebookId) return;
        await removeLorebookEntryInTransaction(tx, id, entryLorebookId);
      });
    },

    async removeEntryFenced(
      context: PersonalExtensionFencedMutationContext,
      lorebookId: string,
      entryId: string,
      expectedResourceRevision: number,
    ) {
      const committed = await getPersonalExtensionCoordinationService(db).runFencedResourceMutation(
        context,
        [{ kind: "lorebook", resourceId: lorebookId, expectedRevision: expectedResourceRevision }],
        async (tx) => {
          const actualLorebookId = await resolveEntryLorebookId(entryId, tx);
          if (actualLorebookId !== lorebookId)
            throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
          await removeLorebookEntryInTransaction(tx, entryId, lorebookId);
          return { deleted: true as const };
        },
        { operationKind: "mutation" },
      );
      return { ...committed.result, resourceRevision: committed.resourceRevisions[0]!.resourceRevision };
    },

    // ── Folders ──

    async listFolders(lorebookId: string) {
      const rows = await db
        .select()
        .from(lorebookFolders)
        .where(eq(lorebookFolders.lorebookId, lorebookId))
        .orderBy(asc(lorebookFolders.order));
      return rows.map((r) => parseFolderRow(r as Record<string, unknown>));
    },

    /**
     * Look up a folder. When `lorebookId` is provided, the lookup is also
     * scoped to that lorebook — needed because the route layer accepts both
     * `:id` (lorebook) and `:folderId` and the two should always agree.
     * Without this scope, `/lorebooks/A/folders/B` would happily return a
     * folder belonging to lorebook `X`.
     */
    async getFolder(folderId: string, lorebookId?: string) {
      const conditions = lorebookId
        ? and(eq(lorebookFolders.id, folderId), eq(lorebookFolders.lorebookId, lorebookId))
        : eq(lorebookFolders.id, folderId);
      const rows = await db.select().from(lorebookFolders).where(conditions);
      const row = rows[0];
      return row ? parseFolderRow(row as Record<string, unknown>) : null;
    },

    async createFolder(lorebookId: string, input: CreateLorebookFolderInput) {
      await assertLegacyBookWritable(lorebookId);
      const id = newId();
      const timestamp = now();
      return runLegacyBookMutation(lorebookId, async (tx) => {
        // If the caller didn't pass an explicit order, append after existing folders
        // so the new one shows up at the bottom of the folder block by default.
        let order = input.order ?? 0;
        if (input.order === undefined || input.order === 0) {
          const existing = await tx
            .select({ order: lorebookFolders.order })
            .from(lorebookFolders)
            .where(eq(lorebookFolders.lorebookId, lorebookId));
          order = existing.length > 0 ? Math.max(...existing.map((row) => row.order ?? 0)) + 10 : 10;
        }
        await tx.insert(lorebookFolders).values({
          id,
          lorebookId,
          name: input.name,
          enabled: String(input.enabled ?? true),
          // Honors input.parentFolderId (null = root); the route layer validates
          // the parent (exists, same lorebook, no cycle) before calling.
          parentFolderId: input.parentFolderId ?? null,
          order,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const rows = await tx
          .select()
          .from(lorebookFolders)
          .where(and(eq(lorebookFolders.id, id), eq(lorebookFolders.lorebookId, lorebookId)));
        return rows[0] ? parseFolderRow(rows[0] as Record<string, unknown>) : null;
      });
    },

    /**
     * Update a folder. `lorebookId` is required so a malicious or buggy
     * caller can't reach folders in a different lorebook by guessing the
     * folder ID; the WHERE clause requires both to match.
     */
    async updateFolder(folderId: string, input: UpdateLorebookFolderInput, lorebookId?: string) {
      const currentFolder = (await this.getFolder(folderId, lorebookId)) as Record<string, unknown> | null;
      if (currentFolder?.lorebookId) await assertLegacyBookWritable(String(currentFolder.lorebookId));
      if (!currentFolder?.lorebookId) return null;
      const ownerLorebookId = String(currentFolder.lorebookId);
      return runLegacyBookMutation(ownerLorebookId, async (tx) => {
        const whereClause = lorebookId
          ? and(eq(lorebookFolders.id, folderId), eq(lorebookFolders.lorebookId, lorebookId))
          : eq(lorebookFolders.id, folderId);
        const currentRows = await tx.select().from(lorebookFolders).where(whereClause);
        const current = currentRows[0];
        if (!current || current.lorebookId !== ownerLorebookId) return null;
        const updates: Record<string, unknown> = { updatedAt: now() };
        if (input.name !== undefined) updates.name = input.name;
        if (input.enabled !== undefined) updates.enabled = String(input.enabled);
        if (input.parentFolderId !== undefined) updates.parentFolderId = input.parentFolderId;
        if (input.order !== undefined) updates.order = input.order;
        await tx.update(lorebookFolders).set(updates).where(whereClause);
        const rows = await tx.select().from(lorebookFolders).where(whereClause);
        return rows[0] ? parseFolderRow(rows[0] as Record<string, unknown>) : null;
      });
    },

    /**
     * Remove a folder. Entries inside the folder are NOT deleted — their
     * `folderId` is reset to NULL (root level) so the user doesn't lose
     * data when they remove a folder by accident.
     *
     * `lorebookId` scopes the lookup so a request to
     * `/lorebooks/A/folders/B` cannot reach a folder belonging to lorebook
     * `X` and accidentally reparent that other lorebook's entries.
     */
    async removeFolder(folderId: string, lorebookId?: string, cascade = false) {
      const folder = (await this.getFolder(folderId, lorebookId)) as Record<string, unknown> | null;
      if (!folder) return;
      const ownerLorebookId = folder.lorebookId as string;
      await assertLegacyBookWritable(ownerLorebookId);
      await runLegacyBookMutation(ownerLorebookId, async (tx) => {
        const currentRows = await tx
          .select()
          .from(lorebookFolders)
          .where(and(eq(lorebookFolders.id, folderId), eq(lorebookFolders.lorebookId, ownerLorebookId)));
        if (!currentRows[0]) return;
        // Cascade: delete the folder, every descendant folder, and all their entries.
        if (cascade) {
          const folderRows = await tx
            .select()
            .from(lorebookFolders)
            .where(eq(lorebookFolders.lorebookId, ownerLorebookId));
          const subtreeIds = collectFolderSubtreeIds(
            folderRows.map((row) => ({ id: row.id, parentFolderId: row.parentFolderId })),
            folderId,
          );
          await tx
            .delete(lorebookEntries)
            .where(and(eq(lorebookEntries.lorebookId, ownerLorebookId), inArray(lorebookEntries.folderId, subtreeIds)));
          await tx
            .delete(lorebookFolders)
            .where(and(eq(lorebookFolders.lorebookId, ownerLorebookId), inArray(lorebookFolders.id, subtreeIds)));
          return;
        }
        // Entries in this folder fall back to root...
        await tx
          .update(lorebookEntries)
          .set({ folderId: null, updatedAt: now() })
          .where(and(eq(lorebookEntries.lorebookId, ownerLorebookId), eq(lorebookEntries.folderId, folderId)));
        // ...and direct child folders are promoted to the top level.
        await tx
          .update(lorebookFolders)
          .set({ parentFolderId: null, updatedAt: now() })
          .where(and(eq(lorebookFolders.lorebookId, ownerLorebookId), eq(lorebookFolders.parentFolderId, folderId)));
        await tx
          .delete(lorebookFolders)
          .where(and(eq(lorebookFolders.id, folderId), eq(lorebookFolders.lorebookId, ownerLorebookId)));
      });
    },

    /** Renumber folders within a lorebook to match `folderIds` left-to-right. */
    async reorderFolders(lorebookId: string, folderIds: string[]) {
      await assertLegacyBookWritable(lorebookId);
      return runLegacyBookMutation(lorebookId, async (tx) => {
        const rows = await tx
          .select()
          .from(lorebookFolders)
          .where(eq(lorebookFolders.lorebookId, lorebookId))
          .orderBy(asc(lorebookFolders.order));
        const existing = rows.map((row) => parseFolderRow(row as Record<string, unknown>)) as unknown as Array<{
          id: string;
          order: number;
        }>;
        const orderById = new Map(existing.map((folder) => [folder.id, folder.order]));
        const existingIds = new Set(existing.map((folder) => folder.id));
        const orderedIds = folderIds.filter((id, index, ids) => existingIds.has(id) && ids.indexOf(id) === index);
        const missingIds = existing
          .map((folder) => folder.id)
          .filter((id) => !orderedIds.includes(id))
          .sort((leftId, rightId) => (orderById.get(leftId) ?? 0) - (orderById.get(rightId) ?? 0));
        const timestamp = now();
        for (const [index, id] of [...orderedIds, ...missingIds].entries()) {
          await tx
            .update(lorebookFolders)
            .set({ order: (index + 1) * 10, updatedAt: timestamp })
            .where(and(eq(lorebookFolders.id, id), eq(lorebookFolders.lorebookId, lorebookId)));
        }
        const updatedRows = await tx
          .select()
          .from(lorebookFolders)
          .where(eq(lorebookFolders.lorebookId, lorebookId))
          .orderBy(asc(lorebookFolders.order));
        return updatedRows.map((row) => parseFolderRow(row as Record<string, unknown>));
      });
    },

    /**
     * Deep-clone a folder into the same lorebook: the folder itself, its entries,
     * and its entire subtree of sub-folders (with their entries). The clone is
     * created as a sibling of the original (same parent); only the root copy is
     * renamed "<name> (Copy)" — sub-folders keep their names. Folder and entry
     * order is preserved within each group. Returns the new root folder.
     *
     * Folders are created top-down so each parent exists before its children, and
     * entries are created afterwards so createEntry's "folder must belong to this
     * lorebook" guard passes against the freshly-created folders.
     */
    async cloneFolder(folderId: string, lorebookId: string) {
      await assertLegacyBookWritable(lorebookId);
      return runLegacyBookMutation(lorebookId, async () => {
        const allFolders = (await this.listFolders(lorebookId)) as unknown as Array<{
          id: string;
          name: string;
          enabled: boolean;
          parentFolderId: string | null;
          order: number;
        }>;
        const root = allFolders.find((f) => f.id === folderId);
        if (!root) throw new Error("folder not found");
        const allEntries = (await this.listEntries(lorebookId)) as unknown as Array<
          Record<string, unknown> & { id: string; folderId: string | null; order: number }
        >;

        // Children indexed by parent, each group kept in display order.
        const childrenByParent = new Map<string, typeof allFolders>();
        for (const f of allFolders) {
          if (f.parentFolderId == null) continue;
          const group = childrenByParent.get(f.parentFolderId) ?? [];
          group.push(f);
          childrenByParent.set(f.parentFolderId, group);
        }

        // Depth-first list of the subtree (root first). A seen guard keeps a
        // malformed cycle from looping forever.
        const subtree: typeof allFolders = [];
        const seen = new Set<string>();
        const walk = (f: (typeof allFolders)[number]) => {
          if (seen.has(f.id)) return;
          seen.add(f.id);
          subtree.push(f);
          const kids = (childrenByParent.get(f.id) ?? []).slice().sort((a, b) => a.order - b.order);
          for (const k of kids) walk(k);
        };
        walk(root);

        // Recreate the folders. createFolder appends order, so creating in
        // depth-first order preserves each group's relative ordering.
        const idMap = new Map<string, string>();
        for (const folder of subtree) {
          const isRoot = folder.id === root.id;
          const newParentId = isRoot ? root.parentFolderId : (idMap.get(folder.parentFolderId as string) ?? null);
          const created = (await this.createFolder(lorebookId, {
            name: isRoot ? `${folder.name} (Copy)` : folder.name,
            enabled: folder.enabled,
            parentFolderId: newParentId,
          })) as { id: string } | null;
          if (created) idMap.set(folder.id, created.id);
        }

        // Clone each entry into its matching new folder, preserving order. Drop the
        // server-managed fields — createEntry re-derives id/timestamps and embedding
        // is re-derived on demand, mirroring the single-entry duplicate path.
        const subtreeFolderIds = new Set(subtree.map((f) => f.id));
        const entriesToClone = allEntries
          .filter((e) => e.folderId != null && subtreeFolderIds.has(e.folderId))
          .sort((a, b) => a.order - b.order);
        for (const entry of entriesToClone) {
          const newFolderId = idMap.get(entry.folderId as string);
          if (!newFolderId) continue;
          const clone: Record<string, unknown> = { ...entry, lorebookId, folderId: newFolderId };
          delete clone.id;
          delete clone.createdAt;
          delete clone.updatedAt;
          delete clone.embedding;
          await this.createEntry(clone as unknown as CreateLorebookEntryInput);
        }

        const newRootId = idMap.get(root.id);
        return newRootId ? this.getFolder(newRootId, lorebookId) : null;
      });
    },

    // ── Search ──

    /** Search entries by keyword match in name/content/keys. */
    async searchEntries(query: string) {
      const pattern = `%${query}%`;
      const rows = await db
        .select()
        .from(lorebookEntries)
        .where(like(lorebookEntries.name, pattern))
        .orderBy(lorebookEntries.order);
      return rows.map((r) => parseEntryRow(r as Record<string, unknown>));
    },
  };
}
