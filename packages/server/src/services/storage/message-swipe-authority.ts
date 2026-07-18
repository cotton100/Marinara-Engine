import type { DB } from "../../db/connection.js";
import { messageSwipes } from "../../db/schema/index.js";

type MessageEnvelope = {
  id: string;
  activeSwipeIndex: number;
  content: string;
  extra: unknown;
  characterId?: string | null;
};

type MessageSwipe = {
  messageId: string;
  index: number;
  content: string;
  extra: unknown;
};

const SWIPE_CHARACTER_ID_KEY = "swipeCharacterId";
export const MESSAGE_STABLE_EXTRA_KEYS = [
  "hiddenFromAI",
  "hiddenFromUser",
  "isConversationStart",
  "reactions",
  "personaSnapshot",
] as const;

function parseExtraRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function overlayMessageStableExtra(messageExtra: unknown, swipeExtra: unknown): unknown {
  const merged = { ...parseExtraRecord(swipeExtra) };
  const stable = parseExtraRecord(messageExtra);
  for (const key of MESSAGE_STABLE_EXTRA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stable, key)) merged[key] = stable[key];
  }

  return typeof messageExtra === "string" || typeof swipeExtra === "string" ? JSON.stringify(merged) : merged;
}

export function readSwipeCharacterId(extra: unknown): { present: boolean; characterId: string | null } {
  const parsed = parseExtraRecord(extra);
  if (!Object.prototype.hasOwnProperty.call(parsed, SWIPE_CHARACTER_ID_KEY)) {
    return { present: false, characterId: null };
  }
  const value = parsed[SWIPE_CHARACTER_ID_KEY];
  if (value === null) return { present: true, characterId: null };
  return typeof value === "string" && value.length > 0
    ? { present: true, characterId: value }
    : { present: false, characterId: null };
}

export function overlayMessageWithSwipe<TMessage extends MessageEnvelope>(
  message: TMessage,
  swipe: MessageSwipe | null | undefined,
): TMessage & { activeSwipeFound: boolean } {
  if (!swipe || swipe.messageId !== message.id || swipe.index !== message.activeSwipeIndex) {
    return { ...message, activeSwipeFound: false };
  }

  return overlayMessageWithExactSwipe(message, swipe);
}

export function overlayMessageWithExactSwipe<TMessage extends MessageEnvelope>(
  message: TMessage,
  swipe: MessageSwipe,
): TMessage & { activeSwipeFound: true } {
  if (swipe.messageId !== message.id) {
    throw new Error("Cannot overlay a swipe from a different message");
  }

  const swipeCharacter = readSwipeCharacterId(swipe.extra);
  return {
    ...message,
    content: swipe.content,
    // The selected swipe owns generated metadata (attachments, reasoning,
    // replay scope, and similar fields). Preserve only fields whose product
    // contract is message-wide so legacy rows cannot lose them when overlaid.
    extra: overlayMessageStableExtra(message.extra, swipe.extra),
    activeSwipeFound: true,
    ...(swipeCharacter.present ? { characterId: swipeCharacter.characterId } : {}),
  };
}

export function overlayMessagesWithActiveSwipes<TMessage extends MessageEnvelope>(
  messages: readonly TMessage[],
  swipes: readonly MessageSwipe[],
): Array<TMessage & { activeSwipeFound: boolean }> {
  const activeByMessageId = new Map<string, MessageSwipe>();
  const wanted = new Map(messages.map((message) => [message.id, message.activeSwipeIndex]));
  for (const swipe of swipes) {
    if (wanted.get(swipe.messageId) === swipe.index) activeByMessageId.set(swipe.messageId, swipe);
  }
  return messages.map((message) => overlayMessageWithSwipe(message, activeByMessageId.get(message.id)));
}

/** Resolve selected-swipe authority for a batch with one swipe-table scan. */
export async function overlayActiveSwipesForMessages<TMessage extends MessageEnvelope>(
  db: DB,
  messages: readonly TMessage[],
): Promise<Array<TMessage & { activeSwipeFound: boolean }>> {
  if (messages.length === 0) return [];
  const wanted = new Set(messages.map((message) => message.id));
  const swipes = (await db.select().from(messageSwipes)).filter((swipe) => wanted.has(swipe.messageId));
  return overlayMessagesWithActiveSwipes(messages, swipes);
}
