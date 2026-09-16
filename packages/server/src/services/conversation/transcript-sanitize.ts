// ──────────────────────────────────────────────
// Conversation: Transcript Sanitizers
// ──────────────────────────────────────────────
import {
  CLOCK_TOKEN_SOURCE,
  DATE_TIME_TOKEN_SOURCE,
  FULL_DATE_TOKEN_SOURCE,
  decodeEncodedSpeakerTags,
  normalizeSpeakerName,
  normalizeTextForMatch,
  parseNamePrefixFormat,
  parseSpeakerTags,
} from "@marinara-engine/shared";

const DATE_TAG_RE = /<\/?date(?:="[^"]*")?>/gi;
const TIMESTAMP_TOKEN = String.raw`\[(?:${DATE_TIME_TOKEN_SOURCE}|${CLOCK_TOKEN_SOURCE}|${FULL_DATE_TOKEN_SOURCE})\]`;
const LEADING_TIMESTAMP_RE = new RegExp(`^(\\s*(?:[-*]\\s*)?)(?:${TIMESTAMP_TOKEN}\\s*)+`, "gim");
const SPEAKER_TIMESTAMP_RE = new RegExp(`^(\\s*(?:[-*]\\s*)?[^:\\n]{1,80}:\\s*)(?:${TIMESTAMP_TOKEN}\\s*)+`, "gim");
const CONVERSATION_REPEAT_MIN_LENGTH = 40;

type ConversationResponseHistoryMessage = {
  id?: unknown;
  role?: unknown;
  characterId?: unknown;
  content?: unknown;
};

/**
 * Detect a substantial exact repeat of the same character's latest message.
 * Short conversational responses remain repeatable because phrases such as
 * "lol" or "good morning" can be natural on consecutive turns.
 */
export function isRepeatedConversationResponse(
  messages: readonly ConversationResponseHistoryMessage[],
  characterId: string | null,
  content: string,
  options: { excludeMessageId?: string | null } = {},
): boolean {
  const normalizedContent = normalizeTextForMatch(content);
  if (normalizedContent.length < CONVERSATION_REPEAT_MIN_LENGTH) return false;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (options.excludeMessageId && message.id === options.excludeMessageId) continue;
    if (message.role !== "assistant" || (message.characterId ?? null) !== characterId) continue;
    if (normalizeTextForMatch(message.content) === normalizedContent) return true;
  }
  return false;
}

/** Collapse model-produced `Name: Name:` prefixes without touching later dialogue text. */
export function collapseDuplicateConversationSpeakerPrefixes(content: string, speakerNames: readonly string[]): string {
  let cleaned = content;
  const uniqueSpeakerNames = new Set(speakerNames.map((speakerName) => speakerName.trim()).filter(Boolean));
  for (const speakerName of uniqueSpeakerNames) {
    const escapedName = speakerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(
      new RegExp(`(^|\\n)(\\s*(?:[-*]\\s*)?)(${escapedName}\\s*:\\s*)(?:${escapedName}\\s*:\\s*)+`, "gi"),
      "$1$2$3",
    );
  }
  return cleaned;
}

/**
 * Conversation mode adds prompt-only timestamps like [12:01] for DM time awareness.
 * Strip those when conversation text crosses into roleplay/game context.
 */
export function stripConversationPromptTimestamps(content: string): string {
  return content
    .replace(DATE_TAG_RE, "")
    .replace(LEADING_TIMESTAMP_RE, "$1")
    .replace(SPEAKER_TIMESTAMP_RE, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Remove model-leaked Conversation metadata before persistence. Merged group
 * replies keep their `Name:` boundaries because the client uses them to split
 * speakers; single and individual replies already have a server-owned speaker.
 */
export function stripConversationResponseEnvelope(
  content: string,
  options: {
    speakerName?: string | null;
    speakerNames?: readonly string[];
    preserveSpeakerPrefix?: boolean;
  } = {},
): string {
  let cleaned = stripConversationPromptTimestamps(content);
  const speakerName = options.speakerName?.trim();
  cleaned = collapseDuplicateConversationSpeakerPrefixes(
    cleaned,
    options.speakerNames ?? (speakerName ? [speakerName] : []),
  );
  if (!speakerName || options.preserveSpeakerPrefix) return cleaned;

  const escapedName = speakerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  cleaned = cleaned
    .replace(new RegExp(`^\\s*${escapedName}\\s*:\\s*`, "i"), "")
    .replace(new RegExp(`^\\s*${escapedName}\\s*\\n+`, "i"), "")
    .trim();
  return cleaned;
}

/** Keep only the selected CMB speaker's response, before extracting commands or history. */
export function retainConversationSpeaker(
  content: string,
  characterId: string | null,
  characters: readonly { id: string; name: string; convoDisplayName?: string }[],
): string {
  const character = characters.find((candidate) => candidate.id === characterId);
  if (!character?.name.trim()) return "";
  const aliases = (candidate: { name: string; convoDisplayName?: string }) =>
    [candidate.name, candidate.convoDisplayName].filter((name): name is string => !!name?.trim());
  const targetAliases = aliases(character);
  const targetNames = new Set(targetAliases.map(normalizeSpeakerName));
  const speakerNames = characters.flatMap(aliases);
  const knownNames = new Set(speakerNames.map(normalizeSpeakerName));
  let cleaned = decodeEncodedSpeakerTags(stripConversationPromptTimestamps(content));
  // Explicit unknown tags must not become unlabelled narration owned by the target.
  for (const match of cleaned.matchAll(/<speaker="([^"]*)">/g)) {
    knownNames.add(normalizeSpeakerName(match[1]));
  }
  // ponytail: cap nested/mixed envelopes at eight passes; reject deeper output.
  // Reuse the display parsers so retained text cannot reveal another speaker on reparse.
  for (let pass = 0; pass < 8; pass++) {
    const segments =
      parseSpeakerTags(cleaned, knownNames) ?? parseNamePrefixFormat(cleaned, knownNames, character.name);
    const retained = segments
      ? segments
          .filter((segment) => segment.speaker === null || targetNames.has(normalizeSpeakerName(segment.speaker)))
          .map((segment) => segment.text)
          .join("\n")
      : cleaned;
    const next = targetAliases.reduce(
      (text, speakerName) => stripConversationResponseEnvelope(text, { speakerName, speakerNames }),
      retained,
    );
    if (next === cleaned) {
      // Display and future prompts expand macros before parsing speakers. Keep
      // generated macros literal in CMB-scoped replies so a later context/seed
      // cannot reveal another speaker or execute variable writes. Literalize
      // only after envelope removal, including overlapping `{{{` and internal
      // macro sentinels; authored cards and ordinary replies are unchanged.
      return next
        .replace(/\{(?=\{)/g, "{ ")
        .replace(/\x00/g, "\u2400")
        .replace(/\x1e/g, "\u241e");
    }
    cleaned = next;
  }
  return "";
}
