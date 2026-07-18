import { stripGenerationGuideInstruction, type GenerationGuideSource } from "@marinara-engine/shared";

export type GenerationReplayGuideSource = GenerationGuideSource;

export type ConversationScopeReplay =
  | { mode: "merged" }
  | { mode: "focused"; characterId: string }
  | { mode: "restricted"; characterIds: string[] };

export type ConversationScopeReplayInspection =
  | { kind: "absent" }
  | { kind: "valid"; scope: ConversationScopeReplay }
  | { kind: "invalid" };

export interface GenerationReplay {
  conversationScope?: ConversationScopeReplay;
  impersonate?: true;
  userMessage?: string | null;
  generationGuide?: string;
  generationGuideSource?: GenerationReplayGuideSource;
  narrativeDirectorMode?: "natural" | "random";
  impersonatePresetId?: string | null;
  impersonateConnectionId?: string | null;
  impersonateBlockAgents?: boolean;
  impersonatePromptTemplate?: string | null;
}

export interface GenerationReplayInput {
  conversationScope?: unknown;
  userMessage?: string | null;
  impersonate?: boolean;
  generationGuide?: string | null;
  generationGuideSource?: GenerationReplayGuideSource | null;
  narrativeDirectorMode?: "natural" | "random" | null;
  impersonatePresetId?: string | null;
  impersonateConnectionId?: string | null;
  impersonateBlockAgents?: boolean;
  impersonatePromptTemplate?: string | null;
}

const GUIDE_SOURCES = new Set<GenerationReplayGuideSource>(["narrator", "guide", "game_start"]);

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asTrimmedNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asGuideSource(value: unknown): GenerationReplayGuideSource | null {
  return typeof value === "string" && GUIDE_SOURCES.has(value as GenerationReplayGuideSource)
    ? (value as GenerationReplayGuideSource)
    : null;
}

function asNarrativeDirectorMode(value: unknown): "natural" | "random" | null {
  return value === "natural" || value === "random" ? value : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeConversationScopeReplay(value: unknown): ConversationScopeReplay | null {
  if (!isPlainRecord(value)) return null;
  if (value.mode === "merged") {
    return hasExactKeys(value, ["mode"]) ? { mode: "merged" } : null;
  }
  if (value.mode === "focused") {
    if (!hasExactKeys(value, ["mode", "characterId"])) return null;
    const characterId = asTrimmedNonEmptyString(value.characterId);
    return characterId ? { mode: "focused", characterId } : null;
  }
  if (value.mode === "restricted") {
    if (!hasExactKeys(value, ["mode", "characterIds"]) || !Array.isArray(value.characterIds)) return null;
    const seen = new Set<string>();
    const characterIds: string[] = [];
    for (const rawId of value.characterIds) {
      const characterId = asTrimmedNonEmptyString(rawId);
      if (!characterId) return null;
      if (seen.has(characterId)) continue;
      seen.add(characterId);
      characterIds.push(characterId);
    }
    return characterIds.length >= 2 ? { mode: "restricted", characterIds } : null;
  }
  return null;
}

export function inspectConversationScopeReplay(rawGenerationReplay: unknown): ConversationScopeReplayInspection {
  if (rawGenerationReplay === undefined || rawGenerationReplay === null) return { kind: "absent" };
  if (!isPlainRecord(rawGenerationReplay)) return { kind: "invalid" };
  if (!Object.prototype.hasOwnProperty.call(rawGenerationReplay, "conversationScope")) return { kind: "absent" };
  const scope = normalizeConversationScopeReplay(rawGenerationReplay.conversationScope);
  return scope ? { kind: "valid", scope } : { kind: "invalid" };
}

/**
 * Keep only the two swipe-owned fields that are safe and necessary when a
 * Conversation message is branched or round-tripped through JSONL. Prompt
 * caches, provider metadata, and the rest of generationReplay stay local.
 */
export function extractPortableConversationSwipeExtra(rawExtra: unknown): Record<string, unknown> {
  if (!isPlainRecord(rawExtra)) return {};

  const portable: Record<string, unknown> = {};
  const scopeInspection = inspectConversationScopeReplay(rawExtra.generationReplay);
  if (scopeInspection.kind === "valid") {
    portable.generationReplay = { conversationScope: scopeInspection.scope };
  }

  if (Object.prototype.hasOwnProperty.call(rawExtra, "swipeCharacterId")) {
    if (rawExtra.swipeCharacterId === null) {
      portable.swipeCharacterId = null;
    } else {
      const characterId = asTrimmedNonEmptyString(rawExtra.swipeCharacterId);
      if (characterId) portable.swipeCharacterId = characterId;
    }
  }

  return portable;
}

export function buildGenerationReplay(input: GenerationReplayInput): GenerationReplay | null {
  const replay: GenerationReplay = {};
  const conversationScope = normalizeConversationScopeReplay(input.conversationScope);
  if (conversationScope) replay.conversationScope = conversationScope;

  const guide = asNonEmptyString(input.generationGuide);
  const guideSource = asGuideSource(input.generationGuideSource);

  if (guide && guideSource) {
    replay.generationGuide = guide;
    replay.generationGuideSource = guideSource;
  }

  const narrativeDirectorMode = asNarrativeDirectorMode(input.narrativeDirectorMode);
  if (narrativeDirectorMode) replay.narrativeDirectorMode = narrativeDirectorMode;

  if (input.impersonate === true) {
    replay.impersonate = true;
    replay.userMessage = asNonEmptyString(input.userMessage);

    const impersonatePresetId = asTrimmedNonEmptyString(input.impersonatePresetId);
    if (impersonatePresetId) replay.impersonatePresetId = impersonatePresetId;

    const impersonateConnectionId = asTrimmedNonEmptyString(input.impersonateConnectionId);
    if (impersonateConnectionId) replay.impersonateConnectionId = impersonateConnectionId;

    if (input.impersonateBlockAgents === true) replay.impersonateBlockAgents = true;

    const impersonatePromptTemplate = asNonEmptyString(input.impersonatePromptTemplate);
    if (impersonatePromptTemplate) replay.impersonatePromptTemplate = impersonatePromptTemplate;
  }

  return Object.keys(replay).length > 0 ? replay : null;
}

export function normalizeGenerationReplay(value: unknown): GenerationReplay | null {
  if (!value || typeof value !== "object") return null;

  const raw = value as Record<string, unknown>;
  return buildGenerationReplay({
    conversationScope: raw.conversationScope,
    userMessage: asNonEmptyString(raw.userMessage),
    impersonate: raw.impersonate === true,
    generationGuide: asNonEmptyString(raw.generationGuide),
    generationGuideSource: asGuideSource(raw.generationGuideSource),
    narrativeDirectorMode: asNarrativeDirectorMode(raw.narrativeDirectorMode),
    impersonatePresetId: asTrimmedNonEmptyString(raw.impersonatePresetId),
    impersonateConnectionId: asTrimmedNonEmptyString(raw.impersonateConnectionId),
    impersonateBlockAgents: raw.impersonateBlockAgents === true,
    impersonatePromptTemplate: asNonEmptyString(raw.impersonatePromptTemplate),
  });
}

export function applyGenerationReplayToRegenerateInput(
  input: GenerationReplayInput,
  replay: GenerationReplay | null,
): boolean {
  if (!replay) return false;

  let applied = false;

  if (replay.impersonate === true) {
    if (input.impersonate !== true) {
      input.impersonate = true;
      applied = true;
    }

    const currentUserMessage = asNonEmptyString(input.userMessage);
    const explicitGuide = asNonEmptyString(input.generationGuide);
    if (explicitGuide) {
      if (!currentUserMessage) {
        input.userMessage = stripGenerationGuideInstruction(explicitGuide);
      }
      input.generationGuide = null;
      input.generationGuideSource = null;
      applied = true;
    } else if (!currentUserMessage && replay.userMessage) {
      input.userMessage = replay.userMessage;
      applied = true;
    } else if (!currentUserMessage && replay.generationGuide) {
      input.userMessage = stripGenerationGuideInstruction(replay.generationGuide);
      applied = true;
    }

    if (!asTrimmedNonEmptyString(input.impersonatePresetId) && replay.impersonatePresetId) {
      input.impersonatePresetId = replay.impersonatePresetId;
      applied = true;
    }

    if (!asTrimmedNonEmptyString(input.impersonateConnectionId) && replay.impersonateConnectionId) {
      input.impersonateConnectionId = replay.impersonateConnectionId;
      applied = true;
    }

    if (input.impersonateBlockAgents !== true && replay.impersonateBlockAgents === true) {
      input.impersonateBlockAgents = true;
      applied = true;
    }

    if (!asNonEmptyString(input.impersonatePromptTemplate) && replay.impersonatePromptTemplate) {
      input.impersonatePromptTemplate = replay.impersonatePromptTemplate;
      applied = true;
    }
  }

  if (replay.impersonate !== true && !asNonEmptyString(input.generationGuide) && replay.generationGuide) {
    input.generationGuide = replay.generationGuide;
    input.generationGuideSource = replay.generationGuideSource ?? "guide";
    applied = true;
  }

  if (!asNarrativeDirectorMode(input.narrativeDirectorMode) && replay.narrativeDirectorMode) {
    input.narrativeDirectorMode = replay.narrativeDirectorMode;
    applied = true;
  }

  return applied;
}
