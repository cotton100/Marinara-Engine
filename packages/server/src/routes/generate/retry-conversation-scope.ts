import {
  ConversationScopePreflightInputError,
  prepareConversationScopePreflight,
  type ConversationScopePreflightInput,
  type ConversationScopePreflightResult,
} from "./conversation-scope-preflight.js";
import type { ConversationScopeErrorCode } from "./generate-route-utils.js";
import type { LorebookAccessContext } from "../../services/lorebook/access-context.js";

export class RetryConversationScopeError extends Error {
  constructor(readonly code: ConversationScopeErrorCode | ConversationScopePreflightInputError["code"]) {
    super(code);
    this.name = "RetryConversationScopeError";
  }
}

export type RetryConversationScopeResult = ConversationScopePreflightResult & {
  promptCharacterIds: string[];
  primaryCharacterId: string | null;
  /**
   * Defined only for multi-character Conversation scope.  `[]` means a
   * shared group memory, `[id]` means focused ownership, and `undefined`
   * preserves legacy Personal Convo / Roleplay write matching.
   */
  newEntryCharacterFilterIds?: string[];
};

export async function resolveRetryConversationScope(
  input: Omit<
    ConversationScopePreflightInput,
    "impersonate" | "lifecycle" | "explicitTargetCharacterId" | "mentionedCharacterNames"
  >,
): Promise<RetryConversationScopeResult> {
  let preflight: ConversationScopePreflightResult;
  try {
    preflight = await prepareConversationScopePreflight({
      ...input,
      impersonate: false,
      lifecycle: "regenerate",
      explicitTargetCharacterId: null,
      mentionedCharacterNames: [],
    });
  } catch (error) {
    if (error instanceof ConversationScopePreflightInputError) {
      throw new RetryConversationScopeError(error.code);
    }
    throw error;
  }

  if (preflight.resolution.kind === "invalid") {
    throw new RetryConversationScopeError(preflight.resolution.code);
  }

  const focusedCharacterIds = preflight.resolution.kind === "focused" ? [preflight.resolution.targetCharacterId] : [];
  const promptCharacterIds = focusedCharacterIds.length > 0 ? focusedCharacterIds : [...preflight.activeCharacterIds];
  const primaryCharacterId =
    preflight.resolution.kind === "focused"
      ? preflight.resolution.targetCharacterId
      : preflight.resolution.kind === "restricted"
        ? (preflight.resolution.allowedCharacterIds[0] ?? promptCharacterIds[0] ?? null)
        : (promptCharacterIds[0] ?? null);
  return {
    ...preflight,
    promptCharacterIds,
    primaryCharacterId,
    newEntryCharacterFilterIds:
      preflight.resolution.kind === "focused"
        ? focusedCharacterIds
        : preflight.resolution.kind === "merged" || preflight.resolution.kind === "restricted"
          ? []
          : undefined,
  };
}

export function buildRetryLorebookAccessContext(
  baseContext: LorebookAccessContext,
  scope: Pick<RetryConversationScopeResult, "promptCharacterIds">,
  characterTagsById: Readonly<Record<string, readonly string[]>>,
): LorebookAccessContext {
  const promptCharacterIds = [...scope.promptCharacterIds];
  return {
    ...baseContext,
    characterIds: promptCharacterIds,
    activeCharacterIds: promptCharacterIds,
    activeCharacterTags: Array.from(
      new Set(promptCharacterIds.flatMap((characterId) => characterTagsById[characterId] ?? [])),
    ),
  };
}
