import { normalizeTextForMatch } from "@marinara-engine/shared";

import { logger } from "../../lib/logger.js";
import { stripConversationPromptTimestamps } from "../conversation/transcript-sanitize.js";
import {
  type CharacterCommand,
  type InfluenceCommand,
  type MemoryCommand,
  type NoteCommand,
} from "../conversation/character-commands.js";

type CharactersStore = {
  getById(id: string): Promise<{ data: unknown } | null>;
  list(): Promise<Array<{ id: string; data: unknown }>>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
};

type ChatsStore = {
  getById(id: string): Promise<{ connectedChatId?: unknown } | null>;
  createInfluence(
    sourceChatId: string,
    targetChatId: string,
    content: string,
    anchorMessageId?: string,
  ): Promise<unknown>;
  createNote(sourceChatId: string, targetChatId: string, content: string, anchorMessageId?: string): Promise<unknown>;
};

type CharacterMemory = {
  from: string;
  fromCharId: string;
  summary: string;
  createdAt: string;
};

/** An active CMB Convo route from this conversation to its ensemble RP (see cmb-convo-routes.ts). */
export type ConversationCmbRoute = { rpChatId: string; memberCharacterIds: string[] };

export async function handleConversationSideEffectCommand(args: {
  command: CharacterCommand;
  characterId: string | null;
  chatId: string;
  messageId?: string | null;
  chars: CharactersStore;
  chats: ChatsStore;
  /** Re-reads the route at write time; never used when a native link exists. */
  resolveCmbRoute?: () => Promise<ConversationCmbRoute | { held: string } | null>;
  onHeld?: (hold: { command: "influence" | "note"; reason: string }) => void;
}): Promise<boolean> {
  if (args.command.type === "memory") {
    await handleMemoryCommand(args.command as MemoryCommand, args);
    return true;
  }
  if (args.command.type === "influence") {
    await handleInfluenceCommand(args.command as InfluenceCommand, args);
    return true;
  }
  if (args.command.type === "note") {
    await handleNoteCommand(args.command as NoteCommand, args);
    return true;
  }
  return false;
}

async function handleMemoryCommand(
  command: MemoryCommand,
  args: Parameters<typeof handleConversationSideEffectCommand>[0],
): Promise<void> {
  const targetName = normalizeTextForMatch(command.target);

  const srcCharRow = args.characterId ? await args.chars.getById(args.characterId) : null;
  const srcCharData = parseRecord(srcCharRow?.data);
  const srcCharName = typeof srcCharData?.name === "string" && srcCharData.name.trim() ? srcCharData.name : "Unknown";

  const allCharsList = await args.chars.list();
  const targetChar = allCharsList.find((character) => {
    const data = parseRecord(character.data);
    return typeof data?.name === "string" && normalizeTextForMatch(data.name) === targetName;
  });

  if (!targetChar) {
    logger.warn('[commands] Memory target character "%s" not found', command.target);
    return;
  }

  const targetData = parseRecord(targetChar.data) ?? {};
  const extensions = { ...(parseRecord(targetData.extensions) ?? {}) };
  const memories = Array.isArray(extensions.characterMemories)
    ? ([...extensions.characterMemories] as CharacterMemory[])
    : [];

  memories.push({
    from: srcCharName,
    fromCharId: args.characterId ?? "",
    summary: command.summary,
    createdAt: new Date().toISOString(),
  });

  extensions.characterMemories = memories;
  await args.chars.update(targetChar.id, { extensions });

  const targetDisplayName =
    typeof targetData.name === "string" && targetData.name.trim() ? targetData.name : targetChar.id;
  logger.info(
    '[commands] Memory created: "%s" -> "%s" (summaryLength=%d)',
    srcCharName,
    targetDisplayName,
    command.summary.length,
  );
}

/**
 * The native 1:1 link keeps its original meaning. Only a conversation without one may use the CMB
 * route, and only for a confirmed ensemble member; failures never fall back to another room.
 * `resolveCmbRoute` is passed only when the generation started on the CMB path (no native link at
 * start), so a link that appeared since is a route change and holds — it never redirects the write.
 */
async function resolveConnectedTarget(
  kind: "influence" | "note",
  args: Parameters<typeof handleConversationSideEffectCommand>[0],
): Promise<string | null> {
  const freshChat = await args.chats.getById(args.chatId);
  const connectedId = typeof freshChat?.connectedChatId === "string" ? freshChat.connectedChatId : null;
  if (!args.resolveCmbRoute) {
    if (connectedId) return connectedId;
    logger.warn("[commands] %s command used but no connected chat", kind === "influence" ? "Influence" : "Note");
    return null;
  }
  const route = connectedId ? { held: "routes-changed" as const } : await args.resolveCmbRoute();
  if (!route) {
    logger.warn("[commands] %s command used but no connected chat", kind === "influence" ? "Influence" : "Note");
    return null;
  }
  if ("held" in route) {
    logger.warn("[commands] CMB %s held for chat %s: %s", kind, args.chatId, route.held);
    args.onHeld?.({ command: kind, reason: route.held });
    return null;
  }
  if (!args.characterId || !route.memberCharacterIds.includes(args.characterId)) {
    const reason = args.characterId ? "speaker-not-member" : "speaker-unknown";
    logger.warn("[commands] CMB %s held for chat %s: %s", kind, args.chatId, reason);
    args.onHeld?.({ command: kind, reason });
    return null;
  }
  return route.rpChatId;
}

async function handleInfluenceCommand(
  command: InfluenceCommand,
  args: Parameters<typeof handleConversationSideEffectCommand>[0],
): Promise<void> {
  const connectedId = await resolveConnectedTarget("influence", args);
  if (!connectedId) return;

  const influenceContent = stripConversationPromptTimestamps(command.content);
  if (!influenceContent) return;

  await args.chats.createInfluence(args.chatId, connectedId, influenceContent, args.messageId ?? undefined);
  logger.info(
    "[commands] OOC influence queued for connected chat %s (contentLength=%d)",
    connectedId,
    influenceContent.length,
  );
}

async function handleNoteCommand(
  command: NoteCommand,
  args: Parameters<typeof handleConversationSideEffectCommand>[0],
): Promise<void> {
  const connectedId = await resolveConnectedTarget("note", args);
  if (!connectedId) return;

  const noteContent = stripConversationPromptTimestamps(command.content);
  if (!noteContent) return;

  try {
    await args.chats.createNote(args.chatId, connectedId, noteContent, args.messageId ?? undefined);
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "CONVERSATION_NOTE_BUDGET") throw error;
    // The RP keeps its existing notes; the new one is refused with a visible reason.
    logger.warn("[commands] Conversation note refused for chat %s: notes budget is full", connectedId);
    args.onHeld?.({ command: "note", reason: "notes-budget-full" });
    return;
  }
  logger.info(
    "[commands] Conversation note saved for connected chat %s (contentLength=%d)",
    connectedId,
    noteContent.length,
  );
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
