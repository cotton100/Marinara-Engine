import type {
  CapabilityConversationCallContext,
  CapabilityConversationCallContextInput,
  LorebookEntry,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, desc, eq, gte, inArray, lt } from "../../db/file-query.js";
import {
  appSettings,
  characters,
  chats,
  installedExtensions,
  lorebookEntries,
  messages,
  personalExtensionCoordination,
} from "../../db/schema/index.js";
import {
  hasActiveCmbCompression,
  loadCmbCompressedSourceSpans,
  resolveCmbCompressionEntries,
} from "../lorebook/cmb-compression-retrieval.js";
import { lorebookEntryPassesContextFilters } from "../lorebook/keyword-scanner.js";
import { resolveLorebookScopeExclusions } from "../lorebook/game-lorebook-scope.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";
import { isApprovedClientCmb, parseCmbConfig } from "./autonomous-cmb-context.service.js";
import {
  isCmbSourceMessageRestricted,
  resolveCmbSourceRestrictions,
  type CmbSourceRestriction,
} from "./cmb-source-visibility.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function json(value: string): unknown {
  if (value.length > 4 * 1024 * 1024) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function ids(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 2048) return null;
  return value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id)
    ? [...new Set(value as string[])]
    : null;
}

/** Configuration authentication and shape validation use the existing CMB host validators. */
export async function loadCmbConfig(db: DB) {
  const extensions = await db
    .select()
    .from(installedExtensions)
    .where(and(eq(installedExtensions.name, "Convo Memory Bridge"), eq(installedExtensions.runtime, "client")))
    .limit(9);
  const approved = extensions.filter(isApprovedClientCmb);
  if (extensions.length > 8 || approved.length !== 1) return null;
  const extension = approved[0]!;
  const coordination = await db
    .select({ mode: personalExtensionCoordination.mode, contentHash: personalExtensionCoordination.contentHash })
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, extension.id))
    .limit(2);
  if (
    coordination.length !== 1 ||
    coordination[0]!.mode !== "active" ||
    coordination[0]!.contentHash !== extension.contentHash
  )
    return null;
  const settings = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, `extension-storage:${extension.id}`))
    .limit(2);
  if (settings.length !== 1 || Buffer.byteLength(settings[0]!.value, "utf8") > 1_000_000) return null;
  return parseCmbConfig(record(json(settings[0]!.value))?.convoMemoryBridgeV1);
}

async function sourceRestrictions(db: DB, chatId: string, audience: string[], eligibleIds: Set<string>) {
  // Include disabled/excluded memories: their source messages must not reopen through today's tail.
  // This projection deliberately omits original bodies and vectors.
  const entries = await db
    .select({
      id: lorebookEntries.id,
      lorebookId: lorebookEntries.lorebookId,
      enabled: lorebookEntries.enabled,
      characterFilterMode: lorebookEntries.characterFilterMode,
      characterFilterIds: lorebookEntries.characterFilterIds,
      dynamicState: lorebookEntries.dynamicState,
    })
    .from(lorebookEntries)
    .where(eq(lorebookEntries.tag, "convo-memory-bridge"))
    .limit(2049);
  if (entries.length === 0) return [];
  if (entries.length > 2048) return null;
  let metadataChars = 0;
  const relevant = [];
  // A lost native source has no locator, so its covered room is only known through its ensemble.
  const missing = [];
  for (const entry of entries) {
    metadataChars += entry.dynamicState.length;
    if (metadataChars > 4 * 1024 * 1024) return null;
    const bridge = record(record(json(entry.dynamicState))?.convoMemoryBridge);
    const source = record(bridge?.source);
    if (source?.kind === "manual") continue;
    if (source?.kind !== "native-memory-chunk" || !Array.isArray(source.occurrences)) return null;
    if (!source.occurrences.length) {
      // CMB sync records a vanished source chunk as `missing` with no occurrences.
      if (bridge?.sourceStatus !== "missing") return null;
      // Visible to this whole audience: there is nothing to hide, wherever its source was.
      if (
        eligibleIds.has(entry.id) &&
        !hasActiveCmbCompression(entry.dynamicState) &&
        Array.isArray(bridge.unknownToCastIds) &&
        bridge.unknownToCastIds.length === 0
      )
        continue;
      missing.push(entry);
      continue;
    }
    if (source.occurrences.some((occurrence) => record(occurrence)?.chatId === chatId)) relevant.push(entry);
  }
  if (relevant.length === 0 && missing.length === 0) return [];
  const spans = relevant.length
    ? await loadCmbCompressedSourceSpans(db, { entries: relevant, sourceChatIds: [chatId] })
    : [];
  if (spans === null) return null;
  const restrictions: CmbSourceRestriction[] = spans.map((span) => ({
    chatId: span.chatId,
    firstMessageAt: span.first === null ? null : new Date(span.first).toISOString(),
    lastMessageAt: span.last === null ? null : new Date(span.last).toISOString(),
  }));
  const config = await loadCmbConfig(db);
  if (!config) return null;
  // Unknown ownership cannot be treated as permission to expose raw source messages.
  const owned = (entry: { lorebookId: string }) =>
    config.ensembles.some((ensemble) => ensemble.lorebookId === entry.lorebookId);
  if (!relevant.every(owned) || !missing.every(owned)) return null;
  for (const ensemble of config.ensembles) {
    const rooms = [ensemble.rpChatId, ...ensemble.groupConvoChatIds, ...ensemble.members.map((m) => m.dmChatId)];
    const scoped = [
      ...relevant.filter((entry) => entry.lorebookId === ensemble.lorebookId),
      // A lost source can only have covered this ensemble's own rooms; other chats are unaffected.
      ...(rooms.includes(chatId) ? missing.filter((entry) => entry.lorebookId === ensemble.lorebookId) : []),
    ];
    if (!scoped.length) continue;
    const resolved = resolveCmbSourceRestrictions(
      scoped.map((entry) => (eligibleIds.has(entry.id) ? entry : { ...entry, enabled: "false" })),
      ensemble,
      audience,
    );
    if (resolved === null) return null;
    restrictions.push(...resolved);
  }
  return restrictions;
}

function messageVisible(extra: string, audience: string[]): boolean {
  const value = record(json(extra));
  if (!value || value.hiddenFromAI === true || value.commandOnly === true) return false;
  if (value.hiddenFromAICharacterIds === undefined) return true;
  const hidden = ids(value.hiddenFromAICharacterIds);
  return hidden !== null && !audience.some((id) => hidden.includes(id));
}

/** Resolve one shared call prompt in a single read transaction, before handing text to the package. */
export async function resolveConversationCallContext(
  db: DB,
  input: CapabilityConversationCallContextInput,
): Promise<CapabilityConversationCallContext> {
  const audience = ids(input.audienceCharacterIds);
  if (!audience?.length || audience.length > 32 || typeof input.query !== "string")
    throw new Error("Invalid conversation call audience");
  return db.transaction(async (tx) => {
    const chat = (
      await tx
        .select({
          id: chats.id,
          mode: chats.mode,
          characterIds: chats.characterIds,
          personaId: chats.personaId,
          metadata: chats.metadata,
        })
        .from(chats)
        .where(eq(chats.id, input.chatId))
        .limit(1)
    )[0];
    const chatCharacters = chat ? ids(json(chat.characterIds)) : null;
    const metadata = chat ? record(json(chat.metadata)) : null;
    if (!chat || !chatCharacters || !metadata || audience.some((id) => !chatCharacters.includes(id)))
      throw new Error("Conversation call audience does not belong to the chat");
    const activeLorebookIds = ids(metadata.activeLorebookIds ?? []);
    const overrides = record(metadata.entryStateOverrides ?? metadata.lorebookEntryStateOverrides ?? {});
    if (!activeLorebookIds || !ids(metadata.excludedLorebookIds ?? []) || !overrides)
      throw new Error("Invalid conversation call lorebook scope");
    const exclusions = resolveLorebookScopeExclusions(chat.mode, metadata);
    const cards = await tx
      .select({ id: characters.id, data: characters.data })
      .from(characters)
      .where(inArray(characters.id, audience));
    if (cards.length !== audience.length) throw new Error("Conversation call character is unavailable");
    const tagsByCharacter = new Map(cards.map((card) => [card.id, ids(record(json(card.data))?.tags ?? []) ?? []]));
    const activeCharacterTags = [...new Set([...tagsByCharacter.values()].flat())];
    const candidates = (await createLorebooksStorage(tx).listActiveEntries(
      {
        activeLorebookIds,
        characterIds: audience,
        personaId: chat.personaId ?? undefined,
        chatId: chat.id,
        ...exclusions,
      },
      true,
    )) as LorebookEntry[];
    const eligible = candidates.filter((entry) => {
      const override = overrides[entry.id];
      if (
        override !== undefined &&
        (!record(override) ||
          (record(override)!.enabled !== undefined && typeof record(override)!.enabled !== "boolean"))
      )
        return false;
      if (record(override)?.enabled === false) return false;
      // A merged prompt is visible to every speaker, including ordinary entry filters.
      return audience.every((id) =>
        lorebookEntryPassesContextFilters(entry, {
          activeCharacterIds: [id],
          activeCharacterTags: tagsByCharacter.get(id),
          generationTriggers: ["conversation_call"],
        }),
      );
    });
    const selected = await resolveCmbCompressionEntries(tx, eligible, {
      audienceCharacterIds: audience,
      contextCharacterIds: audience,
      activeCharacterTags,
      generationTriggers: ["conversation_call"],
      query: input.query,
    });
    const restrictions = await sourceRestrictions(tx, chat.id, audience, new Set(eligible.map((entry) => entry.id)));
    let recentMessages: CapabilityConversationCallContext["recentMessages"] = [];
    if (restrictions !== null) {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const recent = await tx
        .select({
          role: messages.role,
          characterId: messages.characterId,
          content: messages.content,
          createdAt: messages.createdAt,
          extra: messages.extra,
        })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, chat.id),
            gte(messages.createdAt, start.toISOString()),
            lt(messages.createdAt, end.toISOString()),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(40);
      recent.reverse();
      // Apply reset boundaries before hidden markers are removed. Every speaker
      // shares this prompt, so the latest boundary of any participant wins.
      let startIndex = 0;
      for (const [index, message] of recent.entries()) {
        const extra = record(json(message.extra));
        const starts = extra ? ids(extra.conversationStartForCharacterIds ?? []) : null;
        if (
          !extra ||
          starts === null ||
          (extra.isConversationStart !== undefined && typeof extra.isConversationStart !== "boolean")
        ) {
          startIndex = recent.length;
          break;
        }
        if (extra.isConversationStart === true || starts.some((id) => audience.includes(id))) startIndex = index;
      }
      recentMessages = recent
        .slice(startIndex)
        .filter(
          (message) =>
            messageVisible(message.extra, audience) &&
            !isCmbSourceMessageRestricted(restrictions, chat.id, message.createdAt),
        )
        .map(({ extra: _extra, ...message }) => message);
    }
    return {
      lorebookEntries: selected.slice(0, 30).map(({ id, name, content }) => ({ id, name, content })),
      recentMessages,
    };
  });
}
