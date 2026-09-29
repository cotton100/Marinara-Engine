import type { ChatMode } from "@marinara-engine/shared";

import { stripConversationPromptTimestamps } from "../../services/conversation/transcript-sanitize.js";

type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  [key: string]: unknown;
};

type InfluenceRow = { id: string; sourceChatId?: unknown; content?: unknown };
type NoteRow = { sourceChatId?: unknown; content?: unknown };

type ConnectedConversationStore = {
  listPendingInfluences(chatId: string): Promise<InfluenceRow[]>;
  listInfluencesByIds?(chatId: string, ids: string[]): Promise<InfluenceRow[]>;
  markInfluenceConsumed(id: string, targetChatId?: string): Promise<unknown>;
  listNotes(chatId: string): Promise<NoteRow[]>;
  getById(chatId: string): Promise<{ mode?: string | null; name?: string | null } | null>;
};

/**
 * For an RP that has once used CMB Convo routes. Only the allowed source rooms are injected, and
 * influences are consumed by the caller after the RP reply is saved (never on injection).
 */
export type CmbConnectedInjection = {
  allowedSourceChatIds: ReadonlySet<string>;
  /** Influences already consumed by the reply being regenerated; reproduced, not consumed again. */
  replayInfluenceIds: string[];
  /** A managed OOC instruction replaces the native one while CMB routes are active. */
  oocInstruction: string | null;
};

function injectBeforeLastUser(messages: PromptMessage[], content: string): void {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUserIdx >= 0) {
    messages.splice(lastUserIdx, 0, { role: "system", content });
  } else {
    messages.push({ role: "system", content });
  }
}

function insertAfterFirstSystem(finalMessages: PromptMessage[], content: string): void {
  const firstSysIdx = finalMessages.findIndex((m) => m.role === "system");
  if (firstSysIdx >= 0) {
    finalMessages.splice(firstSysIdx + 1, 0, { role: "system", content });
  } else {
    finalMessages.unshift({ role: "system", content });
  }
}

function influenceBlock(chatMode: ChatMode, rows: InfluenceRow[]): string | null {
  const influenceLines = rows
    .map((inf) => stripConversationPromptTimestamps(String(inf.content ?? "")))
    .filter((content) => content.length > 0)
    .map((content) => `- ${content}`);
  if (influenceLines.length === 0) return null;
  return [
    `<ooc_influences>`,
    chatMode === "game"
      ? `The following out-of-character notes come from a connected conversation. They represent things the players discussed or decided outside the game. Use them to steer the next scene, NPC reactions, objectives, or world state when appropriate — don't mention them explicitly as "OOC" in the narrative.`
      : `The following out-of-character notes come from a connected conversation. They represent things the players discussed or decided outside of the roleplay. Weave them naturally into the story — don't mention them explicitly as "OOC" in the narrative.`,
    ...influenceLines,
    `</ooc_influences>`,
  ].join("\n");
}

function noteBlock(chatMode: ChatMode, rows: NoteRow[]): string | null {
  const noteLines = rows
    .map((n) => stripConversationPromptTimestamps(String(n.content ?? "")))
    .filter((content) => content.length > 0)
    .map((content) => `- ${content}`);
  if (noteLines.length === 0) return null;
  return [
    `<conversation_notes>`,
    chatMode === "game"
      ? `Durable notes from a connected conversation. These persist across every turn until the user clears them and represent things the players have established as ongoing truth — character knowledge, world facts, recurring dynamics. Use them to inform NPC behavior, world state, and scene framing — don't reference them explicitly as "notes" in the narrative.`
      : `Durable notes from a connected conversation. These persist across every turn until the user clears them and represent things the character has been told to durably remember about themselves, the user, or the world. Use them to inform behavior, knowledge, and reactions naturally — don't reference them explicitly as "notes" in the narrative.`,
    ...noteLines,
    `</conversation_notes>`,
  ].join("\n");
}

function nativeOocInstruction(conversationName: string | null | undefined): string {
  return [
    `<ooc_instruction>`,
    `You have a connected out-of-character conversation: "${conversationName}".`,
    `If a character wants to break the fourth wall and comment on something happening in the roleplay, post a reaction, or chat casually with the user "outside" the story, they can use an <ooc> tag:`,
    `<ooc>casual comment or reaction about what just happened in the RP</ooc>`,
    ``,
    `The <ooc> text is stripped from the roleplay response and posted as a message in the conversation chat.`,
    `Use this very sparingly — only when a character would genuinely want to comment out-of-character. Most RP responses should NOT include <ooc> tags.`,
    `</ooc_instruction>`,
  ].join("\n");
}

/** Returns the influence IDs injected for a once-opted RP so the caller can consume them after saving. */
export async function injectConnectedConversationPromptBlocks(args: {
  chatMode: ChatMode;
  connectedChatId: unknown;
  isSceneChat: boolean;
  chatId: string;
  chats: ConnectedConversationStore;
  finalMessages: PromptMessage[];
  cmb?: CmbConnectedInjection | null;
}): Promise<{ injectedInfluenceIds: string[] }> {
  const { chatMode, connectedChatId, isSceneChat, chatId, chats, finalMessages } = args;
  if (args.cmb) return injectOnceOptedRoleplayBlocks({ ...args, cmb: args.cmb });

  if ((chatMode === "roleplay" || chatMode === "game") && connectedChatId && !isSceneChat) {
    const pendingInfluences = await chats.listPendingInfluences(chatId);
    if (pendingInfluences.length > 0) {
      const block = influenceBlock(chatMode, pendingInfluences);
      if (block) injectBeforeLastUser(finalMessages, block);

      for (const inf of pendingInfluences) {
        await chats.markInfluenceConsumed(inf.id, chatId);
      }
    }
  }

  if ((chatMode === "roleplay" || chatMode === "game") && connectedChatId && !isSceneChat) {
    const persistentNotes = await chats.listNotes(chatId);
    const block = persistentNotes.length > 0 ? noteBlock(chatMode, persistentNotes) : null;
    if (block) injectBeforeLastUser(finalMessages, block);
  }

  if (chatMode === "roleplay" && connectedChatId && !isSceneChat) {
    const convChat = await chats.getById(connectedChatId as string);
    if (convChat && convChat.mode === "conversation") {
      insertAfterFirstSystem(finalMessages, nativeOocInstruction(convChat.name));
    }
  }
  return { injectedInfluenceIds: [] };
}

async function injectOnceOptedRoleplayBlocks(args: {
  chatMode: ChatMode;
  connectedChatId: unknown;
  isSceneChat: boolean;
  chatId: string;
  chats: ConnectedConversationStore;
  finalMessages: PromptMessage[];
  cmb: CmbConnectedInjection;
}): Promise<{ injectedInfluenceIds: string[] }> {
  const { chatMode, isSceneChat, chatId, chats, finalMessages, cmb } = args;
  if (isSceneChat) return { injectedInfluenceIds: [] };
  // Rows from rooms outside the live native link or the active CMB route stay stored but unused.
  const allowed = (row: { sourceChatId?: unknown }) =>
    typeof row.sourceChatId === "string" && cmb.allowedSourceChatIds.has(row.sourceChatId);

  const pending = (await chats.listPendingInfluences(chatId)).filter(allowed);
  const replayed =
    cmb.replayInfluenceIds.length && chats.listInfluencesByIds
      ? (await chats.listInfluencesByIds(chatId, cmb.replayInfluenceIds)).filter(allowed)
      : [];
  const influences = [...new Map([...replayed, ...pending].map((row) => [row.id, row])).values()];
  const influenceText = influenceBlock(chatMode, influences);
  if (influenceText) injectBeforeLastUser(finalMessages, influenceText);

  const notes = noteBlock(chatMode, (await chats.listNotes(chatId)).filter(allowed));
  if (notes) injectBeforeLastUser(finalMessages, notes);

  if (cmb.oocInstruction) {
    insertAfterFirstSystem(finalMessages, cmb.oocInstruction);
  } else if (chatMode === "roleplay" && typeof args.connectedChatId === "string") {
    const convChat = await chats.getById(args.connectedChatId);
    if (convChat?.mode === "conversation" && cmb.allowedSourceChatIds.has(args.connectedChatId)) {
      insertAfterFirstSystem(finalMessages, nativeOocInstruction(convChat.name));
    }
  }
  return { injectedInfluenceIds: influences.map((row) => row.id) };
}
