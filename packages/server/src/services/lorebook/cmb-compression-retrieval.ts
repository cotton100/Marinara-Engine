import { personalExtensionCoordinationCmbCompressionRecordSchema, type LorebookEntry } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, eq, inArray } from "../../db/file-query.js";
import { lorebookEntries, memoryChunks } from "../../db/schema/index.js";
import { inspectCmbCompression } from "./cmb-compression.js";
import { lorebookEntryPassesContextFilters } from "./keyword-scanner.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dynamicRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  if (value.length > 4 * 1024 * 1024) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function compressionRecords(dynamic: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!dynamic) return null;
  if (!Object.prototype.hasOwnProperty.call(dynamic, "convoMemoryBridgeCompression")) return {};
  const namespace = record(dynamic.convoMemoryBridgeCompression);
  const byCast = record(namespace?.byCast);
  if (
    namespace?.schemaVersion !== 1 ||
    Object.keys(namespace).some((key) => !["schemaVersion", "byCast", "history"].includes(key)) ||
    !byCast ||
    Object.keys(byCast).length > 32
  )
    return null;
  if (
    namespace.history !== undefined &&
    (!Array.isArray(namespace.history) ||
      namespace.history.some((value) => {
        const item = record(value);
        return (
          !item ||
          Object.keys(item).length !== 2 ||
          typeof item.castId !== "string" ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(item.castId) ||
          !personalExtensionCoordinationCmbCompressionRecordSchema.safeParse(item.record).success
        );
      }))
  )
    return null;
  return Object.entries(byCast).every(
    ([castId, value]) =>
      /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(castId) &&
      personalExtensionCoordinationCmbCompressionRecordSchema.safeParse(value).success,
  )
    ? byCast
    : null;
}

/** Malformed application metadata is not permission to fall back to the original. */
export function hasActiveCmbCompression(dynamicState: unknown): boolean {
  const dynamic = dynamicRecord(dynamicState);
  const byCast = compressionRecords(dynamic);
  return byCast === null || Object.values(byCast).some((value) => record(value)?.active === true);
}

export type CmbDetailedRecallBudget = { count: number; characters: number };
export function createCmbDetailedRecallBudget(): CmbDetailedRecallBudget {
  return { count: 0, characters: 0 };
}

function relevantDetail(query: string, original: string): boolean {
  // Deliberately conservative: generic one-word searches never expand old details.
  const words = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  const content = original.toLocaleLowerCase();
  return words.filter((word) => content.includes(word)).length >= 2;
}

function readerBindings(
  entry: LorebookEntry,
  audience: readonly string[],
): Array<{ castId: string; characterId: string }> | null {
  const bridge = record(dynamicRecord(entry.dynamicState)?.convoMemoryBridge);
  if (bridge?.schemaVersion !== 1 || !Array.isArray(bridge.rosterBindings) || !Array.isArray(bridge.unknownToCastIds))
    return null;
  const bindings = bridge.rosterBindings.map(record);
  if (
    !bindings.length ||
    bindings.length > 32 ||
    bindings.some((item) => !item || typeof item.castId !== "string" || typeof item.characterId !== "string")
  )
    return null;
  const castIds = new Set(bindings.map((item) => item!.castId));
  const characterIds = new Set(bindings.map((item) => item!.characterId));
  if (
    castIds.size !== bindings.length ||
    characterIds.size !== bindings.length ||
    bridge.unknownToCastIds.some((id) => !castIds.has(id))
  )
    return null;
  const unknownTo = bridge.unknownToCastIds;
  const readers = [...new Set(audience)].map((id) => bindings.find((item) => item!.characterId === id));
  if (!readers.length || readers.some((item) => !item || unknownTo.includes(item.castId))) return null;
  return readers as Array<{ castId: string; characterId: string }>;
}

/** Select one prompt representation per original ID, before matching/topK and budgeting. Never persists a body. */
export async function resolveCmbCompressionEntries(
  db: DB | undefined,
  entries: readonly LorebookEntry[],
  options: {
    audienceCharacterIds: readonly string[];
    contextCharacterIds?: string[];
    activeCharacterTags?: string[];
    generationTriggers?: string[];
    query?: string;
    detailBudget?: CmbDetailedRecallBudget;
    /** Local CMB originals already covered by native recall; explicit selections are omitted. */
    excludeUncompressedEntryIds?: ReadonlySet<string>;
  },
): Promise<LorebookEntry[]> {
  const budget = options.detailBudget ?? createCmbDetailedRecallBudget();
  const selected: LorebookEntry[] = [];
  for (const candidate of entries) {
    let entry = candidate;
    if (
      entry.enabled === false ||
      !lorebookEntryPassesContextFilters(entry, {
        activeCharacterIds: options.contextCharacterIds ?? [...options.audienceCharacterIds],
        activeCharacterTags: options.activeCharacterTags,
        generationTriggers: options.generationTriggers,
      })
    )
      continue;
    const dynamic = dynamicRecord(entry.dynamicState);
    const managed = entry.tag === "convo-memory-bridge" || Boolean(dynamic?.convoMemoryBridgeCompression);
    if (!managed) {
      selected.push(entry);
      continue;
    }
    const readers = readerBindings(entry, options.audienceCharacterIds);
    // Every recipient must be allowed, not merely one member of a merged prompt.
    if (
      !readers ||
      readers.some(
        ({ characterId }) =>
          !lorebookEntryPassesContextFilters(entry, {
            activeCharacterIds: [characterId],
            activeCharacterTags: options.activeCharacterTags,
            generationTriggers: options.generationTriggers,
          }),
      )
    )
      continue;
    const byCast = compressionRecords(dynamic);
    if (byCast === null) continue;
    const activeReaders = readers.filter(({ castId }) => record(byCast[castId])?.active === true);
    if (!activeReaders.length && options.excludeUncompressedEntryIds?.has(entry.id)) continue;
    // Only eligible readers reach disk-backed originals, one event at a time.
    const readOriginal = async () => {
      if (!db) return !(entry as LorebookEntry & { cmbOriginalDeferred?: boolean }).cmbOriginalDeferred;
      // Recheck metadata and read this body in one storage read transaction. A
      // permission change after candidate selection must not reopen an original.
      return db.transaction(async (tx) => {
        const fresh = (
          await createLorebooksStorage(tx).listEligibleEntriesByIds([entry.id], { deferCmbOriginals: true })
        )[0];
        if (!fresh) return false;
        const identity = (value: LorebookEntry) =>
          JSON.stringify([
            value.id,
            value.lorebookId,
            value.tag,
            value.enabled,
            value.folderId ?? null,
            value.dynamicState,
            value.characterFilterMode,
            value.characterFilterIds,
            value.characterTagFilterMode,
            value.characterTagFilters,
            value.generationTriggerFilterMode,
            value.generationTriggerFilters,
          ]);
        if (identity(entry) !== identity(fresh)) return false;
        const row = (
          await tx
            .select({ content: lorebookEntries.content })
            .from(lorebookEntries)
            .where(and(eq(lorebookEntries.id, entry.id), eq(lorebookEntries.lorebookId, entry.lorebookId)))
        )[0];
        if (!row || typeof row.content !== "string") return false;
        entry = { ...entry, content: row.content };
        delete (entry as LorebookEntry & { cmbOriginalDeferred?: boolean }).cmbOriginalDeferred;
        return true;
      });
    };
    // Application and undo belong to a character. A mixed merged audience cannot share raw details.
    if (!activeReaders.length) {
      try {
        if (await readOriginal()) selected.push(entry);
      } catch {
        /* Unreadable originals are never empty memories. */
      }
      continue;
    }
    if (activeReaders.length !== readers.length) continue;
    if (!db) continue;
    if (entry.folderId) continue; // Applied summaries do not support folder placement yet.
    try {
      if (!(await readOriginal())) continue;
      const inspections = [];
      for (const reader of readers) {
        const item = record(byCast[reader.castId]);
        const importance = item?.importanceMode;
        if (importance !== "auto" && importance !== "detail" && importance !== "core") break;
        inspections.push(await inspectCmbCompression(db, entry, reader.castId, importance));
      }
      if (
        inspections.length !== readers.length ||
        inspections.some(
          (value, index) =>
            value.state !== "active" ||
            value.eligibility.status !== "ready" ||
            value.characterId !== readers[index]!.characterId ||
            !value.current ||
            typeof value.current.summary !== "string" ||
            !value.current.summary.trim(),
        )
      )
        continue;
      const canRecallDetail =
        inspections.every((value) => value.detailedRecall) &&
        budget.count < 2 &&
        entry.content.length <= 6000 - budget.characters &&
        relevantDetail(
          options.query ?? "",
          entry.content.replace(/^\[Knowledge boundary\]\nUnknown to cast IDs: [^\n]*\n\n\[Memory\]\n/u, ""),
        );
      let content: string;
      if (canRecallDetail) {
        content = `[CMB recalled original details]\n${entry.content}`;
        budget.count += 1;
        budget.characters += entry.content.length;
      } else {
        content = inspections
          .map((value, index) => {
            const label =
              "characterName" in value && typeof value.characterName === "string"
                ? value.characterName.replace(/[\r\n\u0000-\u001f]/gu, " ").slice(0, 200)
                : readers[index]!.characterId;
            return `[CMB compressed memory for ${label}]\n${value.current!.summary}`;
          })
          .join("\n\n");
      }
      selected.push({ ...entry, content });
    } catch {
      // An unreadable current source/card/config is a held derivative, never an original fallback.
    }
  }
  return selected;
}

type SourceSpan = { chatId: string; chunkId: string; first: number | null; last: number | null };

/** Source coverage survives stale summaries and rebuilt native chunk IDs; only explicit release removes it. */
export async function loadCmbCompressedSourceSpans(
  db: DB,
  options: { sourceChatIds?: readonly string[]; entries?: readonly { dynamicState: string }[] } = {},
): Promise<SourceSpan[] | null> {
  try {
    const entries =
      options.entries ??
      (await db
        .select({ dynamicState: lorebookEntries.dynamicState })
        .from(lorebookEntries)
        .where(eq(lorebookEntries.tag, "convo-memory-bridge"))
        .limit(2049));
    if (entries.length > 2048) return null;
    if (entries.reduce((total, entry) => total + entry.dynamicState.length, 0) > 4 * 1024 * 1024) return null;
    const spans: SourceSpan[] = [];
    const chunkIdsByChat = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (!hasActiveCmbCompression(entry.dynamicState)) continue;
      const bridge = record(dynamicRecord(entry.dynamicState)?.convoMemoryBridge);
      const source = record(bridge?.source);
      if (source?.kind === "manual") continue;
      if (
        source?.kind !== "native-memory-chunk" ||
        !Array.isArray(source.occurrences) ||
        !source.occurrences.length ||
        source.occurrences.length > 128
      )
        return null;
      const first = typeof source.firstMessageAt === "string" ? Date.parse(source.firstMessageAt) : NaN;
      const last = typeof source.lastMessageAt === "string" ? Date.parse(source.lastMessageAt) : NaN;
      const validSpan = Number.isFinite(first) && Number.isFinite(last) && first <= last;
      for (const value of source.occurrences) {
        const item = record(value);
        if (typeof item?.chatId !== "string" || !item.chatId.trim()) return null;
        if (options.sourceChatIds && !options.sourceChatIds.includes(item.chatId)) continue;
        if (typeof item.chunkId !== "string" || !item.chunkId.trim()) return null;
        spans.push({
          chatId: item.chatId,
          chunkId: item.chunkId,
          first: validSpan ? first : null,
          last: validSpan ? last : null,
        });
        if (spans.length > 4096) return null;
        const ids = chunkIdsByChat.get(item.chatId) ?? new Set<string>();
        ids.add(item.chunkId);
        chunkIdsByChat.set(item.chatId, ids);
      }
    }
    for (const [chatId, chunkIds] of chunkIdsByChat) {
      // Never load source bodies or vectors to close raw-tail/native bypasses.
      const current = await db
        .select({
          id: memoryChunks.id,
          chatId: memoryChunks.chatId,
          firstMessageAt: memoryChunks.firstMessageAt,
          lastMessageAt: memoryChunks.lastMessageAt,
        })
        .from(memoryChunks)
        .where(and(eq(memoryChunks.chatId, chatId), inArray(memoryChunks.id, [...chunkIds])))
        .limit(chunkIds.size + 1);
      if (current.length > chunkIds.size) return null;
      const byId = new Map(current.map((chunk) => [chunk.id, chunk]));
      for (const chunkId of chunkIds) {
        const chunk = byId.get(chunkId);
        const first = chunk ? Date.parse(chunk.firstMessageAt) : NaN;
        const last = chunk ? Date.parse(chunk.lastMessageAt) : NaN;
        const valid = Number.isFinite(first) && Number.isFinite(last) && first <= last;
        // A missing locator does not prove deletion. Its raw coverage is unknown
        // until resolved or explicitly released, so hold this source chat only.
        spans.push({ chatId, chunkId, first: valid ? first : null, last: valid ? last : null });
      }
    }
    return spans;
  } catch {
    return null;
  }
}

export function cmbCompressedSourceOverlaps(
  spans: readonly SourceSpan[],
  chunk: { id?: string; chatId: string; firstMessageAt: string; lastMessageAt: string },
): boolean {
  const first = Date.parse(chunk.firstMessageAt);
  const last = Date.parse(chunk.lastMessageAt);
  return spans.some(
    (span) =>
      span.chatId === chunk.chatId &&
      (span.chunkId === chunk.id ||
        span.first === null ||
        span.last === null ||
        !Number.isFinite(first) ||
        !Number.isFinite(last) ||
        first > last ||
        (first <= span.last && last >= span.first)),
  );
}
