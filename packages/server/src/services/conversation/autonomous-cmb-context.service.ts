import {
  PERSONAL_EXTENSION_FULL_PAGE_CAPABILITY,
  normalizePersonalExtensionCapabilities,
  type PersonalExtensionCapability,
  type PersonalExtensionSource,
  type WrapFormat,
} from "@marinara-engine/shared";

import { and, desc, eq, inArray } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import {
  appSettings,
  characters,
  chats,
  installedExtensions,
  lorebookEntries,
  messages,
  personalExtensionCoordination,
  personas,
} from "../../db/schema/index.js";
import { computePersonalExtensionHash } from "../extensions/personal-extension-hash.js";
import { wrapContent } from "../prompt/format-engine.js";
import { sanitizePromptLeaf } from "../prompt/prompt-escaping.js";
import { formatZonedConversationDate, formatZonedConversationTime } from "./timezone.js";

const CMB_EXTENSION_NAME = "Convo Memory Bridge";
const CMB_STORAGE_KEY = "convoMemoryBridgeV1";
const EXTENSION_STORAGE_PREFIX = "extension-storage:";
const CMB_SCHEMA_VERSION = 1;
const RECENT_MESSAGE_SCAN_LIMIT = 250;

// A malformed or unexpectedly large CMB graph is safer to ignore than to scan
// without a stable upper bound on the autonomous-generation path.
const MAX_MATCHING_EXTENSION_ROWS = 8;
const MAX_CONFIG_BYTES = 1_000_000;
const MAX_ENSEMBLES = 32;
const MAX_MEMBERS_PER_ENSEMBLE = 32;
const MAX_GROUP_SOURCES_PER_ENSEMBLE = 12;
const MAX_MAPPED_SOURCES = MAX_GROUP_SOURCES_PER_ENSEMBLE + 1;
const MAX_MANAGED_CMB_ENTRIES_PER_ENSEMBLE = 2048;
const MAX_OUTPUT_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 750;
const MANAGED_CMB_ENTRY_TAG = "convo-memory-bridge";

const CAST_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

type ExtensionRow = typeof installedExtensions.$inferSelect;
type ChatRow = Pick<typeof chats.$inferSelect, "id" | "name" | "mode" | "characterIds" | "metadata" | "personaId">;

type CmbMember = {
  castId: string;
  characterId: string;
  dmChatId: string;
};

type CmbEnsemble = {
  ensembleId: string;
  name: string;
  lorebookId: string;
  rpChatId: string;
  groupConvoChatIds: string[];
  members: CmbMember[];
};

type CmbConfig = {
  ensembles: CmbEnsemble[];
};

type SourceDescriptor = {
  chat: ChatRow;
  sourceIndex: number;
  chatRole: "rp" | "group";
};

type TargetMapping = {
  ensemble: CmbEnsemble;
  targetRole: "dm" | "group";
};

type PendingMessage = {
  sourceIndex: number;
  chatId: string;
  chatName: string;
  id: string;
  role: string;
  characterId: string | null;
  content: string;
  createdAt: string;
  userName: string;
};

type RecentMessage = {
  id: string;
  chatId: string;
  role: string;
  characterId: string | null;
  content: string;
  extra: string;
  createdAt: string;
};

type ManagedCmbEntry = {
  id: string;
  enabled: string;
  characterFilterMode: string;
  characterFilterIds: string;
  excludeFromVectorization: string;
  embeddingSpaceId: string | null;
  dynamicState: string;
};

type AutonomousCmbPendingContextInput = {
  db: DB;
  targetChatId: string;
  targetCharacterId: string;
  timeZone?: string;
  wrapFormat?: WrapFormat;
  /** Regression-only shortening; production callers cannot extend the 750ms ceiling. */
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableString(value: unknown, maxChars = MAX_ID_CHARS): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && value.trim() === value
    ? value
    : null;
}

function parseStableStringArray(value: unknown, maxItems: number): string[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    if (Buffer.byteLength(parsed, "utf8") > MAX_CONFIG_BYTES) return null;
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length > maxItems) return null;
  const values: string[] = [];
  for (const item of parsed) {
    const normalized = stableString(item);
    if (normalized === null) return null;
    values.push(normalized);
  }
  return new Set(values).size === values.length ? values : null;
}

function parseExtensionSource(value: unknown): PersonalExtensionSource {
  return value === "external" || value === "local" || value === "professor_mari" || value === "profile_import"
    ? value
    : "legacy";
}

function parseCapabilities(value: unknown, source: PersonalExtensionSource): PersonalExtensionCapability[] | null {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const normalized = normalizePersonalExtensionCapabilities(parsed);
  return source === "professor_mari"
    ? normalized.filter((capability) => capability !== PERSONAL_EXTENSION_FULL_PAGE_CAPABILITY)
    : normalized;
}

function isApprovedClientCmb(row: ExtensionRow): boolean {
  if (row.name !== CMB_EXTENSION_NAME || row.runtime !== "client" || row.enabled !== "true") return false;
  const source = parseExtensionSource(row.source);
  const capabilities = parseCapabilities(row.capabilities, source);
  if (capabilities === null) return false;
  const actualHash = computePersonalExtensionHash({
    runtime: "client",
    capabilities,
    css: row.css ?? null,
    js: row.js ?? null,
    serverJs: null,
  });
  return row.contentHash === actualHash && row.approvedHash === actualHash;
}

function parseCmbConfig(value: unknown): CmbConfig | null {
  if (!isRecord(value) || value.schemaVersion !== CMB_SCHEMA_VERSION || !Array.isArray(value.ensembles)) return null;
  if (value.ensembles.length === 0 || value.ensembles.length > MAX_ENSEMBLES) return null;

  const ensembles: CmbEnsemble[] = [];
  const ensembleIds = new Set<string>();
  const lorebookIds = new Set<string>();
  const mappedChatIds = new Set<string>();

  for (const rawEnsemble of value.ensembles) {
    if (!isRecord(rawEnsemble)) return null;
    const ensembleId = stableString(rawEnsemble.ensembleId);
    const name = stableString(rawEnsemble.name, MAX_NAME_CHARS);
    const rpChatId = stableString(rawEnsemble.rpChatId);
    const lorebookId = stableString(rawEnsemble.lorebookId);
    const groupConvoChatIds = parseStableStringArray(rawEnsemble.groupConvoChatIds, MAX_GROUP_SOURCES_PER_ENSEMBLE);
    if (
      ensembleId === null ||
      name === null ||
      rpChatId === null ||
      lorebookId === null ||
      groupConvoChatIds === null ||
      !Array.isArray(rawEnsemble.members) ||
      rawEnsemble.members.length === 0 ||
      rawEnsemble.members.length > MAX_MEMBERS_PER_ENSEMBLE
    ) {
      return null;
    }
    if (ensembleIds.has(ensembleId) || lorebookIds.has(lorebookId)) return null;
    ensembleIds.add(ensembleId);
    lorebookIds.add(lorebookId);

    const members: CmbMember[] = [];
    const castIds = new Set<string>();
    const characterIds = new Set<string>();
    for (const rawMember of rawEnsemble.members) {
      if (!isRecord(rawMember)) return null;
      const castId = stableString(rawMember.castId, 64);
      const characterId = stableString(rawMember.characterId);
      const dmChatId = stableString(rawMember.dmChatId);
      if (
        castId === null ||
        !CAST_ID_PATTERN.test(castId) ||
        characterId === null ||
        dmChatId === null ||
        castIds.has(castId) ||
        characterIds.has(characterId)
      ) {
        return null;
      }
      castIds.add(castId);
      characterIds.add(characterId);
      members.push({ castId, characterId, dmChatId });
    }

    const ensembleChatIds = [rpChatId, ...groupConvoChatIds, ...members.map((member) => member.dmChatId)];
    if (new Set(ensembleChatIds).size !== ensembleChatIds.length) return null;
    for (const chatId of ensembleChatIds) {
      if (mappedChatIds.has(chatId)) return null;
      mappedChatIds.add(chatId);
    }
    ensembles.push({ ensembleId, name, lorebookId, rpChatId, groupConvoChatIds, members });
  }

  return { ensembles };
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseCharacterName(data: string): string | null {
  if (Buffer.byteLength(data, "utf8") > MAX_CONFIG_BYTES) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) ? stableString(parsed.name, MAX_NAME_CHARS) : null;
  } catch {
    return null;
  }
}

function parseChatState(chat: ChatRow): { activeCharacterIds: string[]; metadata: Record<string, unknown> } | null {
  const characterIds = parseStableStringArray(chat.characterIds, MAX_MEMBERS_PER_ENSEMBLE * 2);
  if (characterIds === null || Buffer.byteLength(chat.metadata, "utf8") > MAX_CONFIG_BYTES) return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(chat.metadata) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(metadata)) return null;
  const inactiveCharacterIds = Object.hasOwn(metadata, "inactiveCharacterIds")
    ? parseStableStringArray(metadata.inactiveCharacterIds, MAX_MEMBERS_PER_ENSEMBLE * 2)
    : [];
  if (
    inactiveCharacterIds === null ||
    inactiveCharacterIds.some((characterId) => !characterIds.includes(characterId))
  ) {
    return null;
  }
  const inactive = new Set(inactiveCharacterIds);
  return {
    activeCharacterIds: characterIds.filter((characterId) => !inactive.has(characterId)),
    metadata,
  };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value))
  );
}

function parseLiveNativeBoundary(
  value: unknown,
  ensembleId: string,
  chatId: string,
  chatRole: "rp" | "group",
): string | null {
  if (!isRecord(value)) return null;
  const bridge = isRecord(value.convoMemoryBridge) ? value.convoMemoryBridge : null;
  if (
    bridge === null ||
    bridge.schemaVersion !== CMB_SCHEMA_VERSION ||
    bridge.ensembleId !== ensembleId ||
    (Object.hasOwn(bridge, "sourceStatus") && bridge.sourceStatus !== null)
  ) {
    return null;
  }
  const source = isRecord(bridge.source) ? bridge.source : null;
  if (
    source === null ||
    source.kind !== "native-memory-chunk" ||
    !canonicalIsoTimestamp(source.firstMessageAt) ||
    !canonicalIsoTimestamp(source.lastMessageAt) ||
    source.firstMessageAt > source.lastMessageAt ||
    !Array.isArray(source.occurrences)
  ) {
    return null;
  }
  if (source.occurrences.length === 0 || source.occurrences.length > MAX_MAPPED_SOURCES) return null;
  const occurrenceKeys = new Set<string>();
  for (const occurrence of source.occurrences) {
    if (!isRecord(occurrence)) return null;
    const occurrenceChatId = stableString(occurrence.chatId);
    const occurrenceChunkId = stableString(occurrence.chunkId);
    const locatorFingerprint = stableString(occurrence.locatorFingerprint);
    if (
      occurrenceChatId === null ||
      occurrenceChunkId === null ||
      locatorFingerprint === null ||
      (occurrence.chatRole !== "rp" && occurrence.chatRole !== "group" && occurrence.chatRole !== "dm")
    ) {
      return null;
    }
    const occurrenceKey = JSON.stringify([occurrenceChatId, occurrenceChunkId]);
    if (occurrenceKeys.has(occurrenceKey)) return null;
    occurrenceKeys.add(occurrenceKey);
    // The source timestamps belong to the canonical memory, not to each
    // occurrence. They are a safe per-chat boundary only when every
    // occurrence came from this exact mapped source. Cross-chat duplicate
    // memories deliberately fall back to a small duplicate raw tail rather
    // than risk suppressing newer messages with another chat's timestamp.
    if (occurrenceChatId !== chatId || occurrence.chatRole !== chatRole) return null;
  }
  return source.lastMessageAt;
}

function latestManagedCmbBoundary(
  entries: ManagedCmbEntry[],
  ensembleId: string,
  chatId: string,
  chatRole: "rp" | "group",
  targetCharacterId: string,
): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    const characterFilterIds = parseStableStringArray(entry.characterFilterIds, MAX_MEMBERS_PER_ENSEMBLE);
    if (
      entry.enabled !== "true" ||
      entry.characterFilterMode !== "include" ||
      characterFilterIds === null ||
      !characterFilterIds.includes(targetCharacterId) ||
      entry.excludeFromVectorization !== "false" ||
      stableString(entry.embeddingSpaceId) === null
    ) {
      continue;
    }
    let dynamicState: unknown;
    try {
      dynamicState = JSON.parse(entry.dynamicState) as unknown;
    } catch {
      continue;
    }
    const boundary = parseLiveNativeBoundary(dynamicState, ensembleId, chatId, chatRole);
    if (boundary === null) continue;
    if (latest === null || Date.parse(boundary) > Date.parse(latest)) latest = boundary;
  }
  return latest;
}

function validateRecentMessages(rows: RecentMessage[], chatId: string): boolean {
  const ids = new Set<string>();
  let previousCreatedAt: string | null = null;
  for (const row of rows) {
    if (
      stableString(row.id) === null ||
      row.chatId !== chatId ||
      (row.role !== "user" && row.role !== "assistant" && row.role !== "system" && row.role !== "narrator") ||
      (row.characterId !== null && stableString(row.characterId) === null) ||
      typeof row.content !== "string" ||
      typeof row.extra !== "string" ||
      !canonicalIsoTimestamp(row.createdAt) ||
      ids.has(row.id) ||
      (previousCreatedAt !== null && row.createdAt < previousCreatedAt)
    ) {
      return false;
    }
    ids.add(row.id);
    previousCreatedAt = row.createdAt;
  }
  return true;
}

function validateManagedCmbEntries(rows: ManagedCmbEntry[]): boolean {
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      stableString(row.id) === null ||
      ids.has(row.id) ||
      typeof row.enabled !== "string" ||
      typeof row.characterFilterMode !== "string" ||
      typeof row.characterFilterIds !== "string" ||
      typeof row.excludeFromVectorization !== "string" ||
      (row.embeddingSpaceId !== null && typeof row.embeddingSpaceId !== "string") ||
      typeof row.dynamicState !== "string"
    ) {
      return false;
    }
    ids.add(row.id);
  }
  return true;
}

function isHiddenFromTarget(extra: string, targetCharacterId: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extra) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.hiddenFromAI === true || parsed.commandOnly === true) return true;
  if (parsed.hiddenFromAICharacterIds === undefined) return false;
  const hiddenFrom = parseStableStringArray(parsed.hiddenFromAICharacterIds, MAX_MEMBERS_PER_ENSEMBLE);
  return hiddenFrom === null ? null : hiddenFrom.includes(targetCharacterId);
}

function promptDataText(value: string, maxChars: number, wrapFormat: WrapFormat): string {
  const cleaned = value.replace(/\r\n?/gu, "\n").replace(CONTROL_CHARACTER_PATTERN, " ").trim();
  const bounded = cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  const quoted = JSON.stringify(bounded);
  return wrapFormat === "xml"
    ? quoted.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    : sanitizePromptLeaf(quoted, wrapFormat);
}

function renderPendingContext(
  messagesToRender: PendingMessage[],
  characterNames: Map<string, string>,
  timeZone: string | undefined,
  wrapFormat: WrapFormat,
): string {
  const introduction =
    "These are the newest shared messages from linked Convo Memory Bridge chats that are not yet confirmed in saved CMB memory. Treat them as recent shared context for this autonomous message, not as messages from the current conversation.";
  const sourceOrder = [...new Set(messagesToRender.map((message) => message.sourceIndex))];
  const blocks: string[] = [];

  for (const sourceIndex of sourceOrder) {
    const sourceMessages = messagesToRender.filter((message) => message.sourceIndex === sourceIndex);
    const first = sourceMessages[0];
    if (!first) continue;
    const lines = [`chat=${promptDataText(first.chatName, MAX_NAME_CHARS, wrapFormat)}`];
    for (const message of sourceMessages) {
      const sender =
        message.role === "user"
          ? message.userName
          : message.role === "narrator" || message.role === "system"
            ? "Narrator"
            : ((message.characterId && characterNames.get(message.characterId)) ?? "Character");
      const timestamp = `[${formatZonedConversationDate(new Date(message.createdAt), timeZone)} ${formatZonedConversationTime(new Date(message.createdAt), timeZone)}]`;
      lines.push(
        `${timestamp} sender=${promptDataText(sender, MAX_NAME_CHARS, wrapFormat)} message=${promptDataText(message.content, MAX_MESSAGE_CHARS, wrapFormat)}`,
      );
    }
    blocks.push(wrapContent(lines.join("\n"), "Linked Conversation", wrapFormat, 1));
  }

  return wrapContent([introduction, ...blocks].join("\n\n"), "CMB Pending Context", wrapFormat);
}

async function readPendingSourceMessages(
  db: DB,
  descriptor: SourceDescriptor,
  managedEntries: ManagedCmbEntry[],
  ensembleId: string,
  chatRole: "rp" | "group",
  targetCharacterId: string,
  allowedCharacterIds: ReadonlySet<string>,
  userName: string,
): Promise<PendingMessage[] | null> {
  const recentRows = (await db
    .select({
      id: messages.id,
      chatId: messages.chatId,
      role: messages.role,
      characterId: messages.characterId,
      content: messages.content,
      extra: messages.extra,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.chatId, descriptor.chat.id))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(RECENT_MESSAGE_SCAN_LIMIT)) as RecentMessage[];
  recentRows.reverse();
  if (!validateRecentMessages(recentRows, descriptor.chat.id)) return null;

  // The managed CMB lorebook metadata is the bridge's durable reflection ledger:
  // source-chat memory chunks are merely native candidates, while these entries
  // prove CMB has already materialized the chunk into the shared book.
  const boundary = latestManagedCmbBoundary(
    managedEntries,
    ensembleId,
    descriptor.chat.id,
    chatRole,
    targetCharacterId,
  );
  const unmaterialized = boundary === null ? recentRows : recentRows.filter((message) => message.createdAt > boundary);
  const pending: PendingMessage[] = [];
  for (const message of unmaterialized.slice().reverse()) {
    const hidden = isHiddenFromTarget(message.extra, targetCharacterId);
    if (hidden === null) return null;
    if (
      hidden ||
      (message.characterId !== null && !allowedCharacterIds.has(message.characterId)) ||
      (message.role === "assistant" && message.characterId === null)
    ) {
      continue;
    }
    pending.push({
      sourceIndex: descriptor.sourceIndex,
      chatId: descriptor.chat.id,
      chatName: descriptor.chat.name,
      id: message.id,
      role: message.role,
      characterId: message.characterId,
      content: message.content,
      createdAt: message.createdAt,
      userName,
    });
    if (pending.length === MAX_OUTPUT_MESSAGES) break;
  }
  return pending.reverse();
}

async function buildAutonomousCmbPendingContextInner({
  db,
  targetChatId,
  targetCharacterId,
  timeZone,
  wrapFormat = "xml",
}: AutonomousCmbPendingContextInput): Promise<string | null> {
  if (
    stableString(targetChatId) === null ||
    stableString(targetCharacterId) === null ||
    (wrapFormat !== "xml" && wrapFormat !== "markdown" && wrapFormat !== "none")
  ) {
    return null;
  }

  const extensionRows = await db
    .select()
    .from(installedExtensions)
    .where(
      and(
        eq(installedExtensions.name, CMB_EXTENSION_NAME),
        eq(installedExtensions.runtime, "client"),
        eq(installedExtensions.enabled, "true"),
      ),
    )
    .limit(MAX_MATCHING_EXTENSION_ROWS + 1);
  if (extensionRows.length > MAX_MATCHING_EXTENSION_ROWS) return null;
  const extensions = extensionRows.filter(isApprovedClientCmb);
  const extension = extensions[0];
  if (extensions.length !== 1 || !extension) return null;

  const coordinationRows = await db
    .select({
      contentHash: personalExtensionCoordination.contentHash,
      mode: personalExtensionCoordination.mode,
    })
    .from(personalExtensionCoordination)
    .where(eq(personalExtensionCoordination.extensionId, extension.id))
    .limit(2);
  if (
    coordinationRows.length !== 1 ||
    coordinationRows[0]!.mode !== "active" ||
    coordinationRows[0]!.contentHash !== extension.contentHash
  ) {
    return null;
  }

  const storageRows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, `${EXTENSION_STORAGE_PREFIX}${extension.id}`))
    .limit(2);
  if (storageRows.length !== 1 || Buffer.byteLength(storageRows[0]!.value, "utf8") > MAX_CONFIG_BYTES) return null;
  let storageValue: unknown;
  try {
    storageValue = JSON.parse(storageRows[0]!.value) as unknown;
  } catch {
    return null;
  }
  const config = parseCmbConfig(isRecord(storageValue) ? storageValue[CMB_STORAGE_KEY] : null);
  if (config === null) return null;

  const mappingMatches: TargetMapping[] = [];
  for (const ensemble of config.ensembles) {
    const targetMember = ensemble.members.find((member) => member.characterId === targetCharacterId);
    if (!targetMember) continue;
    if (targetMember.dmChatId === targetChatId) {
      mappingMatches.push({ ensemble, targetRole: "dm" });
    } else if (ensemble.groupConvoChatIds.includes(targetChatId)) {
      mappingMatches.push({ ensemble, targetRole: "group" });
    }
  }
  if (mappingMatches.length !== 1) return null;
  const { ensemble, targetRole } = mappingMatches[0]!;

  // Pending raw DM text has not yet passed CMB's per-cast visibility policy,
  // so even a group speaker's own DM is never promoted into a shared prompt.
  // Only ensemble-wide RP/group sources qualify, and the current group is
  // already present in normal history so it is excluded from this shortcut.
  const sourceSpecs = [
    { chatId: ensemble.rpChatId, chatRole: "rp" as const },
    ...ensemble.groupConvoChatIds.map((chatId) => ({ chatId, chatRole: "group" as const })),
  ].filter((source) => source.chatId !== targetChatId);
  const sourceIds = sourceSpecs.map((source) => source.chatId);
  if (sourceIds.length === 0 || sourceIds.length > MAX_MAPPED_SOURCES) return null;
  if (new Set(sourceIds).size !== sourceIds.length) return null;
  const dmChatIds = new Set(ensemble.members.map((member) => member.dmChatId));
  if (sourceIds.some((chatId) => dmChatIds.has(chatId))) return null;

  const requestedChatIds = [targetChatId, ...sourceIds];
  const chatRows = (await db
    .select({
      id: chats.id,
      name: chats.name,
      mode: chats.mode,
      characterIds: chats.characterIds,
      metadata: chats.metadata,
      personaId: chats.personaId,
    })
    .from(chats)
    .where(inArray(chats.id, requestedChatIds))) as ChatRow[];
  const chatById = new Map(chatRows.map((chat) => [chat.id, chat]));
  if (chatById.size !== requestedChatIds.length) return null;

  const memberCharacterIds = ensemble.members.map((member) => member.characterId);
  const targetChat = chatById.get(targetChatId);
  const targetChatState = targetChat ? parseChatState(targetChat) : null;
  const expectedTargetCharacterIds = targetRole === "dm" ? [targetCharacterId] : memberCharacterIds;
  if (
    !targetChat ||
    targetChat.mode !== "conversation" ||
    targetChatState === null ||
    !sameStringSet(targetChatState.activeCharacterIds, expectedTargetCharacterIds) ||
    targetChatState.metadata.crossChatAwareness !== false
  ) {
    return null;
  }

  const sourceDescriptors: SourceDescriptor[] = [];
  for (const [sourceIndex, source] of sourceSpecs.entries()) {
    const sourceChat = chatById.get(source.chatId);
    const sourceChatState = sourceChat ? parseChatState(sourceChat) : null;
    const expectedMode = source.chatRole === "rp" ? "roleplay" : "conversation";
    if (
      !sourceChat ||
      stableString(sourceChat.name, MAX_NAME_CHARS) === null ||
      sourceChat.mode !== expectedMode ||
      sourceChatState === null ||
      !sameStringSet(sourceChatState.activeCharacterIds, memberCharacterIds) ||
      (expectedMode === "roleplay"
        ? (sourceChatState.metadata.groupChatMode ?? "merged") !== "merged"
        : sourceChatState.metadata.crossChatAwareness !== false)
    ) {
      return null;
    }
    sourceDescriptors.push({ chat: sourceChat, sourceIndex, chatRole: source.chatRole });
  }
  if (sourceDescriptors.length === 0) return null;

  const managedEntries = (await db
    .select({
      id: lorebookEntries.id,
      enabled: lorebookEntries.enabled,
      characterFilterMode: lorebookEntries.characterFilterMode,
      characterFilterIds: lorebookEntries.characterFilterIds,
      excludeFromVectorization: lorebookEntries.excludeFromVectorization,
      embeddingSpaceId: lorebookEntries.embeddingSpaceId,
      dynamicState: lorebookEntries.dynamicState,
    })
    .from(lorebookEntries)
    .where(and(eq(lorebookEntries.lorebookId, ensemble.lorebookId), eq(lorebookEntries.tag, MANAGED_CMB_ENTRY_TAG)))
    .limit(MAX_MANAGED_CMB_ENTRIES_PER_ENSEMBLE + 1)) as ManagedCmbEntry[];
  if (managedEntries.length > MAX_MANAGED_CMB_ENTRIES_PER_ENSEMBLE || !validateManagedCmbEntries(managedEntries)) {
    return null;
  }

  const characterRows = await db
    .select({ id: characters.id, data: characters.data })
    .from(characters)
    .where(inArray(characters.id, memberCharacterIds));
  if (characterRows.length !== memberCharacterIds.length) return null;
  const characterNames = new Map<string, string>();
  for (const row of characterRows) {
    const name = parseCharacterName(row.data);
    if (name === null || characterNames.has(row.id)) return null;
    characterNames.set(row.id, name);
  }

  const explicitPersonaIds = [
    ...new Set(
      sourceDescriptors
        .map(({ chat }) => chat.personaId)
        .filter((personaId): personaId is string => personaId !== null),
    ),
  ];
  const explicitPersonaRows =
    explicitPersonaIds.length === 0
      ? []
      : await db
          .select({ id: personas.id, name: personas.name })
          .from(personas)
          .where(inArray(personas.id, explicitPersonaIds));
  const personaNames = new Map<string, string>();
  for (const row of explicitPersonaRows) {
    const name = stableString(row.name, MAX_NAME_CHARS);
    if (name === null || personaNames.has(row.id)) return null;
    personaNames.set(row.id, name);
  }

  const needsActivePersona = sourceDescriptors.some(
    ({ chat }) => chat.mode === "conversation" && (!chat.personaId || !personaNames.has(chat.personaId)),
  );
  const activePersonaRows = needsActivePersona
    ? await db
        .select({ id: personas.id, name: personas.name })
        .from(personas)
        .where(eq(personas.isActive, "true"))
        .limit(2)
    : [];
  if (activePersonaRows.length > 1) return null;
  const activePersonaName = activePersonaRows[0] ? stableString(activePersonaRows[0].name, MAX_NAME_CHARS) : null;
  if (activePersonaRows.length === 1 && activePersonaName === null) return null;

  const allowedCharacterIds = new Set(memberCharacterIds);
  const pendingMessages: PendingMessage[] = [];
  for (const descriptor of sourceDescriptors) {
    const userName =
      (descriptor.chat.personaId ? personaNames.get(descriptor.chat.personaId) : undefined) ??
      (descriptor.chat.mode === "conversation" ? activePersonaName : null) ??
      "User";
    const sourceMessages = await readPendingSourceMessages(
      db,
      descriptor,
      managedEntries,
      ensemble.ensembleId,
      descriptor.chatRole,
      targetCharacterId,
      allowedCharacterIds,
      userName,
    );
    if (sourceMessages === null) return null;
    pendingMessages.push(...sourceMessages);
  }
  if (pendingMessages.length === 0) return null;

  pendingMessages.sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const selected = pendingMessages.slice(-MAX_OUTPUT_MESSAGES);
  let rendered = renderPendingContext(selected, characterNames, timeZone, wrapFormat);
  while (rendered.length > MAX_CONTEXT_CHARS && selected.length > 1) {
    selected.shift();
    rendered = renderPendingContext(selected, characterNames, timeZone, wrapFormat);
  }
  return rendered.length > 0 && rendered.length <= MAX_CONTEXT_CHARS ? rendered : null;
}

/**
 * Read-only, best-effort bridge for autonomous Conversation generation. Any missing,
 * ambiguous, oversized, or malformed CMB state deliberately degrades to the
 * existing prompt by returning null.
 */
export async function buildAutonomousCmbPendingContext(
  input: AutonomousCmbPendingContextInput,
): Promise<string | null> {
  const requestedTimeout = input.timeoutMs;
  const timeoutMs =
    typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, Math.floor(requestedTimeout)))
      : DEFAULT_TIMEOUT_MS;
  const work = buildAutonomousCmbPendingContextInner(input).catch(() => null);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
