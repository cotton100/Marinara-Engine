// ──────────────────────────────────────────────
// Storage: Chats
// ──────────────────────────────────────────────
import { eq, desc, and, gt, inArray, isNull } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import {
  chats,
  messages,
  messageSwipes,
  gameStateSnapshots,
  spatialContextSnapshots,
  gameCheckpoints,
  gameEngineState,
  chatImages,
  gameSceneVideos,
  gameTurnStoryboardKeyframes,
  gameTurnStoryboards,
  oocInfluences,
  conversationNotes,
  agentRuns,
  agentMemory,
  memoryChunks,
  conversationCallSessions,
  conversationCallMessages,
} from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../../utils/data-dir.js";
import type { CreateChatInput, CreateMessageInput } from "@marinara-engine/shared";
import {
  MESSAGE_STABLE_EXTRA_KEYS,
  overlayMessageWithExactSwipe,
  overlayMessageWithSwipe,
  overlayMessagesWithActiveSwipes,
  readSwipeCharacterId,
} from "./message-swipe-authority.js";
import {
  ensureTimestampAfter,
  latestTrustedTimestamp,
  normalizeTimestampOverrides,
  type TimestampOverrides,
} from "../import/import-timestamps.js";
import { scheduleNeedsRefresh, type CharacterSchedules, type WeekSchedule } from "../conversation/schedule.service.js";
import { resolveConversationTimeZone, toZonedWallClockDate } from "../conversation/timezone.js";
import { logger } from "../../lib/logger.js";

const GALLERY_DIR = join(DATA_DIR, "gallery");
const GAME_SCENE_VIDEOS_DIR = join(DATA_DIR, "game-scene-videos");

/** Total character budget for durable conversation notes per roleplay chat. Oldest pruned on insert. */
export const CONVERSATION_NOTES_BUDGET_CHARS = 4000;

export type MetadataPatch = Record<string, unknown>;
export type MetadataUpdater = (current: MetadataPatch) => MetadataPatch | Promise<MetadataPatch>;
export type ChatDeleteGuardResult = { allowed: true } | { allowed: false; reason: string };

const metadataPatchQueues = new Map<string, Promise<void>>();
const messageExtraPatchQueues = new Map<string, Promise<void>>();

async function withPatchQueue<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(operation);
  const queuedVoid = queued.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, queuedVoid);

  try {
    return await queued;
  } finally {
    if (queues.get(key) === queuedVoid) {
      queues.delete(key);
    }
  }
}

export async function withChatMetadataPatchQueue<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
  return withPatchQueue(metadataPatchQueues, chatId, operation);
}

function parseMetadata(raw: unknown): MetadataPatch {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as MetadataPatch) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? (raw as MetadataPatch) : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeConversationStatusOverrides(current: unknown, incoming: unknown): unknown {
  if (incoming === null) return null;
  if (incoming === undefined) return current;
  if (isPlainRecord(current) && isPlainRecord(incoming)) {
    const merged = { ...current, ...incoming };
    // Strip null tombstones (explicit deletion signals from the client)
    for (const key of Object.keys(merged)) {
      if (merged[key] === null) delete merged[key];
    }
    return merged;
  }
  return incoming;
}

function mergeMetadataPatch(current: MetadataPatch, patch: MetadataPatch): MetadataPatch {
  const merged = { ...current, ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "conversationStatusOverrides")) {
    merged.conversationStatusOverrides = mergeConversationStatusOverrides(
      current.conversationStatusOverrides,
      patch.conversationStatusOverrides,
    );
  }
  return merged;
}

function readUnreadCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readCharacterIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
}

function hasConversationSchedules(value: unknown): value is CharacterSchedules {
  return !!value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
}

function areConversationSchedulesEnabled(meta: MetadataPatch): boolean {
  if (typeof meta.conversationSchedulesEnabled === "boolean") return meta.conversationSchedulesEnabled;
  return hasConversationSchedules(meta.characterSchedules);
}

function parseCharacterIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

function firstScheduleWeekStart(schedules: CharacterSchedules): string | undefined {
  return Object.values(schedules).find((schedule): schedule is WeekSchedule => !!schedule)?.weekStart;
}

function resolveTimestamps(overrides?: TimestampOverrides | null) {
  const normalized = normalizeTimestampOverrides(overrides);
  const createdAt = normalized?.createdAt ?? now();
  return {
    createdAt,
    updatedAt: normalized?.updatedAt ?? createdAt,
  };
}

function parseExtraRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function withMessageStableExtra(swipeExtra: unknown, messageExtra: unknown): Record<string, unknown> {
  const next = { ...parseExtraRecord(swipeExtra) };
  const stable = parseExtraRecord(messageExtra);
  for (const key of MESSAGE_STABLE_EXTRA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stable, key)) next[key] = stable[key];
  }
  return next;
}

function freshSwipeMessageExtra(value: unknown): Record<string, unknown> {
  const current = parseExtraRecord(value);
  const next: Record<string, unknown> = {
    displayText: null,
    isGenerated: typeof current.isGenerated === "boolean" ? current.isGenerated : true,
    tokenCount: null,
    generationInfo: null,
  };

  for (const key of MESSAGE_STABLE_EXTRA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      next[key] = current[key];
    }
  }

  return next;
}

const SWIPE_CHARACTER_ID_KEY = "swipeCharacterId";

function withSwipeCharacterId(extra: unknown, characterId: string | null): Record<string, unknown> {
  return {
    ...parseExtraRecord(extra),
    [SWIPE_CHARACTER_ID_KEY]: characterId,
  };
}

function withDefaultSwipeCharacterId(extra: unknown, characterId: string | null): Record<string, unknown> {
  const parsed = parseExtraRecord(extra);
  return readSwipeCharacterId(parsed).present ? parsed : withSwipeCharacterId(parsed, characterId);
}

function initialMessageExtra(extra: unknown, role: string): Record<string, unknown> {
  return {
    ...parseExtraRecord(extra),
    displayText: null,
    isGenerated: role !== "user",
    tokenCount: null,
    generationInfo: null,
  };
}

function completeActiveSwipeExtra(
  messageExtra: unknown,
  swipeExtra: unknown,
  characterId: string | null,
): Record<string, unknown> {
  const complete = {
    ...parseExtraRecord(messageExtra),
    ...parseExtraRecord(swipeExtra),
  };
  const authoritativeSwipeExtra = parseExtraRecord(swipeExtra);
  if (!Object.prototype.hasOwnProperty.call(authoritativeSwipeExtra, "generationReplay")) {
    delete complete.generationReplay;
  }
  return withDefaultSwipeCharacterId(complete, characterId);
}

function backfillMessageStableExtra(messageExtra: unknown, swipeExtra: unknown, messageCharacterId: string | null) {
  return withDefaultSwipeCharacterId(withMessageStableExtra(swipeExtra, messageExtra), messageCharacterId);
}

function isUsableTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function parseMessageCursor(before?: string): { createdAt: string; rowid: number } | null {
  if (!before) return null;
  const separatorIndex = before.indexOf("|");
  if (separatorIndex <= 0 || separatorIndex === before.length - 1) return null;
  const rowid = Number(before.slice(separatorIndex + 1));
  if (!Number.isSafeInteger(rowid) || rowid < 1) return null;
  return {
    createdAt: before.slice(0, separatorIndex),
    rowid,
  };
}

async function invalidateMemoryChunksFrom(db: DB, chatId: string, createdAt: string) {
  await db
    .delete(memoryChunks)
    .where(
      and(
        eq(memoryChunks.chatId, chatId),
        isNull(memoryChunks.sourceChatId),
        gt(memoryChunks.lastMessageAt, createdAt),
      ),
    );
  await db
    .delete(memoryChunks)
    .where(
      and(
        eq(memoryChunks.chatId, chatId),
        isNull(memoryChunks.sourceChatId),
        eq(memoryChunks.lastMessageAt, createdAt),
      ),
    );
}

/**
 * Count swipes per message id. Avoids `inArray(messageSwipes.messageId, ids)`,
 * which the file-native store evaluates as `ids.includes()` for every swipe row
 * (re-materializing the ids array each row) — O(swipeRows * ids) = O(n^2) for a
 * large chat and a prime cause of the post-generation stall (#3402). One scan of
 * the swipes table + a Set of the wanted ids is O(totalSwipes) instead.
 */
async function countSwipesByMessageId(db: DB, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const wanted = new Set(ids);
  const rows = await db.select({ messageId: messageSwipes.messageId }).from(messageSwipes);
  for (const row of rows) {
    if (wanted.has(row.messageId)) {
      counts.set(row.messageId, (counts.get(row.messageId) ?? 0) + 1);
    }
  }
  return counts;
}

/** Create the chat storage facade used by routes and importers. */
export function createChatsStorage(db: DB) {
  let chatLastMessageAtBackfilled = false;
  let chatLastMessageAtBackfillPromise: Promise<void> | null = null;

  async function hasGameDeletePayload(chatId: string): Promise<boolean> {
    const existingMessage = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .limit(1);
    if (existingMessage.length > 0) return true;
    const existingSnapshot = await db
      .select({ id: gameStateSnapshots.id })
      .from(gameStateSnapshots)
      .where(eq(gameStateSnapshots.chatId, chatId))
      .limit(1);
    if (existingSnapshot.length > 0) return true;
    const existingCheckpoint = await db
      .select({ id: gameCheckpoints.id })
      .from(gameCheckpoints)
      .where(eq(gameCheckpoints.chatId, chatId))
      .limit(1);
    if (existingCheckpoint.length > 0) return true;
    const existingImage = await db
      .select({ id: chatImages.id })
      .from(chatImages)
      .where(eq(chatImages.chatId, chatId))
      .limit(1);
    if (existingImage.length > 0) return true;
    const existingVideo = await db
      .select({ id: gameSceneVideos.id })
      .from(gameSceneVideos)
      .where(eq(gameSceneVideos.chatId, chatId))
      .limit(1);
    if (existingVideo.length > 0) return true;
    const existingStoryboard = await db
      .select({ id: gameTurnStoryboards.id })
      .from(gameTurnStoryboards)
      .where(eq(gameTurnStoryboards.chatId, chatId))
      .limit(1);
    return existingStoryboard.length > 0;
  }

  async function isProtectedGameDeleteTarget(chat: {
    id: string;
    mode: string | null;
    metadata: unknown;
  }): Promise<boolean> {
    if (chat.mode !== "game") return false;
    const meta = parseMetadata(chat.metadata);
    const hasGameId = typeof meta.gameId === "string" && meta.gameId.trim().length > 0;
    return hasGameId || (await hasGameDeletePayload(chat.id));
  }

  async function checkDeleteTargets(
    rows: Array<{ id: string; mode: string | null; metadata: unknown }>,
    options: { force?: boolean },
    reason: string,
  ): Promise<ChatDeleteGuardResult> {
    if (options.force) return { allowed: true };
    for (const chat of rows) {
      if (await isProtectedGameDeleteTarget(chat)) {
        return { allowed: false, reason };
      }
    }
    return { allowed: true };
  }

  async function deleteGameStateForMessages(messageIds: string[]) {
    const ids = Array.from(new Set(messageIds.filter(Boolean)));
    if (ids.length === 0) return;

    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const snapshots = await db
        .select({ id: gameStateSnapshots.id })
        .from(gameStateSnapshots)
        .where(inArray(gameStateSnapshots.messageId, chunk));
      const snapshotIds = snapshots.map((row) => row.id).filter(Boolean);

      for (let j = 0; j < snapshotIds.length; j += CHUNK) {
        const snapshotChunk = snapshotIds.slice(j, j + CHUNK);
        await db.delete(gameCheckpoints).where(inArray(gameCheckpoints.snapshotId, snapshotChunk));
      }
      await db.delete(gameCheckpoints).where(inArray(gameCheckpoints.messageId, chunk));
      await db.delete(gameStateSnapshots).where(inArray(gameStateSnapshots.messageId, chunk));
      await db.delete(spatialContextSnapshots).where(inArray(spatialContextSnapshots.messageId, chunk));
      await db.delete(gameEngineState).where(inArray(gameEngineState.messageId, chunk));
    }
  }

  async function readLatestMessageAt(chatId: string): Promise<string | null> {
    const rows = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return rows[0]?.createdAt ?? null;
  }

  async function refreshChatLastMessageAt(chatId: string): Promise<string | null> {
    const lastMessageAt = await readLatestMessageAt(chatId);
    await db.update(chats).set({ lastMessageAt }).where(eq(chats.id, chatId));
    return lastMessageAt;
  }

  async function ensureChatLastMessageAtBackfilled() {
    if (chatLastMessageAtBackfilled) return;
    chatLastMessageAtBackfillPromise ??= (async () => {
      const chatRows = await db.select({ id: chats.id, lastMessageAt: chats.lastMessageAt }).from(chats);
      const missingChatIds = new Set(
        chatRows
          .filter((chat) => !isUsableTimestamp(chat.lastMessageAt))
          .map((chat) => chat.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      );
      if (missingChatIds.size === 0) {
        chatLastMessageAtBackfilled = true;
        return;
      }

      const latestByChat = new Map<string, string>();
      const messageRows = await db
        .select({ chatId: messages.chatId, createdAt: messages.createdAt })
        .from(messages)
        .orderBy(desc(messages.createdAt));
      for (const row of messageRows) {
        if (!missingChatIds.has(row.chatId) || latestByChat.has(row.chatId)) continue;
        latestByChat.set(row.chatId, row.createdAt);
        if (latestByChat.size === missingChatIds.size) break;
      }

      for (const [chatId, lastMessageAt] of latestByChat) {
        await db.update(chats).set({ lastMessageAt }).where(eq(chats.id, chatId));
      }
      chatLastMessageAtBackfilled = true;
    })().finally(() => {
      chatLastMessageAtBackfillPromise = null;
    });
    await chatLastMessageAtBackfillPromise;
  }

  async function collectFreshConversationSchedules(
    characterIds: string[],
    excludeChatId?: string,
  ): Promise<CharacterSchedules> {
    const wanted = new Set(characterIds);
    const sharedSchedules: CharacterSchedules = {};
    if (wanted.size === 0) return sharedSchedules;

    const allChats = await db.select().from(chats).orderBy(desc(chats.updatedAt));
    for (const chat of allChats) {
      if (chat.id === excludeChatId || chat.mode !== "conversation") continue;
      const meta = parseMetadata(chat.metadata);
      if (!areConversationSchedulesEnabled(meta) || !hasConversationSchedules(meta.characterSchedules)) continue;
      const scheduleNow = toZonedWallClockDate(new Date(), resolveConversationTimeZone(meta));

      for (const [characterId, schedule] of Object.entries(meta.characterSchedules)) {
        if (!wanted.has(characterId) || sharedSchedules[characterId] || scheduleNeedsRefresh(schedule, scheduleNow))
          continue;
        sharedSchedules[characterId] = schedule;
      }

      if (Object.keys(sharedSchedules).length === wanted.size) break;
    }

    return sharedSchedules;
  }

  return {
    async list() {
      await ensureChatLastMessageAtBackfilled();
      return db.select().from(chats).orderBy(desc(chats.updatedAt));
    },

    async getById(id: string) {
      const rows = await db.select().from(chats).where(eq(chats.id, id));
      return rows[0] ?? null;
    },

    async create(input: CreateChatInput, timestampOverrides?: TimestampOverrides | null) {
      const id = newId();
      const timestamp = resolveTimestamps(timestampOverrides);
      const inheritedSchedules =
        input.mode === "conversation" ? await collectFreshConversationSchedules(input.characterIds) : {};
      const metadata: MetadataPatch = {
        summary: null,
        tags: [],
        enableAgents: true,
        agentOverrides: {},
        activeAgentIds: [],
        activeToolIds: [],
      };
      if (hasConversationSchedules(inheritedSchedules)) {
        metadata.conversationSchedulesEnabled = true;
        metadata.characterSchedules = inheritedSchedules;
        const scheduleWeekStart = firstScheduleWeekStart(inheritedSchedules);
        if (scheduleWeekStart) metadata.scheduleWeekStart = scheduleWeekStart;
      }
      await db.insert(chats).values({
        id,
        name: input.name,
        mode: input.mode,
        characterIds: JSON.stringify(input.characterIds),
        groupId: input.groupId ?? null,
        personaId: input.personaId,
        promptPresetId: input.promptPresetId,
        connectionId: input.connectionId,
        metadata: JSON.stringify(metadata),
        lastMessageAt: null,
        createdAt: timestamp.createdAt,
        updatedAt: timestamp.updatedAt,
      });
      return this.getById(id);
    },

    async inheritFreshConversationSchedules(id: string) {
      const chat = await this.getById(id);
      if (!chat || chat.mode !== "conversation") return {};

      const meta = parseMetadata(chat.metadata);
      if (meta.conversationSchedulesEnabled === false) return {};

      const characterIds = parseCharacterIds(chat.characterIds);
      const currentSchedules = hasConversationSchedules(meta.characterSchedules) ? meta.characterSchedules : {};
      const scheduleNow = toZonedWallClockDate(new Date(), resolveConversationTimeZone(meta));
      const missingOrStaleIds = characterIds.filter((characterId) => {
        const existing = currentSchedules[characterId];
        return !existing || scheduleNeedsRefresh(existing, scheduleNow);
      });
      if (missingOrStaleIds.length === 0) return currentSchedules;

      const sharedSchedules = await collectFreshConversationSchedules(missingOrStaleIds, id);
      if (!hasConversationSchedules(sharedSchedules)) return currentSchedules;

      const nextSchedules: CharacterSchedules = { ...currentSchedules, ...sharedSchedules };
      const scheduleWeekStart = firstScheduleWeekStart(nextSchedules);
      await this.patchMetadata(
        id,
        {
          conversationSchedulesEnabled: true,
          characterSchedules: nextSchedules,
          ...(scheduleWeekStart ? { scheduleWeekStart } : {}),
        },
        { touchUpdatedAt: false },
      );

      return nextSchedules;
    },

    async update(
      id: string,
      data: Partial<CreateChatInput> & { folderId?: string | null; sortOrder?: number },
      opts?: { tx?: Pick<DB, "select" | "update"> },
    ) {
      const conn = opts?.tx ?? db;
      await conn
        .update(chats)
        .set({
          ...(data.name !== undefined && { name: data.name }),
          ...(data.mode !== undefined && { mode: data.mode }),
          ...(data.characterIds !== undefined && { characterIds: JSON.stringify(data.characterIds) }),
          ...(data.groupId !== undefined && { groupId: data.groupId }),
          ...(data.personaId !== undefined && { personaId: data.personaId }),
          ...(data.promptPresetId !== undefined && { promptPresetId: data.promptPresetId }),
          ...(data.connectionId !== undefined && { connectionId: data.connectionId }),
          ...(data.folderId !== undefined && { folderId: data.folderId }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
          updatedAt: now(),
        })
        .where(eq(chats.id, id));
      // Caller-level read; uses outer db so it reads committed state when no
      // tx is in flight, or the in-flight tx state when one is provided.
      const rows = await conn.select().from(chats).where(eq(chats.id, id));
      return rows[0] ?? null;
    },

    async touch(id: string, opts?: { tx?: Pick<DB, "select" | "update"> }) {
      const conn = opts?.tx ?? db;
      await conn.update(chats).set({ updatedAt: now() }).where(eq(chats.id, id));
      const rows = await conn.select().from(chats).where(eq(chats.id, id));
      return rows[0] ?? null;
    },

    /**
     * Set the folder assignment for a chat, propagating to every branch that
     * shares its groupId. The sidebar collapses each group to a single visible
     * row whose folder is read from whichever branch is currently the
     * representative — so when one branch is created or deleted and the rep
     * shifts, every branch must already carry the same folderId or the whole
     * tree falls back to Uncategorized.
     *
     * Sibling branches are updated without bumping updatedAt so categorizing
     * a chat doesn't silently reorder its branch history.
     */
    async setFolderForChat(chatId: string, folderId: string | null, opts?: { tx?: Pick<DB, "select" | "update"> }) {
      const conn = opts?.tx ?? db;
      const rows = await conn.select().from(chats).where(eq(chats.id, chatId));
      const chat = rows[0];
      if (!chat) return null;
      if (chat.groupId) {
        await conn.update(chats).set({ folderId }).where(eq(chats.groupId, chat.groupId));
        await conn.update(chats).set({ updatedAt: now() }).where(eq(chats.id, chatId));
      } else {
        await conn.update(chats).set({ folderId, updatedAt: now() }).where(eq(chats.id, chatId));
      }
      const updated = await conn.select().from(chats).where(eq(chats.id, chatId));
      return updated[0] ?? null;
    },

    /** List all chats belonging to a group. */
    async listByGroup(groupId: string) {
      await ensureChatLastMessageAtBackfilled();
      return db.select().from(chats).where(eq(chats.groupId, groupId)).orderBy(desc(chats.updatedAt));
    },

    async canDeleteChat(id: string, options: { force?: boolean } = {}): Promise<ChatDeleteGuardResult> {
      const rows = await db
        .select({ id: chats.id, mode: chats.mode, metadata: chats.metadata })
        .from(chats)
        .where(eq(chats.id, id))
        .limit(1);
      return checkDeleteTargets(
        rows,
        options,
        "Refusing to hard-delete a game campaign without explicit confirmation.",
      );
    },

    async canDeleteGroup(groupId: string, options: { force?: boolean } = {}): Promise<ChatDeleteGuardResult> {
      const rows = await db
        .select({ id: chats.id, mode: chats.mode, metadata: chats.metadata })
        .from(chats)
        .where(eq(chats.groupId, groupId));
      return checkDeleteTargets(
        rows,
        options,
        "Refusing to hard-delete a game campaign group without explicit confirmation.",
      );
    },

    async updateMetadata(id: string, metadata: Record<string, unknown>) {
      await db
        .update(chats)
        .set({ metadata: JSON.stringify(metadata), updatedAt: now() })
        .where(eq(chats.id, id));
      return this.getById(id);
    },

    async patchMetadata(
      id: string,
      patchOrUpdater: MetadataPatch | MetadataUpdater,
      opts: { touchUpdatedAt?: boolean } = {},
    ) {
      return withChatMetadataPatchQueue(id, async () => {
        const existing = await this.getById(id);
        if (!existing) return null;

        const current = parseMetadata(existing.metadata);
        const patch = typeof patchOrUpdater === "function" ? await patchOrUpdater({ ...current }) : patchOrUpdater;
        const merged = mergeMetadataPatch(current, patch);

        await db
          .update(chats)
          .set({
            metadata: JSON.stringify(merged),
            ...(opts.touchUpdatedAt !== false && { updatedAt: now() }),
          })
          .where(eq(chats.id, id));
        return this.getById(id);
      });
    },

    /**
     * Patch metadata and the denormalized `characterIds` column together inside a single per-chat
     * critical section. Both columns are written in one row update under the same metadata patch queue
     * as `patchMetadata`, so a concurrent metadata-queued writer can neither interleave between the two
     * writes nor leave `characterIds` reflecting an older party than the queued-final metadata. The
     * updater receives the fresh metadata and returns the metadata patch plus the `characterIds` array
     * to mirror; the reloaded chat returned reflects both writes. Used by the game party handlers.
     */
    async patchMetadataWithCharacterIds(
      id: string,
      updater: (
        current: MetadataPatch,
      ) =>
        | { metadata: MetadataPatch; characterIds: string[] }
        | Promise<{ metadata: MetadataPatch; characterIds: string[] }>,
      opts: { touchUpdatedAt?: boolean } = {},
    ) {
      return withChatMetadataPatchQueue(id, async () => {
        const existing = await this.getById(id);
        if (!existing) return null;

        const current = parseMetadata(existing.metadata);
        const { metadata: patch, characterIds } = await updater({ ...current });
        const merged = mergeMetadataPatch(current, patch);

        await db
          .update(chats)
          .set({
            metadata: JSON.stringify(merged),
            characterIds: JSON.stringify(characterIds),
            ...(opts.touchUpdatedAt !== false && { updatedAt: now() }),
          })
          .where(eq(chats.id, id));
        return this.getById(id);
      });
    },

    async markAutonomousUnread(id: string, input?: { characterId?: string | null; count?: number }) {
      const timestamp = now();
      return this.patchMetadata(id, (current) => {
        const increment = Math.max(1, Math.floor(input?.count ?? 1));
        const currentCount = readUnreadCount(current.autonomousUnreadCount);
        const characterIds = new Set(readCharacterIds(current.autonomousUnreadCharacterIds));
        if (input?.characterId) characterIds.add(input.characterId);

        return {
          ...current,
          autonomousUnreadCount: currentCount + increment,
          autonomousUnreadCharacterIds: Array.from(characterIds),
          autonomousUnreadAt: timestamp,
        };
      });
    },

    async clearAutonomousUnread(id: string) {
      return this.patchMetadata(
        id,
        (current) => {
          if (
            current.autonomousUnreadCount === undefined &&
            current.autonomousUnreadCharacterIds === undefined &&
            current.autonomousUnreadAt === undefined
          ) {
            return current;
          }

          return {
            autonomousUnreadCount: undefined,
            autonomousUnreadCharacterIds: undefined,
            autonomousUnreadAt: undefined,
          };
        },
        { touchUpdatedAt: false },
      );
    },

    async removeLorebookFromChatMetadata(lorebookId: string) {
      const allChats = await this.list();
      for (const chat of allChats) {
        const metadata = parseMetadata(chat.metadata);
        if (!Array.isArray(metadata.activeLorebookIds)) continue;

        const nextActiveLorebookIds = metadata.activeLorebookIds.filter((id) => id !== lorebookId);
        if (nextActiveLorebookIds.length === metadata.activeLorebookIds.length) continue;

        await this.patchMetadata(chat.id, (current) => {
          const currentLorebookIds = Array.isArray(current.activeLorebookIds) ? current.activeLorebookIds : [];
          return {
            activeLorebookIds: currentLorebookIds.filter((id) => id !== lorebookId),
          };
        });
      }
    },

    async remove(id: string) {
      // Clean up agent data referencing this chat
      await db.delete(agentRuns).where(eq(agentRuns.chatId, id));
      await db.delete(agentMemory).where(eq(agentMemory.chatId, id));
      await db.delete(gameCheckpoints).where(eq(gameCheckpoints.chatId, id));
      await db.delete(gameStateSnapshots).where(eq(gameStateSnapshots.chatId, id));
      await db.delete(spatialContextSnapshots).where(eq(spatialContextSnapshots.chatId, id));
      await db.delete(gameEngineState).where(eq(gameEngineState.chatId, id));
      await db.delete(conversationCallMessages).where(eq(conversationCallMessages.chatId, id));
      await db.delete(conversationCallSessions).where(eq(conversationCallSessions.chatId, id));
      const storyboards = await db
        .select({ id: gameTurnStoryboards.id })
        .from(gameTurnStoryboards)
        .where(eq(gameTurnStoryboards.chatId, id));
      for (const storyboard of storyboards) {
        await db.delete(gameTurnStoryboardKeyframes).where(eq(gameTurnStoryboardKeyframes.storyboardId, storyboard.id));
      }
      await db.delete(gameTurnStoryboards).where(eq(gameTurnStoryboards.chatId, id));
      await db.delete(gameSceneVideos).where(eq(gameSceneVideos.chatId, id));

      // Clean up gallery images (DB records + files on disk)
      await db.delete(chatImages).where(eq(chatImages.chatId, id));
      const galleryDir = join(GALLERY_DIR, id);
      if (existsSync(galleryDir)) rmSync(galleryDir, { recursive: true, force: true });
      const videoDir = join(GAME_SCENE_VIDEOS_DIR, id);
      if (existsSync(videoDir)) rmSync(videoDir, { recursive: true, force: true });

      await db.delete(chats).where(eq(chats.id, id));
    },

    /** Delete exactly one previously verified snapshot of a chat group. */
    async removeGroup(groupId: string, expectedChatIds: readonly string[]) {
      const expectedIds = Array.from(new Set(expectedChatIds.filter(Boolean))).sort();
      const removedIds = await db.transaction(async (tx) => {
        const currentRows = await tx.select({ id: chats.id }).from(chats).where(eq(chats.groupId, groupId));
        const currentIds = Array.from(new Set(currentRows.map((chat) => chat.id))).sort();
        if (currentIds.length !== expectedIds.length || currentIds.some((id, index) => id !== expectedIds[index])) {
          return null;
        }

        for (const chatId of expectedIds) {
          await tx.delete(agentRuns).where(eq(agentRuns.chatId, chatId));
          await tx.delete(agentMemory).where(eq(agentMemory.chatId, chatId));
          await tx.delete(gameCheckpoints).where(eq(gameCheckpoints.chatId, chatId));
          await tx.delete(gameStateSnapshots).where(eq(gameStateSnapshots.chatId, chatId));
          await tx.delete(spatialContextSnapshots).where(eq(spatialContextSnapshots.chatId, chatId));
          await tx.delete(gameEngineState).where(eq(gameEngineState.chatId, chatId));
          await tx.delete(conversationCallMessages).where(eq(conversationCallMessages.chatId, chatId));
          await tx.delete(conversationCallSessions).where(eq(conversationCallSessions.chatId, chatId));
          const storyboards = await tx
            .select({ id: gameTurnStoryboards.id })
            .from(gameTurnStoryboards)
            .where(eq(gameTurnStoryboards.chatId, chatId));
          for (const storyboard of storyboards) {
            await tx
              .delete(gameTurnStoryboardKeyframes)
              .where(eq(gameTurnStoryboardKeyframes.storyboardId, storyboard.id));
          }
          await tx.delete(gameTurnStoryboards).where(eq(gameTurnStoryboards.chatId, chatId));
          await tx.delete(gameSceneVideos).where(eq(gameSceneVideos.chatId, chatId));
          await tx.delete(chatImages).where(eq(chatImages.chatId, chatId));
        }

        if (expectedIds.length > 0) {
          await tx.delete(chats).where(and(eq(chats.groupId, groupId), inArray(chats.id, expectedIds)));
        }
        return expectedIds;
      });

      if (!removedIds) return false;
      for (const chatId of removedIds) {
        const galleryDir = join(GALLERY_DIR, chatId);
        if (existsSync(galleryDir)) rmSync(galleryDir, { recursive: true, force: true });
        const videoDir = join(GAME_SCENE_VIDEOS_DIR, chatId);
        if (existsSync(videoDir)) rmSync(videoDir, { recursive: true, force: true });
      }
      return true;
    },

    // ── Messages ──

    async lastContactByCharacter(chatId: string): Promise<Record<string, string>> {
      // Aggregate in JS because the file-native query builder intentionally
      // exposes only row selection, filtering, ordering, and pagination.
      // created_at is a TEXT (ISO) column, so lexicographic `>` is chronological.
      const rows = await this.listMessagesWithActiveSwipes(chatId);
      const result: Record<string, string> = {};
      for (const row of rows) {
        const characterId = row.characterId;
        const createdAt = row.createdAt;
        if (!characterId || !createdAt) continue;
        if (!result[characterId] || createdAt > result[characterId]) {
          result[characterId] = createdAt;
        }
      }
      return result;
    },

    async countMessages(chatId: string): Promise<number> {
      const rows = await db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
      return rows.length;
    },

    async hasGameDeletePayload(chatId: string): Promise<boolean> {
      return hasGameDeletePayload(chatId);
    },

    async listMessages(chatId: string) {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(messages.createdAt, messages.id);
      const decorated = rows.map((m, index) => ({ ...m, rowid: index + 1 }));
      const countMap = await countSwipesByMessageId(
        db,
        decorated.map((m) => m.id),
      );
      return decorated.map((m) => ({ ...m, swipeCount: countMap.get(m.id) ?? 0 }));
    },

    /**
     * Read narrative history with each message's selected swipe overlaid as the
     * authority for content, extra metadata, and per-swipe attribution.
     *
     * The legacy listMessages() contract intentionally remains envelope-native
     * for exports and repair tooling. This method performs one serialized,
     * read-only snapshot and one swipe-table scan, avoiding per-message reads.
     */
    async listMessagesWithActiveSwipes(chatId: string) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(messages)
          .where(eq(messages.chatId, chatId))
          .orderBy(messages.createdAt, messages.id);
        const decorated = rows.map((message, index) => ({ ...message, rowid: index + 1 }));
        if (decorated.length === 0) return [];

        const wanted = new Set(decorated.map((message) => message.id));
        const swipeRows = (await tx.select().from(messageSwipes)).filter((swipe) => wanted.has(swipe.messageId));
        const swipeCounts = new Map<string, number>();
        for (const swipe of swipeRows) {
          swipeCounts.set(swipe.messageId, (swipeCounts.get(swipe.messageId) ?? 0) + 1);
        }
        return overlayMessagesWithActiveSwipes(decorated, swipeRows).map((message) => ({
          ...message,
          swipeCount: swipeCounts.get(message.id) ?? 0,
        }));
      });
    },

    /** Paginated: returns the latest `limit` messages (optionally before a cursor). */
    async listMessagesPaginated(chatId: string, limit: number, before?: string) {
      const cursor = parseMessageCursor(before);
      const allRows = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(messages.createdAt, messages.id);
      let candidates = allRows.map((m, index) => ({ ...m, rowid: index + 1 }));
      if (cursor) {
        candidates = candidates.filter(
          (m) => m.createdAt < cursor.createdAt || (m.createdAt === cursor.createdAt && m.rowid < cursor.rowid),
        );
      } else if (before) {
        candidates = candidates.filter((m) => m.createdAt < before);
      }
      const reversed = candidates.slice(-limit);
      const countMap = await countSwipesByMessageId(
        db,
        reversed.map((m) => m.id),
      );
      return reversed.map((m) => ({ ...m, swipeCount: countMap.get(m.id) ?? 0 }));
    },

    /** Paginated narrative history with each selected swipe as the authority. */
    async listMessagesPaginatedWithActiveSwipes(chatId: string, limit: number, before?: string) {
      return db.transaction(async (tx) => {
        const cursor = parseMessageCursor(before);
        const allRows = await tx
          .select()
          .from(messages)
          .where(eq(messages.chatId, chatId))
          .orderBy(messages.createdAt, messages.id);
        let candidates = allRows.map((message, index) => ({ ...message, rowid: index + 1 }));
        if (cursor) {
          candidates = candidates.filter(
            (message) =>
              message.createdAt < cursor.createdAt ||
              (message.createdAt === cursor.createdAt && message.rowid < cursor.rowid),
          );
        } else if (before) {
          candidates = candidates.filter((message) => message.createdAt < before);
        }

        const selected = candidates.slice(-limit);
        if (selected.length === 0) return [];

        const wanted = new Set(selected.map((message) => message.id));
        const swipeRows = (await tx.select().from(messageSwipes)).filter((swipe) => wanted.has(swipe.messageId));
        const swipeCounts = new Map<string, number>();
        for (const swipe of swipeRows) {
          swipeCounts.set(swipe.messageId, (swipeCounts.get(swipe.messageId) ?? 0) + 1);
        }
        return overlayMessagesWithActiveSwipes(selected, swipeRows).map((message) => ({
          ...message,
          swipeCount: swipeCounts.get(message.id) ?? 0,
        }));
      });
    },

    async getMessage(id: string) {
      const rows = await db.select().from(messages).where(eq(messages.id, id));
      return rows[0] ?? null;
    },

    /**
     * Read the message envelope while treating the selected swipe as the
     * authoritative source for swipe-owned content and extra metadata.
     *
     * The per-message patch queue keeps this snapshot from interleaving with
     * addSwipe(), setActiveSwipe(), or updateMessageExtraForSwipe(). Legacy or
     * damaged rows with no matching swipe retain the envelope as a compatibility
     * fallback; callers can still fail closed on malformed replay metadata.
     */
    async getMessageWithActiveSwipe(id: string) {
      return withPatchQueue(messageExtraPatchQueues, id, async () => {
        const message = await this.getMessage(id);
        if (!message) return null;
        const swipes = await this.getSwipes(id);
        const activeSwipe = swipes.find((swipe: any) => swipe.index === message.activeSwipeIndex);
        return overlayMessageWithSwipe(message, activeSwipe);
      });
    },

    /** Read one exact swipe row without trusting the message envelope shortcut. */
    async getMessageWithSwipe(id: string, swipeIndex: number) {
      return withPatchQueue(messageExtraPatchQueues, id, async () => {
        const message = await this.getMessage(id);
        if (!message) return null;
        const swipes = await this.getSwipes(id);
        const targetSwipe = swipes.find((swipe: any) => swipe.index === swipeIndex);
        return targetSwipe ? overlayMessageWithExactSwipe(message, targetSwipe) : null;
      });
    },

    /**
     * Compare-and-set one swipe's content. Callers that mutate the visible turn
     * can require that the same swipe is still selected and still has the exact
     * content they inspected.
     */
    async updateMessageContentForSwipe(
      id: string,
      swipeIndex: number,
      content: string,
      options: { requireActive?: boolean; expectedContent?: string } = {},
    ) {
      return withPatchQueue(messageExtraPatchQueues, id, async () => {
        const result = await db.transaction(async (tx) => {
          const [message] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1);
          if (!message) return { status: "not_found" as const };
          if (options.requireActive === true && message.activeSwipeIndex !== swipeIndex) {
            return { status: "conflict" as const };
          }

          const [targetSwipe] = await tx
            .select()
            .from(messageSwipes)
            .where(and(eq(messageSwipes.messageId, id), eq(messageSwipes.index, swipeIndex)))
            .limit(1);
          if (!targetSwipe) return { status: "not_found" as const };
          if (options.expectedContent !== undefined && targetSwipe.content !== options.expectedContent) {
            return { status: "conflict" as const };
          }

          await tx.update(messageSwipes).set({ content }).where(eq(messageSwipes.id, targetSwipe.id));
          const active = message.activeSwipeIndex === swipeIndex;
          if (active) {
            await tx.update(messages).set({ content }).where(eq(messages.id, id));
          }
          return {
            status: "updated" as const,
            message: overlayMessageWithExactSwipe(message, { ...targetSwipe, content }),
            invalidation: active ? { chatId: message.chatId, createdAt: message.createdAt } : null,
          };
        });

        if (result.status !== "updated") return result;
        if (result.invalidation) {
          await invalidateMemoryChunksFrom(db, result.invalidation.chatId, result.invalidation.createdAt);
        }
        return { status: result.status, message: result.message };
      });
    },

    async createMessage(input: CreateMessageInput, timestampOverrides?: TimestampOverrides | null) {
      const id = newId();
      const resolvedTimestamp = resolveTimestamps(timestampOverrides).createdAt;
      const explicitTimestamp = normalizeTimestampOverrides(timestampOverrides)?.createdAt;
      const chatRows = await db
        .select({ lastMessageAt: chats.lastMessageAt })
        .from(chats)
        .where(eq(chats.id, input.chatId))
        .limit(1);
      const timestamp = explicitTimestamp
        ? resolvedTimestamp
        : ensureTimestampAfter(resolvedTimestamp, chatRows[0]?.lastMessageAt);
      const completeExtra = withSwipeCharacterId(initialMessageExtra(input.extra, input.role), input.characterId);
      await db.insert(messages).values({
        id,
        chatId: input.chatId,
        role: input.role,
        characterId: input.characterId,
        content: input.content,
        activeSwipeIndex: 0,
        extra: JSON.stringify(completeExtra),
        createdAt: timestamp,
      });
      // Create the initial swipe (index 0)
      await db.insert(messageSwipes).values({
        id: newId(),
        messageId: id,
        index: 0,
        content: input.content,
        extra: JSON.stringify(completeExtra),
        createdAt: timestamp,
      });
      await db.update(chats).set({ lastMessageAt: timestamp, updatedAt: timestamp }).where(eq(chats.id, input.chatId));
      return this.getMessage(id);
    },

    /**
     * Bulk-insert messages in a single transaction. Much faster than one-by-one
     * createMessage calls (especially on Windows/NTFS where each transaction fsync is expensive).
     *
     * Callers may pass `createdAt`, message `extra`, `activeSwipeIndex`,
     * and either the first swipe's `swipeExtra` or the full `swipes` list
     * when cloning/importing existing transcripts so attachments, persona
     * snapshots, hidden context flags, alternate swipes, and original
     * timestamps survive the copy.
     *
     * Returns the created message IDs in input order and updates chat.updatedAt once after the batch.
     */
    async createMessagesBatch(
      chatId: string,
      inputs: Array<
        Omit<CreateMessageInput, "chatId"> & {
          createdAt?: string | null;
          extra?: unknown;
          activeSwipeIndex?: number;
          swipeExtra?: unknown;
          swipes?: Array<{
            index: number;
            content: string;
            extra?: unknown;
            createdAt?: string | null;
          }>;
        }
      >,
      timestampOverrides?: TimestampOverrides | null,
    ) {
      if (inputs.length === 0) return [];
      const msgRows: (typeof messages.$inferInsert)[] = [];
      const swipeRows: (typeof messageSwipes.$inferInsert)[] = [];
      const createdIds: string[] = [];
      const batchTimestamps = resolveTimestamps(timestampOverrides);
      const baseTime = Date.parse(batchTimestamps.createdAt);
      const safeBaseTime = Number.isNaN(baseTime) ? Date.now() : baseTime;
      const createdTimestamps: string[] = [];

      for (let idx = 0; idx < inputs.length; idx++) {
        const input = inputs[idx]!;
        const id = newId();
        createdIds.push(id);
        const explicitTimestamp = normalizeTimestampOverrides({
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })?.createdAt;
        const timestamp = explicitTimestamp ?? new Date(safeBaseTime + idx).toISOString();
        createdTimestamps.push(timestamp);
        const hasExplicitSwipes = !!input.swipes?.length;
        const normalizedInputSwipes = hasExplicitSwipes
          ? [...(input.swipes ?? [])].sort((a, b) => a.index - b.index)
          : [
              {
                index: 0,
                content: input.content,
                extra: input.swipeExtra,
                createdAt: timestamp,
              },
            ];
        const activeSwipeIndex = input.activeSwipeIndex ?? 0;
        const activeSwipeInput = normalizedInputSwipes.find((swipe) => swipe.index === activeSwipeIndex);
        const messageExtra = initialMessageExtra(input.extra, input.role);
        const activeSwipeExtra = activeSwipeInput
          ? hasExplicitSwipes
            ? withDefaultSwipeCharacterId(
                withMessageStableExtra(activeSwipeInput.extra, messageExtra),
                input.characterId,
              )
            : completeActiveSwipeExtra(messageExtra, activeSwipeInput.extra, input.characterId)
          : withDefaultSwipeCharacterId(messageExtra, input.characterId);
        const activeSwipeCharacter = readSwipeCharacterId(activeSwipeExtra);
        const resolvedCharacterId = activeSwipeCharacter.present ? activeSwipeCharacter.characterId : input.characterId;
        msgRows.push({
          id,
          chatId,
          role: input.role,
          characterId: resolvedCharacterId,
          content: activeSwipeInput?.content ?? input.content,
          activeSwipeIndex,
          extra: JSON.stringify(activeSwipeExtra),
          createdAt: timestamp,
        });
        for (const swipe of normalizedInputSwipes) {
          const storedSwipeExtra =
            swipe.index === activeSwipeIndex
              ? activeSwipeExtra
              : withDefaultSwipeCharacterId(swipe.extra, input.characterId);
          swipeRows.push({
            id: newId(),
            messageId: id,
            index: swipe.index,
            content: swipe.content,
            extra: JSON.stringify(storedSwipeExtra),
            createdAt: normalizeTimestampOverrides({ createdAt: swipe.createdAt })?.createdAt ?? timestamp,
          });
        }
      }

      const lastTimestamp = latestTrustedTimestamp(createdTimestamps) ?? batchTimestamps.updatedAt;

      // Batch large imports to bound the amount of work performed per write.
      const CHUNK = 500;
      for (let i = 0; i < msgRows.length; i += CHUNK) {
        await db.insert(messages).values(msgRows.slice(i, i + CHUNK));
      }
      for (let i = 0; i < swipeRows.length; i += CHUNK) {
        await db.insert(messageSwipes).values(swipeRows.slice(i, i + CHUNK));
      }
      await db
        .update(chats)
        .set({ lastMessageAt: lastTimestamp, updatedAt: lastTimestamp })
        .where(eq(chats.id, chatId));
      return createdIds;
    },

    async updateMessageContent(id: string, content: string) {
      return withPatchQueue(messageExtraPatchQueues, id, async () => {
        const updated = await db.transaction(async (tx) => {
          const [message] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1);
          if (!message) return null;
          const [activeSwipe] = await tx
            .select()
            .from(messageSwipes)
            .where(and(eq(messageSwipes.messageId, id), eq(messageSwipes.index, message.activeSwipeIndex)))
            .limit(1);
          if (activeSwipe) {
            await tx.update(messageSwipes).set({ content }).where(eq(messageSwipes.id, activeSwipe.id));
          }
          await tx.update(messages).set({ content }).where(eq(messages.id, id));
          return { chatId: message.chatId, createdAt: message.createdAt };
        });
        if (!updated) return null;
        await invalidateMemoryChunksFrom(db, updated.chatId, updated.createdAt);
        return this.getMessage(id);
      });
    },

    /** Merge partial data into a message's extra JSON field. */
    async updateMessageExtra(id: string, partial: Record<string, unknown>) {
      return withPatchQueue(messageExtraPatchQueues, id, async () => {
        const updated = await db.transaction(async (tx) => {
          const [msg] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1);
          if (!msg) return false;

          const swipes = await tx.select().from(messageSwipes).where(eq(messageSwipes.messageId, id));
          const activeSwipe = swipes.find((swipe) => swipe.index === msg.activeSwipeIndex);
          const nextMessageBase = { ...parseExtraRecord(msg.extra), ...partial };
          const nextActiveExtra = activeSwipe
            ? withMessageStableExtra({ ...parseExtraRecord(activeSwipe.extra), ...partial }, nextMessageBase)
            : nextMessageBase;
          await tx
            .update(messages)
            .set({ extra: JSON.stringify(nextActiveExtra) })
            .where(eq(messages.id, id));

          const propagateToAllSwipes =
            Object.prototype.hasOwnProperty.call(partial, "hiddenFromAI") ||
            Object.prototype.hasOwnProperty.call(partial, "reactions");
          for (const swipe of swipes) {
            if (!propagateToAllSwipes && swipe.index !== msg.activeSwipeIndex) continue;
            const nextSwipeExtra =
              swipe.index === msg.activeSwipeIndex ? nextActiveExtra : { ...parseExtraRecord(swipe.extra), ...partial };
            await tx
              .update(messageSwipes)
              .set({ extra: JSON.stringify(nextSwipeExtra) })
              .where(eq(messageSwipes.id, swipe.id));
          }
          return true;
        });

        return updated ? this.getMessage(id) : null;
      });
    },

    /** Merge partial data into a specific swipe and mirror it to the message only if that swipe is active. */
    async updateMessageExtraForSwipe(id: string, swipeIndex: number, partial: Record<string, unknown>) {
      return withPatchQueue(messageExtraPatchQueues, id, async () => {
        const updated = await db.transaction(async (tx) => {
          const [message] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1);
          if (!message) return false;
          const [targetSwipe] = await tx
            .select()
            .from(messageSwipes)
            .where(and(eq(messageSwipes.messageId, id), eq(messageSwipes.index, swipeIndex)))
            .limit(1);
          if (!targetSwipe) return false;

          const nextSwipeExtra = withMessageStableExtra(
            { ...parseExtraRecord(targetSwipe.extra), ...partial },
            { ...parseExtraRecord(message.extra), ...partial },
          );

          await tx
            .update(messageSwipes)
            .set({ extra: JSON.stringify(nextSwipeExtra) })
            .where(eq(messageSwipes.id, targetSwipe.id));

          if (message.activeSwipeIndex === swipeIndex) {
            await tx
              .update(messages)
              .set({ extra: JSON.stringify(nextSwipeExtra) })
              .where(eq(messages.id, id));
          }
          return true;
        });

        return updated ? this.getMessage(id) : null;
      });
    },

    /**
     * Bulk-set hiddenFromAI on many messages at once.
     * Reuses updateMessageExtra() for each message. That operation atomically
     * propagates message-wide hidden state to every swipe row.
     *
     * Returns the ids this call actually flipped INTO the target state — the
     * messages whose hidden flag, read immediately before the write (no provider
     * or network call in between), differed from `hidden`. Callers that record
     * ownership of a hide (e.g. a summary entry's `hiddenMessageIds`) use this
     * return so ownership is sourced from the mutation itself, never from a stale
     * pre-mutation snapshot. The request is scoped to this chat; use `.length` for
     * a count of changed messages.
     */
    async bulkSetHiddenFromAI(chatId: string, messageIds: string[], hidden: boolean): Promise<string[]> {
      if (messageIds.length === 0) return [];
      const uniqueIds = Array.from(new Set(messageIds));
      const scopedRows: { id: string; extra: string | null }[] = [];
      const CHUNK = 500;
      for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        const batch = uniqueIds.slice(i, i + CHUNK);
        const batchRows = await db
          .select({ id: messages.id, extra: messages.extra })
          .from(messages)
          .where(and(eq(messages.chatId, chatId), inArray(messages.id, batch)));
        scopedRows.push(...batchRows);
      }

      const seen = new Set<string>();
      const flipped: string[] = [];
      try {
        for (const row of scopedRows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          // State read immediately before the write — the moment-of-mutation truth
          // that decides whether THIS call flips the message into the target state.
          let wasHidden = false;
          try {
            const parsed = typeof row.extra === "string" ? JSON.parse(row.extra) : (row.extra ?? {});
            wasHidden = (parsed as { hiddenFromAI?: unknown } | null)?.hiddenFromAI === true;
          } catch {
            wasHidden = false;
          }
          await this.updateMessageExtra(row.id, { hiddenFromAI: hidden });
          if (wasHidden !== hidden) flipped.push(row.id);
        }
      } catch (err) {
        // A write failed partway through. The rows we did not reach are untouched,
        // and rows already in the target state were never flipped, so the only
        // partial state is the `flipped` set. Undo exactly those so the call is
        // all-or-nothing and a caller never records ownership of a half-applied
        // batch. (db.transaction() is intentionally avoided in this store — see the
        // bounded bulk-insert path above — so this
        // compensating undo is the atomicity mechanism.) A clean undo preserves
        // the original error. A failed undo is surfaced as a compound failure so
        // callers never mistake a partially restored batch for a clean rollback.
        const undoErrors: unknown[] = [];
        for (const id of flipped) {
          try {
            await this.updateMessageExtra(id, { hiddenFromAI: !hidden });
          } catch (undoErr) {
            undoErrors.push(undoErr);
            logger.error(undoErr, "bulkSetHiddenFromAI: failed to undo partial hide for message %s", id);
          }
        }
        if (undoErrors.length > 0) {
          throw new AggregateError(
            [err, ...undoErrors],
            `bulkSetHiddenFromAI failed and rollback failed for ${undoErrors.length} of ${flipped.length} flipped messages`,
          );
        }
        throw err;
      }
      return flipped;
    },

    async removeMessage(id: string) {
      const existing = await this.getMessage(id);
      if (existing) await deleteGameStateForMessages([id]);
      await db.delete(messages).where(eq(messages.id, id));
      if (existing) {
        await invalidateMemoryChunksFrom(db, existing.chatId, existing.createdAt);
        await refreshChatLastMessageAt(existing.chatId);
      }
    },

    async removeMessages(ids: string[], chatId?: string) {
      if (ids.length === 0) return;
      const earliestByChat = new Map<string, string>();
      const CHUNK = 500;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const condition = chatId
          ? and(inArray(messages.id, chunk), eq(messages.chatId, chatId))
          : inArray(messages.id, chunk);
        const existingRows = await db
          .select({ id: messages.id, chatId: messages.chatId, createdAt: messages.createdAt })
          .from(messages)
          .where(condition);
        for (const row of existingRows) {
          const current = earliestByChat.get(row.chatId);
          if (!current || row.createdAt < current) earliestByChat.set(row.chatId, row.createdAt);
        }
        await deleteGameStateForMessages(existingRows.map((row) => row.id));
        await db.delete(messages).where(condition);
      }
      for (const [affectedChatId, createdAt] of earliestByChat) {
        await invalidateMemoryChunksFrom(db, affectedChatId, createdAt);
        await refreshChatLastMessageAt(affectedChatId);
      }
    },

    async getSwipes(messageId: string) {
      return db.select().from(messageSwipes).where(eq(messageSwipes.messageId, messageId)).orderBy(messageSwipes.index);
    },

    async addSwipe(messageId: string, content: string, silent?: boolean, extra?: unknown, characterId?: string | null) {
      return withPatchQueue(messageExtraPatchQueues, messageId, async () => {
        const existing = await this.getSwipes(messageId);
        const nextIndex = existing.length;
        const msg = await this.getMessage(messageId);
        const activeSwipe = msg ? existing.find((swipe: any) => swipe.index === msg.activeSwipeIndex) : undefined;
        const activeSwipeCharacter = readSwipeCharacterId(activeSwipe?.extra);
        const inheritedCharacterId = activeSwipeCharacter.present
          ? activeSwipeCharacter.characterId
          : (msg?.characterId ?? null);
        const initialExtra =
          characterId === undefined
            ? withDefaultSwipeCharacterId(extra, inheritedCharacterId)
            : withSwipeCharacterId(extra, characterId);
        const storedNewSwipeExtra = silent
          ? initialExtra
          : {
              ...(msg ? freshSwipeMessageExtra(msg.extra) : {}),
              ...initialExtra,
            };
        const initialSwipeCharacter = readSwipeCharacterId(storedNewSwipeExtra);

        // Backfill: save current message extra onto the currently-active swipe
        // so its thinking/generationInfo isn't lost when we switch away
        // (skip when silent — greeting swipes don't need backfill)
        if (msg && !silent) {
          const msgExtra = parseExtraRecord(msg.extra);
          if (activeSwipe) {
            const backfilledExtra = backfillMessageStableExtra(msgExtra, activeSwipe.extra, msg.characterId);
            await db
              .update(messageSwipes)
              .set({ extra: JSON.stringify(backfilledExtra) })
              .where(eq(messageSwipes.id, activeSwipe.id));
          }
        }

        const id = newId();
        await db.insert(messageSwipes).values({
          id,
          messageId,
          index: nextIndex,
          content,
          extra: JSON.stringify(storedNewSwipeExtra),
          createdAt: now(),
        });

        // When silent, only insert the swipe row without switching the active index.
        if (!silent) {
          // Set active swipe to the new one. The selected swipe row and envelope
          // carry the same complete extra so authoritative reads never lose
          // message-stable fields or freshly generated swipe metadata.
          await db
            .update(messages)
            .set({
              activeSwipeIndex: nextIndex,
              content,
              extra: JSON.stringify(storedNewSwipeExtra),
              ...(initialSwipeCharacter.present ? { characterId: initialSwipeCharacter.characterId } : {}),
            })
            .where(eq(messages.id, messageId));
          if (msg) {
            await invalidateMemoryChunksFrom(db, msg.chatId, msg.createdAt);
          }
        }
        return { id, index: nextIndex };
      });
    },

    async setActiveSwipe(messageId: string, index: number) {
      return withPatchQueue(messageExtraPatchQueues, messageId, async () => {
        const swipes = await this.getSwipes(messageId);
        const target = swipes.find((s: any) => s.index === index);
        if (!target) return null;

        // Before switching, save current message content and extra onto the outgoing swipe.
        const msg = await this.getMessage(messageId);
        if (msg) {
          const msgExtra = parseExtraRecord(msg.extra);
          const outgoingSwipe = swipes.find((s: any) => s.index === msg.activeSwipeIndex);
          if (outgoingSwipe) {
            const backfilledExtra = backfillMessageStableExtra(msgExtra, outgoingSwipe.extra, msg.characterId);
            await db
              .update(messageSwipes)
              .set({ extra: JSON.stringify(backfilledExtra) })
              .where(eq(messageSwipes.id, outgoingSwipe.id));
          }
        }

        // Sync the target swipe's extra onto the message.
        const refreshedTarget = (await this.getSwipes(messageId)).find((swipe: any) => swipe.index === index) ?? target;
        const swipeExtra = withMessageStableExtra(refreshedTarget.extra, msg?.extra);
        const swipeCharacter = readSwipeCharacterId(swipeExtra);
        await db
          .update(messageSwipes)
          .set({ extra: JSON.stringify(swipeExtra) })
          .where(eq(messageSwipes.id, target.id));
        await db
          .update(messages)
          .set({
            activeSwipeIndex: index,
            content: refreshedTarget.content,
            extra: JSON.stringify(swipeExtra),
            ...(swipeCharacter.present ? { characterId: swipeCharacter.characterId } : {}),
          })
          .where(eq(messages.id, messageId));
        if (msg) {
          await invalidateMemoryChunksFrom(db, msg.chatId, msg.createdAt);
        }
        return this.getMessage(messageId);
      });
    },

    async removeSwipe(messageId: string, index: number) {
      return withPatchQueue(messageExtraPatchQueues, messageId, async () => {
        const removed = await db.transaction(async (tx) => {
          const [msg] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
          if (!msg) return null;

          const swipes = await tx
            .select()
            .from(messageSwipes)
            .where(eq(messageSwipes.messageId, messageId))
            .orderBy(messageSwipes.index);
          const target = swipes.find((swipe) => swipe.index === index);
          if (!target || swipes.length <= 1) return null;

          const remaining = swipes.filter((swipe) => swipe.index !== index);
          const currentExtra = parseExtraRecord(msg.extra);
          const activeSwipeRemoved = msg.activeSwipeIndex === index;
          let nextActiveSwipeIndex = msg.activeSwipeIndex;
          let nextContent = msg.content;
          let nextExtra = currentExtra;
          let nextCharacterId = msg.characterId;

          if (msg.activeSwipeIndex > index) {
            nextActiveSwipeIndex = msg.activeSwipeIndex - 1;
          } else if (activeSwipeRemoved) {
            nextActiveSwipeIndex = Math.min(index, remaining.length - 1);
            const replacement = remaining[index] ?? remaining[remaining.length - 1];
            if (replacement) {
              nextContent = replacement.content;
              nextExtra = withMessageStableExtra(replacement.extra, currentExtra);
              const replacementCharacter = readSwipeCharacterId(nextExtra);
              if (replacementCharacter.present) nextCharacterId = replacementCharacter.characterId;
              await tx
                .update(messageSwipes)
                .set({ extra: JSON.stringify(nextExtra) })
                .where(eq(messageSwipes.id, replacement.id));
            }
          }

          await tx.delete(messageSwipes).where(eq(messageSwipes.id, target.id));
          await tx
            .delete(gameStateSnapshots)
            .where(and(eq(gameStateSnapshots.messageId, messageId), eq(gameStateSnapshots.swipeIndex, index)));
          await tx
            .delete(spatialContextSnapshots)
            .where(
              and(eq(spatialContextSnapshots.messageId, messageId), eq(spatialContextSnapshots.swipeIndex, index)),
            );
          await tx
            .delete(gameEngineState)
            .where(and(eq(gameEngineState.messageId, messageId), eq(gameEngineState.swipeIndex, index)));

          const removedStoryboards = await tx
            .select({ id: gameTurnStoryboards.id })
            .from(gameTurnStoryboards)
            .where(and(eq(gameTurnStoryboards.messageId, messageId), eq(gameTurnStoryboards.swipeIndex, index)));
          for (const storyboard of removedStoryboards) {
            await tx
              .delete(gameTurnStoryboardKeyframes)
              .where(eq(gameTurnStoryboardKeyframes.storyboardId, storyboard.id));
          }
          await tx
            .delete(gameTurnStoryboards)
            .where(and(eq(gameTurnStoryboards.messageId, messageId), eq(gameTurnStoryboards.swipeIndex, index)));

          const swipesToShift = await tx
            .select()
            .from(messageSwipes)
            .where(and(eq(messageSwipes.messageId, messageId), gt(messageSwipes.index, index)));
          for (const swipe of swipesToShift) {
            await tx
              .update(messageSwipes)
              .set({ index: swipe.index - 1 })
              .where(eq(messageSwipes.id, swipe.id));
          }

          const snapshotsToShift = await tx
            .select()
            .from(gameStateSnapshots)
            .where(and(eq(gameStateSnapshots.messageId, messageId), gt(gameStateSnapshots.swipeIndex, index)));
          for (const snapshot of snapshotsToShift) {
            await tx
              .update(gameStateSnapshots)
              .set({ swipeIndex: snapshot.swipeIndex - 1 })
              .where(eq(gameStateSnapshots.id, snapshot.id));
          }

          const spatialSnapshotsToShift = await tx
            .select()
            .from(spatialContextSnapshots)
            .where(
              and(eq(spatialContextSnapshots.messageId, messageId), gt(spatialContextSnapshots.swipeIndex, index)),
            );
          for (const snapshot of spatialSnapshotsToShift) {
            await tx
              .update(spatialContextSnapshots)
              .set({ swipeIndex: snapshot.swipeIndex - 1 })
              .where(eq(spatialContextSnapshots.id, snapshot.id));
          }

          const engineSnapshotsToShift = await tx
            .select()
            .from(gameEngineState)
            .where(and(eq(gameEngineState.messageId, messageId), gt(gameEngineState.swipeIndex, index)));
          for (const snapshot of engineSnapshotsToShift) {
            await tx
              .update(gameEngineState)
              .set({ swipeIndex: snapshot.swipeIndex - 1 })
              .where(eq(gameEngineState.id, snapshot.id));
          }

          const storyboardsToShift = await tx
            .select()
            .from(gameTurnStoryboards)
            .where(and(eq(gameTurnStoryboards.messageId, messageId), gt(gameTurnStoryboards.swipeIndex, index)));
          for (const storyboard of storyboardsToShift) {
            await tx
              .update(gameTurnStoryboards)
              .set({ swipeIndex: storyboard.swipeIndex - 1 })
              .where(eq(gameTurnStoryboards.id, storyboard.id));
          }

          await tx
            .update(messages)
            .set({
              activeSwipeIndex: nextActiveSwipeIndex,
              content: nextContent,
              extra: JSON.stringify(nextExtra),
              characterId: nextCharacterId,
            })
            .where(eq(messages.id, messageId));
          return { chatId: msg.chatId, createdAt: msg.createdAt, activeSwipeRemoved };
        });

        if (!removed) return null;
        if (removed.activeSwipeRemoved) {
          await invalidateMemoryChunksFrom(db, removed.chatId, removed.createdAt);
        }
        return this.getMessage(messageId);
      });
    },

    /** Merge partial data into a swipe's extra JSON field. */
    async updateSwipeExtra(messageId: string, swipeIndex: number, partial: Record<string, unknown>) {
      return withPatchQueue(messageExtraPatchQueues, messageId, async () => {
        const swipes = await this.getSwipes(messageId);
        const target = swipes.find((s: any) => s.index === swipeIndex);
        if (!target) return;
        const existing = typeof target.extra === "string" ? JSON.parse(target.extra) : (target.extra ?? {});
        const merged = { ...existing, ...partial };
        await db
          .update(messageSwipes)
          .set({ extra: JSON.stringify(merged) })
          .where(eq(messageSwipes.id, target.id));
      });
    },

    /** Append to one exact swipe and mirror it to the envelope iff that swipe remains selected. */
    async appendAttachmentForSwipe(messageId: string, swipeIndex: number, attachment: Record<string, unknown>) {
      return withPatchQueue(messageExtraPatchQueues, messageId, async () => {
        return db.transaction(async (tx) => {
          const [message] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
          if (!message) return null;
          const [target] = await tx
            .select()
            .from(messageSwipes)
            .where(and(eq(messageSwipes.messageId, messageId), eq(messageSwipes.index, swipeIndex)))
            .limit(1);
          if (!target) return null;

          const swipeExtra = parseExtraRecord(target.extra);
          const swipeAttachments = Array.isArray(swipeExtra.attachments) ? swipeExtra.attachments : [];
          const nextSwipeExtra = withMessageStableExtra(
            { ...swipeExtra, attachments: [...swipeAttachments, attachment] },
            message.extra,
          );
          await tx
            .update(messageSwipes)
            .set({ extra: JSON.stringify(nextSwipeExtra) })
            .where(eq(messageSwipes.id, target.id));

          if (message.activeSwipeIndex === swipeIndex) {
            await tx
              .update(messages)
              .set({ extra: JSON.stringify(nextSwipeExtra) })
              .where(eq(messages.id, messageId));
          }
          return { active: message.activeSwipeIndex === swipeIndex };
        });
      });
    },

    // ── Chat Connections ──

    /** Bidirectionally link two chats. */
    async connectChats(chatIdA: string, chatIdB: string) {
      const timestamp = now();
      await db.update(chats).set({ connectedChatId: chatIdB, updatedAt: timestamp }).where(eq(chats.id, chatIdA));
      await db.update(chats).set({ connectedChatId: chatIdA, updatedAt: timestamp }).where(eq(chats.id, chatIdB));
    },

    /** Remove the bidirectional link for a chat (and its partner). */
    async disconnectChat(chatId: string) {
      const chat = await this.getById(chatId);
      if (!chat) return;
      const parsed = typeof chat.connectedChatId === "string" ? chat.connectedChatId : null;
      const timestamp = now();
      await db.update(chats).set({ connectedChatId: null, updatedAt: timestamp }).where(eq(chats.id, chatId));
      if (parsed) {
        await db.update(chats).set({ connectedChatId: null, updatedAt: timestamp }).where(eq(chats.id, parsed));
      }
    },

    // ── OOC Influences ──

    /** Create a queued influence from a conversation → its connected roleplay. */
    async createInfluence(sourceChatId: string, targetChatId: string, content: string, anchorMessageId?: string) {
      const id = newId();
      await db.insert(oocInfluences).values({
        id,
        sourceChatId,
        targetChatId,
        content,
        anchorMessageId: anchorMessageId ?? null,
        consumed: "false",
        createdAt: now(),
      });
      return id;
    },

    /** Get all unconsumed influences targeting a chat. */
    async listPendingInfluences(targetChatId: string) {
      return db
        .select()
        .from(oocInfluences)
        .where(and(eq(oocInfluences.targetChatId, targetChatId), eq(oocInfluences.consumed, "false")))
        .orderBy(oocInfluences.createdAt);
    },

    /** Mark an influence as consumed after it's been injected. */
    async markInfluenceConsumed(id: string) {
      await db.update(oocInfluences).set({ consumed: "true" }).where(eq(oocInfluences.id, id));
    },

    /** Delete all influences associated with a chat (as source or target). */
    async deleteInfluencesForChat(chatId: string) {
      await db.delete(oocInfluences).where(eq(oocInfluences.sourceChatId, chatId));
      await db.delete(oocInfluences).where(eq(oocInfluences.targetChatId, chatId));
    },

    // ── Conversation Notes ──

    /** Create a durable note from a conversation → its connected roleplay, then prune oldest past the char budget. */
    async createNote(sourceChatId: string, targetChatId: string, content: string, anchorMessageId?: string) {
      const id = newId();
      await db.insert(conversationNotes).values({
        id,
        sourceChatId,
        targetChatId,
        content,
        anchorMessageId: anchorMessageId ?? null,
        createdAt: now(),
      });

      const all = await db
        .select()
        .from(conversationNotes)
        .where(eq(conversationNotes.targetChatId, targetChatId))
        .orderBy(desc(conversationNotes.createdAt), desc(conversationNotes.id));

      const toDelete: string[] = [];
      let total = 0;
      for (let i = 0; i < all.length; i++) {
        total += all[i]!.content.length;
        // Always keep the newest note even if it alone exceeds the budget.
        if (i > 0 && total > CONVERSATION_NOTES_BUDGET_CHARS) {
          toDelete.push(all[i]!.id);
        }
      }
      if (toDelete.length > 0) {
        await db.delete(conversationNotes).where(inArray(conversationNotes.id, toDelete));
      }

      return id;
    },

    /** List all durable notes targeting a chat, oldest first (for stable prompt ordering).
     *  `id` secondary sort gives deterministic ordering when timestamps tie (e.g. multiple
     *  `<note>` tags emitted in a single character response within one millisecond). */
    async listNotes(targetChatId: string) {
      return db
        .select()
        .from(conversationNotes)
        .where(eq(conversationNotes.targetChatId, targetChatId))
        .orderBy(conversationNotes.createdAt, conversationNotes.id);
    },

    /** Delete a single note by id, scoped to its target chat. */
    async deleteNoteForChat(targetChatId: string, id: string) {
      await db
        .delete(conversationNotes)
        .where(and(eq(conversationNotes.targetChatId, targetChatId), eq(conversationNotes.id, id)));
    },

    /** Clear every note targeting a chat. */
    async clearNotes(targetChatId: string) {
      await db.delete(conversationNotes).where(eq(conversationNotes.targetChatId, targetChatId));
    },

    /** Delete all notes associated with a chat (as source or target). */
    async deleteNotesForChat(chatId: string) {
      await db.delete(conversationNotes).where(eq(conversationNotes.sourceChatId, chatId));
      await db.delete(conversationNotes).where(eq(conversationNotes.targetChatId, chatId));
    },
  };
}
