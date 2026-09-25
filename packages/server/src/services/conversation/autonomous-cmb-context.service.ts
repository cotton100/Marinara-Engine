import {
  PERSONAL_EXTENSION_FULL_PAGE_CAPABILITY,
  collectEffectivelyDisabledFolderIds,
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
  lorebookFolders,
  lorebooks,
  messages,
  personalExtensionCoordination,
  personas,
} from "../../db/schema/index.js";
import { computePersonalExtensionHash } from "../extensions/personal-extension-hash.js";
import { wrapContent } from "../prompt/format-engine.js";
import { sanitizePromptLeaf } from "../prompt/prompt-escaping.js";
import { formatZonedConversationDate, formatZonedConversationTime } from "./timezone.js";
import {
  isCmbSourceMessageRestricted,
  resolveCmbSourceRestrictions,
  type CmbSourceRestriction,
} from "./cmb-source-visibility.js";

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
// ponytail: rank by persisted chat activity; a dedicated tail index is only
// needed if four recently updated sources cannot cover a larger ensemble.
const MAX_READ_SOURCES = 4;
const MAX_MANAGED_ENTRIES = 2048;
const MAX_MANAGED_FOLDERS = 256;
const MAX_OUTPUT_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 750;
// Optional recent-context reads must not pile up behind a slow storage read.
// Keep the slot until the underlying work settles, not just until its caller times out.
const activeReads = new WeakSet<DB>();

const CAST_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

type ExtensionRow = typeof installedExtensions.$inferSelect;
type ChatRow = Pick<
  typeof chats.$inferSelect,
  "id" | "name" | "mode" | "characterIds" | "metadata" | "personaId" | "updatedAt"
>;

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
  targetRole: "dm" | "group" | "rp";
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

type AutonomousCmbPendingContextInput = {
  db: DB;
  targetChatId: string;
  targetCharacterId: string;
  timeZone?: string;
  wrapFormat?: WrapFormat;
  /** Regression-only shortening; production callers cannot extend the 750ms ceiling. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CmbRecentContextInput = Omit<AutonomousCmbPendingContextInput, "targetCharacterId"> & {
  /** Actual prompt audience; ordinary Individual RP must supply exactly its selected speaker. */
  targetCharacterIds: string[];
  generation: "autonomous" | "ordinary";
};

export type CmbRecentContextResult = {
  block: string | null;
  /** Unavailable is not permission to fall back to an unfiltered native RP transcript. */
  scope: "unavailable" | "unmanaged" | "managed";
  rpChatId: string | null;
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

function isHiddenFromTarget(extra: string, targetCharacterIds: readonly string[]): boolean | null {
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
  return hiddenFrom === null ? null : hiddenFrom.some((id) => targetCharacterIds.includes(id));
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
    "These are recent shared messages from linked Convo Memory Bridge chats, including messages already saved in CMB memory. They are a limited selection from recently updated rooms, not a complete history. Timestamps describe source message records, not in-world event dates. Use this shared context for the current response; these are not new messages in the current chat.";
  const sourceOrder = [...new Set(messagesToRender.map((message) => message.sourceIndex))];
  const blocks: string[] = [];

  for (const sourceIndex of sourceOrder) {
    const sourceMessages = messagesToRender.filter((message) => message.sourceIndex === sourceIndex);
    const first = sourceMessages[0];
    if (!first) continue;
    const lines = [
      `chat=${promptDataText(first.chatName, MAX_NAME_CHARS, wrapFormat)} source_chat_id=${promptDataText(first.chatId, MAX_ID_CHARS, wrapFormat)}`,
    ];
    for (const message of sourceMessages) {
      const sender =
        message.role === "user"
          ? message.userName
          : message.role === "narrator" || message.role === "system"
            ? "Narrator"
            : ((message.characterId && characterNames.get(message.characterId)) ?? "Character");
      const timestamp = `[${formatZonedConversationDate(new Date(message.createdAt), timeZone)} ${formatZonedConversationTime(new Date(message.createdAt), timeZone)}; UTC ${message.createdAt}]`;
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
  targetCharacterIds: string[],
  allowedCharacterIds: ReadonlySet<string>,
  userName: string,
  restrictions: readonly CmbSourceRestriction[],
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

  // Reset boundaries apply before visibility filtering, including a hidden marker.
  // A shared prompt uses the latest boundary of any member of its audience.
  let startIndex = 0;
  for (const [index, message] of recentRows.entries()) {
    let extra: unknown;
    try {
      extra = JSON.parse(message.extra) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(extra)) return null;
    if (extra.isConversationStart !== undefined && typeof extra.isConversationStart !== "boolean") return null;
    const starts =
      extra.conversationStartForCharacterIds === undefined
        ? []
        : parseStableStringArray(extra.conversationStartForCharacterIds, MAX_MEMBERS_PER_ENSEMBLE);
    if (starts === null) return null;
    if (extra.isConversationStart === true || starts.some((id) => targetCharacterIds.includes(id))) startIndex = index;
  }

  const pending: PendingMessage[] = [];
  // Saved memory is not necessarily selected by semantic retrieval. Always
  // include a bounded recent visible tail, independent of CMB sync progress.
  for (const message of recentRows.slice(startIndex).reverse()) {
    const hidden = isHiddenFromTarget(message.extra, targetCharacterIds);
    if (hidden === null) return null;
    if (
      hidden ||
      isCmbSourceMessageRestricted(restrictions, descriptor.chat.id, message.createdAt) ||
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

async function buildCmbRecentContextInner(
  { db, targetChatId, targetCharacterIds, generation, timeZone, wrapFormat = "xml" }: CmbRecentContextInput,
  expired: () => boolean,
  result: CmbRecentContextResult,
): Promise<string | null> {
  if (
    expired() ||
    stableString(targetChatId) === null ||
    parseStableStringArray(targetCharacterIds, MAX_MEMBERS_PER_ENSEMBLE) === null ||
    targetCharacterIds.length === 0 ||
    (generation !== "autonomous" && generation !== "ordinary") ||
    (generation === "autonomous" && targetCharacterIds.length !== 1) ||
    (wrapFormat !== "xml" && wrapFormat !== "markdown" && wrapFormat !== "none")
  ) {
    return null;
  }

  const extensionRows = await db
    .select()
    .from(installedExtensions)
    .where(and(eq(installedExtensions.name, CMB_EXTENSION_NAME), eq(installedExtensions.runtime, "client")))
    .limit(MAX_MATCHING_EXTENSION_ROWS + 1);
  if (expired() || extensionRows.length > MAX_MATCHING_EXTENSION_ROWS) return null;
  const extensions = extensionRows.filter(isApprovedClientCmb);
  const extension = extensions[0];
  if (extensionRows.length === 0) result.scope = "unmanaged";
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
    expired() ||
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
  if (expired() || storageRows.length !== 1 || Buffer.byteLength(storageRows[0]!.value, "utf8") > MAX_CONFIG_BYTES)
    return null;
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
    if (!targetCharacterIds.every((id) => ensemble.members.some((member) => member.characterId === id))) continue;
    const targetMember = ensemble.members.find((member) => member.dmChatId === targetChatId);
    if (targetMember && sameStringSet(targetCharacterIds, [targetMember.characterId])) {
      mappingMatches.push({ ensemble, targetRole: "dm" });
    } else if (ensemble.groupConvoChatIds.includes(targetChatId)) {
      mappingMatches.push({ ensemble, targetRole: "group" });
    } else if (generation === "ordinary" && ensemble.rpChatId === targetChatId) {
      mappingMatches.push({ ensemble, targetRole: "rp" });
    }
  }
  if (mappingMatches.length === 0) {
    // Only a genuinely unregistered target may keep the native-only path.
    const registered = config.ensembles.some((e) =>
      [e.rpChatId, ...e.groupConvoChatIds, ...e.members.map((m) => m.dmChatId)].includes(targetChatId),
    );
    if (!registered) result.scope = "unmanaged";
  }
  if (mappingMatches.length !== 1) return null;
  const { ensemble, targetRole } = mappingMatches[0]!;
  result.scope = "managed";
  result.rpChatId = ensemble.rpChatId;

  const bookRows = await db
    .select({ enabled: lorebooks.enabled, scope: lorebooks.scope })
    .from(lorebooks)
    .where(eq(lorebooks.id, ensemble.lorebookId))
    .limit(2);
  const book = bookRows[0];
  if (expired() || bookRows.length !== 1 || book?.enabled !== "true" || book.scope.length > MAX_CONFIG_BYTES)
    return null;
  let bookScope: unknown;
  try {
    bookScope = JSON.parse(book.scope) as unknown;
  } catch {
    return null;
  }
  // CMB owns a specific scope containing exactly its mapped RP, groups and DMs.
  const mappedBookChatIds = [
    ensemble.rpChatId,
    ...ensemble.groupConvoChatIds,
    ...ensemble.members.map((member) => member.dmChatId),
  ];
  const scopedChatIds = isRecord(bookScope)
    ? parseStableStringArray(bookScope.chatIds, MAX_MAPPED_SOURCES + MAX_MEMBERS_PER_ENSEMBLE)
    : null;
  if (
    !isRecord(bookScope) ||
    bookScope.mode !== "specific" ||
    scopedChatIds === null ||
    !sameStringSet(scopedChatIds, mappedBookChatIds)
  )
    return null;

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
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(inArray(chats.id, requestedChatIds))) as ChatRow[];
  if (expired()) return null;
  const chatById = new Map(chatRows.map((chat) => [chat.id, chat]));
  if (chatById.size !== requestedChatIds.length) return null;

  const memberCharacterIds = ensemble.members.map((member) => member.characterId);
  const targetChat = chatById.get(targetChatId);
  const targetChatState = targetChat ? parseChatState(targetChat) : null;
  const excludedBooks =
    targetChatState?.metadata.excludedLorebookIds === undefined
      ? []
      : parseStableStringArray(targetChatState.metadata.excludedLorebookIds, MAX_MANAGED_ENTRIES);
  const expectedTargetCharacterIds = targetRole === "dm" ? targetCharacterIds : memberCharacterIds;
  const targetGroupChatMode = targetChatState?.metadata.groupChatMode;
  const individualRpTarget = targetRole === "rp" && targetGroupChatMode === "individual";
  if (
    !targetChat ||
    targetChat.mode !== (targetRole === "rp" ? "roleplay" : "conversation") ||
    targetChatState === null ||
    excludedBooks === null ||
    excludedBooks.includes(ensemble.lorebookId) ||
    !sameStringSet(targetChatState.activeCharacterIds, expectedTargetCharacterIds) ||
    (generation === "ordinary" &&
      (individualRpTarget
        ? targetCharacterIds.length !== 1
        : !sameStringSet(targetChatState.activeCharacterIds, targetCharacterIds))) ||
    targetChatState.metadata.sceneStatus != null ||
    (targetRole === "rp"
      ? targetGroupChatMode !== undefined && targetGroupChatMode !== "merged" && targetGroupChatMode !== "individual"
      : targetChatState.metadata.crossChatAwareness !== false)
  ) {
    return null;
  }

  const entryOverrides =
    targetChatState.metadata.entryStateOverrides ?? targetChatState.metadata.lorebookEntryStateOverrides;
  if (entryOverrides !== undefined && !isRecord(entryOverrides)) return null;

  const sourceDescriptors: SourceDescriptor[] = [];
  for (const [sourceIndex, source] of sourceSpecs.entries()) {
    const sourceChat = chatById.get(source.chatId);
    const sourceChatState = sourceChat ? parseChatState(sourceChat) : null;
    const expectedMode = source.chatRole === "rp" ? "roleplay" : "conversation";
    const sourceGroupChatMode = sourceChatState?.metadata.groupChatMode;
    if (
      !sourceChat ||
      stableString(sourceChat.name, MAX_NAME_CHARS) === null ||
      sourceChat.mode !== expectedMode ||
      !canonicalIsoTimestamp(sourceChat.updatedAt) ||
      sourceChatState === null ||
      sourceChatState.metadata.sceneStatus != null ||
      !sameStringSet(sourceChatState.activeCharacterIds, memberCharacterIds) ||
      (expectedMode === "roleplay"
        ? sourceGroupChatMode !== undefined && sourceGroupChatMode !== "merged" && sourceGroupChatMode !== "individual"
        : sourceChatState.metadata.crossChatAwareness !== false)
    ) {
      return null;
    }
    sourceDescriptors.push({ chat: sourceChat, sourceIndex, chatRole: source.chatRole });
  }
  if (sourceDescriptors.length === 0) return null;
  sourceDescriptors.sort(
    (a, b) => b.chat.updatedAt.localeCompare(a.chat.updatedAt) || a.chat.id.localeCompare(b.chat.id),
  );
  sourceDescriptors.splice(MAX_READ_SOURCES);

  // Read metadata only: a hidden materialized memory must not re-enter through
  // the recent raw tail. Do not read its body or embedding for this check.
  const managedEntries = await db
    .select({
      id: lorebookEntries.id,
      folderId: lorebookEntries.folderId,
      enabled: lorebookEntries.enabled,
      characterFilterMode: lorebookEntries.characterFilterMode,
      characterFilterIds: lorebookEntries.characterFilterIds,
      dynamicState: lorebookEntries.dynamicState,
    })
    .from(lorebookEntries)
    .where(and(eq(lorebookEntries.lorebookId, ensemble.lorebookId), eq(lorebookEntries.tag, "convo-memory-bridge")))
    .limit(MAX_MANAGED_ENTRIES + 1);
  if (expired() || managedEntries.length > MAX_MANAGED_ENTRIES) return null;
  const folderRows = await db
    .select({
      id: lorebookFolders.id,
      parentFolderId: lorebookFolders.parentFolderId,
      enabled: lorebookFolders.enabled,
    })
    .from(lorebookFolders)
    .where(eq(lorebookFolders.lorebookId, ensemble.lorebookId))
    .limit(MAX_MANAGED_FOLDERS + 1);
  if (expired() || folderRows.length > MAX_MANAGED_FOLDERS) return null;
  const folderIds = new Set(folderRows.map((folder) => folder.id));
  if (
    folderIds.size !== folderRows.length ||
    folderRows.some(
      (folder) =>
        stableString(folder.id) === null ||
        (folder.enabled !== "true" && folder.enabled !== "false") ||
        (folder.parentFolderId !== null && !folderIds.has(folder.parentFolderId)),
    ) ||
    managedEntries.some((entry) => entry.folderId !== null && !folderIds.has(entry.folderId))
  )
    return null;
  const disabledFolderIds = collectEffectivelyDisabledFolderIds(
    folderRows.map((folder) => ({ ...folder, enabled: folder.enabled === "true" })),
  );
  const scopedEntries = [];
  for (const entry of managedEntries) {
    const override = entryOverrides?.[entry.id];
    if (
      override !== undefined &&
      (!isRecord(override) || (override.enabled !== undefined && typeof override.enabled !== "boolean"))
    )
      return null;
    const disabled = override?.enabled === false || (entry.folderId !== null && disabledFolderIds.has(entry.folderId));
    scopedEntries.push(disabled ? { ...entry, enabled: "false" } : entry);
  }
  const restrictions = resolveCmbSourceRestrictions(scopedEntries, ensemble, targetCharacterIds);
  if (restrictions === null) return null;

  const characterRows = await db
    .select({ id: characters.id, data: characters.data })
    .from(characters)
    .where(inArray(characters.id, memberCharacterIds));
  if (expired() || characterRows.length !== memberCharacterIds.length) return null;
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
  if (expired()) return null;
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
  if (expired() || activePersonaRows.length > 1) return null;
  const activePersonaName = activePersonaRows[0] ? stableString(activePersonaRows[0].name, MAX_NAME_CHARS) : null;
  if (activePersonaRows.length === 1 && activePersonaName === null) return null;

  const allowedCharacterIds = new Set(memberCharacterIds);
  const pendingMessages: PendingMessage[] = [];
  for (const descriptor of sourceDescriptors) {
    if (expired()) return null;
    const userName =
      (descriptor.chat.personaId ? personaNames.get(descriptor.chat.personaId) : undefined) ??
      (descriptor.chat.mode === "conversation" ? activePersonaName : null) ??
      "User";
    const sourceMessages = await readPendingSourceMessages(
      db,
      descriptor,
      targetCharacterIds,
      allowedCharacterIds,
      userName,
      restrictions,
    );
    if (expired() || sourceMessages === null) return null;
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
 * Read-only, best-effort recent-context bridge for autonomous Conversation generation. Any missing,
 * ambiguous, oversized, or malformed CMB state deliberately degrades to the
 * existing prompt by returning null.
 */
export async function buildAutonomousCmbPendingContext(
  input: AutonomousCmbPendingContextInput,
): Promise<string | null> {
  return (
    await buildCmbRecentContext({
      ...input,
      targetCharacterIds: [input.targetCharacterId],
      generation: "autonomous",
    })
  ).block;
}

/** Both prompt modes share one optional read slot and one deadline per DB. */
export async function buildCmbRecentContext(input: CmbRecentContextInput): Promise<CmbRecentContextResult> {
  const result: CmbRecentContextResult = { block: null, scope: "unavailable", rpChatId: null };
  // No queue or cached prompt body: a concurrent caller uses the ordinary
  // memory path instead of retaining another task and its message arrays.
  if (activeReads.has(input.db) || input.signal?.aborted) return result;
  const requestedTimeout = input.timeoutMs;
  const timeoutMs =
    typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, Math.floor(requestedTimeout)))
      : DEFAULT_TIMEOUT_MS;
  const deadline = performance.now() + timeoutMs;
  activeReads.add(input.db);
  const work = buildCmbRecentContextInner(
    input,
    () => performance.now() >= deadline || input.signal?.aborted === true,
    result,
  )
    .catch(() => null)
    .finally(() => activeReads.delete(input.db));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const block = await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return { ...result, block: input.signal?.aborted ? null : block };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
