import { inspectConversationScopeReplay, type ConversationScopeReplayInspection } from "./generation-replay.js";
import {
  resolveActiveCharacterIds,
  resolveCharacterNameMap,
  resolveConversationScope,
  type ConversationScopeLifecycle,
  type ConversationScopeResolution,
} from "./generate-route-utils.js";

export type ConversationScopePreflightInput = {
  chatMode: string | null | undefined;
  storedCharacterIds: unknown;
  chatMetadata: Record<string, unknown>;
  impersonate: boolean;
  lifecycle: ConversationScopeLifecycle;
  explicitTargetCharacterId?: string | null;
  mentionedCharacterNames: readonly string[];
  rawGenerationReplay: unknown;
  getCharacterById: (id: string) => Promise<{ data?: unknown } | null | undefined>;
};

export type ConversationScopePreflightResult = {
  allCharacterIds: string[];
  activeCharacterIds: string[];
  activeCharacters: Array<{ id: string; name: string }>;
  replay: ConversationScopeReplayInspection;
  resolution: ConversationScopeResolution;
};

export type ConversationScopePreflightInputErrorCode = "invalid_character_roster" | "all_characters_inactive";

export class ConversationScopePreflightInputError extends Error {
  constructor(readonly code: ConversationScopePreflightInputErrorCode) {
    super(code);
    this.name = "ConversationScopePreflightInputError";
  }
}

function parseStoredCharacterIds(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new ConversationScopePreflightInputError("invalid_character_roster");
    }
  }

  if (!Array.isArray(parsed)) {
    throw new ConversationScopePreflightInputError("invalid_character_roster");
  }

  const characterIds: string[] = [];
  for (const rawId of parsed) {
    if (typeof rawId !== "string" || !rawId.trim()) {
      throw new ConversationScopePreflightInputError("invalid_character_roster");
    }
    characterIds.push(rawId);
  }
  return characterIds;
}

export async function prepareConversationScopePreflight(
  input: ConversationScopePreflightInput,
): Promise<ConversationScopePreflightResult> {
  const replay = inspectConversationScopeReplay(input.rawGenerationReplay);
  const allCharacterIds = parseStoredCharacterIds(input.storedCharacterIds);
  if (input.chatMode === "conversation" && new Set(allCharacterIds).size !== allCharacterIds.length) {
    throw new ConversationScopePreflightInputError("invalid_character_roster");
  }
  const activeCharacterIds = resolveActiveCharacterIds(allCharacterIds, input.chatMetadata, {
    mode: input.chatMode ?? undefined,
    allowEmpty: true,
  });

  if (allCharacterIds.length > 0 && activeCharacterIds.length === 0) {
    throw new ConversationScopePreflightInputError("all_characters_inactive");
  }

  const characterNamesById = await resolveCharacterNameMap(activeCharacterIds, input.getCharacterById);
  if (input.chatMode === "conversation" && characterNamesById.size !== activeCharacterIds.length) {
    throw new ConversationScopePreflightInputError("invalid_character_roster");
  }
  const activeCharacters = activeCharacterIds.flatMap((id) => {
    const name = characterNamesById.get(id);
    return name ? [{ id, name }] : [];
  });
  const resolution = resolveConversationScope({
    chatMode: input.chatMode,
    // Conversation scope belongs to the stored ensemble, not merely the
    // currently-active subset.  Otherwise a two-person focused swipe can be
    // silently reinterpreted as a one-person non-group after its target is
    // deactivated instead of failing closed as a stale replay.
    isGroupChat:
      allCharacterIds.length > 1 ||
      (input.chatMode === "conversation" && input.lifecycle !== "initial" && replay.kind !== "absent"),
    impersonate: input.impersonate,
    activeCharacters,
    lifecycle: input.lifecycle,
    explicitTargetCharacterId: input.explicitTargetCharacterId,
    mentionedCharacterNames: input.mentionedCharacterNames,
    replay,
  });

  return {
    allCharacterIds,
    activeCharacterIds,
    activeCharacters,
    replay,
    resolution,
  };
}
