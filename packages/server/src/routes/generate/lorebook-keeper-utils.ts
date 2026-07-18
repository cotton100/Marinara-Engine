import type { AgentContext, Lorebook, LorebookEntry } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import {
  filterLorebookEntriesForPromptContext,
  type LorebookPromptContext,
} from "../../services/lorebook/keyword-scanner.js";
import {
  filterAccessibleLorebooks,
  lorebookEntryMatchesCharacterWriteScope,
  lorebookIsWritableInAccessContext,
  type LorebookAccessContext,
} from "../../services/lorebook/access-context.js";
import { createLorebooksStorage } from "../../services/storage/lorebooks.storage.js";

export interface LorebookKeeperSettings {
  targetLorebookId: string | null;
  readBehindMessages: number;
}

export interface ExistingLorebookEntrySummary {
  id: string;
  name: string;
  content: string;
  keys: string[];
  locked: boolean;
}

type LorebooksStore = ReturnType<typeof createLorebooksStorage>;

type LorebookKeeperMessage = {
  id: string;
  role: string;
  content: string;
  characterId?: string | null;
};

export function applyLorebookKeeperRunMemoryScope(args: {
  baseMemory: Record<string, unknown>;
  accessContext: LorebookAccessContext;
  newEntryCharacterFilterIds?: readonly string[];
  targetLorebookId: string | null;
  targetLorebookName: string | null;
  existingEntries: readonly ExistingLorebookEntrySummary[];
}): Record<string, unknown> {
  const memory: Record<string, unknown> = {
    ...args.baseMemory,
    _lorebookAccessContext: args.accessContext,
    _lorebookKeeperTargetLorebookId: args.targetLorebookId,
    _lorebookKeeperTargetLorebookName: args.targetLorebookName,
  };
  delete memory._newLorebookEntryCharacterFilterIds;
  if (args.newEntryCharacterFilterIds !== undefined) {
    memory._newLorebookEntryCharacterFilterIds = [...args.newEntryCharacterFilterIds];
  }
  delete memory._existingLorebookEntries;
  if (args.existingEntries.length > 0) {
    memory._existingLorebookEntries = [...args.existingEntries];
  }
  return memory;
}

const MAX_READ_BEHIND_MESSAGES = 100;

function normalizeNonNegativeInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

function isEnabledLorebook(value: unknown): boolean {
  return value === true || value === "true";
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

function getAssistantMessages<T extends { id: string; role: string }>(messages: T[]): T[] {
  return messages.filter((message) => message.role === "assistant");
}

function findMessageIndex<T extends { id: string }>(messages: T[], messageId: string | null): number {
  if (!messageId) return -1;
  return messages.findIndex((message) => message.id === messageId);
}

export function getLorebookKeeperSettings(chatMeta: Record<string, unknown>): LorebookKeeperSettings {
  const targetLorebookId =
    typeof chatMeta.lorebookKeeperTargetLorebookId === "string" && chatMeta.lorebookKeeperTargetLorebookId.trim()
      ? chatMeta.lorebookKeeperTargetLorebookId.trim()
      : null;

  return {
    targetLorebookId,
    readBehindMessages: normalizeNonNegativeInteger(
      chatMeta.lorebookKeeperReadBehindMessages,
      0,
      MAX_READ_BEHIND_MESSAGES,
    ),
  };
}

export async function resolveLorebookKeeperTarget(args: {
  lorebooksStore: LorebooksStore;
  accessContext: LorebookAccessContext;
  preferredTargetLorebookId: string | null;
}): Promise<{
  writableLorebookIds: string[];
  targetLorebookId: string | null;
  targetLorebookName: string | null;
}> {
  const { lorebooksStore, accessContext, preferredTargetLorebookId } = args;
  const allBooks = (await lorebooksStore.list()) as unknown as Lorebook[];
  const accessibleBooks = filterAccessibleLorebooks(allBooks, accessContext, { requireEnabled: false });
  const relevantBooks = accessibleBooks.filter(
    (book) => isEnabledLorebook(book.enabled) || (!!preferredTargetLorebookId && book.id === preferredTargetLorebookId),
  );

  const uniqueBooks = [...new Map(relevantBooks.map((book) => [book.id, book])).values()];
  uniqueBooks.sort((left, right) => {
    const leftPreferred = preferredTargetLorebookId && left.id === preferredTargetLorebookId ? 0 : 1;
    const rightPreferred = preferredTargetLorebookId && right.id === preferredTargetLorebookId ? 0 : 1;
    if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;

    const leftChatScoped = left.chatId === accessContext.chatId ? 0 : 1;
    const rightChatScoped = right.chatId === accessContext.chatId ? 0 : 1;
    return leftChatScoped - rightChatScoped;
  });

  const writableLorebookIds = uniqueBooks.map((book) => book.id);
  const targetLorebookId =
    preferredTargetLorebookId && writableLorebookIds.includes(preferredTargetLorebookId)
      ? preferredTargetLorebookId
      : (writableLorebookIds[0] ?? null);
  const targetLorebookName = uniqueBooks.find((book) => book.id === targetLorebookId)?.name?.trim() ?? null;

  return { writableLorebookIds, targetLorebookId, targetLorebookName };
}

export async function loadLorebookKeeperExistingEntries(
  lorebooksStore: LorebooksStore,
  targetLorebookId: string | null,
  lorebookPromptContext?: LorebookPromptContext,
): Promise<ExistingLorebookEntrySummary[]> {
  if (!targetLorebookId) return [];

  const rawEntries = (await lorebooksStore.listEntries(targetLorebookId)) as LorebookEntry[];
  const entries = lorebookPromptContext
    ? filterLorebookEntriesForPromptContext(rawEntries, lorebookPromptContext)
    : rawEntries;

  return entries
    .filter((entry) => typeof entry.name === "string" && entry.name.trim().length > 0)
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      name: entry.name!.trim(),
      content: typeof entry.content === "string" ? entry.content : "",
      keys: Array.isArray(entry.keys) ? entry.keys.filter((key) => typeof key === "string") : [],
      locked: isTruthyFlag(entry.locked),
    }));
}

export function getLorebookKeeperAutomaticTarget<T extends { id: string; role: string }>(
  messages: T[],
  readBehindMessages: number,
): T | null {
  if (readBehindMessages <= 0) return null;
  const assistants = getAssistantMessages(messages);
  return assistants[assistants.length - readBehindMessages] ?? null;
}

export function getLorebookKeeperAutomaticPendingCount<T extends { id: string; role: string }>(
  messages: T[],
  readBehindMessages: number,
  lastProcessedMessageId: string | null,
): number {
  const assistants = getAssistantMessages(messages);
  const targetIndex = readBehindMessages <= 0 ? assistants.length : assistants.length - readBehindMessages;
  if (targetIndex < 0) return 0;

  const lastProcessedIndex = findMessageIndex(assistants, lastProcessedMessageId);
  if (lastProcessedIndex >= 0) {
    return Math.max(targetIndex - lastProcessedIndex, 0);
  }
  return targetIndex + 1;
}

export function getLorebookKeeperBackfillTargets<T extends { id: string; role: string }>(
  messages: T[],
  readBehindMessages: number,
  lastProcessedMessageId: string | null,
): T[] {
  const assistants = getAssistantMessages(messages);
  const eligibleCount = Math.max(assistants.length - Math.max(readBehindMessages, 0), 0);
  const eligibleAssistants = assistants.slice(0, eligibleCount);
  const lastProcessedIndex = findMessageIndex(eligibleAssistants, lastProcessedMessageId);
  return lastProcessedIndex >= 0 ? eligibleAssistants.slice(lastProcessedIndex + 1) : eligibleAssistants;
}

export function buildHistoricalLorebookKeeperContext<T extends LorebookKeeperMessage>(
  baseContext: AgentContext,
  messages: T[],
  targetMessageId: string,
): AgentContext | null {
  const targetIndex = messages.findIndex((message) => message.id === targetMessageId);
  if (targetIndex < 0) return null;

  const targetMessage = messages[targetIndex]!;
  return {
    ...baseContext,
    recentMessages: messages.slice(0, targetIndex).map((message) => ({
      role: message.role,
      content: message.content,
      characterId: message.characterId ?? undefined,
    })),
    mainResponse: targetMessage.content,
  };
}

function normalizeKeeperFact(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/^(?:[-*]|\u2022)\s+/, "")
    .replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizeKeeperFactForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKeeperFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const entry of value) {
    const fact = normalizeKeeperFact(entry);
    if (!fact) continue;
    const comparable = normalizeKeeperFactForComparison(fact);
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    facts.push(fact);
  }
  return facts;
}

function dedupeKeeperContentParagraphs(content: string): string {
  const paragraphs = content
    .split(/\r?\n\s*\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const paragraph of paragraphs) {
    const comparable = normalizeKeeperFactForComparison(paragraph);
    if (!comparable || seen.has(comparable)) continue;
    seen.add(comparable);
    deduped.push(paragraph);
  }

  return deduped.join("\n\n");
}

function mergeLorebookKeys(existingKeys: unknown, newKeys: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const add = (key: unknown) => {
    if (typeof key !== "string") return;
    const trimmed = key.trim();
    if (!trimmed) return;
    const comparable = trimmed.toLowerCase();
    if (seen.has(comparable)) return;
    seen.add(comparable);
    merged.push(trimmed);
  };

  if (Array.isArray(existingKeys)) {
    for (const key of existingKeys) add(key);
  }
  for (const key of newKeys) add(key);
  return merged;
}

export function mergeLorebookKeeperUpdateContent(args: {
  existingContent: unknown;
  replacementContent: unknown;
  newFacts: unknown;
}): string {
  const existing = typeof args.existingContent === "string" ? dedupeKeeperContentParagraphs(args.existingContent) : "";
  const replacement =
    typeof args.replacementContent === "string" ? dedupeKeeperContentParagraphs(args.replacementContent) : "";
  const facts = normalizeKeeperFacts(args.newFacts);

  if (facts.length === 0) {
    if (!existing) return replacement;
    if (!replacement) return existing;

    const existingComparable = normalizeKeeperFactForComparison(existing);
    const replacementComparable = normalizeKeeperFactForComparison(replacement);
    if (replacementComparable.includes(existingComparable)) return replacement;
    if (existingComparable.includes(replacementComparable)) return existing;

    return dedupeKeeperContentParagraphs(`${existing}\n\n${replacement}`);
  }

  const baseContent =
    existing && replacement ? dedupeKeeperContentParagraphs(`${existing}\n\n${replacement}`) : existing || replacement;
  const existingComparable = normalizeKeeperFactForComparison(baseContent);
  const novelFacts = facts.filter((fact) => {
    const comparable = normalizeKeeperFactForComparison(fact);
    return comparable.length > 0 && !existingComparable.includes(comparable);
  });

  if (novelFacts.length === 0) return baseContent;

  const addition = novelFacts.map((fact) => `- ${fact}`).join("\n");
  return baseContent ? `${baseContent}\n\n${addition}` : addition;
}

function readNestedEntry(update: Record<string, unknown>): Record<string, unknown> {
  return update.entry && typeof update.entry === "object" && !Array.isArray(update.entry)
    ? (update.entry as Record<string, unknown>)
    : {};
}

function readKeeperUpdateName(update: Record<string, unknown>): string {
  const nestedEntry = readNestedEntry(update);
  const rawName =
    typeof update.entryName === "string"
      ? update.entryName
      : typeof update.name === "string"
        ? update.name
        : typeof nestedEntry.name === "string"
          ? nestedEntry.name
          : "";
  return rawName.trim();
}

function readKeeperUpdateContent(update: Record<string, unknown>): string {
  const nestedEntry = readNestedEntry(update);
  return typeof update.content === "string"
    ? update.content
    : typeof nestedEntry.content === "string"
      ? nestedEntry.content
      : "";
}

function readKeeperUpdateKeys(update: Record<string, unknown>): string[] {
  const nestedEntry = readNestedEntry(update);
  const rawKeys = Array.isArray(update.keys) ? update.keys : Array.isArray(nestedEntry.keys) ? nestedEntry.keys : [];
  return rawKeys.filter((key): key is string => typeof key === "string");
}

function readKeeperUpdateTag(update: Record<string, unknown>): string {
  const nestedEntry = readNestedEntry(update);
  return typeof update.tag === "string" ? update.tag : typeof nestedEntry.tag === "string" ? nestedEntry.tag : "";
}

export async function persistLorebookKeeperUpdates(args: {
  lorebooksStore: LorebooksStore;
  chatId: string;
  chatName: string | null | undefined;
  preferredTargetLorebookId: string | null;
  writableLorebookIds: string[] | null;
  updates: Array<Record<string, unknown>>;
  revectorizeEntry?: (entry: LorebookEntry) => Promise<void>;
  lorebookPromptContext?: LorebookPromptContext;
  newEntryCharacterFilterIds?: string[];
  accessContext?: LorebookAccessContext;
  allowCreateTarget?: boolean;
}): Promise<string | null> {
  const {
    lorebooksStore,
    chatId,
    chatName,
    preferredTargetLorebookId,
    writableLorebookIds,
    updates,
    revectorizeEntry,
    lorebookPromptContext,
    newEntryCharacterFilterIds,
    accessContext,
    allowCreateTarget = true,
  } = args;

  const requestedTargetIds = Array.from(
    new Set([preferredTargetLorebookId, ...(writableLorebookIds ?? [])].filter((id): id is string => !!id)),
  );
  let targetLorebookId: string | null = null;
  for (const candidateId of requestedTargetIds) {
    if (!accessContext) {
      targetLorebookId = candidateId;
      break;
    }
    const candidate = (await lorebooksStore.getById(candidateId)) as unknown as Lorebook | null;
    if (candidate && lorebookIsWritableInAccessContext(candidate, accessContext)) {
      targetLorebookId = candidateId;
      break;
    }
  }
  if (!targetLorebookId) {
    if (!allowCreateTarget) return null;
    const created = await lorebooksStore.create({
      name: `Auto-generated (${chatName || chatId})`,
      description: "Automatically created by the Lorebook Keeper agent",
      category: "uncategorized",
      chatId,
      enabled: true,
      generatedBy: "agent",
      sourceAgentId: "lorebook-keeper",
    });
    targetLorebookId = (created as { id?: string } | null)?.id ?? null;
  }

  if (!targetLorebookId) return null;

  const rawExistingEntries = (await lorebooksStore.listEntries(targetLorebookId)) as LorebookEntry[];
  const promptVisibleEntries = lorebookPromptContext
    ? filterLorebookEntriesForPromptContext(rawExistingEntries, lorebookPromptContext)
    : rawExistingEntries;
  const existingEntries =
    newEntryCharacterFilterIds === undefined
      ? promptVisibleEntries
      : promptVisibleEntries.filter((entry) =>
          lorebookEntryMatchesCharacterWriteScope(entry, newEntryCharacterFilterIds),
        );
  const entryByName = new Map<string, (typeof existingEntries)[number]>();
  for (const entry of existingEntries) {
    const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
    if (name) entryByName.set(name, entry);
  }

  for (const update of updates) {
    const rawName = readKeeperUpdateName(update);
    if (!rawName) continue;

    const content = readKeeperUpdateContent(update);
    const keys = readKeeperUpdateKeys(update);
    const tag = readKeeperUpdateTag(update);
    const existing = entryByName.get(rawName.toLowerCase());

    if (existing && isTruthyFlag(existing.locked)) {
      continue;
    }

    if (existing) {
      const mergedContent = mergeLorebookKeeperUpdateContent({
        existingContent: existing.content,
        replacementContent: content,
        newFacts: update.newFacts,
      });
      const mergedKeys = mergeLorebookKeys(existing.keys, keys);
      const mergedTag = tag || existing.tag || "";
      const updated = await lorebooksStore.updateEntry(existing.id, {
        content: mergedContent,
        keys: mergedKeys,
        tag: mergedTag,
      });
      if (revectorizeEntry && updated) {
        try {
          await revectorizeEntry(updated as LorebookEntry);
        } catch (err) {
          logger.warn(err, "[lorebook-keeper] Failed to refresh embedding for updated entry %s", existing.id);
        }
      }
      entryByName.set(rawName.toLowerCase(), {
        ...existing,
        content: mergedContent,
        keys: mergedKeys,
        tag: mergedTag,
      });
      continue;
    }

    const createContent = mergeLorebookKeeperUpdateContent({
      existingContent: "",
      replacementContent: content,
      newFacts: update.newFacts,
    });
    const created = await lorebooksStore.createEntry({
      lorebookId: targetLorebookId,
      name: rawName,
      content: createContent,
      keys,
      tag,
      enabled: true,
      ...(newEntryCharacterFilterIds?.length
        ? {
            characterFilterMode: "include",
            characterFilterIds: Array.from(new Set(newEntryCharacterFilterIds)),
          }
        : {}),
    });
    if (created && typeof created === "object" && "id" in created) {
      const createdEntry = created as unknown as LorebookEntry;
      entryByName.set(rawName.toLowerCase(), {
        ...createdEntry,
        name: createdEntry.name ?? rawName,
        content: createContent,
        keys,
        tag,
      });
    }
  }

  return targetLorebookId;
}
