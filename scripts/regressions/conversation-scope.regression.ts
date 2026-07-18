import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const tempRoot = await mkdtemp(join(tmpdir(), "marinara-conversation-scope-"));
process.env.DATA_DIR = join(tempRoot, "data");
process.env.FILE_STORAGE_DIR = join(tempRoot, "storage");

let closeDatabase: (() => Promise<void>) | null = null;

try {
  const { resolveConversationScope, resolveNonConversationLifecycleCharacterFallback } =
    await import("../../packages/server/src/routes/generate/generate-route-utils.js");
  const {
    applyGenerationReplayToRegenerateInput,
    buildGenerationReplay,
    extractPortableConversationSwipeExtra,
    inspectConversationScopeReplay,
    normalizeGenerationReplay,
  } = await import("../../packages/server/src/routes/generate/generation-replay.js");
  const { ConversationScopePreflightInputError, prepareConversationScopePreflight } =
    await import("../../packages/server/src/routes/generate/conversation-scope-preflight.js");
  const { ConversationMessageAuthorityError, readAuthoritativeConversationMessage, replaceMessageSnapshot } =
    await import("../../packages/server/src/routes/generate/conversation-message-authority.js");
  const {
    acquireActiveGenerationLease,
    acquireChatMutationLease,
    acquireMessageMutationLease,
    createActiveGenerationRegistry,
    requireActiveGenerationRegistry,
    takeOverActiveGenerationLease,
  } = await import("../../packages/server/src/services/generation/active-generation-registry.js");
  const { buildRetryLorebookAccessContext, RetryConversationScopeError, resolveRetryConversationScope } =
    await import("../../packages/server/src/routes/generate/retry-conversation-scope.js");
  const {
    hasExactConversationPresenceRoster,
    resolveConversationPresenceRuntime,
    selectConversationPresenceResponders,
  } = await import("../../packages/server/src/routes/generate/conversation-presence-runtime.js");
  const { parseCharacterCommandsBySpeaker } =
    await import("../../packages/server/src/services/conversation/character-commands.js");
  const { filterLorebookEntriesForPromptContext } =
    await import("../../packages/server/src/services/lorebook/keyword-scanner.js");
  const {
    filterAccessibleLorebooks,
    lorebookIsWritableInAccessContext,
    normalizeLorebookAccessContext,
    normalizeLorebookCharacterFilterIds,
    normalizeLorebookPromptContext,
  } = await import("../../packages/server/src/services/lorebook/access-context.js");
  const {
    applyLorebookKeeperRunMemoryScope,
    buildHistoricalLorebookKeeperContext,
    loadLorebookKeeperExistingEntries,
    persistLorebookKeeperUpdates,
    resolveLorebookKeeperTarget,
  } = await import("../../packages/server/src/routes/generate/lorebook-keeper-utils.js");
  const { buildLorebookWriteApprovalProposal } =
    await import("../../packages/server/src/routes/generate/agent-write-approval.js");
  const { resolveGenerationTools } =
    await import("../../packages/server/src/services/generation/tool-resolution-runtime.js");
  const { importSTChat } = await import("../../packages/server/src/services/import/st-chat.importer.js");
  const { buildPromptMacroContext } = await import("../../packages/server/src/services/prompt/macro-context.js");
  const { buildAgentPromptMacroContext } = await import("../../packages/server/src/services/agents/agent-executor.js");
  const { formatConversationGroupOutputFormat, resolveConversationOutputCharacterNames } =
    await import("../../packages/server/src/routes/generate/conversation-prompt-formatting.js");

  const activeCharacters = [
    { id: "leo", name: "Leo" },
    { id: "dan", name: "Dan" },
    { id: "haram", name: "Haram" },
  ] as const;

  const outputRoster = [
    { id: "c", name: "C" },
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const focusedOutputNames = resolveConversationOutputCharacterNames(["a"], outputRoster);
  const restrictedOutputNames = resolveConversationOutputCharacterNames(["a", "b"], outputRoster);
  const mergedOutputNames = resolveConversationOutputCharacterNames(["c", "a", "b"], outputRoster);
  assert.deepEqual(focusedOutputNames, ["A"]);
  assert.deepEqual(restrictedOutputNames, ["A", "B"]);
  assert.deepEqual(mergedOutputNames, ["C", "A", "B"]);
  const focusedOutputFormat = formatConversationGroupOutputFormat({
    wrapFormat: "xml",
    characterNames: focusedOutputNames,
    userName: "User",
  });
  assert.match(focusedOutputFormat, /Only respond for these characters: A\./);
  assert.doesNotMatch(focusedOutputFormat, /\bB\b|\bC\b/);

  const retryCharacterRows = new Map(
    activeCharacters.map((character) => [character.id, { data: JSON.stringify({ name: character.name }) }]),
  );
  const retryFocusedLeo = await resolveRetryConversationScope({
    chatMode: "conversation",
    storedCharacterIds: ["leo", "dan"],
    chatMetadata: {},
    rawGenerationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
    getCharacterById: async (id) => retryCharacterRows.get(id) ?? null,
  });
  assert.equal(retryFocusedLeo.resolution.kind, "focused");
  assert.deepEqual(retryFocusedLeo.promptCharacterIds, ["leo"]);
  assert.equal(retryFocusedLeo.primaryCharacterId, "leo");
  assert.deepEqual(retryFocusedLeo.newEntryCharacterFilterIds, ["leo"]);

  const retryMerged = await resolveRetryConversationScope({
    chatMode: "conversation",
    storedCharacterIds: ["leo", "dan"],
    chatMetadata: {},
    rawGenerationReplay: { conversationScope: { mode: "merged" } },
    getCharacterById: async (id) => retryCharacterRows.get(id) ?? null,
  });
  assert.equal(retryMerged.resolution.kind, "merged");
  assert.deepEqual(retryMerged.promptCharacterIds, ["leo", "dan"]);
  assert.equal(retryMerged.primaryCharacterId, "leo");
  assert.deepEqual(retryMerged.newEntryCharacterFilterIds, []);

  const retryRoleplay = await resolveRetryConversationScope({
    chatMode: "roleplay",
    storedCharacterIds: ["leo", "dan"],
    chatMetadata: {},
    rawGenerationReplay: undefined,
    getCharacterById: async (id) => retryCharacterRows.get(id) ?? null,
  });
  assert.equal(
    retryRoleplay.newEntryCharacterFilterIds,
    undefined,
    "non-Conversation retry writes must preserve legacy same-name matching",
  );

  const retryFocusedDan = await resolveRetryConversationScope({
    chatMode: "conversation",
    storedCharacterIds: ["leo", "dan"],
    chatMetadata: {},
    rawGenerationReplay: { conversationScope: { mode: "focused", characterId: "dan" } },
    getCharacterById: async (id) => retryCharacterRows.get(id) ?? null,
  });
  assert.deepEqual(retryFocusedDan.promptCharacterIds, ["dan"], "backfill targets must restore their own swipe scope");
  assert.equal(retryFocusedDan.primaryCharacterId, "dan");
  const retryDanAccessContext = buildRetryLorebookAccessContext(
    {
      chatId: "focused-chat",
      characterIds: ["leo"],
      personaId: null,
      activeLorebookIds: [],
      excludedLorebookIds: [],
      excludedSourceAgentIds: [],
      activeCharacterIds: ["leo"],
      activeCharacterTags: ["leader"],
      generationTriggers: ["chat"],
    },
    retryFocusedDan,
    { leo: ["leader"], dan: ["medic"] },
  );
  assert.deepEqual(retryDanAccessContext.characterIds, ["dan"]);
  assert.deepEqual(retryDanAccessContext.activeCharacterIds, ["dan"]);
  assert.deepEqual(retryDanAccessContext.activeCharacterTags, ["medic"]);
  await assert.rejects(
    () =>
      resolveRetryConversationScope({
        chatMode: "conversation",
        storedCharacterIds: ["leo", "dan"],
        chatMetadata: {},
        rawGenerationReplay: { conversationScope: { mode: "focused", characterId: "haram" } },
        getCharacterById: async (id) => retryCharacterRows.get(id) ?? null,
      }),
    (error: unknown) => error instanceof RetryConversationScopeError && error.code === "stale_replay_scope",
    "retry must fail closed before provider work when the stored swipe target is stale",
  );

  const lorebookFilterDefaults = {
    characterTagFilterMode: "any",
    characterTagFilters: [],
    generationTriggerFilterMode: "any",
    generationTriggerFilters: [],
  } as const;
  const scopedLorebookEntries = [
    {
      ...lorebookFilterDefaults,
      id: "shared",
      name: "Shared",
      content: "Known by everyone",
      characterFilterMode: "any",
      characterFilterIds: [],
    },
    {
      ...lorebookFilterDefaults,
      id: "leo-private",
      name: "Leo secret",
      content: "Known by Leo",
      characterFilterMode: "include",
      characterFilterIds: ["leo"],
    },
    {
      ...lorebookFilterDefaults,
      id: "dan-private",
      name: "Dan secret",
      content: "Known by Dan",
      characterFilterMode: "include",
      characterFilterIds: ["dan"],
    },
  ];
  const focusedLeoLorebookContext = {
    activeCharacterIds: ["leo"],
    activeCharacterTags: [],
    generationTriggers: ["chat"],
  };
  const focusedLeoLorebookAccessContext = {
    chatId: "focused-chat",
    characterIds: ["leo"],
    personaId: null,
    activeLorebookIds: [],
    excludedLorebookIds: [],
    excludedSourceAgentIds: [],
    ...focusedLeoLorebookContext,
  };
  const historicalDanMemory = applyLorebookKeeperRunMemoryScope({
    baseMemory: {
      retained: "yes",
      _lorebookAccessContext: focusedLeoLorebookAccessContext,
      _newLorebookEntryCharacterFilterIds: ["leo"],
      _existingLorebookEntries: [{ id: "leo-entry", name: "Leo memory" }],
    },
    accessContext: retryDanAccessContext,
    newEntryCharacterFilterIds: ["dan"],
    targetLorebookId: "dan-book",
    targetLorebookName: "Dan book",
    existingEntries: [],
  });
  assert.equal(historicalDanMemory.retained, "yes");
  assert.deepEqual(historicalDanMemory._lorebookAccessContext, retryDanAccessContext);
  assert.deepEqual(historicalDanMemory._newLorebookEntryCharacterFilterIds, ["dan"]);
  assert.equal(
    Object.prototype.hasOwnProperty.call(historicalDanMemory, "_existingLorebookEntries"),
    false,
    "a historical target with zero entries must not inherit the latest turn's existing memories",
  );
  const historicalLegacyMemory = applyLorebookKeeperRunMemoryScope({
    baseMemory: historicalDanMemory,
    accessContext: focusedLeoLorebookAccessContext,
    newEntryCharacterFilterIds: undefined,
    targetLorebookId: null,
    targetLorebookName: null,
    existingEntries: [],
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(historicalLegacyMemory, "_newLorebookEntryCharacterFilterIds"),
    false,
    "non-Conversation historical runs must clear inherited character write ownership",
  );
  assert.deepEqual(normalizeLorebookAccessContext(focusedLeoLorebookAccessContext), focusedLeoLorebookAccessContext);
  assert.equal(
    normalizeLorebookAccessContext({
      ...focusedLeoLorebookAccessContext,
      activeCharacterIds: ["dan"],
    }),
    null,
    "an approval scope must not claim an active character outside its accessible character roster",
  );
  assert.equal(
    normalizeLorebookPromptContext({ ...focusedLeoLorebookContext, generationTriggers: ["chat", 42] }),
    null,
    "approval prompt scope arrays must fail closed instead of filtering malformed elements",
  );
  assert.deepEqual(normalizeLorebookCharacterFilterIds([" leo ", "leo"], focusedLeoLorebookAccessContext), ["leo"]);
  assert.equal(
    normalizeLorebookCharacterFilterIds(["dan"], focusedLeoLorebookAccessContext),
    null,
    "new-entry ownership must stay inside the original active character scope",
  );

  const focusedApprovalProposal = buildLorebookWriteApprovalProposal({
    chatId: "focused-chat",
    agentType: "lorebook-keeper",
    agentName: "Lorebook Keeper",
    updates: [{ name: "Leo memory", content: "Leo remembers", keys: [] }],
    preferredTargetLorebookId: "leo-book",
    writableLorebookIds: ["leo-book"],
    lorebookPromptContext: focusedLeoLorebookContext,
    newEntryCharacterFilterIds: ["leo"],
    accessContext: focusedLeoLorebookAccessContext,
    allowCreateTarget: false,
  });
  assert.deepEqual(focusedApprovalProposal.payload?.accessContext, focusedLeoLorebookAccessContext);
  assert.deepEqual(focusedApprovalProposal.payload?.lorebookPromptContext, focusedLeoLorebookContext);
  assert.deepEqual(focusedApprovalProposal.payload?.newEntryCharacterFilterIds, ["leo"]);
  assert.equal(focusedApprovalProposal.payload?.allowCreateTarget, false);
  const legacyApprovalProposal = buildLorebookWriteApprovalProposal({
    chatId: "legacy-chat",
    agentType: "lorebook-keeper",
    agentName: "Lorebook Keeper",
    updates: [],
    preferredTargetLorebookId: null,
    writableLorebookIds: null,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(legacyApprovalProposal.payload, "accessContext"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(legacyApprovalProposal.payload, "lorebookPromptContext"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(legacyApprovalProposal.payload, "newEntryCharacterFilterIds"),
    false,
    "legacy approval payloads must remain distinguishable from scoped proposals",
  );
  assert.deepEqual(
    filterLorebookEntriesForPromptContext(scopedLorebookEntries, focusedLeoLorebookContext).map((entry) => entry.id),
    ["shared", "leo-private"],
    "focused lorebook consumers must exclude entries scoped to another character",
  );
  assert.deepEqual(
    filterLorebookEntriesForPromptContext(scopedLorebookEntries, {
      ...focusedLeoLorebookContext,
      activeCharacterIds: ["leo", "dan"],
    }).map((entry) => entry.id),
    ["shared", "leo-private", "dan-private"],
    "merged lorebook consumers must retain entries visible to the full prompt roster",
  );

  const lorebookDefaults = {
    name: "Book",
    enabled: true,
    scanDepth: 4,
    tokenBudget: 1000,
    entryLimit: 10,
    recursiveScanning: false,
    maxRecursionDepth: 1,
    vectorScoreThreshold: null,
    vectorMaxResults: null,
    isGlobal: false,
    characterId: null,
    characterIds: [],
    personaId: null,
    personaIds: [],
    chatId: null,
    scope: { mode: "all", chatIds: [] },
    sourceAgentId: null,
  } as const;
  const scopedLorebooks = [
    { ...lorebookDefaults, id: "global", isGlobal: true },
    { ...lorebookDefaults, id: "chat", chatId: "focused-chat" },
    { ...lorebookDefaults, id: "leo-book", characterIds: ["leo"] },
    { ...lorebookDefaults, id: "dan-book", characterIds: ["dan"] },
  ];
  assert.deepEqual(
    filterAccessibleLorebooks(scopedLorebooks, focusedLeoLorebookAccessContext).map((book) => book.id),
    ["global", "chat", "leo-book"],
    "focused lorebook access must reject another character's manually configured book",
  );
  assert.equal(lorebookIsWritableInAccessContext(scopedLorebooks[3]!, focusedLeoLorebookAccessContext), false);
  const mergedLorebookAccessContext = {
    ...focusedLeoLorebookAccessContext,
    characterIds: ["leo", "dan"],
    activeCharacterIds: ["leo", "dan"],
  };
  assert.equal(lorebookIsWritableInAccessContext(scopedLorebooks[3]!, mergedLorebookAccessContext), true);

  const keeperWrites: Array<{ kind: "create" | "update"; value: Record<string, unknown> }> = [];
  const keeperStore = {
    list: async () => scopedLorebooks,
    getById: async (id: string) => scopedLorebooks.find((book) => book.id === id) ?? null,
    listEntries: async () => [
      {
        ...lorebookFilterDefaults,
        id: "dan-secret",
        lorebookId: "book-1",
        name: "Secret",
        content: "Dan only",
        keys: [],
        tag: "",
        locked: false,
        characterFilterMode: "include",
        characterFilterIds: ["dan"],
      },
    ],
    createEntry: async (value: Record<string, unknown>) => {
      keeperWrites.push({ kind: "create", value });
      return { id: "created-secret", ...value };
    },
    updateEntry: async (_id: string, value: Record<string, unknown>) => {
      keeperWrites.push({ kind: "update", value });
      return value;
    },
  };
  const focusedExistingEntries = await loadLorebookKeeperExistingEntries(
    keeperStore as never,
    "chat",
    focusedLeoLorebookContext,
  );
  assert.deepEqual(focusedExistingEntries, [], "Keeper must not receive another character's private entry body");
  await persistLorebookKeeperUpdates({
    lorebooksStore: keeperStore as never,
    chatId: "focused-chat",
    chatName: "Focused chat",
    preferredTargetLorebookId: "chat",
    writableLorebookIds: ["chat"],
    updates: [{ name: "Secret", content: "Leo only", keys: [] }],
    lorebookPromptContext: focusedLeoLorebookContext,
    newEntryCharacterFilterIds: ["leo"],
    accessContext: focusedLeoLorebookAccessContext,
  });
  assert.equal(keeperWrites.length, 1);
  assert.equal(keeperWrites[0]?.kind, "create", "a hidden same-name entry must never be overwritten");
  assert.deepEqual(keeperWrites[0]?.value.characterFilterIds, ["leo"]);
  assert.equal(keeperWrites[0]?.value.characterFilterMode, "include");
  const writesBeforeDeniedTarget = keeperWrites.length;
  const deniedEditOnlyTarget = await persistLorebookKeeperUpdates({
    lorebooksStore: keeperStore as never,
    chatId: "focused-chat",
    chatName: "Focused chat",
    preferredTargetLorebookId: "dan-book",
    writableLorebookIds: ["dan-book"],
    updates: [{ name: "Denied", content: "Must not create a fallback book", keys: [] }],
    lorebookPromptContext: focusedLeoLorebookContext,
    newEntryCharacterFilterIds: ["leo"],
    accessContext: focusedLeoLorebookAccessContext,
    allowCreateTarget: false,
  });
  assert.equal(deniedEditOnlyTarget, null);
  assert.equal(
    keeperWrites.length,
    writesBeforeDeniedTarget,
    "an edit-only scoped write must not create a fallback lorebook when every configured target is inaccessible",
  );

  const focusedKeeperTarget = await resolveLorebookKeeperTarget({
    lorebooksStore: keeperStore as never,
    accessContext: focusedLeoLorebookAccessContext,
    preferredTargetLorebookId: "dan-book",
  });
  assert.equal(focusedKeeperTarget.writableLorebookIds.includes("dan-book"), false);
  const mergedKeeperTarget = await resolveLorebookKeeperTarget({
    lorebooksStore: keeperStore as never,
    accessContext: mergedLorebookAccessContext,
    preferredTargetLorebookId: "dan-book",
  });
  assert.equal(mergedKeeperTarget.targetLorebookId, "dan-book");

  const toolEntryDefaults = {
    ...lorebookFilterDefaults,
    lorebookId: "leo-book",
    description: "",
    keys: ["needle"],
    tag: "",
    enabled: true,
    constant: false,
    selective: false,
    position: 0,
    depth: 4,
    role: "system",
    priority: 0,
    order: 0,
    probability: null,
    sticky: null,
    cooldown: null,
    delay: null,
    activationConditions: [],
    schedule: null,
    locked: false,
    ephemeral: null,
  } as const;

  async function buildToolRuntimeFixture(args: {
    writableLorebookId: string;
    requireApproval?: boolean;
    listActiveEntries?: Array<Record<string, unknown>>;
    listEntries?: Array<Record<string, unknown>>;
    entryStateOverrides?: Record<string, { enabled?: boolean; ephemeral?: number | null }>;
    accessContext?: typeof focusedLeoLorebookAccessContext;
    promptCharacterIds?: string[];
    primaryCharacterId?: string | null;
    agentCharacters?: Array<{ id: string; name: string }>;
    /** null explicitly requests the legacy non-Conversation write path. */
    newEntryCharacterFilterIds?: string[] | null;
  }) {
    const calls = { getById: 0, listEntries: 0, createEntry: 0, updateEntry: 0 };
    const writes: Array<Record<string, unknown>> = [];
    const booksById = new Map(scopedLorebooks.map((book) => [book.id, book]));
    const lorebooksStore = {
      listActiveEntries: async () => args.listActiveEntries ?? [],
      getById: async (id: string) => {
        calls.getById += 1;
        return booksById.get(id) ?? null;
      },
      listEntries: async () => {
        calls.listEntries += 1;
        return args.listEntries ?? [];
      },
      createEntry: async (value: Record<string, unknown>) => {
        calls.createEntry += 1;
        writes.push(value);
        return { id: "created-by-tool", ...value };
      },
      updateEntry: async (_id: string, value: Record<string, unknown>) => {
        calls.updateEntry += 1;
        writes.push(value);
        return value;
      },
    };
    const agent = {
      id: "custom-memory-agent",
      type: "custom-memory-agent",
      name: "Memory Agent",
      phase: "post_processing",
      promptTemplate: "",
      connectionId: null,
      settings: {
        enabledTools: ["save_lorebook_entry"],
        writableLorebookId: args.writableLorebookId,
      },
      provider: {},
      model: "test",
    };
    const agentContext = {
      chatId: "focused-chat",
      chatMode: "conversation",
      recentMessages: [],
      mainResponse: null,
      gameState: null,
      characters: args.agentCharacters ?? [],
      persona: null,
      memory: {},
      activatedLorebookEntries: null,
      writableLorebookIds: null,
      chatSummary: null,
    };
    const runtime = await resolveGenerationTools({
      requestBody: { enableTools: true },
      chatId: "focused-chat",
      chatMetadata: {
        ...(args.requireApproval ? { agentWriteApprovalRequired: true } : {}),
        ...(args.entryStateOverrides ? { entryStateOverrides: args.entryStateOverrides } : {}),
      },
      chats: {
        getMessage: async () => null,
        updateMessageContent: async () => null,
        patchMetadata: async () => null,
      },
      agentsStore: {},
      customToolsStore: { listEnabled: async () => [] },
      lorebooksStore,
      resolvedAgents: [agent] as never,
      enabledConfigs: [],
      promptCharacterIds: args.promptCharacterIds ?? args.accessContext?.activeCharacterIds ?? ["leo"],
      primaryCharacterId: args.primaryCharacterId ?? null,
      personaId: null,
      activeLorebookIds: [],
      excludedLorebookIds: [],
      excludedSourceAgentIds: [],
      lorebookAccessContext: args.accessContext ?? focusedLeoLorebookAccessContext,
      newLorebookEntryCharacterFilterIds:
        args.newEntryCharacterFilterIds === null ? undefined : (args.newEntryCharacterFilterIds ?? ["leo"]),
      gameState: null,
      gameSpotifyMusicEnabled: false,
      agentContext: agentContext as never,
      emitMetadataPatch: () => undefined,
    });
    return { runtime, agent, calls, writes };
  }

  const toolSearchFixture = await buildToolRuntimeFixture({
    writableLorebookId: "leo-book",
    entryStateOverrides: { "hidden-by-chat": { enabled: false } },
    listActiveEntries: [
      {
        ...toolEntryDefaults,
        id: "shared-tool-memory",
        name: "Shared needle",
        content: "Shared needle",
        characterFilterMode: "any",
        characterFilterIds: [],
      },
      {
        ...toolEntryDefaults,
        id: "leo-tool-memory",
        name: "Leo needle",
        content: "Leo needle",
        characterFilterMode: "include",
        characterFilterIds: ["leo"],
      },
      {
        ...toolEntryDefaults,
        id: "dan-tool-memory",
        name: "Dan needle",
        content: "Dan needle",
        characterFilterMode: "include",
        characterFilterIds: ["dan"],
      },
      {
        ...toolEntryDefaults,
        id: "hidden-by-chat",
        name: "Hidden needle",
        content: "Hidden needle",
        characterFilterMode: "include",
        characterFilterIds: ["leo"],
      },
    ],
  });
  const toolSearchResults = await toolSearchFixture.runtime.baseToolExecutionContext.searchLorebook?.("needle", null);
  assert.deepEqual(
    toolSearchResults?.map((entry) => entry.name),
    ["Shared needle", "Leo needle"],
    "search_lorebook must apply focused entry filters and chat entry-state overrides",
  );

  const mergedToolSearch = await buildToolRuntimeFixture({
    writableLorebookId: "dan-book",
    accessContext: mergedLorebookAccessContext,
    newEntryCharacterFilterIds: [],
    listActiveEntries: [
      {
        ...toolEntryDefaults,
        id: "merged-shared-memory",
        name: "Shared needle",
        content: "Shared needle",
        characterFilterMode: "any",
        characterFilterIds: [],
      },
      {
        ...toolEntryDefaults,
        id: "merged-dan-memory",
        name: "Dan needle",
        content: "Dan needle",
        characterFilterMode: "include",
        characterFilterIds: ["dan"],
      },
    ],
  });
  const mergedToolSearchResults = await mergedToolSearch.runtime.baseToolExecutionContext.searchLorebook?.(
    "needle",
    null,
  );
  assert.deepEqual(
    mergedToolSearchResults?.map((entry) => entry.name),
    ["Shared needle", "Dan needle"],
    "merged tool search must preserve full-roster lorebook visibility",
  );

  const restrictedToolIdentity = await buildToolRuntimeFixture({
    writableLorebookId: "dan-book",
    promptCharacterIds: ["c", "a", "b"],
    primaryCharacterId: "a",
    agentCharacters: [
      { id: "c", name: "C" },
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    newEntryCharacterFilterIds: [],
  });
  const restrictedHiddenContext = restrictedToolIdentity.runtime.baseToolExecutionContext.hiddenContext;
  assert.equal(restrictedHiddenContext?.characterId, "a");
  assert.equal(restrictedHiddenContext?.characterName, "A");
  assert.equal(restrictedHiddenContext?.macros.characterId, "a");
  assert.equal(restrictedHiddenContext?.macros.characterName, "A");
  assert.deepEqual(
    restrictedHiddenContext?.characterIds,
    ["c", "a", "b"],
    "restricted tool identity must not narrow the full prompt and memory roster",
  );
  const restrictedAgentMacroContext = buildAgentPromptMacroContext({
    chatId: "restricted-agent-chat",
    chatMode: "conversation",
    primaryCharacterId: "a",
    recentMessages: [],
    mainResponse: null,
    gameState: null,
    characters: [
      { id: "c", name: "C", description: "C description" },
      { id: "a", name: "A", description: "A description" },
      { id: "b", name: "B", description: "B description" },
    ],
    persona: null,
    memory: {},
    activatedLorebookEntries: null,
    writableLorebookIds: null,
    chatSummary: null,
  } as never);
  assert.equal(restrictedAgentMacroContext.char, "C, A, B");
  assert.equal(restrictedAgentMacroContext.characterFields?.description, "A description");

  const mergedToolWrite = await buildToolRuntimeFixture({
    writableLorebookId: "dan-book",
    accessContext: mergedLorebookAccessContext,
    newEntryCharacterFilterIds: [],
    listEntries: [],
  });
  const mergedToolWriteRaw = await mergedToolWrite.agent.toolContext?.executeToolCall({
    id: "merged-tool-write",
    type: "function",
    function: {
      name: "save_lorebook_entry",
      arguments: JSON.stringify({ name: "Shared event", content: "Everyone remembers", mode: "create" }),
    },
  });
  const mergedToolWriteResult = JSON.parse(mergedToolWriteRaw ?? "{}") as Record<string, unknown>;
  assert.equal(mergedToolWriteResult.applied, true);
  assert.equal(mergedToolWrite.calls.createEntry, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(mergedToolWrite.writes[0] ?? {}, "characterFilterIds"),
    false,
    "merged tool writes must preserve the legacy shared-entry shape",
  );

  const blockedToolWrite = await buildToolRuntimeFixture({
    writableLorebookId: "dan-book",
    requireApproval: true,
    listEntries: [
      {
        ...toolEntryDefaults,
        id: "dan-existing-secret",
        lorebookId: "dan-book",
        name: "Secret",
        content: "Dan secret body",
        characterFilterMode: "include",
        characterFilterIds: ["dan"],
      },
    ],
  });
  const blockedToolWriteRaw = await blockedToolWrite.agent.toolContext?.executeToolCall({
    id: "blocked-tool-write",
    type: "function",
    function: {
      name: "save_lorebook_entry",
      arguments: JSON.stringify({ name: "Secret", content: "Overwrite attempt", mode: "replace" }),
    },
  });
  const blockedToolWriteResult = JSON.parse(blockedToolWriteRaw ?? "{}") as Record<string, unknown>;
  assert.equal(typeof blockedToolWriteResult.error, "string");
  assert.equal(blockedToolWrite.calls.getById, 1, "tool writes must fresh-read their configured target");
  assert.equal(blockedToolWrite.calls.listEntries, 0, "an inaccessible book must be rejected before reading entries");
  assert.equal(blockedToolWrite.calls.createEntry + blockedToolWrite.calls.updateEntry, 0);

  const focusedToolWrite = await buildToolRuntimeFixture({
    writableLorebookId: "leo-book",
    listEntries: [
      {
        ...toolEntryDefaults,
        id: "dan-same-name-secret",
        lorebookId: "leo-book",
        name: "Secret",
        content: "Dan secret body",
        characterFilterMode: "include",
        characterFilterIds: ["dan"],
      },
    ],
  });
  const focusedToolWriteRaw = await focusedToolWrite.agent.toolContext?.executeToolCall({
    id: "focused-tool-write",
    type: "function",
    function: {
      name: "save_lorebook_entry",
      arguments: JSON.stringify({ name: "Secret", content: "Leo secret body", mode: "replace" }),
    },
  });
  const focusedToolWriteResult = JSON.parse(focusedToolWriteRaw ?? "{}") as Record<string, unknown>;
  assert.equal(focusedToolWriteResult.applied, true);
  assert.equal(focusedToolWrite.calls.updateEntry, 0, "a hidden same-name entry must never be overwritten by the tool");
  assert.equal(focusedToolWrite.calls.createEntry, 1);
  assert.deepEqual(focusedToolWrite.writes[0]?.characterFilterIds, ["leo"]);
  assert.equal(focusedToolWrite.writes[0]?.characterFilterMode, "include");

  const focusedSharedSameName = await buildToolRuntimeFixture({
    writableLorebookId: "leo-book",
    listEntries: [
      {
        ...toolEntryDefaults,
        id: "shared-same-name-memory",
        lorebookId: "leo-book",
        name: "Shared name",
        content: "Shared fact",
        characterFilterMode: "any",
        characterFilterIds: [],
      },
    ],
  });
  await focusedSharedSameName.agent.toolContext?.executeToolCall({
    id: "focused-shared-same-name-write",
    type: "function",
    function: {
      name: "save_lorebook_entry",
      arguments: JSON.stringify({ name: "Shared name", content: "Leo-private fact", mode: "replace" }),
    },
  });
  assert.equal(
    focusedSharedSameName.calls.updateEntry,
    0,
    "a focused write must not repurpose a visible shared same-name entry",
  );
  assert.equal(focusedSharedSameName.calls.createEntry, 1);
  assert.deepEqual(focusedSharedSameName.writes[0]?.characterFilterIds, ["leo"]);

  const legacyVisibleSameName = await buildToolRuntimeFixture({
    writableLorebookId: "leo-book",
    newEntryCharacterFilterIds: null,
    listEntries: [
      {
        ...toolEntryDefaults,
        id: "legacy-visible-filtered-memory",
        lorebookId: "leo-book",
        name: "Legacy name",
        content: "Existing legacy fact",
        characterFilterMode: "include",
        characterFilterIds: ["leo"],
      },
    ],
  });
  await legacyVisibleSameName.agent.toolContext?.executeToolCall({
    id: "legacy-visible-same-name-write",
    type: "function",
    function: {
      name: "save_lorebook_entry",
      arguments: JSON.stringify({ name: "Legacy name", content: "Updated legacy fact", mode: "replace" }),
    },
  });
  assert.equal(
    legacyVisibleSameName.calls.updateEntry,
    1,
    "Personal Convo and Roleplay must retain legacy visible same-name updates",
  );
  assert.equal(legacyVisibleSameName.calls.createEntry, 0);

  const focusedToolApproval = await buildToolRuntimeFixture({
    writableLorebookId: "leo-book",
    requireApproval: true,
    listEntries: [
      {
        ...toolEntryDefaults,
        id: "approval-hidden-dan-memory",
        lorebookId: "leo-book",
        name: "Approved memory",
        content: "Dan secret body",
        characterFilterMode: "include",
        characterFilterIds: ["dan"],
      },
    ],
  });
  const focusedToolApprovalRaw = await focusedToolApproval.agent.toolContext?.executeToolCall({
    id: "focused-tool-approval",
    type: "function",
    function: {
      name: "save_lorebook_entry",
      arguments: JSON.stringify({ name: "Approved memory", content: "Leo remembers", mode: "create" }),
    },
  });
  const focusedToolApprovalResult = JSON.parse(focusedToolApprovalRaw ?? "{}") as {
    requiresApproval?: boolean;
    approval?: { payload?: Record<string, unknown> };
  };
  assert.equal(focusedToolApprovalResult.requiresApproval, true);
  assert.deepEqual(focusedToolApprovalResult.approval?.payload?.accessContext, focusedLeoLorebookAccessContext);
  assert.deepEqual(focusedToolApprovalResult.approval?.payload?.newEntryCharacterFilterIds, ["leo"]);
  assert.doesNotMatch(
    focusedToolApprovalRaw ?? "",
    /Dan secret body/,
    "approval previews must not expose a hidden same-name entry body",
  );

  const presenceCharacters = activeCharacters.map((character) => ({
    charId: character.id,
    name: character.name,
    displayName: character.name,
  }));
  assert.equal(hasExactConversationPresenceRoster(presenceCharacters, ["leo", "dan", "haram"]), true);
  assert.equal(hasExactConversationPresenceRoster(presenceCharacters.slice(0, 2), ["leo", "dan", "haram"]), false);
  assert.equal(hasExactConversationPresenceRoster(presenceCharacters, ["leo", "dan", "missing"]), false);
  const presenceEvents: unknown[] = [];
  let presenceEndCount = 0;
  let presenceMetadataWriteCount = 0;
  const driftPresenceResult = await resolveConversationPresenceRuntime({
    db: {} as never,
    chatId: "drift-chat",
    chatMeta: {},
    characterIds: ["leo", "missing"],
    chars: {
      getById: async (id) => (id === "leo" ? { data: { name: "Leo" } } : null),
    },
    chats: {
      patchMetadata: async () => {
        presenceMetadataWriteCount += 1;
      },
      listMessages: async () => [],
    },
    promptNow: new Date("2026-07-18T00:00:00.000Z"),
    shouldAccountAutonomousGeneration: false,
    skipPresenceDelay: true,
    supportsHiddenFromAI: false,
    contextMessageLimit: null,
    chatMessages: [],
    finalMessages: [],
    abortSignal: new AbortController().signal,
    writeSse: (payload) => presenceEvents.push(payload),
    endSse: () => {
      presenceEndCount += 1;
    },
    mapChatHistoryMessageForPrompt: async (message) => message,
    resolveHistoryMessageMacros: (messages) => messages,
  });
  assert.equal(driftPresenceResult.ended, true);
  assert.deepEqual(presenceEvents, [
    { type: "error", data: "The Conversation character roster changed. Please retry." },
    { type: "done" },
  ]);
  assert.equal(presenceEndCount, 1);
  assert.equal(presenceMetadataWriteCount, 0);
  assert.deepEqual(
    selectConversationPresenceResponders(presenceCharacters, {
      characterIds: ["leo", "dan", "haram"],
      scopedCharacterIds: ["dan"],
      forCharacterId: "leo",
      mentionedCharacterNames: ["Leo"],
    }),
    { respondingCharacters: [presenceCharacters[1]], hasTargeting: true },
  );
  assert.deepEqual(
    selectConversationPresenceResponders(presenceCharacters, {
      characterIds: ["leo", "dan", "haram"],
      scopedCharacterIds: ["missing"],
    }),
    { respondingCharacters: [], hasTargeting: true },
  );
  assert.deepEqual(
    selectConversationPresenceResponders(presenceCharacters, {
      characterIds: ["leo", "dan", "haram"],
      scopedCharacterIds: null,
    }),
    { respondingCharacters: presenceCharacters, hasTargeting: false },
  );
  assert.deepEqual(
    selectConversationPresenceResponders(presenceCharacters, {
      characterIds: ["leo", "dan", "haram"],
      forCharacterId: "leo",
    }),
    { respondingCharacters: [presenceCharacters[0]], hasTargeting: true },
  );

  const commandCharacters = [
    { id: "leo", name: "Leo", aliases: ["Leon"] },
    { id: "dan", name: "Dan", aliases: ["Danny"] },
  ];
  assert.deepEqual(parseCharacterCommandsBySpeaker("Danny: [selfie]", commandCharacters, "leo").commandCharacterIds, [
    "dan",
  ]);
  assert.deepEqual(
    parseCharacterCommandsBySpeaker(
      "Ace: [selfie]",
      [
        { id: "leo", name: "Leo", aliases: ["Ace"] },
        { id: "dan", name: "Dan", aliases: ["Ace"] },
      ],
      "leo",
    ).commandCharacterIds,
    [null],
  );
  assert.deepEqual(parseCharacterCommandsBySpeaker("Dan: [selfie]", commandCharacters, "leo").commandCharacterIds, [
    "dan",
  ]);
  assert.deepEqual(
    parseCharacterCommandsBySpeaker("Stranger: [selfie]", commandCharacters, "leo").commandCharacterIds,
    [null],
  );
  assert.deepEqual(parseCharacterCommandsBySpeaker("[selfie]", commandCharacters, "leo").commandCharacterIds, ["leo"]);
  assert.deepEqual(
    parseCharacterCommandsBySpeaker('<speaker="Danny">[selfie]</speaker>', commandCharacters, "leo")
      .commandCharacterIds,
    ["dan"],
  );
  assert.deepEqual(
    parseCharacterCommandsBySpeaker(
      '<speaker="Ace">[selfie]</speaker>',
      [
        { id: "leo", name: "Leo", aliases: ["Ace"] },
        { id: "dan", name: "Dan", aliases: ["Ace"] },
      ],
      "leo",
    ).commandCharacterIds,
    [null],
  );
  assert.deepEqual(
    parseCharacterCommandsBySpeaker('<speaker="Stranger">[selfie]</speaker>', commandCharacters, "leo")
      .commandCharacterIds,
    [null],
  );
  assert.deepEqual(
    parseCharacterCommandsBySpeaker(
      "&lt;speaker=&quot;Danny&quot;&gt;[selfie]&lt;/speaker&gt;",
      commandCharacters,
      "leo",
    ).commandCharacterIds,
    ["dan"],
  );
  assert.deepEqual(
    parseCharacterCommandsBySpeaker('<speaker="Danny">[selfie]', commandCharacters, "leo").commandCharacterIds,
    [null],
    "an unclosed explicit speaker tag must not fall back to the envelope character",
  );
  assert.deepEqual(
    parseCharacterCommandsBySpeaker("&lt;speaker=&quot;Danny&quot;&gt;[selfie]", commandCharacters, "leo")
      .commandCharacterIds,
    [null],
    "an encoded unclosed speaker tag must fail closed",
  );
  assert.deepEqual(
    parseCharacterCommandsBySpeaker('Danny: [selfie: context="x\nLeo: y"]', commandCharacters, "leo")
      .commandCharacterIds,
    [null],
    "a command spanning explicit speaker sections must not be re-attributed to the envelope character",
  );
  assert.deepEqual(
    parseCharacterCommandsBySpeaker("Leo: hello\nStranger: hello\n[selfie]", commandCharacters, "leo")
      .commandCharacterIds,
    [null],
    "an unknown explicit speaker section must fail closed for following commands",
  );
  assert.deepEqual(
    parseCharacterCommandsBySpeaker("Leo: hello\nMood: calm\n[selfie]", commandCharacters, "leo").commandCharacterIds,
    ["leo"],
    "a non-speaker label must not discard a command from the known speaker section",
  );

  type ResolverInput = Parameters<typeof resolveConversationScope>[0];

  const baseInput: ResolverInput = {
    chatMode: "conversation",
    isGroupChat: true,
    impersonate: false,
    activeCharacters,
    lifecycle: "initial",
    explicitTargetCharacterId: null,
    mentionedCharacterNames: [],
    replay: { kind: "absent" },
  };

  function resolve(overrides: Partial<ResolverInput> = {}) {
    return resolveConversationScope({ ...baseInput, ...overrides });
  }

  type InvalidCode = Extract<ReturnType<typeof resolve>, { kind: "invalid" }>["code"];

  function assertInvalid(overrides: Partial<ResolverInput>, code: InvalidCode) {
    assert.deepEqual(resolve(overrides), { kind: "invalid", code });
  }

  assert.deepEqual(resolve(), { kind: "merged", mentionedCharacterIds: [] });
  assert.deepEqual(resolve({ mentionedCharacterNames: ["Leo"] }), {
    kind: "focused",
    targetCharacterId: "leo",
    source: "mention",
  });
  assert.deepEqual(resolve({ mentionedCharacterNames: ["  LEO ", "Leo"] }), {
    kind: "focused",
    targetCharacterId: "leo",
    source: "mention",
  });
  assert.deepEqual(resolve({ mentionedCharacterNames: ["Ｈａｒａｍ"] }), {
    kind: "focused",
    targetCharacterId: "haram",
    source: "mention",
  });
  assert.deepEqual(resolve({ mentionedCharacterNames: ["Haram", "Leo", "Haram"] }), {
    kind: "restricted",
    allowedCharacterIds: ["leo", "haram"],
    source: "mentions",
  });

  for (const mentionedCharacterNames of [["Unknown"], [""], ["   "], ["Leo", "Unknown"]]) {
    assertInvalid({ mentionedCharacterNames }, "invalid_mention");
  }
  const duplicateLeoRoster = [...activeCharacters, { id: "other-leo", name: "  LEO " }] as const;
  assertInvalid({ activeCharacters: duplicateLeoRoster, mentionedCharacterNames: ["Leo"] }, "ambiguous_mention");
  assertInvalid(
    {
      activeCharacters: activeCharacters.filter((character) => character.id !== "dan"),
      mentionedCharacterNames: ["Dan"],
    },
    "invalid_mention",
  );

  assert.deepEqual(resolve({ explicitTargetCharacterId: "dan" }), {
    kind: "focused",
    targetCharacterId: "dan",
    source: "explicit",
  });
  assert.deepEqual(resolve({ activeCharacters: duplicateLeoRoster, explicitTargetCharacterId: "leo" }), {
    kind: "focused",
    targetCharacterId: "leo",
    source: "explicit",
  });
  assertInvalid({ explicitTargetCharacterId: "missing" }, "invalid_explicit_target");
  assertInvalid({ explicitTargetCharacterId: "" }, "invalid_explicit_target");
  assert.deepEqual(resolve({ explicitTargetCharacterId: "dan", mentionedCharacterNames: ["Dan", " dan "] }), {
    kind: "focused",
    targetCharacterId: "dan",
    source: "explicit",
  });
  assertInvalid({ explicitTargetCharacterId: "dan", mentionedCharacterNames: ["Leo"] }, "conflicting_scope");
  for (const mentionedCharacterNames of [["Unknown"], [""], ["Dan", "Unknown"]]) {
    assertInvalid({ explicitTargetCharacterId: "dan", mentionedCharacterNames }, "invalid_mention");
  }
  assertInvalid(
    {
      activeCharacters: duplicateLeoRoster,
      explicitTargetCharacterId: "dan",
      mentionedCharacterNames: ["Leo"],
    },
    "ambiguous_mention",
  );

  for (const overrides of [
    { chatMode: "roleplay", explicitTargetCharacterId: "missing", replay: { kind: "invalid" as const } },
    { chatMode: "visual_novel", mentionedCharacterNames: ["Unknown"] },
    { chatMode: "game", replay: { kind: "invalid" as const } },
    { isGroupChat: false, explicitTargetCharacterId: "missing" },
    { impersonate: true, mentionedCharacterNames: ["Unknown"] },
  ] satisfies Array<Partial<ResolverInput>>) {
    assert.deepEqual(resolve(overrides), { kind: "not_applicable" });
  }

  assertInvalid({ replay: { kind: "invalid" } }, "invalid_replay");
  assertInvalid({ replay: { kind: "valid", scope: { mode: "merged" } } }, "invalid_replay");

  const focusedReplay = {
    kind: "valid" as const,
    scope: { mode: "focused" as const, characterId: "leo" },
  };
  for (const lifecycle of ["regenerate", "continue"] as const) {
    const focusedLifecycle = { lifecycle, replay: focusedReplay };
    assert.deepEqual(resolve(focusedLifecycle), {
      kind: "focused",
      targetCharacterId: "leo",
      source: "replay",
    });
    assert.deepEqual(resolve({ ...focusedLifecycle, explicitTargetCharacterId: "leo" }), {
      kind: "focused",
      targetCharacterId: "leo",
      source: "replay",
    });
    assert.deepEqual(resolve({ ...focusedLifecycle, mentionedCharacterNames: ["Leo", " leo "] }), {
      kind: "focused",
      targetCharacterId: "leo",
      source: "replay",
    });
    assertInvalid({ ...focusedLifecycle, explicitTargetCharacterId: "dan" }, "conflicting_scope");
    assertInvalid({ ...focusedLifecycle, mentionedCharacterNames: ["Dan"] }, "conflicting_scope");
    assertInvalid(
      {
        ...focusedLifecycle,
        activeCharacters: activeCharacters.filter((character) => character.id !== "leo"),
      },
      "stale_replay_scope",
    );
  }

  const restrictedReplay = {
    kind: "valid" as const,
    scope: { mode: "restricted" as const, characterIds: ["haram", "leo", "haram"] },
  };
  for (const lifecycle of ["regenerate", "continue"] as const) {
    const restrictedLifecycle = { lifecycle, replay: restrictedReplay };
    assert.deepEqual(resolve(restrictedLifecycle), {
      kind: "restricted",
      allowedCharacterIds: ["leo", "haram"],
      source: "replay",
    });
    assert.deepEqual(resolve({ ...restrictedLifecycle, mentionedCharacterNames: ["Haram", "Leo", "Haram"] }), {
      kind: "restricted",
      allowedCharacterIds: ["leo", "haram"],
      source: "replay",
    });
    assertInvalid({ ...restrictedLifecycle, mentionedCharacterNames: ["Leo"] }, "conflicting_scope");
    assertInvalid({ ...restrictedLifecycle, mentionedCharacterNames: ["Leo", "Dan"] }, "conflicting_scope");
    assertInvalid({ ...restrictedLifecycle, mentionedCharacterNames: ["Leo", "Haram", "Dan"] }, "conflicting_scope");
    assertInvalid({ ...restrictedLifecycle, explicitTargetCharacterId: "leo" }, "conflicting_scope");
    assertInvalid(
      {
        ...restrictedLifecycle,
        activeCharacters: activeCharacters.filter((character) => character.id !== "haram"),
      },
      "stale_replay_scope",
    );
    assertInvalid(
      { lifecycle, replay: { kind: "valid", scope: { mode: "restricted", characterIds: ["leo"] } } },
      "invalid_replay",
    );
  }

  for (const lifecycle of ["regenerate", "continue"] as const) {
    assert.deepEqual(resolve({ lifecycle, replay: { kind: "absent" } }), {
      kind: "merged",
      mentionedCharacterIds: [],
    });
    assertInvalid(
      { lifecycle, replay: { kind: "absent" }, explicitTargetCharacterId: "leo" },
      "lifecycle_retarget_forbidden",
    );
    assertInvalid(
      { lifecycle, replay: { kind: "absent" }, mentionedCharacterNames: ["Leo"] },
      "lifecycle_retarget_forbidden",
    );
    assert.deepEqual(resolve({ lifecycle, replay: { kind: "valid", scope: { mode: "merged" } } }), {
      kind: "merged",
      mentionedCharacterIds: [],
    });
    assertInvalid(
      {
        lifecycle,
        replay: { kind: "valid", scope: { mode: "merged" } },
        explicitTargetCharacterId: "leo",
      },
      "lifecycle_retarget_forbidden",
    );
    assertInvalid(
      {
        lifecycle,
        replay: { kind: "valid", scope: { mode: "merged" } },
        mentionedCharacterNames: ["Leo"],
      },
      "lifecycle_retarget_forbidden",
    );
    assertInvalid({ lifecycle, replay: { kind: "invalid" } }, "invalid_replay");
  }

  assert.equal(buildGenerationReplay({}), null);
  assert.deepEqual(inspectConversationScopeReplay(buildGenerationReplay({})), { kind: "absent" });
  assert.deepEqual(inspectConversationScopeReplay(undefined), { kind: "absent" });
  assert.deepEqual(inspectConversationScopeReplay(null), { kind: "absent" });
  assert.deepEqual(inspectConversationScopeReplay({ generationGuide: "legacy", generationGuideSource: "guide" }), {
    kind: "absent",
  });
  assert.deepEqual(inspectConversationScopeReplay({ conversationScope: null }), { kind: "invalid" });
  assert.deepEqual(inspectConversationScopeReplay({ conversationScope: { mode: "focused", characterId: "" } }), {
    kind: "invalid",
  });
  assert.deepEqual(
    inspectConversationScopeReplay({ conversationScope: { mode: "restricted", characterIds: ["leo"] } }),
    {
      kind: "invalid",
    },
  );
  for (const characterIds of [
    ["leo", "dan", 42],
    ["leo", "dan", "   "],
  ]) {
    assert.deepEqual(inspectConversationScopeReplay({ conversationScope: { mode: "restricted", characterIds } }), {
      kind: "invalid",
    });
    assert.equal(buildGenerationReplay({ conversationScope: { mode: "restricted", characterIds } }), null);
  }
  assert.deepEqual(inspectConversationScopeReplay({ conversationScope: { mode: "merged", extra: true } }), {
    kind: "invalid",
  });
  for (const raw of [[], "null", 0, true]) {
    assert.deepEqual(inspectConversationScopeReplay(raw), { kind: "invalid" });
  }

  assert.deepEqual(buildGenerationReplay({ conversationScope: { mode: "merged" } }), {
    conversationScope: { mode: "merged" },
  });
  assert.deepEqual(buildGenerationReplay({ conversationScope: { mode: "focused", characterId: " leo " } }), {
    conversationScope: { mode: "focused", characterId: "leo" },
  });
  assert.deepEqual(
    buildGenerationReplay({ conversationScope: { mode: "restricted", characterIds: [" dan ", "leo", "dan"] } }),
    { conversationScope: { mode: "restricted", characterIds: ["dan", "leo"] } },
  );
  assert.deepEqual(
    normalizeGenerationReplay({
      generationGuide: "keep this",
      generationGuideSource: "guide",
      conversationScope: { mode: "restricted", characterIds: ["leo", "haram"] },
    }),
    {
      generationGuide: "keep this",
      generationGuideSource: "guide",
      conversationScope: { mode: "restricted", characterIds: ["leo", "haram"] },
    },
  );
  assert.deepEqual(inspectConversationScopeReplay({ conversationScope: { mode: "merged" } }), {
    kind: "valid",
    scope: { mode: "merged" },
  });
  assert.deepEqual(inspectConversationScopeReplay({ conversationScope: { mode: "focused", characterId: " leo " } }), {
    kind: "valid",
    scope: { mode: "focused", characterId: "leo" },
  });
  assert.deepEqual(
    inspectConversationScopeReplay({ conversationScope: { mode: "restricted", characterIds: ["dan", "leo", "dan"] } }),
    {
      kind: "valid",
      scope: { mode: "restricted", characterIds: ["dan", "leo"] },
    },
  );
  assert.deepEqual(
    extractPortableConversationSwipeExtra({
      generationReplay: {
        conversationScope: { mode: "focused", characterId: " dan " },
        generationGuide: "must not travel",
      },
      swipeCharacterId: " dan ",
      cachedPrompt: "must not travel",
    }),
    {
      generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } },
      swipeCharacterId: "dan",
    },
  );
  assert.deepEqual(
    extractPortableConversationSwipeExtra({
      generationReplay: { conversationScope: null },
      swipeCharacterId: 42,
    }),
    {},
  );
  assert.deepEqual(extractPortableConversationSwipeExtra({ swipeCharacterId: null }), { swipeCharacterId: null });
  assert.deepEqual(
    buildGenerationReplay({ conversationScope: { mode: "restricted", characterIds: ["leo", "leo"] } }),
    null,
  );

  const regenerateInput: Record<string, unknown> = {};
  assert.equal(
    applyGenerationReplayToRegenerateInput(regenerateInput, {
      conversationScope: { mode: "focused", characterId: "leo" },
    }),
    false,
  );
  assert.deepEqual(regenerateInput, {});

  const legacyNullReplay = inspectConversationScopeReplay(null);
  for (const lifecycle of ["regenerate", "continue"] as const) {
    assert.deepEqual(resolve({ lifecycle, replay: legacyNullReplay }), {
      kind: "merged",
      mentionedCharacterIds: [],
    });
    assertInvalid(
      { lifecycle, replay: legacyNullReplay, explicitTargetCharacterId: "leo" },
      "lifecycle_retarget_forbidden",
    );
  }

  const characterRows = new Map<string, { data?: unknown }>([
    ["leo", { data: { name: "Leo" } }],
    ["dan", { data: JSON.stringify({ name: "Dan" }) }],
    ["haram", { data: { name: "Haram" } }],
    ["other-leo", { data: { name: "  LEO " } }],
    ["broken", { data: "not-json" }],
  ]);
  type PreflightInput = Parameters<typeof prepareConversationScopePreflight>[0];
  const basePreflightInput: PreflightInput = {
    chatMode: "conversation",
    storedCharacterIds: JSON.stringify(["leo", "dan", "haram"]),
    chatMetadata: {},
    impersonate: false,
    lifecycle: "initial",
    explicitTargetCharacterId: null,
    mentionedCharacterNames: [],
    rawGenerationReplay: undefined,
    getCharacterById: async (id) => characterRows.get(id),
  };
  const prepare = (overrides: Partial<PreflightInput> = {}) =>
    prepareConversationScopePreflight({ ...basePreflightInput, ...overrides });

  assert.deepEqual(await prepare(), {
    allCharacterIds: ["leo", "dan", "haram"],
    activeCharacterIds: ["leo", "dan", "haram"],
    activeCharacters,
    replay: { kind: "absent" },
    resolution: { kind: "merged", mentionedCharacterIds: [] },
  });
  assert.deepEqual((await prepare({ mentionedCharacterNames: ["Haram"] })).resolution, {
    kind: "focused",
    targetCharacterId: "haram",
    source: "mention",
  });
  assert.deepEqual((await prepare({ explicitTargetCharacterId: "dan" })).resolution, {
    kind: "focused",
    targetCharacterId: "dan",
    source: "explicit",
  });
  assert.deepEqual((await prepare({ mentionedCharacterNames: ["Haram", "Leo"] })).resolution, {
    kind: "restricted",
    allowedCharacterIds: ["leo", "haram"],
    source: "mentions",
  });

  for (const [overrides, code] of [
    [{ mentionedCharacterNames: ["Unknown"] }, "invalid_mention"],
    [{ chatMetadata: { inactiveCharacterIds: ["dan"] }, explicitTargetCharacterId: "dan" }, "invalid_explicit_target"],
    [{ storedCharacterIds: ["leo", "other-leo", "dan"], mentionedCharacterNames: ["Leo"] }, "ambiguous_mention"],
    [{ mentionedCharacterNames: ["Leo", "Unknown"] }, "invalid_mention"],
    [
      {
        lifecycle: "regenerate",
        chatMetadata: { inactiveCharacterIds: ["haram"] },
        rawGenerationReplay: { conversationScope: { mode: "focused", characterId: "haram" } },
      },
      "stale_replay_scope",
    ],
    [{ explicitTargetCharacterId: "dan", mentionedCharacterNames: ["Leo"] }, "conflicting_scope"],
  ] as const) {
    assert.deepEqual((await prepare(overrides)).resolution, { kind: "invalid", code });
  }

  const malformedReplayResult = await prepare({
    lifecycle: "regenerate",
    rawGenerationReplay: { conversationScope: null },
  });
  assert.deepEqual(malformedReplayResult.replay, { kind: "invalid" });
  assert.deepEqual(malformedReplayResult.resolution, { kind: "invalid", code: "invalid_replay" });

  for (const lifecycle of ["regenerate", "continue"] as const) {
    for (const rawGenerationReplay of [undefined, null]) {
      assert.deepEqual((await prepare({ lifecycle, rawGenerationReplay })).resolution, {
        kind: "merged",
        mentionedCharacterIds: [],
      });
    }
    assert.deepEqual(
      (
        await prepare({
          lifecycle,
          rawGenerationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
        })
      ).resolution,
      { kind: "focused", targetCharacterId: "leo", source: "replay" },
    );
    assert.deepEqual(
      (
        await prepare({
          lifecycle,
          rawGenerationReplay: { conversationScope: { mode: "restricted", characterIds: ["haram", "leo"] } },
        })
      ).resolution,
      { kind: "restricted", allowedCharacterIds: ["leo", "haram"], source: "replay" },
    );
    assert.deepEqual(
      (
        await prepare({
          lifecycle,
          explicitTargetCharacterId: "leo",
          rawGenerationReplay: { conversationScope: { mode: "merged" } },
        })
      ).resolution,
      { kind: "invalid", code: "lifecycle_retarget_forbidden" },
    );
  }

  for (const lifecycle of ["regenerate", "continue"] as const) {
    assert.deepEqual(
      (
        await prepare({
          storedCharacterIds: ["leo", "dan"],
          chatMetadata: { inactiveCharacterIds: ["leo"] },
          lifecycle,
          rawGenerationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
        })
      ).resolution,
      { kind: "invalid", code: "stale_replay_scope" },
      "a stored ensemble must not collapse to non-group when a focused swipe target becomes inactive",
    );
  }

  assert.deepEqual(
    (
      await prepare({
        storedCharacterIds: ["dan"],
        lifecycle: "regenerate",
        rawGenerationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
      })
    ).resolution,
    { kind: "invalid", code: "stale_replay_scope" },
    "a one-character Conversation roster must reject a stored focus that no longer belongs to the chat",
  );
  assert.deepEqual(
    (
      await prepare({
        storedCharacterIds: ["leo"],
        lifecycle: "regenerate",
        rawGenerationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
      })
    ).resolution,
    { kind: "focused", targetCharacterId: "leo", source: "replay" },
    "a one-character Conversation roster must restore its matching stored focus",
  );
  assert.deepEqual(
    (
      await prepare({
        storedCharacterIds: ["dan"],
        lifecycle: "regenerate",
        rawGenerationReplay: { conversationScope: { mode: "restricted", characterIds: ["leo", "dan"] } },
      })
    ).resolution,
    { kind: "invalid", code: "stale_replay_scope" },
    "a one-character Conversation roster must reject a stored restricted scope with removed members",
  );
  assert.deepEqual(
    (
      await prepare({
        storedCharacterIds: ["dan"],
        lifecycle: "regenerate",
        rawGenerationReplay: undefined,
      })
    ).resolution,
    { kind: "not_applicable" },
    "a legacy one-character Conversation lifecycle without stored scope must retain baseline behavior",
  );
  assert.deepEqual(
    (
      await prepare({
        storedCharacterIds: [],
        lifecycle: "regenerate",
        rawGenerationReplay: { conversationScope: { mode: "merged" } },
      })
    ).resolution,
    { kind: "invalid", code: "stale_replay_scope" },
    "a stored merged scope must fail closed when the Conversation roster has become empty",
  );

  assert.deepEqual((await prepare({ chatMode: "roleplay" })).resolution, { kind: "not_applicable" });
  assert.deepEqual((await prepare({ storedCharacterIds: ["leo"] })).resolution, { kind: "not_applicable" });
  assert.deepEqual((await prepare({ impersonate: true })).resolution, { kind: "not_applicable" });

  const frozenRoster = Object.freeze(["leo", "dan", "haram"]);
  const frozenMetadata = Object.freeze({ inactiveCharacterIds: Object.freeze(["haram"]) });
  const frozenMentions = Object.freeze(["Leo"]);
  const loadedCharacterIds: string[] = [];
  const frozenResult = await prepare({
    storedCharacterIds: frozenRoster,
    chatMetadata: frozenMetadata,
    mentionedCharacterNames: frozenMentions,
    getCharacterById: async (id) => {
      loadedCharacterIds.push(id);
      return characterRows.get(id);
    },
  });
  assert.deepEqual(frozenResult.activeCharacterIds, ["leo", "dan"]);
  assert.deepEqual(loadedCharacterIds, ["leo", "dan"]);
  assert.deepEqual(frozenRoster, ["leo", "dan", "haram"]);
  assert.deepEqual(frozenMetadata, { inactiveCharacterIds: ["haram"] });
  assert.deepEqual(frozenMentions, ["Leo"]);

  for (const storedCharacterIds of ["not-json", {}, null, ["leo", 42], ["leo", "   "]]) {
    await assert.rejects(
      () => prepare({ storedCharacterIds }),
      (error: unknown) =>
        error instanceof ConversationScopePreflightInputError && error.code === "invalid_character_roster",
    );
  }
  for (const storedCharacterIds of [
    ["leo", "missing"],
    ["leo", "broken"],
    ["leo", "leo"],
  ]) {
    await assert.rejects(
      () => prepare({ storedCharacterIds }),
      (error: unknown) =>
        error instanceof ConversationScopePreflightInputError && error.code === "invalid_character_roster",
    );
  }
  await assert.rejects(
    () =>
      prepare({
        storedCharacterIds: ["leo", "leo", "dan"],
        chatMetadata: { inactiveCharacterIds: ["leo"] },
      }),
    (error: unknown) =>
      error instanceof ConversationScopePreflightInputError && error.code === "invalid_character_roster",
    "inactive duplicate roster IDs must not bypass Conversation validation",
  );
  assert.deepEqual((await prepare({ chatMode: "roleplay", storedCharacterIds: ["leo", "missing"] })).resolution, {
    kind: "not_applicable",
  });
  await assert.rejects(
    () =>
      prepare({
        chatMetadata: { inactiveCharacterIds: ["leo", "dan", "haram"] },
      }),
    (error: unknown) =>
      error instanceof ConversationScopePreflightInputError && error.code === "all_characters_inactive",
  );
  assert.deepEqual(
    await prepare({
      chatMode: "game",
      chatMetadata: { inactiveCharacterIds: ["leo", "dan", "haram"] },
    }),
    {
      allCharacterIds: ["leo", "dan", "haram"],
      activeCharacterIds: ["leo", "dan", "haram"],
      activeCharacters,
      replay: { kind: "absent" },
      resolution: { kind: "not_applicable" },
    },
    "Game mode must preserve its baseline all-inactive roster exception",
  );

  assert.throws(
    () => requireActiveGenerationRegistry({}),
    /active generation registry is not initialized/i,
    "routes must fail closed when the shared registry was not installed on their Fastify ancestor",
  );
  const leaseRegistry = createActiveGenerationRegistry();
  assert.equal(requireActiveGenerationRegistry({ activeGenerations: leaseRegistry }), leaseRegistry);
  const firstController = new AbortController();
  const firstLease = acquireActiveGenerationLease(leaseRegistry, "chat-lease", firstController);
  assert.ok(firstLease);
  assert.equal(firstLease.abortController, firstController);
  assert.equal(acquireActiveGenerationLease(leaseRegistry, "chat-lease"), null);
  assert.equal(firstLease.release(), true);

  const secondController = new AbortController();
  const secondLease = acquireActiveGenerationLease(leaseRegistry, "chat-lease", secondController);
  assert.ok(secondLease);
  assert.equal(firstLease.release(), false);
  assert.equal(firstLease.setBackendUrl("stale-backend"), false);
  assert.equal(secondLease.setBackendUrl("current-backend"), true);
  assert.deepEqual(leaseRegistry.get("chat-lease"), {
    abortController: secondController,
    backendUrl: "current-backend",
    purpose: "generation",
  });
  assert.equal(secondLease.release(), true);

  const heldLease = acquireActiveGenerationLease(leaseRegistry, "chat-held");
  assert.ok(heldLease);
  await prepare();
  assert.equal(acquireActiveGenerationLease(leaseRegistry, "chat-held"), null);
  assert.equal(heldLease.release(), true);
  const reacquiredLease = acquireActiveGenerationLease(leaseRegistry, "chat-held");
  assert.ok(reacquiredLease);
  assert.equal(reacquiredLease.release(), true);

  const deletionRegistry = createActiveGenerationRegistry();
  const generationController = new AbortController();
  const generationLease = acquireActiveGenerationLease(deletionRegistry, "chat-deleting", generationController);
  assert.ok(generationLease);
  const deletionLease = takeOverActiveGenerationLease(deletionRegistry, "chat-deleting");
  assert.equal(generationController.signal.aborted, true, "deletion takeover must abort the in-flight generation");
  assert.equal(
    generationLease.release(),
    false,
    "the displaced generation owner must not release the deletion tombstone from its late finally block",
  );
  assert.equal(
    acquireActiveGenerationLease(deletionRegistry, "chat-deleting"),
    null,
    "new generation must remain blocked until the deletion operation finishes",
  );
  assert.equal(
    takeOverActiveGenerationLease(deletionRegistry, "chat-deleting"),
    null,
    "a concurrent delete must not replace and prematurely release the first deletion tombstone",
  );
  assert.equal(deletionLease.release(), true);
  const postDeletionLease = acquireActiveGenerationLease(deletionRegistry, "chat-deleting");
  assert.ok(postDeletionLease, "the deletion tombstone must clear after storage removal finishes");
  assert.equal(postDeletionLease.release(), true);

  const mutationRegistry = createActiveGenerationRegistry();
  const mutationController = new AbortController();
  const mutationLease = acquireChatMutationLease(mutationRegistry, "chat-mutating", mutationController);
  assert.ok(mutationLease);
  assert.equal(
    takeOverActiveGenerationLease(mutationRegistry, "chat-mutating"),
    null,
    "deletion takeover must not displace an in-flight durable mutation",
  );
  assert.equal(mutationController.signal.aborted, false, "a blocked deletion takeover must not abort the mutation");
  assert.deepEqual(mutationRegistry.get("chat-mutating"), {
    abortController: mutationController,
    backendUrl: null,
    purpose: "mutation",
  });
  assert.equal(mutationLease.release(), true);

  const postMutationGenerationController = new AbortController();
  const postMutationGenerationLease = acquireActiveGenerationLease(
    mutationRegistry,
    "chat-mutating",
    postMutationGenerationController,
  );
  assert.ok(postMutationGenerationLease);
  const postMutationDeletionLease = takeOverActiveGenerationLease(mutationRegistry, "chat-mutating");
  assert.ok(postMutationDeletionLease, "deletion takeover must remain available for an ordinary generation");
  assert.equal(postMutationGenerationController.signal.aborted, true);
  assert.equal(postMutationGenerationLease.release(), false);
  assert.equal(postMutationDeletionLease.release(), true);

  const mismatchedMessageLease = await acquireMessageMutationLease(
    leaseRegistry,
    "requested-chat",
    "message-from-another-chat",
    async () => ({ chatId: "actual-chat" }),
  );
  assert.deepEqual(mismatchedMessageLease, { kind: "not_found" });
  assert.equal(leaseRegistry.size, 0, "a mismatched URL chat ID must never acquire a lease for either chat");

  const heldMessageLease = acquireActiveGenerationLease(leaseRegistry, "actual-chat");
  assert.ok(heldMessageLease);
  const busyMessageLease = await acquireMessageMutationLease(
    leaseRegistry,
    "actual-chat",
    "owned-message",
    async () => ({ chatId: "actual-chat" }),
  );
  assert.deepEqual(busyMessageLease, { kind: "busy" });
  assert.equal(heldMessageLease.release(), true);

  const readyMessageLease = await acquireMessageMutationLease(
    leaseRegistry,
    "actual-chat",
    "owned-message",
    async () => ({ chatId: "actual-chat" }),
  );
  assert.equal(readyMessageLease.kind, "ready");
  if (readyMessageLease.kind === "ready") {
    assert.equal(readyMessageLease.message.chatId, "actual-chat");
    assert.equal(readyMessageLease.lease.release(), true);
  }

  const staleConversationEnvelope = {
    id: "authority-message",
    chatId: "authority-chat",
    role: "assistant",
    content: "Leo envelope",
    characterId: "leo",
    extra: { generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } } },
  };
  const authoritativeDanSwipe = {
    ...staleConversationEnvelope,
    content: "Dan active swipe",
    characterId: "dan",
    extra: { generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } } },
    activeSwipeFound: true,
  };
  assert.deepEqual(
    await readAuthoritativeConversationMessage({
      chatId: "authority-chat",
      messageId: "authority-message",
      getMessageWithActiveSwipe: async () => authoritativeDanSwipe,
    }),
    authoritativeDanSwipe,
  );
  assert.deepEqual(replaceMessageSnapshot([staleConversationEnvelope], authoritativeDanSwipe), [authoritativeDanSwipe]);
  const authoritativeRetryScope = await resolveRetryConversationScope({
    chatMode: "conversation",
    storedCharacterIds: ["leo", "dan"],
    chatMetadata: {},
    rawGenerationReplay: authoritativeDanSwipe.extra.generationReplay,
    getCharacterById: async (id) => retryCharacterRows.get(id) ?? null,
  });
  assert.deepEqual(authoritativeRetryScope.promptCharacterIds, ["dan"]);
  const authoritativeKeeperContext = buildHistoricalLorebookKeeperContext(
    { recentMessages: [], mainResponse: "" } as any,
    [authoritativeDanSwipe],
    authoritativeDanSwipe.id,
  );
  assert.equal(authoritativeKeeperContext?.mainResponse, "Dan active swipe");
  for (const [label, getMessageWithActiveSwipe, code] of [
    ["missing message", async () => null, "message_not_found"],
    ["cross-chat message", async () => ({ ...authoritativeDanSwipe, chatId: "other-chat" }), "message_chat_mismatch"],
    ["non-assistant message", async () => ({ ...authoritativeDanSwipe, role: "user" }), "message_not_assistant"],
    [
      "missing active swipe",
      async () => ({ ...authoritativeDanSwipe, activeSwipeFound: false }),
      "active_swipe_not_found",
    ],
  ] as const) {
    await assert.rejects(
      () =>
        readAuthoritativeConversationMessage({
          chatId: "authority-chat",
          messageId: "authority-message",
          getMessageWithActiveSwipe,
        }),
      (error: unknown) => error instanceof ConversationMessageAuthorityError && error.code === code,
      label,
    );
  }

  for (const [input, expected] of [
    [{ chatMode: "conversation", explicitTargetCharacterId: "leo", attributedCharacterId: "dan" }, "leo"],
    [{ chatMode: "conversation", attributedCharacterId: "dan" }, null],
    [{ chatMode: "roleplay", explicitTargetCharacterId: "leo", attributedCharacterId: "dan" }, "leo"],
    [{ chatMode: "roleplay", attributedCharacterId: "dan" }, "dan"],
    [{ chatMode: "visual_novel", attributedCharacterId: "haram" }, "haram"],
    [{ chatMode: "roleplay", explicitTargetCharacterId: "", attributedCharacterId: "dan" }, "dan"],
    [{ chatMode: "roleplay" }, null],
  ] as const) {
    assert.equal(resolveNonConversationLifecycleCharacterFallback(input), expected);
  }

  const normalizeLf = (value: string) => value.replace(/\r\n?/g, "\n");
  const appSource = normalizeLf(await readFile(new URL("../../packages/server/src/app.ts", import.meta.url), "utf8"));
  const routeIndexSource = normalizeLf(
    await readFile(new URL("../../packages/server/src/routes/index.ts", import.meta.url), "utf8"),
  );
  const routeSource = normalizeLf(
    await readFile(new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url), "utf8"),
  );
  const preflightSource = normalizeLf(
    await readFile(
      new URL("../../packages/server/src/routes/generate/conversation-scope-preflight.ts", import.meta.url),
      "utf8",
    ),
  );
  const messageAuthoritySource = normalizeLf(
    await readFile(
      new URL("../../packages/server/src/routes/generate/conversation-message-authority.ts", import.meta.url),
      "utf8",
    ),
  );
  const presenceSource = normalizeLf(
    await readFile(
      new URL("../../packages/server/src/routes/generate/conversation-presence-runtime.ts", import.meta.url),
      "utf8",
    ),
  );
  const chatsStorageSource = normalizeLf(
    await readFile(new URL("../../packages/server/src/services/storage/chats.storage.ts", import.meta.url), "utf8"),
  );
  const chatsRouteSource = normalizeLf(
    await readFile(new URL("../../packages/server/src/routes/chats.routes.ts", import.meta.url), "utf8"),
  );
  const stChatImporterSource = normalizeLf(
    await readFile(new URL("../../packages/server/src/services/import/st-chat.importer.ts", import.meta.url), "utf8"),
  );
  const retryAgentsRouteSource = normalizeLf(
    await readFile(new URL("../../packages/server/src/routes/generate/retry-agents-route.ts", import.meta.url), "utf8"),
  );
  const gameRouteSource = normalizeLf(
    await readFile(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8"),
  );
  const toolResolutionSource = normalizeLf(
    await readFile(
      new URL("../../packages/server/src/services/generation/tool-resolution-runtime.ts", import.meta.url),
      "utf8",
    ),
  );
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const literalIndices = (source: string, literal: string) =>
    [...source.matchAll(new RegExp(escapeRegex(literal), "g"))].map((match) => match.index!);
  const uniqueLiteral = (source: string, label: string, literal: string) => {
    const indices = literalIndices(source, literal);
    assert.equal(indices.length, 1, `${label}: expected exactly one match, got ${indices.length}`);
    return indices[0]!;
  };
  const callIndices = (source: string, pattern: RegExp, label: string) => {
    const indices = [...source.matchAll(pattern)].map((match) => match.index!);
    assert.ok(indices.length > 0, `${label}: expected at least one call site`);
    return indices;
  };

  const serverSourceRoot = fileURLToPath(new URL("../../packages/server/src/", import.meta.url));
  const collectTypeScriptFiles = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectTypeScriptFiles(path);
        return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
      }),
    );
    return nested.flat();
  };
  const rawHistoryCallCounts: Record<string, number> = {};
  const rawPaginatedHistoryCallCounts: Record<string, number> = {};
  const unsafeAttachmentMutationCallCounts: Record<string, number> = {};
  for (const file of await collectTypeScriptFiles(serverSourceRoot)) {
    const source = normalizeLf(await readFile(file, "utf8"));
    const count = literalIndices(source, ".listMessages(").length;
    const paginatedCount = literalIndices(source, ".listMessagesPaginated(").length;
    const unsafeAttachmentCount = [
      ".appendMessageAttachment(",
      ".appendMessageAttachmentForActiveSwipe(",
      ".appendSwipeAttachment(",
    ].reduce((total, literal) => total + literalIndices(source, literal).length, 0);
    const relativePath = relative(serverSourceRoot, file).replace(/\\/g, "/");
    if (count > 0) rawHistoryCallCounts[relativePath] = count;
    if (paginatedCount > 0) rawPaginatedHistoryCallCounts[relativePath] = paginatedCount;
    if (unsafeAttachmentCount > 0) unsafeAttachmentMutationCallCounts[relativePath] = unsafeAttachmentCount;
  }
  assert.deepEqual(
    unsafeAttachmentMutationCallCounts,
    {},
    "attachment writes must use the exact-swipe atomic storage operation instead of split read/write helpers",
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(rawHistoryCallCounts).sort(([left], [right]) => left.localeCompare(right))),
    {
      "routes/agents.routes.ts": 1,
      "routes/chats.routes.ts": 5,
      "routes/game.routes.ts": 4,
      "routes/generate.routes.ts": 1,
      "services/generation/message-history.ts": 1,
      "services/generation/roleplay-dm-command-runtime.ts": 1,
      "services/turn-games/turn-game-runner.service.ts": 1,
    },
    "raw envelope history reads are an explicit structural/export allowlist; narrative consumers must use active swipes",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(rawPaginatedHistoryCallCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    { "routes/chats.routes.ts": 1 },
    "raw paginated envelope reads are reserved for the structural/UI API; model-context consumers must use active swipes",
  );

  assert.match(messageAuthoritySource, /message\.role !== "assistant"/);
  assert.match(messageAuthoritySource, /message\.activeSwipeFound !== true/);
  const historicalAuthorityIndex = uniqueLiteral(
    routeSource,
    "historical Keeper active-swipe read",
    "const authoritativeActiveSwipe = await readAuthoritativeConversationMessage({",
  );
  const historicalContextIndex = uniqueLiteral(
    routeSource,
    "historical Keeper context build",
    "const historicalContext = buildHistoricalLorebookKeeperContext(",
  );
  const historicalReplayIndex = uniqueLiteral(
    routeSource,
    "historical Keeper replay read",
    "rawGenerationReplay: parseExtra(historicalTarget.extra).generationReplay,",
  );
  assert.ok(historicalAuthorityIndex < historicalContextIndex);
  assert.ok(historicalAuthorityIndex < historicalReplayIndex);
  const historicalPrimaryIdentityIndex = uniqueLiteral(
    routeSource,
    "historical Keeper primary identity restore",
    "historicalContext.primaryCharacterId = historicalScope.primaryCharacterId;",
  );
  assert.ok(historicalReplayIndex < historicalPrimaryIdentityIndex);

  const retryLeaseIndex = uniqueLiteral(
    retryAgentsRouteSource,
    "retry shared generation lease",
    "const retryGenerationLease = acquireActiveGenerationLease(activeGenerations, chatId);",
  );
  const retrySseIndex = uniqueLiteral(
    retryAgentsRouteSource,
    "retry SSE start",
    'startSseReply(reply, { "X-Accel-Buffering": "no" });',
  );
  const retryChatReadIndex = uniqueLiteral(
    retryAgentsRouteSource,
    "retry chat read",
    "const chat = await chats.getById(chatId);",
  );
  const retryTargetAuthorityIndex = uniqueLiteral(
    retryAgentsRouteSource,
    "retry target active-swipe read",
    "messageId: lastAssistant.id,",
  );
  const retryScopeIndex = uniqueLiteral(
    retryAgentsRouteSource,
    "retry Conversation scope resolution",
    "const retryConversationScope = await resolveRetryConversationScope({",
  );
  const retryLeaseReleaseIndex = uniqueLiteral(
    retryAgentsRouteSource,
    "retry shared generation lease release",
    "retryGenerationLease.release();",
  );
  assert.ok(retryLeaseIndex < retrySseIndex);
  assert.ok(retrySseIndex < retryChatReadIndex);
  assert.ok(retryChatReadIndex < retryTargetAuthorityIndex);
  assert.ok(retryTargetAuthorityIndex < retryScopeIndex);
  assert.ok(retryScopeIndex < retryLeaseReleaseIndex);
  assert.match(
    retryAgentsRouteSource,
    /const promptMacroContext = await buildPromptMacroContext\(\{[\s\S]*?characterIds:\s*promptCharacterIds,[\s\S]*?primaryCharacterId:\s*retryConversationScope\.primaryCharacterId,/,
    "agent retry prompt macros must use the restored Conversation roster and primary identity",
  );
  const retryEffectsStart = uniqueLiteral(
    retryAgentsRouteSource,
    "retry result effect helper",
    "async function applyRetryResultEffects(args: {",
  );
  const retryEffectsEnd = uniqueLiteral(
    retryAgentsRouteSource,
    "retry route registration",
    "export async function registerRetryAgentsRoute(app: FastifyInstance)",
  );
  const retryEffectsBlock = retryAgentsRouteSource.slice(retryEffectsStart, retryEffectsEnd);
  assert.match(
    retryEffectsBlock,
    /const currentMessage = await chats\.getMessageWithSwipe\(retryMessageId, retrySwipeIndex\);/,
    "retry text rewrites must inspect the exact requested swipe",
  );
  assert.match(
    retryEffectsBlock,
    /await chats\.updateMessageContentForSwipe\([\s\S]*?retryMessageId,[\s\S]*?retrySwipeIndex,[\s\S]*?\{[\s\S]*?requireActive: true,[\s\S]*?expectedContent: expectedStoredMessageContent/,
    "retry text rewrites must commit through active-swipe compare-and-set",
  );
  assert.match(
    retryEffectsBlock,
    /const msg = await chats\.getMessageWithSwipe\(retryMessageId, retrySwipeIndex\);[\s\S]*?normalizeContextInjections\(extra\.contextInjections\)/,
    "retry context injections must merge from the exact requested swipe",
  );
  assert.doesNotMatch(
    retryEffectsBlock,
    /chats\.getMessage\(retryMessageId\)|chats\.updateMessageContent\(retryMessageId,/,
    "retry postprocessing must not fall back to the raw message envelope",
  );
  assert.match(
    gameRouteSource,
    /const storyboardMessage = await chats\.getMessageWithSwipe\(message\.id, swipeIndex\);/,
    "storyboard narration must read the exact requested swipe even when it is active",
  );
  assert.match(
    gameRouteSource,
    /acquireMessageMutationLease\([\s\S]*?updateMessageContentForSwipe\(/,
    "skill-check mutation must hold the shared generation lease and use swipe-scoped CAS",
  );

  const keeperRetryStart = uniqueLiteral(
    retryAgentsRouteSource,
    "Keeper retry helper",
    "async function executeLorebookKeeperRetries(args: {",
  );
  const keeperRetryEnd = uniqueLiteral(
    retryAgentsRouteSource,
    "retry result effect helper",
    "async function applyRetryResultEffects(args: {",
  );
  const keeperRetryBlock = retryAgentsRouteSource.slice(keeperRetryStart, keeperRetryEnd);
  const keeperTargetAuthorityIndex = uniqueLiteral(
    keeperRetryBlock,
    "Keeper retry active-swipe read",
    "? await readAuthoritativeConversationMessage({",
  );
  const keeperContextIndex = uniqueLiteral(
    keeperRetryBlock,
    "Keeper retry context build",
    "const retryContext = buildHistoricalLorebookKeeperContext(",
  );
  const keeperScopeIndex = uniqueLiteral(
    keeperRetryBlock,
    "Keeper retry scope resolution",
    "const targetScope = await resolveRetryConversationScope({",
  );
  const keeperProviderIndex = uniqueLiteral(
    keeperRetryBlock,
    "Keeper retry provider call",
    "const rawResult = await executeAgent(",
  );
  assert.ok(keeperTargetAuthorityIndex < keeperContextIndex);
  assert.ok(keeperContextIndex < keeperScopeIndex);
  assert.ok(keeperScopeIndex < keeperProviderIndex);

  const registryInstallIndex = uniqueLiteral(
    appSource,
    "shared active generation registry install",
    'app.decorate("activeGenerations", createActiveGenerationRegistry());',
  );
  const appRouteRegistrationIndex = uniqueLiteral(appSource, "root route registration", "await registerRoutes(app);");
  const chatsRegisterIndex = uniqueLiteral(
    routeIndexSource,
    "chats route registration",
    'await app.register(chatsRoutes, { prefix: "/api/chats" });',
  );
  const generateRegisterIndex = uniqueLiteral(
    routeIndexSource,
    "generate route registration",
    'await app.register(generateRoutes, { prefix: "/api/generate" });',
  );
  assert.ok(registryInstallIndex < appRouteRegistrationIndex, "the root registry must exist before route registration");
  assert.ok(chatsRegisterIndex < generateRegisterIndex, "the sibling route registration anchors must stay auditable");
  assert.doesNotMatch(
    routeSource,
    /decorate\(\s*["']activeGenerations["']/,
    "the generate child plugin must not shadow the shared parent registry",
  );
  assert.doesNotMatch(
    chatsRouteSource,
    /decorate\(\s*["']activeGenerations["']/,
    "the chats child plugin must not shadow the shared parent registry",
  );
  assert.equal(
    literalIndices(chatsRouteSource, "acquireSwipeMutationLease(req.params.chatId, req.params.messageId)").length,
    6,
    "every external message-bound mutation route must validate message ownership before leasing its actual chat",
  );
  const deleteRouteIndex = uniqueLiteral(
    chatsRouteSource,
    "chat deletion route",
    'app.delete<{ Params: { id: string }; Querystring: { force?: string } }>("/:id", async (req, reply) => {',
  );
  const deleteLeaseIndex = uniqueLiteral(
    chatsRouteSource,
    "chat deletion lease takeover",
    "const deletionLease = takeOverActiveGenerationLease(activeGenerations, req.params.id);",
  );
  const deleteStorageIndex = uniqueLiteral(
    chatsRouteSource,
    "chat storage removal",
    "await storage.remove(req.params.id);",
  );
  const deleteReleaseIndex = uniqueLiteral(chatsRouteSource, "chat deletion lease release", "deletionLease.release();");
  assert.ok(deleteRouteIndex < deleteLeaseIndex);
  assert.ok(deleteLeaseIndex < deleteStorageIndex);
  assert.ok(deleteStorageIndex < deleteReleaseIndex);
  assert.match(
    chatsRouteSource.slice(deleteLeaseIndex, deleteStorageIndex),
    /if \(!deletionLease\)[\s\S]*?status\(409\)/,
    "a concurrent deletion must fail closed instead of replacing the existing deletion tombstone",
  );
  assert.doesNotMatch(
    chatsRouteSource.slice(deleteRouteIndex, deleteReleaseIndex),
    /activeGenerations\.(?:delete|set)\(/,
    "chat deletion must transfer registry ownership only through the identity-checked lease helper",
  );

  const chatReadIndex = uniqueLiteral(
    routeSource,
    "initial chat read",
    "let chat = await chats.getById(input.chatId);",
  );
  const leaseIndex = uniqueLiteral(
    routeSource,
    "active generation lease",
    "const activeGenerationLease = acquireActiveGenerationLease(",
  );
  const lockedChatReadIndex = uniqueLiteral(
    routeSource,
    "authoritative locked chat reread",
    "const lockedChat = await chats.getById(input.chatId).catch(releaseActiveGenerationAndRethrow);",
  );
  const lockedChatAdoptionIndex = uniqueLiteral(
    routeSource,
    "authoritative locked chat adoption",
    "chat = lockedChat;",
  );
  const requestChatModeIndex = uniqueLiteral(
    routeSource,
    "request chat mode from locked row",
    'const requestChatMode = (chat.mode as ChatMode) ?? "roleplay";',
  );
  const earlyMetaIndex = uniqueLiteral(
    routeSource,
    "early metadata from locked row",
    "const earlyMeta = parseExtra(chat.metadata) as Record<string, unknown>;",
  );
  const continueReadIndex = uniqueLiteral(
    routeSource,
    "continue target read",
    "getMessageWithActiveSwipe(input.continueMessageId)",
  );
  const regenerateReadIndex = uniqueLiteral(
    routeSource,
    "regenerate target read",
    "getMessageWithActiveSwipe(input.regenerateMessageId)",
  );
  const preflightIndex = uniqueLiteral(
    routeSource,
    "Conversation scope preflight",
    "const conversationScopePreflight = await prepareConversationScopePreflight(",
  );
  const missingActiveSwipeGuardIndex = uniqueLiteral(
    routeSource,
    "missing active swipe guard",
    'code: "conversation_active_swipe_missing"',
  );
  const invalidReturnIndex = uniqueLiteral(
    routeSource,
    "Conversation scope invalid return",
    'if (conversationScopePreflight.resolution.kind === "invalid") {',
  );
  const turnGameScopeGuardIndex = uniqueLiteral(
    routeSource,
    "turn-game Conversation scope guard",
    'code: "turn_game_requires_merged_scope"',
  );

  assert.ok(chatReadIndex < leaseIndex, "initial chat existence read must precede lease acquisition");
  assert.ok(leaseIndex < lockedChatReadIndex, "lease acquisition must precede the authoritative chat reread");
  assert.ok(lockedChatReadIndex < lockedChatAdoptionIndex, "the locked chat row must be adopted before use");
  assert.ok(lockedChatAdoptionIndex < requestChatModeIndex, "request mode must come from the locked chat row");
  assert.ok(lockedChatAdoptionIndex < earlyMetaIndex, "early metadata must come from the locked chat row");
  assert.ok(earlyMetaIndex < continueReadIndex, "locked chat state must precede continue target read");
  assert.ok(earlyMetaIndex < regenerateReadIndex, "locked chat state must precede regenerate target read");
  assert.ok(continueReadIndex < preflightIndex, "continue target read must precede preflight");
  assert.ok(regenerateReadIndex < preflightIndex, "regenerate target read must precede preflight");
  assert.match(
    routeSource.slice(lockedChatAdoptionIndex, preflightIndex + 700),
    /storedCharacterIds:\s*chat\.characterIds,[\s\S]*?chatMetadata:\s*earlyMeta,/,
    "Conversation preflight must consume roster and metadata from the post-lease chat reread",
  );
  assert.ok(
    continueReadIndex < missingActiveSwipeGuardIndex && regenerateReadIndex < missingActiveSwipeGuardIndex,
    "both lifecycle reads must precede the missing active swipe guard",
  );
  assert.ok(missingActiveSwipeGuardIndex < preflightIndex, "missing active swipe must fail before preflight");
  assert.equal(
    literalIndices(routeSource, "getMessageWithActiveSwipe(").length,
    3,
    "continue, regenerate, and historical Keeper must read the authoritative active swipe",
  );
  assert.ok(preflightIndex < invalidReturnIndex, "preflight must precede invalid return");

  const genericReplayApplyIndices = callIndices(
    routeSource,
    /\bapplyGenerationReplayToRegenerateInput\s*\(/g,
    "generic replay application",
  );
  assert.equal(genericReplayApplyIndices.length, 1, "generic replay application must have exactly one call site");
  assert.ok(
    invalidReturnIndex < genericReplayApplyIndices[0]!,
    "raw scope validation must precede generic replay application",
  );
  assert.equal(
    literalIndices(routeSource, "activeGenerationLease.release()").length,
    1,
    "all route releases must flow through the owner-checked release alias",
  );
  assert.match(
    routeSource.slice(invalidReturnIndex, genericReplayApplyIndices[0]!),
    /\breleaseActiveGeneration\(\)/,
    "invalid Conversation scope must release its lease before returning",
  );

  const boundaryPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["game-state commit", /\bgameStateStore\s*\.\s*commit\s*\(/g],
    ["spatial-owner commit", /\bcommitSpatialOwnerTurn\s*\(/g],
    ["chat message creation", /\bchats\s*\.\s*createMessage\s*\(/g],
    ["chat swipe creation", /\bchats\s*\.\s*addSwipe\s*\(/g],
    ["message content update", /\bchats\s*\.\s*updateMessageContent\s*\(/g],
    ["message extra update", /\bchats\s*\.\s*updateMessageExtra\s*\(/g],
    ["swipe-specific message extra update", /\bchats\s*\.\s*updateMessageExtraForSwipe\s*\(/g],
    ["swipe extra update", /\bchats\s*\.\s*updateSwipeExtra\s*\(/g],
    ["chat metadata patch", /\bchats\s*\.\s*patchMetadata\s*\(/g],
    ["chat metadata update", /\bchats\s*\.\s*updateMetadata\s*\(/g],
    ["user activity record", /\brecordUserActivity\s*\(/g],
    ["generation-in-progress marker", /\bmarkGenerationInProgress\s*\(/g],
    ["Discord webhook", /\bpostToDiscordWebhook\s*\(/g],
    ["SSE start", /\bstartSseReply\s*\(/g],
    ["provider runtime resolution", /\bresolveGenerationProviderRuntime\s*\(/g],
    ["provider chatComplete", /\.\s*chatComplete\s*!?\s*\(/g],
    ["provider chat", /\bprovider\s*\.\s*chat\s*\(/g],
  ];
  for (const [label, pattern] of boundaryPatterns) {
    for (const index of callIndices(routeSource, pattern, label)) {
      assert.ok(invalidReturnIndex < index, `${label} must occur after Conversation scope invalid return`);
      assert.ok(turnGameScopeGuardIndex < index, `turn-game scope guard must occur before ${label}`);
    }
  }
  assert.equal(
    callIndices(routeSource, /\.\s*chatComplete\s*!?\s*\(/g, "all provider chatComplete sites").length,
    4,
    "the provider boundary guard must account for selector, tool-loop, follow-up, and summary completions",
  );
  const turnGameScopeGuardStart = routeSource.lastIndexOf("if (", turnGameScopeGuardIndex);
  const turnGameScopeGuardEnd = routeSource.indexOf(
    'if (conversationScopeResolution.kind === "not_applicable") {',
    turnGameScopeGuardIndex,
  );
  assert.ok(
    turnGameScopeGuardStart >= 0 && turnGameScopeGuardEnd > turnGameScopeGuardIndex,
    "turn-game scope guard block must be identifiable",
  );
  assert.match(
    routeSource.slice(turnGameScopeGuardStart, turnGameScopeGuardEnd),
    /releaseActiveGeneration\(\)/,
    "a rejected targeted turn-game request must release its lease inside the same guard",
  );

  assert.doesNotMatch(
    routeSource,
    /input\.forCharacterId\s*=\s*continueTargetMessage\.characterId\s*;/,
    "Conversation continue must not derive focus from assistant attribution",
  );
  assert.doesNotMatch(
    routeSource,
    /input\.forCharacterId\s*=\s*regenCandidate\.characterId\s*;/,
    "Conversation regenerate must not derive focus from assistant attribution",
  );
  assert.doesNotMatch(
    routeSource,
    /const targetMessage = \(await chats\.getMessage\(input\.continueMessageId\)\) \?\? continueTargetMessage;/,
    "Conversation continue must not replace its lease-protected active-swipe snapshot with a stale message envelope",
  );
  assert.match(
    routeSource,
    /continuedMessageRewriteSource = appendContinuationMessageContent\(\s*continueTargetMessage\?\.content,\s*fullResponse,?\s*\);/,
    "Conversation continue persistence must append to the authoritative active-swipe content read under the lease",
  );
  assert.ok(
    callIndices(
      routeSource,
      /\bresolveNonConversationLifecycleCharacterFallback\s*\(/g,
      "non-Conversation lifecycle fallback",
    ).length >= 1,
  );
  assert.doesNotMatch(
    routeSource,
    /\bactiveGenerations\s*\.\s*(?:set|delete)\s*\(/,
    "route must mutate active generation ownership only through the lease helper",
  );

  assert.equal(
    literalIndices(routeSource, "scopedCharacterIds: scopedConversationSpeakerIds").length,
    2,
    "Conversation presence and custom assets must receive the stable preflight speaker IDs",
  );
  assert.match(
    routeSource,
    /primaryCharacterId:\s*conversationEnvelopeTargetId/,
    "Conversation profile primary identity must derive from the preflight scope",
  );
  assert.ok(
    literalIndices(routeSource, "mentionedCharacterNames: validatedConversationMentionNames").length >= 3,
    "Conversation consumers must receive only the request names accepted by preflight",
  );
  const scopedCharacterFormattingStart = uniqueLiteral(
    routeSource,
    "scoped Conversation character formatting",
    "const mentionedConversationCharacters = scopedConversationSpeakerIds",
  );
  const scopedCharacterFormattingEnd = uniqueLiteral(
    routeSource,
    "post-formatting directive",
    "const hasExplicitGenerationDirective =",
  );
  const scopedCharacterFormattingBlock = routeSource.slice(
    scopedCharacterFormattingStart,
    scopedCharacterFormattingEnd,
  );
  assert.doesNotMatch(scopedCharacterFormattingBlock, /input\.mentionedCharacterNames|normalizeTextForMatch/);
  assert.match(
    routeSource,
    /const persistedGenerationReplay\s*=\s*buildGenerationReplay\(\{[\s\S]*?conversationScope:\s*conversationScopeReplay[\s\S]*?\}\);/,
    "every saved Conversation swipe must persist its explicit resolved scope",
  );
  assert.equal(
    literalIndices(routeSource, "conversationScope: conversationScopeReplay").length,
    1,
    "all assistant save paths must reuse one canonical resolved Conversation scope replay",
  );
  assert.doesNotMatch(routeSource, /buildGenerationReplay\(\s*input\s*\)/);
  assert.doesNotMatch(
    routeSource,
    /targetCharId\s*\?\?\s*input\.forCharacterId/,
    "character-scoped tools must not fall back to mutable request attribution",
  );
  assert.doesNotMatch(
    routeSource,
    /speakerParse\.commandCharacterIds\[index\]\s*\?\?/,
    "explicit null speaker attribution must survive the first command map",
  );
  assert.doesNotMatch(
    routeSource,
    /speakerIdByCommand\.get\(command\)\s*\?\?/,
    "explicit null speaker attribution must survive enabled-command filtering",
  );
  assert.doesNotMatch(
    routeSource,
    /commandCharacterIds\?\.\[cmdIndex\]\s*\?\?/,
    "explicit null speaker attribution must survive command collection",
  );
  assert.equal(
    literalIndices(routeSource, "attributedCharacterId === undefined").length,
    3,
    "all three command-attribution handoffs must preserve explicit null",
  );
  assert.match(
    routeSource,
    /aliases:\s*conversationCommandAliasesByCharacterId\.get\(character\.id\)\s*\?\?\s*\[\]/,
    "command speaker attribution must receive Conversation display-name aliases",
  );
  assert.match(
    routeSource,
    /const isAllowedConversationSpeakerId\s*=\s*\(/,
    "character-scoped effects must share one allowed-speaker predicate",
  );
  assert.ok(
    literalIndices(routeSource, "isAllowedConversationSpeakerId(").length >= 2,
    "the shared allowed-speaker predicate must guard both tools and command execution",
  );
  const implicitSelfieStart = uniqueLiteral(routeSource, "implicit selfie recovery", "const recoveredSelfieCommand =");
  const implicitSelfieEnd = uniqueLiteral(
    routeSource,
    "implicit selfie recovery result",
    "if (recoveredSelfieCommand) {",
  );
  assert.match(
    routeSource.slice(implicitSelfieStart, implicitSelfieEnd),
    /implicitSelfieRecoveryAllowed\s*\?/,
    "implicit selfie recovery must run only for an authoritative single-speaker generation",
  );
  assert.match(
    routeSource,
    /const implicitSelfieRecoveryAllowed\s*=\s*speaksOnlyTargetCharacter\s*&&\s*speakerParse\?\.hasExplicitSpeakerStructure\s*!==\s*true/,
    "implicit selfie recovery must reject explicit speaker structure even in focused output",
  );

  const sseStartIndex = uniqueLiteral(
    routeSource,
    "SSE initialization",
    'startSseReply(reply, { "X-Accel-Buffering": "no" });',
  );
  const generationTryIndex = routeSource.lastIndexOf("try {", sseStartIndex);
  const generationFinallyIndex = uniqueLiteral(
    routeSource,
    "generation cleanup",
    "} finally {\n      if (conversationGenerationStartedAt != null && !conversationAssistantSaved) {",
  );
  assert.ok(
    generationTryIndex >= 0 && generationTryIndex < sseStartIndex,
    "SSE initialization must be inside cleanup try",
  );
  assert.ok(sseStartIndex < generationFinallyIndex, "SSE initialization must precede generation cleanup");
  assert.match(
    routeSource.slice(generationFinallyIndex, generationFinallyIndex + 700),
    /releaseActiveGeneration\(\)/,
    "generation cleanup must release the active-generation lease",
  );

  assert.match(
    chatsStorageSource,
    /async addSwipe\([\s\S]*?extra\?: unknown,[\s\S]*?characterId\?: string \| null,?[\s\S]*?\)/,
    "addSwipe must atomically accept initial extra and swipe attribution",
  );
  const updateMessageContentStart = uniqueLiteral(
    chatsStorageSource,
    "message content update",
    "async updateMessageContent(id: string, content: string)",
  );
  const updateMessageContentForSwipeStart = uniqueLiteral(
    chatsStorageSource,
    "exact swipe content compare-and-set",
    "async updateMessageContentForSwipe(",
  );
  const createMessageStart = uniqueLiteral(
    chatsStorageSource,
    "message creation after exact swipe compare-and-set",
    "async createMessage(input: CreateMessageInput, timestampOverrides?: TimestampOverrides | null)",
  );
  assert.match(
    chatsStorageSource.slice(updateMessageContentForSwipeStart, createMessageStart),
    /const result = await db\.transaction\(/,
    "exact swipe CAS read and its swipe/envelope writes must share one transaction",
  );
  const updateMessageExtraStart = uniqueLiteral(
    chatsStorageSource,
    "message extra update",
    "async updateMessageExtra(id: string, partial: Record<string, unknown>)",
  );
  assert.match(
    chatsStorageSource.slice(updateMessageContentStart, updateMessageExtraStart),
    /db\.transaction\(/,
    "message content and its active swipe copy must update in one transaction",
  );
  const updateMessageExtraForSwipeStart = uniqueLiteral(
    chatsStorageSource,
    "exact swipe extra update",
    "async updateMessageExtraForSwipe(id: string, swipeIndex: number, partial: Record<string, unknown>)",
  );
  const bulkHiddenStart = uniqueLiteral(chatsStorageSource, "bulk hidden update", "async bulkSetHiddenFromAI(");
  assert.match(
    chatsStorageSource.slice(updateMessageExtraForSwipeStart, bulkHiddenStart),
    /db\.transaction\(/,
    "an exact active-swipe extra update and its envelope mirror must commit atomically",
  );
  assert.match(
    routeSource,
    /chats\.addSwipe\([\s\S]*?generationReplay:\s*persistedGenerationReplay[\s\S]*?targetCharId,[\s\S]*?\);/,
    "regeneration must persist the resolved attribution with its new swipe",
  );
  assert.equal(
    literalIndices(
      chatsRouteSource,
      "const swipeMutation = await acquireSwipeMutationLease(req.params.chatId, req.params.messageId);",
    ).length,
    4,
    "all four external swipe mutation routes must validate ownership before acquiring the actual chat lease",
  );
  assert.equal(
    literalIndices(chatsRouteSource, "swipeMutation.lease.release();").length,
    4,
    "every external swipe mutation route must release its lease in finally",
  );
  assert.equal(
    literalIndices(chatsRouteSource, "Cannot change swipes while generation is in progress").length,
    4,
    "every external swipe mutation route must fail closed while generation owns the chat",
  );
  assert.match(
    chatsRouteSource,
    /sanitizeJsonlSwipeExtra[\s\S]*?extractPortableConversationSwipeExtra\(extra\)/,
    "JSONL swipe export must preserve only portable Conversation scope and attribution",
  );
  assert.match(
    chatsRouteSource,
    /sanitizeBranchedMessageExtra[\s\S]*?extractPortableConversationSwipeExtra\(extra\)/,
    "trusted branch copies must preserve portable Conversation scope and attribution",
  );
  assert.match(
    stChatImporterSource,
    /const portable = extractPortableConversationSwipeExtra\(raw\);[\s\S]*?extra\.generationReplay = portable\.generationReplay/,
    "JSONL import must restore only the validated portable Conversation replay",
  );
  assert.match(
    stChatImporterSource,
    /\? \{ \.\.\.\(storedMessageExtra \?\? \{\}\), \.\.\.\(storedSwipe\?\.extra \?\? \{\}\) \}/,
    "the per-swipe JSONL metadata must remain authoritative over the message envelope",
  );
  const approvalCommitStart = uniqueLiteral(
    chatsRouteSource,
    "lorebook approval commit",
    'if (body.kind === "lorebook_update") {',
  );
  const approvalCommitEnd = uniqueLiteral(
    chatsRouteSource,
    "unsupported approval response",
    'return reply.status(400).send({ error: "Unsupported agent write approval kind" });',
  );
  const approvalCommitBlock = chatsRouteSource.slice(approvalCommitStart, approvalCommitEnd);
  assert.match(approvalCommitBlock, /normalizeLorebookAccessContext\(payload\.accessContext\)/);
  assert.match(approvalCommitBlock, /accessContext\.chatId\s*!==\s*req\.params\.id/);
  assert.match(
    approvalCommitBlock,
    /persistLorebookKeeperUpdates\(\{[\s\S]*?accessContext,[\s\S]*?lorebookPromptContext:[\s\S]*?newEntryCharacterFilterIds/,
    "approved writes must restore the original lorebook prompt and character scope",
  );
  assert.match(
    approvalCommitBlock,
    /allowCreateTarget:\s*payload\.allowCreateTarget\s*===\s*true/,
    "approval commit must preserve an explicit false create permission",
  );

  const knowledgeRetrievalStart = uniqueLiteral(
    routeSource,
    "knowledge retrieval source loading",
    'const knowledgeRetrievalAgent = resolvedAgents.find((a) => a.type === "knowledge-retrieval");',
  );
  const knowledgeRouterStart = uniqueLiteral(
    routeSource,
    "knowledge router source loading",
    'const knowledgeRouterAgent = resolvedAgents.find((a) => a.type === "knowledge-router");',
  );
  const trackerInjectionStart = uniqueLiteral(
    routeSource,
    "tracker data injection",
    'if (resolvedAgents.some((a) => a.type === "card-evolution-auditor")) {',
  );
  const knowledgeRetrievalBlock = routeSource.slice(knowledgeRetrievalStart, knowledgeRouterStart);
  const knowledgeRouterBlock = routeSource.slice(knowledgeRouterStart, trackerInjectionStart);
  for (const [label, block] of [
    ["knowledge retrieval", knowledgeRetrievalBlock],
    ["knowledge router", knowledgeRouterBlock],
  ] as const) {
    assert.match(block, /filterLorebookSourceIdsForPrompt\(rawSourceIds\)/, `${label} must scope source books`);
    assert.match(block, /filterAccessibleLorebookEntries\(/, `${label} must scope source entries`);
  }

  const historicalKeeperScopeStart = uniqueLiteral(
    routeSource,
    "historical Keeper scope restoration",
    "const buildLorebookKeeperRunScope = async (args:",
  );
  const historicalKeeperScopeEnd = uniqueLiteral(
    routeSource,
    "historical Keeper approval adapter",
    "const markLorebookResultForApproval = (result: AgentResult): AgentResult => {",
  );
  const historicalKeeperScopeBlock = routeSource.slice(historicalKeeperScopeStart, historicalKeeperScopeEnd);
  assert.match(historicalKeeperScopeBlock, /parseExtra\(historicalTarget\.extra\)\.generationReplay/);
  assert.match(historicalKeeperScopeBlock, /buildRetryLorebookAccessContext\(/);
  assert.match(historicalKeeperScopeBlock, /loadLorebookKeeperExistingEntries\(/);
  assert.match(historicalKeeperScopeBlock, /applyLorebookKeeperRunMemoryScope\(/);
  assert.match(
    routeSource,
    /return rememberLorebookKeeperRunScope\(finalizedResult, runScope\)/,
    "approval envelopes must retain their historical Keeper scope until persistence",
  );
  assert.match(
    routeSource,
    /persistLorebookKeeperUpdates\(\{[\s\S]*?lorebookPromptContext:\s*runScope\.accessContext,[\s\S]*?newEntryCharacterFilterIds:\s*runScope\.newEntryCharacterFilterIds,[\s\S]*?allowCreateTarget:\s*customCanCreateLorebooks/,
    "main Keeper persistence must use the result's restored scope and create permission",
  );

  const retryHistoricalKeeperStart = uniqueLiteral(
    retryAgentsRouteSource,
    "retry historical Keeper loop",
    "const authoritativeTarget =",
  );
  const retryHistoricalKeeperEnd = retryAgentsRouteSource.indexOf(
    "results.push({ messageId: target.id, result });",
    retryHistoricalKeeperStart,
  );
  assert.ok(retryHistoricalKeeperEnd > retryHistoricalKeeperStart, "retry historical Keeper block must be found");
  const retryHistoricalKeeperBlock = retryAgentsRouteSource.slice(retryHistoricalKeeperStart, retryHistoricalKeeperEnd);
  assert.match(retryHistoricalKeeperBlock, /parseExtra\(authoritativeTarget\.extra\)\.generationReplay/);
  assert.match(retryHistoricalKeeperBlock, /buildRetryLorebookAccessContext\(/);
  assert.match(retryHistoricalKeeperBlock, /applyLorebookKeeperRunMemoryScope\(/);
  assert.match(retryHistoricalKeeperBlock, /newEntryCharacterFilterIds:\s*targetScope\.newEntryCharacterFilterIds/);
  assert.doesNotMatch(
    retryHistoricalKeeperBlock,
    /attachRetryLorebookWriterToolContext|resolved\.toolContext/,
    "historical Keeper retries must stay structured-output only",
  );
  assert.match(
    retryAgentsRouteSource,
    /allowCreateTarget:\s*customCanCreateLorebooks/,
    "retry structured results must carry their create permission",
  );
  assert.match(
    retryAgentsRouteSource,
    /allowCreateTarget:\s*false/,
    "retry tool approvals must not silently gain target-creation permission",
  );
  assert.match(
    toolResolutionSource,
    /allowCreateTarget:\s*false/,
    "main tool approvals must not silently gain target-creation permission",
  );
  assert.ok(
    literalIndices(routeSource, "generationReplay: persistedGenerationReplay").length >= 3,
    "hidden anchors, regenerated swipes, and new messages must persist scope with their initial content write",
  );
  assert.match(
    routeSource,
    /extraUpdate\.generationReplay\s*=\s*persistedGenerationReplay/,
    "the later metadata enrichment must preserve the same already-persisted replay",
  );
  const singleCallTargetStart = uniqueLiteral(routeSource, "single-call target", "let targetCharId =");
  const singleCallTargetEnd = uniqueLiteral(
    routeSource,
    "single-call messages",
    "const sentMessages = [...finalMessages];",
  );
  assert.match(
    routeSource.slice(singleCallTargetStart, singleCallTargetEnd),
    /let\s+targetCharId\s*=\s*conversationEnvelopeTargetId\s*;/,
    "single-call Conversation attribution must use the deterministic scope envelope target",
  );
  const mergedScopeStart = uniqueLiteral(routeSource, "merged speaks-only target", "const mergedSpeaksOnlyTarget =");
  const mergedScopeEnd = uniqueLiteral(
    routeSource,
    "merged generation call",
    "const genResult = await generateForCharacter(targetCharId, sentMessages, true, mergedSpeaksOnlyTarget);",
  );
  assert.match(
    routeSource.slice(mergedScopeStart, mergedScopeEnd),
    /conversationScopeResolution\.kind\s*===\s*"focused"/,
    "focused Conversation scope must be treated as exactly one speaker",
  );

  const commandExecutionStart = uniqueLiteral(
    routeSource,
    "filtered command execution",
    "const executableCollectedCommands =",
  );
  const commandExecutionEnd = uniqueLiteral(
    routeSource,
    "command execution end",
    "// ── Trigger follow-up generation if Professor Mari's fetch landed ──",
  );
  const commandExecutionBlock = routeSource.slice(commandExecutionStart, commandExecutionEnd);
  assert.match(commandExecutionBlock, /if\s*\(\s*executableCollectedCommands\.length\s*>\s*0/);
  assert.match(commandExecutionBlock, /countProfessorMariCommands\s*\(\s*executableCollectedCommands\s*\)/);
  assert.match(commandExecutionBlock, /count\s*:\s*executableCollectedCommands\.length/);
  assert.match(commandExecutionBlock, /of\s+executableCollectedCommands\s*\)/);

  const awarenessStart = uniqueLiteral(
    routeSource,
    "cross-chat awareness",
    "convoAwarenessBlock = await buildAwarenessBlock(",
  );
  const awarenessEnd = uniqueLiteral(
    routeSource,
    "connected chat context",
    "const { connectedChatBlock, systemPromptAppend: connectedChatSystemPrompt } =",
  );
  assert.match(routeSource.slice(awarenessStart, awarenessEnd), /\bpromptCharacterIds\b/);
  assert.match(
    routeSource,
    /mergeConversationCharacterMemories\(\{[\s\S]*?characterIds:\s*promptCharacterIds/,
    "focused Conversation memory must use the same prompt character scope",
  );

  const allowedPreflightImports = new Set(["./generate-route-utils.js", "./generation-replay.js"]);
  const preflightImportSources = [...preflightSource.matchAll(/\bfrom\s+["']([^"']+)["'];/g)].map((match) => match[1]!);
  assert.ok(preflightImportSources.length > 0, "preflight must declare its read-only imports");
  for (const importSource of preflightImportSources) {
    assert.ok(allowedPreflightImports.has(importSource), `preflight import is not allowlisted: ${importSource}`);
  }
  assert.match(
    preflightSource,
    /input\.chatMode\s*===\s*"conversation"\s*&&\s*characterNamesById\.size\s*!==\s*activeCharacterIds\.length/,
    "Conversation preflight must reject missing, malformed, or duplicate active roster entries",
  );
  const presenceRosterCheckIndex = uniqueLiteral(
    presenceSource,
    "runtime Conversation roster check",
    "if (!hasExactConversationPresenceRoster(convoCharInfo, args.characterIds)) {",
  );
  const presenceStateWriteIndex = uniqueLiteral(
    presenceSource,
    "Conversation presence-state write",
    "persistConversationPresenceState(args.chats, args.chatId, convoCharInfo);",
  );
  assert.ok(
    presenceRosterCheckIndex < presenceStateWriteIndex,
    "runtime roster drift must stop before presence-state mutation",
  );
  assert.match(
    presenceSource.slice(presenceRosterCheckIndex, presenceStateWriteIndex),
    /writeSse\(\{ type: "error"[\s\S]*?writeSse\(\{ type: "done" \}\)[\s\S]*?endSse\(\)/,
    "runtime roster drift must end the stream without reaching the provider",
  );
  assert.doesNotMatch(preflightSource, /^\s*import\s+["']/m, "preflight must not use side-effect imports");
  for (const [label, pattern] of [
    ["chat storage", /\bcreateChatsStorage\b/],
    ["character storage", /\bcreateCharactersStorage\b/],
    ["game-state mutation", /\bgameStateStore\b/],
    ["spatial-owner mutation", /\bcommitSpatialOwnerTurn\b/],
    ["SSE", /\bstartSseReply\b/],
    ["provider runtime", /\bresolveGenerationProviderRuntime\b/],
    ["provider completion", /\.\s*chatComplete\s*\(/],
    ["provider chat", /\bprovider\s*\.\s*chat\s*\(/],
    ["network fetch", /\bfetch\s*\(/],
    ["chat creation", /\bchats\s*\.\s*createMessage\s*\(/],
    ["message update", /\bchats\s*\.\s*updateMessage/],
    ["metadata update", /\bchats\s*\.\s*(?:patchMetadata|updateMetadata)\s*\(/],
  ] as const) {
    assert.doesNotMatch(preflightSource, pattern, `preflight must not depend on ${label}`);
  }

  function parseExtra(extra: unknown): Record<string, unknown> {
    if (!extra) return {};
    if (typeof extra === "string") return JSON.parse(extra) as Record<string, unknown>;
    return extra as Record<string, unknown>;
  }

  function readConversationScope(message: { extra: unknown }) {
    return (parseExtra(message.extra).generationReplay as Record<string, unknown> | undefined)?.conversationScope;
  }

  function readSwipeCharacterId(message: { extra: unknown }) {
    return parseExtra(message.extra).swipeCharacterId;
  }

  const dbModule = await import("../../packages/server/src/db/connection.js");
  closeDatabase = dbModule.closeDB;
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
  const { buildAwarenessBlock } = await import("../../packages/server/src/services/conversation/awareness.service.js");
  const { chunkAndEmbedMessages } = await import("../../packages/server/src/services/memory-recall.js");
  const { createCapabilityPersistenceHost } =
    await import("../../packages/server/src/services/capability-packages/capability-persistence.service.js");
  const { MariDbService } = await import("../../packages/server/src/services/mari-db/mari-db.service.js");
  const { gameTurnStoryboardKeyframes, gameTurnStoryboards, memoryChunks, messages, messageSwipes } =
    await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createGameStoryboardsStorage } =
    await import("../../packages/server/src/services/storage/game-storyboards.storage.js");
  const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
  const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
  const { registerRetryAgentsRoute } = await import("../../packages/server/src/routes/generate/retry-agents-route.js");
  const requireFromServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireFromServer("fastify") as (options?: Record<string, unknown>) => any;
  const regressionDb = await dbModule.getDB();
  const chats = createChatsStorage(regressionDb);
  const characterStore = createCharactersStorage(regressionDb);
  const chat = await chats.create({
    name: "Conversation scope swipe regression",
    mode: "conversation",
    characterIds: ["leo", "dan"],
  });

  const interleavingChat = await chats.create({
    name: "Post-lease chat reread interleaving",
    mode: "roleplay",
    characterIds: ["leo", "dan"],
  });
  const interleavingLifecycleMessage = await chats.createMessage({
    chatId: interleavingChat.id,
    role: "assistant",
    characterId: "leo",
    content: "old focused Leo lifecycle target",
    extra: { generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } } },
  });
  assert.ok(interleavingLifecycleMessage);
  const preLeaseChatSnapshot = await chats.getById(interleavingChat.id);
  assert.ok(preLeaseChatSnapshot);
  assert.equal(preLeaseChatSnapshot.mode, "roleplay");
  assert.deepEqual(JSON.parse(preLeaseChatSnapshot.characterIds as string), ["leo", "dan"]);

  const interleavingRegistry = createActiveGenerationRegistry();
  const interleavingMutationLease = acquireChatMutationLease(interleavingRegistry, interleavingChat.id);
  assert.ok(interleavingMutationLease);
  await chats.update(interleavingChat.id, { mode: "conversation", characterIds: ["dan"] });
  assert.equal(interleavingMutationLease.release(), true);

  const interleavingGenerationLease = acquireActiveGenerationLease(interleavingRegistry, interleavingChat.id);
  assert.ok(interleavingGenerationLease);
  const postLeaseChatSnapshot = await chats.getById(interleavingChat.id);
  const postLeaseLifecycleTarget = await chats.getMessageWithActiveSwipe(interleavingLifecycleMessage.id);
  assert.ok(postLeaseChatSnapshot);
  assert.ok(postLeaseLifecycleTarget);
  assert.equal(postLeaseChatSnapshot.mode, "conversation");
  assert.deepEqual(JSON.parse(postLeaseChatSnapshot.characterIds as string), ["dan"]);
  const postLeasePreflight = await prepareConversationScopePreflight({
    chatMode: postLeaseChatSnapshot.mode,
    storedCharacterIds: postLeaseChatSnapshot.characterIds,
    chatMetadata: parseExtra(postLeaseChatSnapshot.metadata),
    impersonate: false,
    lifecycle: "regenerate",
    explicitTargetCharacterId: null,
    mentionedCharacterNames: [],
    rawGenerationReplay: parseExtra(postLeaseLifecycleTarget.extra).generationReplay,
    getCharacterById: async (id) => characterRows.get(id),
  });
  assert.deepEqual(
    postLeasePreflight.resolution,
    { kind: "invalid", code: "stale_replay_scope" },
    "generation must use the post-mutation roster and mode reread under its lease instead of a stale pre-lease row",
  );
  assert.equal(interleavingGenerationLease.release(), true);

  const createdMessage = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: "leo",
    content: "focused response",
    extra: { generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } } },
  });
  assert.ok(createdMessage);
  await chats.addSwipe(createdMessage.id, "restricted response");
  await chats.updateMessageExtraForSwipe(createdMessage.id, 1, {
    generationReplay: { conversationScope: { mode: "restricted", characterIds: ["leo", "dan"] } },
  });

  const restoredSwipeZero = await chats.setActiveSwipe(createdMessage.id, 0);
  assert.ok(restoredSwipeZero);
  assert.deepEqual(readConversationScope(restoredSwipeZero), { mode: "focused", characterId: "leo" });
  const restoredSwipeOne = await chats.setActiveSwipe(createdMessage.id, 1);
  assert.ok(restoredSwipeOne);
  assert.deepEqual(readConversationScope(restoredSwipeOne), { mode: "restricted", characterIds: ["leo", "dan"] });
  const restoredSwipeZeroAgain = await chats.setActiveSwipe(createdMessage.id, 0);
  assert.ok(restoredSwipeZeroAgain);
  assert.deepEqual(readConversationScope(restoredSwipeZeroAgain), { mode: "focused", characterId: "leo" });

  const atomicSwipe = await chats.addSwipe(
    createdMessage.id,
    "atomic focused response",
    false,
    { generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } } },
    "dan",
  );
  const atomicActiveMessage = await chats.getMessage(createdMessage.id);
  assert.ok(atomicActiveMessage);
  assert.equal(atomicActiveMessage.activeSwipeIndex, atomicSwipe.index);
  assert.equal(atomicActiveMessage.characterId, "dan");
  assert.deepEqual(readConversationScope(atomicActiveMessage), { mode: "focused", characterId: "dan" });
  const atomicSwipeRow = (await chats.getSwipes(createdMessage.id)).find((swipe) => swipe.index === atomicSwipe.index);
  assert.ok(atomicSwipeRow);
  assert.equal(readSwipeCharacterId(atomicSwipeRow), "dan");
  assert.deepEqual(readConversationScope(atomicSwipeRow), { mode: "focused", characterId: "dan" });
  const restoredLeoAttribution = await chats.setActiveSwipe(createdMessage.id, 0);
  assert.ok(restoredLeoAttribution);
  assert.equal(restoredLeoAttribution.characterId, "leo");
  const restoredDanAttribution = await chats.setActiveSwipe(createdMessage.id, atomicSwipe.index);
  assert.ok(restoredDanAttribution);
  assert.equal(restoredDanAttribution.characterId, "dan");
  const manualSwipe = await chats.addSwipe(createdMessage.id, "manual alternate response");
  const manualSwipeRow = (await chats.getSwipes(createdMessage.id)).find((swipe) => swipe.index === manualSwipe.index);
  assert.ok(manualSwipeRow);
  assert.equal(
    readSwipeCharacterId(manualSwipeRow),
    "dan",
    "a manually-added swipe must inherit the active swipe's attribution",
  );
  const restoredLeoAfterManual = await chats.setActiveSwipe(createdMessage.id, 0);
  assert.ok(restoredLeoAfterManual);
  assert.equal(restoredLeoAfterManual.characterId, "leo");
  const restoredManualAttribution = await chats.setActiveSwipe(createdMessage.id, manualSwipe.index);
  assert.ok(restoredManualAttribution);
  assert.equal(
    restoredManualAttribution.characterId,
    "dan",
    "returning to a manually-added swipe must restore its inherited attribution",
  );
  const removalMessage = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: "leo",
    content: "original Leo response",
    extra: { generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } } },
  });
  assert.ok(removalMessage);
  const removableDanSwipe = await chats.addSwipe(
    removalMessage.id,
    "temporary Dan response",
    false,
    { generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } } },
    "dan",
  );
  const afterActiveSwipeRemoval = await chats.removeSwipe(removalMessage.id, removableDanSwipe.index);
  assert.ok(afterActiveSwipeRemoval);
  assert.equal(
    afterActiveSwipeRemoval.characterId,
    "leo",
    "removing the active swipe must restore the replacement swipe's attribution",
  );
  const [batchMessageId] = await chats.createMessagesBatch(chat.id, [
    {
      role: "assistant",
      characterId: "leo",
      content: "active Dan import",
      activeSwipeIndex: 1,
      swipes: [
        { index: 0, content: "Leo import", extra: { swipeCharacterId: "leo" } },
        { index: 1, content: "Dan import", extra: { swipeCharacterId: "dan" } },
      ],
    },
  ]);
  assert.ok(batchMessageId);
  const batchActiveMessage = await chats.getMessage(batchMessageId);
  assert.ok(batchActiveMessage);
  assert.equal(
    batchActiveMessage.characterId,
    "dan",
    "batch import must mirror the explicit active swipe attribution onto the message envelope",
  );

  const stableEnvelopeFields = {
    hiddenFromAI: true,
    hiddenFromUser: false,
    isConversationStart: true,
    reactions: [{ emoji: "wave", count: 1 }],
    personaSnapshot: { id: "persona-stable", name: "Stable Persona" },
  };
  const [canonicalBatchMessageId] = await chats.createMessagesBatch(chat.id, [
    {
      role: "assistant",
      characterId: "leo",
      content: "stale batch envelope",
      activeSwipeIndex: 1,
      extra: {
        ...stableEnvelopeFields,
        attachments: [{ id: "stale-envelope-attachment" }],
        reasoning: "stale envelope reasoning",
        generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
        cachedPrompt: [{ role: "system", content: "stale envelope prompt" }],
      },
      swipes: [
        {
          index: 0,
          content: "inactive Leo batch swipe",
          extra: {
            swipeCharacterId: "leo",
            attachments: [{ id: "inactive-leo-attachment" }],
            reasoning: "inactive Leo reasoning",
          },
        },
        {
          index: 1,
          content: "active Dan batch swipe",
          extra: {
            swipeCharacterId: "dan",
            attachments: [{ id: "active-dan-attachment" }],
            reasoning: "active Dan reasoning",
            generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } },
            cachedPrompt: [{ role: "system", content: "active Dan prompt" }],
          },
        },
      ],
    },
  ]);
  assert.ok(canonicalBatchMessageId);
  const canonicalBatchEnvelope = await chats.getMessage(canonicalBatchMessageId);
  const canonicalBatchActiveSwipe = (await chats.getSwipes(canonicalBatchMessageId)).find((swipe) => swipe.index === 1);
  const canonicalBatchAuthoritative = await chats.getMessageWithActiveSwipe(canonicalBatchMessageId);
  assert.ok(canonicalBatchEnvelope);
  assert.ok(canonicalBatchActiveSwipe);
  assert.ok(canonicalBatchAuthoritative);
  const canonicalBatchExtra = parseExtra(canonicalBatchEnvelope.extra);
  assert.deepEqual(parseExtra(canonicalBatchActiveSwipe.extra), canonicalBatchExtra);
  assert.deepEqual(parseExtra(canonicalBatchAuthoritative.extra), canonicalBatchExtra);
  for (const [key, value] of Object.entries(stableEnvelopeFields)) {
    assert.deepEqual(canonicalBatchExtra[key], value, `${key} must remain message-stable across batch import`);
  }
  assert.deepEqual(canonicalBatchExtra.attachments, [{ id: "active-dan-attachment" }]);
  assert.equal(canonicalBatchExtra.reasoning, "active Dan reasoning");
  assert.deepEqual(canonicalBatchExtra.generationReplay, {
    conversationScope: { mode: "focused", characterId: "dan" },
  });
  assert.deepEqual(canonicalBatchExtra.cachedPrompt, [{ role: "system", content: "active Dan prompt" }]);
  assert.equal(canonicalBatchEnvelope.content, "active Dan batch swipe");
  assert.equal(canonicalBatchEnvelope.characterId, "dan");

  const canonicalCreatedMessage = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: "leo",
    content: "canonical create message",
    extra: {
      personaSnapshot: { id: "create-persona", name: "Create Persona" },
      attachments: [{ id: "create-attachment" }],
      reasoning: "create reasoning",
    },
  });
  assert.ok(canonicalCreatedMessage);
  const [canonicalCreatedSwipe] = await chats.getSwipes(canonicalCreatedMessage.id);
  assert.ok(canonicalCreatedSwipe);
  assert.deepEqual(parseExtra(canonicalCreatedMessage.extra), parseExtra(canonicalCreatedSwipe.extra));
  assert.equal(readSwipeCharacterId(canonicalCreatedMessage), "leo");

  const canonicalAddedSwipe = await chats.addSwipe(
    canonicalCreatedMessage.id,
    "canonical added swipe",
    false,
    {
      attachments: [{ id: "added-attachment" }],
      reasoning: "added reasoning",
      generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } },
    },
    "dan",
  );
  const canonicalAddedEnvelope = await chats.getMessage(canonicalCreatedMessage.id);
  const canonicalAddedSwipeRow = (await chats.getSwipes(canonicalCreatedMessage.id)).find(
    (swipe) => swipe.index === canonicalAddedSwipe.index,
  );
  assert.ok(canonicalAddedEnvelope);
  assert.ok(canonicalAddedSwipeRow);
  assert.deepEqual(parseExtra(canonicalAddedEnvelope.extra), parseExtra(canonicalAddedSwipeRow.extra));
  assert.deepEqual(parseExtra(canonicalAddedEnvelope.extra).personaSnapshot, {
    id: "create-persona",
    name: "Create Persona",
  });
  assert.deepEqual(parseExtra(canonicalAddedEnvelope.extra).attachments, [{ id: "added-attachment" }]);
  assert.equal(parseExtra(canonicalAddedEnvelope.extra).reasoning, "added reasoning");

  const legacyEnvelopeMessage = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: "leo",
    content: "authoritative active content",
    extra: {
      hiddenFromAI: false,
      attachments: [{ id: "authoritative-active-attachment" }],
      reasoning: "authoritative active reasoning",
      generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
    },
  });
  assert.ok(legacyEnvelopeMessage);
  const legacyAlternateSwipe = await chats.addSwipe(
    legacyEnvelopeMessage.id,
    "alternate Dan content",
    true,
    {
      attachments: [{ id: "alternate-dan-attachment" }],
      reasoning: "alternate Dan reasoning",
      generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } },
    },
    "dan",
  );
  await regressionDb
    .update(messages)
    .set({
      content: "stale legacy envelope content",
      extra: JSON.stringify({
        hiddenFromAI: true,
        swipeCharacterId: "leo",
        attachments: [{ id: "stale-envelope-attachment" }],
        reasoning: "stale envelope reasoning",
        generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } },
      }),
    })
    .where(eq(messages.id, legacyEnvelopeMessage.id));
  const selectedLegacyAlternate = await chats.setActiveSwipe(legacyEnvelopeMessage.id, legacyAlternateSwipe.index);
  assert.ok(selectedLegacyAlternate);
  const legacyRowsAfterSwitch = await chats.getSwipes(legacyEnvelopeMessage.id);
  const legacyOutgoingRow = legacyRowsAfterSwitch.find((swipe) => swipe.index === 0);
  const legacySelectedRow = legacyRowsAfterSwitch.find((swipe) => swipe.index === legacyAlternateSwipe.index);
  assert.ok(legacyOutgoingRow);
  assert.ok(legacySelectedRow);
  assert.equal(legacyOutgoingRow.content, "authoritative active content");
  assert.deepEqual(parseExtra(legacyOutgoingRow.extra).attachments, [{ id: "authoritative-active-attachment" }]);
  assert.equal(parseExtra(legacyOutgoingRow.extra).reasoning, "authoritative active reasoning");
  assert.deepEqual(parseExtra(legacyOutgoingRow.extra).generationReplay, {
    conversationScope: { mode: "focused", characterId: "leo" },
  });
  assert.equal(parseExtra(legacyOutgoingRow.extra).hiddenFromAI, true);
  assert.deepEqual(parseExtra(legacySelectedRow.extra).attachments, [{ id: "alternate-dan-attachment" }]);
  assert.equal(parseExtra(legacySelectedRow.extra).reasoning, "alternate Dan reasoning");
  assert.equal(parseExtra(legacySelectedRow.extra).hiddenFromAI, true);
  assert.deepEqual(parseExtra(selectedLegacyAlternate.extra), parseExtra(legacySelectedRow.extra));

  const capabilityPersistence = createCapabilityPersistenceHost(regressionDb);
  await capabilityPersistence.createMessageWithSwipe({
    id: "canonical-capability-message",
    swipeId: "canonical-capability-swipe",
    chatId: chat.id,
    role: "assistant",
    characterId: "dan",
    content: "canonical capability message",
    extra: {
      hiddenFromUser: true,
      personaSnapshot: { id: "capability-persona", name: "Capability Persona" },
      attachments: [{ id: "capability-attachment" }],
      reasoning: "capability reasoning",
    },
    createdAt: "2026-07-18T00:00:00.000Z",
  });
  const [capabilityEnvelope] = await regressionDb
    .select()
    .from(messages)
    .where(eq(messages.id, "canonical-capability-message"));
  const [capabilitySwipe] = await regressionDb
    .select()
    .from(messageSwipes)
    .where(eq(messageSwipes.id, "canonical-capability-swipe"));
  const capabilityAuthoritative = await chats.getMessageWithActiveSwipe("canonical-capability-message");
  assert.ok(capabilityEnvelope);
  assert.ok(capabilitySwipe);
  assert.ok(capabilityAuthoritative);
  assert.deepEqual(parseExtra(capabilityEnvelope.extra), parseExtra(capabilitySwipe.extra));
  assert.deepEqual(parseExtra(capabilityAuthoritative.extra), parseExtra(capabilitySwipe.extra));
  assert.equal(readSwipeCharacterId(capabilityEnvelope), "dan");

  const sharedExtraMessage = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: "leo",
    content: "shared extra active swipe",
    extra: { swipeOnlyZero: "zero" },
  });
  assert.ok(sharedExtraMessage);
  await chats.addSwipe(sharedExtraMessage.id, "shared extra inactive swipe", true, { swipeOnlyOne: "one" }, "dan");
  const propagatedReactions = [{ emoji: "heart", count: 2 }];
  await chats.updateMessageExtra(sharedExtraMessage.id, {
    hiddenFromAI: true,
    reactions: propagatedReactions,
  });
  const sharedExtraEnvelope = await chats.getMessage(sharedExtraMessage.id);
  const sharedExtraRows = await chats.getSwipes(sharedExtraMessage.id);
  assert.ok(sharedExtraEnvelope);
  for (const row of [sharedExtraEnvelope, ...sharedExtraRows]) {
    assert.equal(parseExtra(row.extra).hiddenFromAI, true);
    assert.deepEqual(parseExtra(row.extra).reactions, propagatedReactions);
  }

  await Promise.all([
    chats.updateSwipeExtra(sharedExtraMessage.id, 0, { concurrentReasoning: "preserved reasoning" }),
    chats.updateMessageExtraForSwipe(sharedExtraMessage.id, 0, {
      concurrentReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
    }),
  ]);
  const sharedExtraAfterConcurrentWrites = await chats.getMessage(sharedExtraMessage.id);
  const sharedActiveAfterConcurrentWrites = (await chats.getSwipes(sharedExtraMessage.id)).find(
    (swipe) => swipe.index === 0,
  );
  assert.ok(sharedExtraAfterConcurrentWrites);
  assert.ok(sharedActiveAfterConcurrentWrites);
  assert.equal(parseExtra(sharedActiveAfterConcurrentWrites.extra).concurrentReasoning, "preserved reasoning");
  assert.deepEqual(parseExtra(sharedActiveAfterConcurrentWrites.extra).concurrentReplay, {
    conversationScope: { mode: "focused", characterId: "leo" },
  });
  assert.deepEqual(
    parseExtra(sharedExtraAfterConcurrentWrites.extra),
    parseExtra(sharedActiveAfterConcurrentWrites.extra),
  );

  await chats.updateMessageContent(sharedExtraMessage.id, "atomically edited active content");
  const contentUpdatedEnvelope = await chats.getMessage(sharedExtraMessage.id);
  const contentUpdatedActiveSwipe = (await chats.getSwipes(sharedExtraMessage.id)).find((swipe) => swipe.index === 0);
  assert.ok(contentUpdatedEnvelope);
  assert.ok(contentUpdatedActiveSwipe);
  assert.equal(contentUpdatedEnvelope.content, "atomically edited active content");
  assert.equal(contentUpdatedActiveSwipe.content, "atomically edited active content");

  const attachmentMessage = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: "leo",
    content: "attachment active swipe",
    extra: { attachments: [{ id: "active-existing" }] },
  });
  assert.ok(attachmentMessage);
  const attachmentInactiveSwipe = await chats.addSwipe(
    attachmentMessage.id,
    "attachment inactive swipe",
    true,
    { attachments: [{ id: "inactive-existing" }] },
    "dan",
  );
  const inactiveAttachment = { id: "inactive-appended", kind: "image" };
  const inactiveAppendResult = await chats.appendAttachmentForSwipe(
    attachmentMessage.id,
    attachmentInactiveSwipe.index,
    inactiveAttachment,
  );
  assert.deepEqual(inactiveAppendResult, { active: false });
  const attachmentEnvelopeAfterInactive = await chats.getMessage(attachmentMessage.id);
  const attachmentRowsAfterInactive = await chats.getSwipes(attachmentMessage.id);
  assert.ok(attachmentEnvelopeAfterInactive);
  assert.deepEqual(parseExtra(attachmentEnvelopeAfterInactive.extra).attachments, [{ id: "active-existing" }]);
  assert.deepEqual(parseExtra(attachmentRowsAfterInactive[0]!.extra).attachments, [{ id: "active-existing" }]);
  assert.deepEqual(parseExtra(attachmentRowsAfterInactive[1]!.extra).attachments, [
    { id: "inactive-existing" },
    inactiveAttachment,
  ]);

  const activeAttachment = { id: "active-appended", kind: "image" };
  const activeAppendResult = await chats.appendAttachmentForSwipe(attachmentMessage.id, 0, activeAttachment);
  assert.deepEqual(activeAppendResult, { active: true });
  const attachmentEnvelopeAfterActive = await chats.getMessage(attachmentMessage.id);
  const attachmentRowsAfterActive = await chats.getSwipes(attachmentMessage.id);
  assert.ok(attachmentEnvelopeAfterActive);
  assert.deepEqual(parseExtra(attachmentEnvelopeAfterActive.extra).attachments, [
    { id: "active-existing" },
    activeAttachment,
  ]);
  assert.deepEqual(
    parseExtra(attachmentRowsAfterActive[0]!.extra).attachments,
    parseExtra(attachmentEnvelopeAfterActive.extra).attachments,
  );
  assert.deepEqual(
    parseExtra(attachmentRowsAfterActive[0]!.extra),
    parseExtra(attachmentEnvelopeAfterActive.extra),
    "an active exact-swipe attachment append must leave one canonical complete extra on row and envelope",
  );

  const storyboardRemovalMessage = await chats.createMessage({
    chatId: chat.id,
    role: "narrator",
    characterId: "leo",
    content: "storyboard swipe zero",
  });
  assert.ok(storyboardRemovalMessage);
  await chats.addSwipe(storyboardRemovalMessage.id, "storyboard swipe one");
  await chats.addSwipe(storyboardRemovalMessage.id, "storyboard swipe two");
  const storyboardStore = createGameStoryboardsStorage(regressionDb);
  const storyboardZero = await storyboardStore.create({
    chatId: chat.id,
    messageId: storyboardRemovalMessage.id,
    swipeIndex: 0,
    sourceNarration: "storyboard zero",
    sourceNarrationHash: "storyboard-zero-hash",
    status: "complete",
  });
  const storyboardOne = await storyboardStore.create({
    chatId: chat.id,
    messageId: storyboardRemovalMessage.id,
    swipeIndex: 1,
    sourceNarration: "storyboard one",
    sourceNarrationHash: "storyboard-one-hash",
    status: "complete",
  });
  const storyboardTwo = await storyboardStore.create({
    chatId: chat.id,
    messageId: storyboardRemovalMessage.id,
    swipeIndex: 2,
    sourceNarration: "storyboard two",
    sourceNarrationHash: "storyboard-two-hash",
    status: "complete",
  });
  assert.ok(storyboardZero);
  assert.ok(storyboardOne);
  assert.ok(storyboardTwo);
  await storyboardStore.replaceKeyframes(storyboardZero.id, [
    {
      index: 0,
      title: "removed keyframe",
      narrationBeat: "must be removed with storyboard zero",
    },
  ]);
  const [removedStoryboardKeyframe] = await storyboardStore.listKeyframes(storyboardZero.id);
  assert.ok(removedStoryboardKeyframe);

  const storyboardEnvelopeAfterRemoval = await chats.removeSwipe(storyboardRemovalMessage.id, 0);
  assert.ok(storyboardEnvelopeAfterRemoval);
  assert.equal(storyboardEnvelopeAfterRemoval.activeSwipeIndex, 1);
  assert.equal(storyboardEnvelopeAfterRemoval.content, "storyboard swipe two");
  assert.deepEqual(
    (await chats.getSwipes(storyboardRemovalMessage.id)).map((swipe) => [swipe.index, swipe.content]),
    [
      [0, "storyboard swipe one"],
      [1, "storyboard swipe two"],
    ],
  );
  assert.equal(await storyboardStore.getById(storyboardZero.id), null);
  assert.deepEqual(await storyboardStore.listKeyframes(storyboardZero.id), []);
  assert.equal(
    (
      await regressionDb
        .select()
        .from(gameTurnStoryboardKeyframes)
        .where(eq(gameTurnStoryboardKeyframes.id, removedStoryboardKeyframe.id))
    ).length,
    0,
  );
  assert.equal((await storyboardStore.getById(storyboardOne.id))?.swipeIndex, 0);
  assert.equal((await storyboardStore.getById(storyboardTwo.id))?.swipeIndex, 1);
  const survivingStoryboardRows = await regressionDb
    .select()
    .from(gameTurnStoryboards)
    .where(eq(gameTurnStoryboards.messageId, storyboardRemovalMessage.id));
  assert.deepEqual(
    survivingStoryboardRows
      .map((row) => [row.id, row.swipeIndex])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    [
      [storyboardOne.id, 0],
      [storyboardTwo.id, 1],
    ].sort(([left], [right]) => String(left).localeCompare(String(right))),
  );

  const portableImport = await importSTChat(
    [
      JSON.stringify({ user_name: "Tester", character_name: "Portable cast" }),
      JSON.stringify({
        name: "Leo",
        is_user: false,
        role: "assistant",
        character_id: "leo",
        mes: "active Dan export",
        swipes: ["Leo export", "active Dan export"],
        swipe_id: 1,
        extra: {
          generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
          swipeCharacterId: "leo",
          marinara_role: "assistant",
          marinara_character_id: "leo",
          marinara_swipes: [
            {
              index: 0,
              extra: {
                generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } },
                swipeCharacterId: "leo",
              },
            },
            {
              index: 1,
              extra: {
                generationReplay: {
                  conversationScope: { mode: "focused", characterId: "dan" },
                  generationGuide: "must be discarded",
                },
                swipeCharacterId: "dan",
                cachedPrompt: "must be discarded",
              },
            },
          ],
        },
      }),
    ].join("\n"),
    await dbModule.getDB(),
    { mode: "conversation", characterIds: ["leo", "dan"] },
  );
  assert.equal(portableImport.success, true);
  assert.ok(portableImport.chatId);
  const [portableImportedMessage] = await chats.listMessages(portableImport.chatId);
  assert.ok(portableImportedMessage);
  assert.equal(portableImportedMessage.characterId, "dan");
  const portableImportedSwipes = await chats.getSwipes(portableImportedMessage.id);
  assert.deepEqual(readConversationScope(portableImportedSwipes[0]!), { mode: "focused", characterId: "leo" });
  assert.deepEqual(readConversationScope(portableImportedSwipes[1]!), { mode: "focused", characterId: "dan" });
  assert.equal(readSwipeCharacterId(portableImportedSwipes[1]!), "dan");
  assert.equal(parseExtra(portableImportedSwipes[1]!.extra).cachedPrompt, undefined);
  assert.equal(
    (parseExtra(portableImportedSwipes[1]!.extra).generationReplay as Record<string, unknown>).generationGuide,
    undefined,
  );

  const unknownAttributionImport = await importSTChat(
    [
      JSON.stringify({ user_name: "Tester", character_name: "Attribution cast" }),
      JSON.stringify({
        name: "Leo",
        is_user: false,
        role: "assistant",
        character_id: "foreign-character",
        mes: "must fall back to the roster speaker",
      }),
    ].join("\n"),
    await dbModule.getDB(),
    {
      mode: "conversation",
      characterIds: ["leo", "dan"],
      speakerMap: { Leo: "leo" },
    },
  );
  assert.equal(unknownAttributionImport.success, true);
  assert.ok(unknownAttributionImport.chatId);
  const [unknownAttributionMessage] = await chats.listMessages(unknownAttributionImport.chatId);
  assert.ok(unknownAttributionMessage);
  assert.equal(
    unknownAttributionMessage.characterId,
    "leo",
    "an imported top-level character ID outside the roster must not override a trusted speaker mapping",
  );
  const [unknownAttributionSwipe] = await chats.getSwipes(unknownAttributionMessage.id);
  assert.ok(unknownAttributionSwipe);
  assert.equal(readSwipeCharacterId(unknownAttributionSwipe), "leo");
  assert.doesNotMatch(JSON.stringify(unknownAttributionSwipe.extra), /foreign-character/);

  const staleEnvelopeMessage = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: "leo",
    content: "stale envelope response",
    extra: { generationReplay: { conversationScope: { mode: "focused", characterId: "leo" } } },
  });
  assert.ok(staleEnvelopeMessage);
  await chats.updateSwipeExtra(staleEnvelopeMessage.id, 0, {
    generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } },
    swipeCharacterId: "dan",
  });
  const staleEnvelope = await chats.getMessage(staleEnvelopeMessage.id);
  assert.ok(staleEnvelope);
  assert.deepEqual(readConversationScope(staleEnvelope), { mode: "focused", characterId: "leo" });

  const authoritativeActiveSwipe = await chats.getMessageWithActiveSwipe(staleEnvelopeMessage.id);
  assert.ok(authoritativeActiveSwipe);
  assert.deepEqual(
    readConversationScope(authoritativeActiveSwipe),
    { mode: "focused", characterId: "dan" },
    "the selected swipe must win over a stale message envelope",
  );

  const staleAttributionManualSwipe = await chats.addSwipe(
    staleEnvelopeMessage.id,
    "manual response inheriting the active swipe speaker",
  );
  const staleAttributionManualRow = (await chats.getSwipes(staleEnvelopeMessage.id)).find(
    (swipe) => swipe.index === staleAttributionManualSwipe.index,
  );
  assert.ok(staleAttributionManualRow);
  assert.equal(
    readSwipeCharacterId(staleAttributionManualRow),
    "dan",
    "manual swipe creation must inherit attribution from the authoritative active swipe, not a stale envelope",
  );
  const staleAttributionManualMessage = await chats.getMessage(staleEnvelopeMessage.id);
  assert.ok(staleAttributionManualMessage);
  assert.equal(staleAttributionManualMessage.characterId, "dan");

  await chats.setActiveSwipe(staleEnvelopeMessage.id, 0);

  await chats.addSwipe(staleEnvelopeMessage.id, "new merged response", false, {
    generationReplay: { conversationScope: { mode: "merged" } },
  });
  const preservedOldSwipe = (await chats.getSwipes(staleEnvelopeMessage.id)).find((swipe) => swipe.index === 0);
  assert.ok(preservedOldSwipe);
  assert.deepEqual(
    readConversationScope(preservedOldSwipe),
    { mode: "focused", characterId: "dan" },
    "adding a swipe must not backfill stale envelope scope over the previous active swipe",
  );

  await chats.updateSwipeExtra(staleEnvelopeMessage.id, 1, {
    generationReplay: { conversationScope: { mode: "focused", characterId: "dan" } },
  });
  await chats.setActiveSwipe(staleEnvelopeMessage.id, 0);
  const preservedOutgoingSwipe = (await chats.getSwipes(staleEnvelopeMessage.id)).find((swipe) => swipe.index === 1);
  assert.ok(preservedOutgoingSwipe);
  assert.deepEqual(
    readConversationScope(preservedOutgoingSwipe),
    { mode: "focused", characterId: "dan" },
    "switching swipes must not backfill stale envelope scope over the outgoing swipe",
  );

  const [sameIndexMessageId] = await chats.createMessagesBatch(chat.id, [
    {
      role: "assistant",
      characterId: "leo",
      content: "fresh selected swipe content",
      activeSwipeIndex: 0,
      swipes: [{ index: 0, content: "fresh selected swipe content", extra: { swipeCharacterId: "leo" } }],
    },
  ]);
  assert.ok(sameIndexMessageId);
  await regressionDb
    .update(messages)
    .set({ content: "stale envelope content" })
    .where(eq(messages.id, sameIndexMessageId));
  const sameIndexResult = await chats.setActiveSwipe(sameIndexMessageId, 0);
  assert.ok(sameIndexResult);
  assert.equal(
    sameIndexResult.content,
    "fresh selected swipe content",
    "selecting the already-active swipe must restore the authoritative swipe over a stale envelope",
  );
  const [sameIndexSwipe] = await chats.getSwipes(sameIndexMessageId);
  assert.ok(sameIndexSwipe);
  assert.equal(sameIndexSwipe.content, "fresh selected swipe content");

  const routeGuardChat = await chats.create({
    name: "Swipe route ownership A",
    mode: "conversation",
    characterIds: ["leo", "dan"],
  });
  const mismatchedUrlChat = await chats.create({
    name: "Swipe route ownership B",
    mode: "conversation",
    characterIds: ["leo", "dan"],
  });
  const routeGuardMessage = await chats.createMessage({
    chatId: routeGuardChat.id,
    role: "assistant",
    characterId: "leo",
    content: "route guard original",
  });
  assert.ok(routeGuardMessage);
  await chats.addSwipe(routeGuardMessage.id, "route guard alternate", true, undefined, "dan");

  const macroLeo = await characterStore.create({ name: "Leo" } as any);
  const macroDan = await characterStore.create({ name: "Dan" } as any);
  assert.ok(macroLeo);
  assert.ok(macroDan);
  const macroC = await characterStore.create({ name: "C", description: "C description" } as any);
  const macroA = await characterStore.create({ name: "A", description: "A description" } as any);
  const macroB = await characterStore.create({ name: "B", description: "B description" } as any);
  assert.ok(macroC);
  assert.ok(macroA);
  assert.ok(macroB);
  const restrictedMacroContext = await buildPromptMacroContext({
    db: regressionDb,
    characterIds: [macroC.id, macroA.id, macroB.id],
    primaryCharacterId: macroA.id,
    personaName: "User",
  });
  assert.equal(restrictedMacroContext.char, "A");
  assert.equal(restrictedMacroContext.characterFields?.description, "A description");
  assert.deepEqual(
    restrictedMacroContext.characters,
    ["C", "A", "B"],
    "restricted macro primary selection must preserve the full roster list",
  );
  const macroExportChat = await chats.create({
    name: "Per-swipe macro attribution",
    mode: "conversation",
    characterIds: [macroLeo.id, macroDan.id],
  });
  await chats.patchMetadata(macroExportChat.id, { inactiveCharacterIds: [macroDan.id] });
  const [macroExportMessageId] = await chats.createMessagesBatch(macroExportChat.id, [
    {
      role: "assistant",
      characterId: macroLeo.id,
      content: "stale envelope {{char}}",
      activeSwipeIndex: 0,
      extra: {
        cachedPrompt: [{ role: "system", content: "stale Leo prompt" }],
        displayLabel: "stale envelope metadata",
        generationReplay: { conversationScope: { mode: "focused", characterId: macroLeo.id } },
        reasoning: "stale Leo reasoning",
      },
      swipes: [
        {
          index: 0,
          content: "active {{char}}",
          extra: {
            cachedPrompt: [{ role: "system", content: "active Dan prompt" }],
            displayLabel: "active swipe metadata",
            generationReplay: { conversationScope: { mode: "focused", characterId: macroLeo.id } },
            reasoning: "active Dan reasoning",
          },
        },
        {
          index: 1,
          content: "inactive {{char}}",
          extra: {
            generationReplay: { conversationScope: { mode: "focused", characterId: macroLeo.id } },
            swipeCharacterId: macroLeo.id,
          },
        },
      ],
    },
  ]);
  assert.ok(macroExportMessageId);
  const macroExportMessage = await chats.getMessage(macroExportMessageId);
  assert.ok(macroExportMessage);
  await chats.updateSwipeExtra(macroExportMessage.id, 0, {
    cachedPrompt: [{ role: "system", content: "active Dan prompt" }],
    displayLabel: "active swipe metadata",
    generationReplay: { conversationScope: { mode: "focused", characterId: macroDan.id } },
    reasoning: "active Dan reasoning",
    swipeCharacterId: macroDan.id,
  });
  await regressionDb
    .update(messages)
    .set({
      characterId: macroLeo.id,
      content: "stale envelope {{char}}",
      extra: JSON.stringify({
        cachedPrompt: [{ role: "system", content: "stale Leo prompt" }],
        displayLabel: "stale envelope metadata",
        generationReplay: { conversationScope: { mode: "focused", characterId: macroLeo.id } },
        reasoning: "stale Leo reasoning",
      }),
    })
    .where(eq(messages.id, macroExportMessage.id));
  const staleMacroEnvelope = await chats.getMessage(macroExportMessage.id);
  assert.ok(staleMacroEnvelope);
  assert.equal(staleMacroEnvelope.characterId, macroLeo.id);
  assert.equal(staleMacroEnvelope.content, "stale envelope {{char}}");
  const authoritativeMacroSwipe = await chats.getMessageWithActiveSwipe(macroExportMessage.id);
  assert.ok(authoritativeMacroSwipe);
  assert.equal(authoritativeMacroSwipe.characterId, macroDan.id);
  assert.equal(authoritativeMacroSwipe.content, "active {{char}}");
  const exactMacroSwipe = await chats.getMessageWithSwipe(macroExportMessage.id, 0);
  assert.ok(exactMacroSwipe);
  assert.equal(exactMacroSwipe.content, "active {{char}}");
  assert.equal(exactMacroSwipe.characterId, macroDan.id);
  assert.equal(await chats.getMessageWithSwipe(macroExportMessage.id, 99), null);

  const swipeCasChat = await chats.create({
    name: "Swipe content compare-and-set",
    mode: "game",
    characterIds: [macroLeo.id, macroDan.id],
  });
  const [swipeCasMessageId] = await chats.createMessagesBatch(swipeCasChat.id, [
    {
      role: "narrator",
      characterId: macroLeo.id,
      content: "stale CAS envelope",
      activeSwipeIndex: 0,
      swipes: [{ index: 0, content: "active CAS content", extra: { swipeCharacterId: macroDan.id } }],
    },
  ]);
  assert.ok(swipeCasMessageId);
  const activeMacroContent = "active CAS content";
  const staleSkillWrite = await chats.updateMessageContentForSwipe(swipeCasMessageId, 0, "must not commit", {
    requireActive: true,
    expectedContent: "stale CAS envelope",
  });
  assert.equal(staleSkillWrite.status, "conflict");
  assert.equal((await chats.getMessageWithSwipe(swipeCasMessageId, 0))?.content, activeMacroContent);
  const committedSkillWrite = await chats.updateMessageContentForSwipe(
    swipeCasMessageId,
    0,
    "active CAS content [resolved]",
    { requireActive: true, expectedContent: activeMacroContent },
  );
  assert.equal(committedSkillWrite.status, "updated");
  assert.equal((await chats.getMessageWithSwipe(swipeCasMessageId, 0))?.content, "active CAS content [resolved]");

  const casRollbackMessage = await chats.createMessage({
    chatId: swipeCasChat.id,
    role: "narrator",
    characterId: macroLeo.id,
    content: "CAS rollback original",
  });
  assert.ok(casRollbackMessage);
  let injectEnvelopeWriteFailure = true;
  const faultInjectedDb = new Proxy(regressionDb, {
    get(target, property, receiver) {
      if (property !== "transaction") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (operation: (tx: unknown) => Promise<unknown>) =>
        target.transaction(async (tx) => {
          const faultInjectedTx = new Proxy(tx, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty === "update") {
                return (table: unknown) => {
                  if (injectEnvelopeWriteFailure && table === messages) {
                    injectEnvelopeWriteFailure = false;
                    throw new Error("injected active envelope CAS write failure");
                  }
                  return txTarget.update(table as never);
                };
              }
              const value = Reflect.get(txTarget, txProperty, txReceiver);
              return typeof value === "function" ? value.bind(txTarget) : value;
            },
          });
          return operation(faultInjectedTx);
        });
    },
  }) as typeof regressionDb;
  const faultInjectedChats = createChatsStorage(faultInjectedDb);
  await assert.rejects(
    () =>
      faultInjectedChats.updateMessageContentForSwipe(
        casRollbackMessage.id,
        0,
        "CAS rollback must not partially commit",
        { requireActive: true, expectedContent: "CAS rollback original" },
      ),
    /injected active envelope CAS write failure/,
  );
  const casEnvelopeAfterRollback = await chats.getMessage(casRollbackMessage.id);
  const [casSwipeAfterRollback] = await chats.getSwipes(casRollbackMessage.id);
  assert.ok(casEnvelopeAfterRollback);
  assert.ok(casSwipeAfterRollback);
  assert.equal(casEnvelopeAfterRollback.content, "CAS rollback original");
  assert.equal(casSwipeAfterRollback.content, "CAS rollback original");

  const rawMacroHistory = await chats.listMessages(macroExportChat.id);
  const rawMacroHistoryMessage = rawMacroHistory.find((message) => message.id === macroExportMessage.id);
  assert.ok(rawMacroHistoryMessage);
  assert.equal(rawMacroHistoryMessage.content, "stale envelope {{char}}");
  assert.equal(rawMacroHistoryMessage.characterId, macroLeo.id);
  const authoritativeMacroHistory = await chats.listMessagesWithActiveSwipes(macroExportChat.id);
  const authoritativeMacroHistoryMessage = authoritativeMacroHistory.find(
    (message) => message.id === macroExportMessage.id,
  );
  assert.ok(authoritativeMacroHistoryMessage);
  assert.equal(authoritativeMacroHistoryMessage.activeSwipeFound, true);
  assert.equal(authoritativeMacroHistoryMessage.content, "active {{char}}");
  assert.equal(authoritativeMacroHistoryMessage.characterId, macroDan.id);
  assert.equal(JSON.parse(authoritativeMacroHistoryMessage.extra as string).displayLabel, "active swipe metadata");
  const rawPaginatedMacroHistory = await chats.listMessagesPaginated(macroExportChat.id, 20);
  const rawPaginatedMacroMessage = rawPaginatedMacroHistory.find((message) => message.id === macroExportMessage.id);
  assert.ok(rawPaginatedMacroMessage);
  assert.equal(rawPaginatedMacroMessage.content, "stale envelope {{char}}");
  assert.equal(rawPaginatedMacroMessage.characterId, macroLeo.id);
  const authoritativePaginatedMacroHistory = await chats.listMessagesPaginatedWithActiveSwipes(macroExportChat.id, 20);
  const authoritativePaginatedMacroMessage = authoritativePaginatedMacroHistory.find(
    (message) => message.id === macroExportMessage.id,
  );
  assert.ok(authoritativePaginatedMacroMessage);
  assert.equal(authoritativePaginatedMacroMessage.activeSwipeFound, true);
  assert.equal(authoritativePaginatedMacroMessage.content, "active {{char}}");
  assert.equal(authoritativePaginatedMacroMessage.characterId, macroDan.id);
  assert.equal(JSON.parse(authoritativePaginatedMacroMessage.extra as string).displayLabel, "active swipe metadata");

  const mariTranscriptResult = await new MariDbService(regressionDb).executeCli({
    argv: ["chats", "messages", macroExportChat.id, "--tail", "--limit", "20"],
  });
  assert.equal(mariTranscriptResult.ok, true);
  const mariTranscript = mariTranscriptResult.output as Array<Record<string, unknown>>;
  const mariTranscriptMessage = mariTranscript.find((message) => message.id === macroExportMessage.id);
  assert.ok(mariTranscriptMessage);
  assert.equal(mariTranscriptMessage.content, "active {{char}}");
  assert.equal(mariTranscriptMessage.characterId, macroDan.id);
  assert.doesNotMatch(JSON.stringify(mariTranscript), /stale envelope/);
  const macroLastContact = await chats.lastContactByCharacter(macroExportChat.id);
  assert.ok(macroLastContact[macroDan.id]);
  assert.equal(macroLastContact[macroLeo.id], undefined);
  const awarenessCurrentChat = await chats.create({
    name: "Awareness active-swipe consumer",
    mode: "conversation",
    characterIds: [macroDan.id],
  });
  const awarenessBlock = await buildAwarenessBlock(
    regressionDb,
    awarenessCurrentChat.id,
    [macroDan.id],
    new Map([
      [macroLeo.id, "Leo"],
      [macroDan.id, "Dan"],
    ]),
    "User",
    "recently",
    4000,
  );
  assert.ok(awarenessBlock);
  assert.match(awarenessBlock, /Dan: active \{\{char\}\}/);
  assert.doesNotMatch(awarenessBlock, /stale envelope/);

  const capabilityMessages = await createCapabilityPersistenceHost(regressionDb).listMessages(macroExportChat.id);
  const capabilityMacroMessage = capabilityMessages.find((message) => message.id === macroExportMessage.id);
  assert.ok(capabilityMacroMessage);
  assert.equal(capabilityMacroMessage.content, "active {{char}}");
  assert.equal(capabilityMacroMessage.characterId, macroDan.id);

  const memoryAuthorityChat = await chats.create({
    name: "Memory active-swipe consumer",
    mode: "conversation",
    characterIds: [macroLeo.id, macroDan.id],
  });
  await chats.createMessagesBatch(
    memoryAuthorityChat.id,
    Array.from({ length: 5 }, (_, index) => ({
      role: "assistant" as const,
      characterId: macroLeo.id,
      content: `stale memory ${index + 1}`,
      activeSwipeIndex: 0,
      swipes: [
        {
          index: 0,
          content: `active memory ${index + 1}`,
          extra: { swipeCharacterId: macroDan.id },
        },
      ],
    })),
  );
  await chunkAndEmbedMessages(
    regressionDb,
    memoryAuthorityChat.id,
    { userName: "User", characterNames: { [macroLeo.id]: "Leo", [macroDan.id]: "Dan" } },
    {
      embeddingSource: {
        label: "conversation-scope-regression",
        embed: async (texts) => texts.map(() => [1, 0]),
      },
    },
  );
  const storedMemoryRows = await regressionDb
    .select({ content: memoryChunks.content })
    .from(memoryChunks)
    .where(eq(memoryChunks.chatId, memoryAuthorityChat.id));
  assert.equal(storedMemoryRows.length, 1);
  assert.match(storedMemoryRows[0]!.content, /Dan: active memory 1/);
  assert.doesNotMatch(storedMemoryRows[0]!.content, /stale memory|Leo:/);

  const missingActiveHistoryChat = await chats.create({
    name: "Missing selected swipe history fallback",
    mode: "conversation",
    characterIds: [macroLeo.id, macroDan.id],
  });
  const [missingActiveHistoryMessageId] = await chats.createMessagesBatch(missingActiveHistoryChat.id, [
    {
      role: "assistant",
      characterId: macroLeo.id,
      content: "damaged envelope fallback",
      activeSwipeIndex: 7,
      swipes: [{ index: 0, content: "unselected row", extra: { swipeCharacterId: macroDan.id } }],
    },
  ]);
  assert.ok(missingActiveHistoryMessageId);
  const missingActiveHistory = (await chats.listMessagesWithActiveSwipes(missingActiveHistoryChat.id)).find(
    (message) => message.id === missingActiveHistoryMessageId,
  );
  assert.ok(missingActiveHistory);
  assert.equal(missingActiveHistory.activeSwipeFound, false);
  assert.equal(missingActiveHistory.content, "damaged envelope fallback");
  assert.equal(missingActiveHistory.characterId, macroLeo.id);

  const missingActivePromptCacheChat = await chats.create({
    name: "Selected swipe prompt cache authority",
    mode: "conversation",
    characterIds: [macroLeo.id, macroDan.id],
  });
  const [missingActivePromptCacheMessageId] = await chats.createMessagesBatch(missingActivePromptCacheChat.id, [
    {
      role: "assistant",
      characterId: macroLeo.id,
      content: "selected swipe has no prompt cache",
      activeSwipeIndex: 0,
      extra: { cachedPrompt: [{ role: "system", content: "stale envelope cache" }] },
      swipes: [
        { index: 0, content: "selected swipe has no prompt cache", extra: { swipeCharacterId: macroDan.id } },
        {
          index: 1,
          content: "inactive swipe has a cache",
          extra: {
            cachedPrompt: [{ role: "system", content: "inactive swipe cache" }],
            swipeCharacterId: macroLeo.id,
          },
        },
      ],
    },
  ]);
  assert.ok(missingActivePromptCacheMessageId);
  const missingActivePromptCacheSwipe = (await chats.getSwipes(missingActivePromptCacheMessageId)).find(
    (swipe) => swipe.index === 0,
  );
  assert.ok(missingActivePromptCacheSwipe);
  await regressionDb
    .update(messageSwipes)
    .set({ extra: JSON.stringify({ swipeCharacterId: macroDan.id }) })
    .where(eq(messageSwipes.id, missingActivePromptCacheSwipe.id));
  await regressionDb
    .update(messages)
    .set({ extra: JSON.stringify({ cachedPrompt: [{ role: "system", content: "stale envelope cache" }] }) })
    .where(eq(messages.id, missingActivePromptCacheMessageId));

  const missingRegistryApp = Fastify({ logger: false });
  missingRegistryApp.decorate("db", await dbModule.getDB());
  missingRegistryApp.register(chatsRoutes, { prefix: "/api/chats" });
  await assert.rejects(
    () => missingRegistryApp.ready(),
    /active generation registry is not initialized/i,
    "the chats plugin must fail closed when its shared parent registry is absent",
  );
  await missingRegistryApp.close();

  const missingRetryRegistryApp = Fastify({ logger: false });
  missingRetryRegistryApp.decorate("db", await dbModule.getDB());
  missingRetryRegistryApp.register(registerRetryAgentsRoute, { prefix: "/api/generate" });
  await assert.rejects(
    () => missingRetryRegistryApp.ready(),
    /active generation registry is not initialized/i,
    "the retry route must fail closed when its shared parent registry is absent",
  );
  await missingRetryRegistryApp.close();

  const routeRegistry = createActiveGenerationRegistry();
  const routeApp = Fastify({ logger: false });
  routeApp.decorate("db", await dbModule.getDB());
  routeApp.decorate("activeGenerations", routeRegistry);
  await routeApp.register(chatsRoutes, { prefix: "/api/chats" });
  await routeApp.ready();
  try {
    const rosterMutationChat = await chats.create({
      name: "Roster mutation lease integration",
      mode: "conversation",
      characterIds: ["leo", "dan"],
    });
    const rosterGenerationController = new AbortController();
    const rosterGenerationLease = acquireActiveGenerationLease(
      routeRegistry,
      rosterMutationChat.id,
      rosterGenerationController,
    );
    assert.ok(rosterGenerationLease);
    const blockedRosterPatch = await routeApp.inject({
      method: "PATCH",
      url: `/api/chats/${rosterMutationChat.id}`,
      payload: { characterIds: ["dan"] },
    });
    assert.equal(blockedRosterPatch.statusCode, 409);
    assert.equal(rosterGenerationController.signal.aborted, false);
    const rosterAfterBlockedPatch = await chats.getById(rosterMutationChat.id);
    assert.ok(rosterAfterBlockedPatch);
    assert.deepEqual(JSON.parse(rosterAfterBlockedPatch.characterIds as string), ["leo", "dan"]);
    assert.equal(rosterGenerationLease.release(), true);

    const successfulRosterPatch = await routeApp.inject({
      method: "PATCH",
      url: `/api/chats/${rosterMutationChat.id}`,
      payload: { characterIds: ["dan"] },
    });
    assert.equal(successfulRosterPatch.statusCode, 200);
    const rosterAfterSuccessfulPatch = await chats.getById(rosterMutationChat.id);
    assert.ok(rosterAfterSuccessfulPatch);
    assert.deepEqual(JSON.parse(rosterAfterSuccessfulPatch.characterIds as string), ["dan"]);

    const modeGenerationController = new AbortController();
    const modeGenerationLease = acquireActiveGenerationLease(
      routeRegistry,
      rosterMutationChat.id,
      modeGenerationController,
    );
    assert.ok(modeGenerationLease);
    const blockedModePatch = await routeApp.inject({
      method: "PATCH",
      url: `/api/chats/${rosterMutationChat.id}`,
      payload: { mode: "roleplay" },
    });
    assert.equal(blockedModePatch.statusCode, 409);
    assert.equal(modeGenerationController.signal.aborted, false);
    assert.equal((await chats.getById(rosterMutationChat.id))?.mode, "conversation");
    assert.equal(modeGenerationLease.release(), true);

    const successfulModePatch = await routeApp.inject({
      method: "PATCH",
      url: `/api/chats/${rosterMutationChat.id}`,
      payload: { mode: "roleplay" },
    });
    assert.equal(successfulModePatch.statusCode, 200);
    assert.equal((await chats.getById(rosterMutationChat.id))?.mode, "roleplay");

    const inactiveRosterChat = await chats.create({
      name: "Inactive roster mutation lease integration",
      mode: "conversation",
      characterIds: ["leo", "dan"],
    });
    const inactiveRosterGenerationController = new AbortController();
    const inactiveRosterGenerationLease = acquireActiveGenerationLease(
      routeRegistry,
      inactiveRosterChat.id,
      inactiveRosterGenerationController,
    );
    assert.ok(inactiveRosterGenerationLease);
    const blockedInactiveRosterPatch = await routeApp.inject({
      method: "PATCH",
      url: `/api/chats/${inactiveRosterChat.id}/metadata`,
      payload: { inactiveCharacterIds: ["leo"] },
    });
    assert.equal(blockedInactiveRosterPatch.statusCode, 409);
    assert.equal(inactiveRosterGenerationController.signal.aborted, false);
    const inactiveRosterAfterBlockedPatch = await chats.getById(inactiveRosterChat.id);
    assert.ok(inactiveRosterAfterBlockedPatch);
    assert.equal(parseExtra(inactiveRosterAfterBlockedPatch.metadata).inactiveCharacterIds, undefined);
    assert.equal(inactiveRosterGenerationLease.release(), true);

    const successfulInactiveRosterPatch = await routeApp.inject({
      method: "PATCH",
      url: `/api/chats/${inactiveRosterChat.id}/metadata`,
      payload: { inactiveCharacterIds: ["leo"] },
    });
    assert.equal(successfulInactiveRosterPatch.statusCode, 200);
    const inactiveRosterAfterSuccessfulPatch = await chats.getById(inactiveRosterChat.id);
    assert.ok(inactiveRosterAfterSuccessfulPatch);
    assert.deepEqual(parseExtra(inactiveRosterAfterSuccessfulPatch.metadata).inactiveCharacterIds, ["leo"]);

    const beforeRouteGuardMessage = await chats.getMessage(routeGuardMessage.id);
    const beforeRouteGuardSwipes = await chats.getSwipes(routeGuardMessage.id);
    assert.ok(beforeRouteGuardMessage);
    const mismatchedBase = `/api/chats/${mismatchedUrlChat.id}/messages/${routeGuardMessage.id}`;
    for (const request of [
      { method: "POST", url: `${mismatchedBase}/swipes`, payload: { content: "must not be added" } },
      { method: "POST", url: `${mismatchedBase}/swipes/bulk`, payload: { contents: ["must not be bulk added"] } },
      { method: "DELETE", url: `${mismatchedBase}/swipes/1` },
      { method: "PUT", url: `${mismatchedBase}/active-swipe`, payload: { index: 1 } },
    ] as const) {
      const response = await routeApp.inject(request);
      assert.equal(
        response.statusCode,
        404,
        `${request.method} ${request.url} must reject cross-chat message ownership`,
      );
    }
    assert.deepEqual(await chats.getMessage(routeGuardMessage.id), beforeRouteGuardMessage);
    assert.deepEqual(await chats.getSwipes(routeGuardMessage.id), beforeRouteGuardSwipes);

    const heldRouteLease = acquireActiveGenerationLease(routeRegistry, routeGuardChat.id);
    assert.ok(heldRouteLease);
    const busyResponse = await routeApp.inject({
      method: "POST",
      url: `/api/chats/${routeGuardChat.id}/messages/${routeGuardMessage.id}/swipes`,
      payload: { content: "must be blocked while generation owns the chat" },
    });
    assert.equal(busyResponse.statusCode, 409);

    const busyMessageMutationRequests = [
      {
        method: "PATCH",
        url: `/api/chats/${routeGuardChat.id}/messages/${routeGuardMessage.id}`,
        payload: { content: "must not overwrite a continue snapshot" },
      },
      {
        method: "DELETE",
        url: `/api/chats/${routeGuardChat.id}/messages/${routeGuardMessage.id}`,
      },
      {
        method: "POST",
        url: `/api/chats/${routeGuardChat.id}/messages/bulk-delete`,
        payload: { messageIds: [routeGuardMessage.id] },
      },
    ] as const;
    for (const request of busyMessageMutationRequests) {
      const response = await routeApp.inject(request);
      assert.equal(
        response.statusCode,
        409,
        `${request.method} ${request.url} must not mutate a message while generation owns the chat`,
      );
    }
    const messageAfterBlockedMutations = await chats.getMessage(routeGuardMessage.id);
    assert.ok(messageAfterBlockedMutations);
    assert.equal(messageAfterBlockedMutations.content, "route guard original");
    assert.equal(heldRouteLease.release(), true);

    const deletingChat = await chats.create({
      name: "Deletion lease integration",
      mode: "conversation",
      characterIds: ["leo"],
    });
    const deletingController = new AbortController();
    const displacedGenerationLease = acquireActiveGenerationLease(routeRegistry, deletingChat.id, deletingController);
    assert.ok(displacedGenerationLease);
    const deleteResponse = await routeApp.inject({
      method: "DELETE",
      url: `/api/chats/${deletingChat.id}`,
    });
    assert.equal(deleteResponse.statusCode, 204);
    assert.equal(deletingController.signal.aborted, true);
    assert.equal(
      displacedGenerationLease.release(),
      false,
      "the deleted generation owner must not release the route-owned deletion tombstone",
    );
    assert.equal(routeRegistry.has(deletingChat.id), false);
    assert.equal(await chats.getById(deletingChat.id), null);

    const deletingGroupId = "group-deletion-lease-integration";
    const deletingGroupChatA = await chats.create({
      name: "Group deletion lease A",
      mode: "conversation",
      characterIds: ["leo"],
      groupId: deletingGroupId,
    });
    const deletingGroupChatB = await chats.create({
      name: "Group deletion lease B",
      mode: "conversation",
      characterIds: ["dan"],
      groupId: deletingGroupId,
    });
    const groupControllerA = new AbortController();
    const groupControllerB = new AbortController();
    const displacedGroupLeaseA = acquireActiveGenerationLease(routeRegistry, deletingGroupChatA.id, groupControllerA);
    const displacedGroupLeaseB = acquireActiveGenerationLease(routeRegistry, deletingGroupChatB.id, groupControllerB);
    assert.ok(displacedGroupLeaseA);
    assert.ok(displacedGroupLeaseB);
    const deleteGroupResponse = await routeApp.inject({
      method: "DELETE",
      url: `/api/chats/group/${deletingGroupId}`,
    });
    assert.equal(deleteGroupResponse.statusCode, 204);
    assert.equal(groupControllerA.signal.aborted, true);
    assert.equal(groupControllerB.signal.aborted, true);
    assert.equal(displacedGroupLeaseA.release(), false);
    assert.equal(displacedGroupLeaseB.release(), false);
    assert.equal(routeRegistry.has(deletingGroupChatA.id), false);
    assert.equal(routeRegistry.has(deletingGroupChatB.id), false);
    assert.equal(await chats.getById(deletingGroupChatA.id), null);
    assert.equal(await chats.getById(deletingGroupChatB.id), null);

    const blockedGroupId = "group-deletion-existing-tombstone";
    const blockedGroupChatA = await chats.create({
      name: "Blocked group deletion A",
      mode: "conversation",
      characterIds: ["leo"],
      groupId: blockedGroupId,
    });
    const blockedGroupChatB = await chats.create({
      name: "Blocked group deletion B",
      mode: "conversation",
      characterIds: ["dan"],
      groupId: blockedGroupId,
    });
    const blockedGroupGenerationController = new AbortController();
    const blockedGroupGenerationLease = acquireActiveGenerationLease(
      routeRegistry,
      blockedGroupChatA.id,
      blockedGroupGenerationController,
    );
    const existingGroupDeletionLease = takeOverActiveGenerationLease(routeRegistry, blockedGroupChatB.id);
    assert.ok(blockedGroupGenerationLease);
    assert.ok(existingGroupDeletionLease);
    const blockedGroupDeleteResponse = await routeApp.inject({
      method: "DELETE",
      url: `/api/chats/group/${blockedGroupId}`,
    });
    assert.equal(blockedGroupDeleteResponse.statusCode, 409);
    assert.equal(
      blockedGroupGenerationController.signal.aborted,
      false,
      "a failed group takeover must not partially abort another member's generation",
    );
    assert.ok(await chats.getById(blockedGroupChatA.id));
    assert.ok(await chats.getById(blockedGroupChatB.id));
    assert.equal(blockedGroupGenerationLease.release(), true);
    assert.equal(existingGroupDeletionLease.release(), true);

    const driftingGroupId = "group-deletion-membership-drift";
    const driftingGroupChatA = await chats.create({
      name: "Group deletion drift A",
      mode: "conversation",
      characterIds: ["leo"],
      groupId: driftingGroupId,
    });
    const expectedDriftingIds = [driftingGroupChatA.id];
    const driftingGroupChatB = await chats.create({
      name: "Group deletion drift B",
      mode: "conversation",
      characterIds: ["dan"],
      groupId: driftingGroupId,
    });
    assert.equal(
      await chats.removeGroup(driftingGroupId, expectedDriftingIds),
      false,
      "a fresh group member must fail closed before any storage mutation",
    );
    assert.ok(await chats.getById(driftingGroupChatA.id));
    assert.ok(await chats.getById(driftingGroupChatB.id));

    const macroPromptResponse = await routeApp.inject({
      method: "POST",
      url: `/api/chats/${macroExportChat.id}/peek-prompt`,
      payload: { messageId: macroExportMessage.id },
    });
    assert.equal(macroPromptResponse.statusCode, 200);
    const macroPrompt = macroPromptResponse.json();
    assert.equal(macroPrompt.source, "cached");
    assert.equal(macroPrompt.exact, true);
    assert.deepEqual(macroPrompt.messages, [{ role: "system", content: "active Dan prompt" }]);
    assert.doesNotMatch(JSON.stringify(macroPrompt), /stale Leo prompt/);

    const missingActivePromptCacheResponse = await routeApp.inject({
      method: "POST",
      url: `/api/chats/${missingActivePromptCacheChat.id}/peek-prompt`,
      payload: { messageId: missingActivePromptCacheMessageId },
    });
    assert.equal(missingActivePromptCacheResponse.statusCode, 404);
    assert.doesNotMatch(missingActivePromptCacheResponse.body, /stale envelope cache|inactive swipe cache/);

    const macroTextExportResponse = await routeApp.inject({
      method: "GET",
      url: `/api/chats/${macroExportChat.id}/export?format=text`,
    });
    assert.equal(macroTextExportResponse.statusCode, 200);
    assert.match(macroTextExportResponse.body, /\[Dan\]/);
    assert.match(macroTextExportResponse.body, /active Dan/);
    assert.doesNotMatch(macroTextExportResponse.body, /\[Leo\]/);
    assert.doesNotMatch(macroTextExportResponse.body, /stale envelope/);

    const macroExportResponse = await routeApp.inject({
      method: "GET",
      url: `/api/chats/${macroExportChat.id}/export?format=jsonl&includeReasoning=true`,
    });
    assert.equal(macroExportResponse.statusCode, 200);
    const macroExportLines = macroExportResponse.body.trim().split("\n").map(JSON.parse);
    assert.equal(macroExportLines.length, 2);
    assert.equal(macroExportLines[1].name, "Dan");
    assert.equal(macroExportLines[1].character_id, macroDan.id);
    assert.equal(macroExportLines[1].mes, "active Dan");
    assert.equal(macroExportLines[1].reasoning_content, "active Dan reasoning");
    assert.doesNotMatch(JSON.stringify(macroExportLines[1]), /stale Leo reasoning/);
    assert.equal(macroExportLines[1].extra.marinara_character_id, macroDan.id);
    assert.deepEqual(macroExportLines[1].swipes, ["active Dan", "inactive Leo"]);
    assert.deepEqual(
      macroExportLines[1].extra.marinara_swipes.map((swipe: any) => swipe.extra.swipeCharacterId),
      [macroDan.id, macroLeo.id],
    );
    assert.equal(
      macroExportLines[1].extra.marinara_swipes[0].extra.displayLabel,
      "active swipe metadata",
      "JSONL active-swipe metadata must come from the sanitized active swipe, not the stale envelope",
    );
    assert.equal(
      macroExportLines[1].extra.displayLabel,
      "active swipe metadata",
      "JSONL top-level metadata must mirror the exported active swipe",
    );
    assert.doesNotMatch(
      JSON.stringify(macroExportLines[1].extra),
      /stale envelope metadata/,
      "JSONL export must not retain stale envelope metadata in either the top-level or per-swipe extras",
    );

    const macroBranchResponse = await routeApp.inject({
      method: "POST",
      url: `/api/chats/${macroExportChat.id}/branch`,
      payload: {},
    });
    assert.equal(macroBranchResponse.statusCode, 200);
    const macroBranch = macroBranchResponse.json();
    const [macroBranchMessage] = await chats.listMessages(macroBranch.id);
    assert.ok(macroBranchMessage);
    assert.equal(macroBranchMessage.content, "active {{char}}");
    assert.equal(macroBranchMessage.characterId, macroDan.id);
    const macroBranchSwipes = await chats.getSwipes(macroBranchMessage.id);
    assert.deepEqual(
      macroBranchSwipes.map((swipe) => swipe.content),
      ["active {{char}}", "inactive {{char}}"],
    );
    assert.deepEqual(
      macroBranchSwipes.map((swipe) => readSwipeCharacterId(swipe)),
      [macroDan.id, macroLeo.id],
    );
    const branchedActiveSwipe = macroBranchSwipes.find((swipe) => swipe.index === macroBranchMessage.activeSwipeIndex);
    assert.ok(branchedActiveSwipe);
    assert.equal(parseExtra(branchedActiveSwipe.extra).displayLabel, "active swipe metadata");
    assert.doesNotMatch(
      JSON.stringify(parseExtra(branchedActiveSwipe.extra)),
      /stale envelope metadata/,
      "trusted branch active metadata must not retain stale envelope values",
    );
    assert.doesNotMatch(
      JSON.stringify(macroBranchSwipes.map((swipe) => swipe.extra)),
      /stale Leo reasoning|active Dan reasoning/,
      "trusted branch copy must not retain non-portable reasoning from either the envelope or a swipe",
    );
  } finally {
    await routeApp.close();
  }

  const gameRouteRegistry = createActiveGenerationRegistry();
  const gameRouteApp = Fastify({ logger: false });
  gameRouteApp.decorate("db", await dbModule.getDB());
  gameRouteApp.decorate("activeGenerations", gameRouteRegistry);
  await gameRouteApp.register(gameRoutes, { prefix: "/api/game" });
  await gameRouteApp.ready();
  try {
    const skillChat = await chats.create({
      name: "Skill check active swipe route",
      mode: "game",
      characterIds: [macroLeo.id, macroDan.id],
    });
    const [skillMessageId] = await chats.createMessagesBatch(skillChat.id, [
      {
        role: "narrator",
        characterId: macroLeo.id,
        content: "stale envelope [skill_check: skill=athletics dc=10]",
        activeSwipeIndex: 0,
        swipes: [
          {
            index: 0,
            content: "active narration [skill_check: skill=athletics dc=10]",
            extra: { swipeCharacterId: macroDan.id },
          },
        ],
      },
    ]);
    assert.ok(skillMessageId);
    const heldSkillLease = acquireActiveGenerationLease(gameRouteRegistry, skillChat.id);
    assert.ok(heldSkillLease);
    const blockedSkillResponse = await gameRouteApp.inject({
      method: "POST",
      url: "/api/game/skill-check",
      payload: { chatId: skillChat.id, messageId: skillMessageId, skill: "athletics", dc: 10, preRolledD20: 20 },
    });
    assert.equal(blockedSkillResponse.statusCode, 409);
    const blockedStoryboardResponse = await gameRouteApp.inject({
      method: "POST",
      url: "/api/game/storyboard/generate",
      payload: { chatId: skillChat.id, messageId: skillMessageId, swipeIndex: 0, previewOnly: true },
    });
    assert.equal(
      blockedStoryboardResponse.statusCode,
      409,
      "storyboard generation must not read or render from a swipe while another generation owns the chat",
    );
    assert.equal(heldSkillLease.release(), true);

    const skillResponse = await gameRouteApp.inject({
      method: "POST",
      url: "/api/game/skill-check",
      payload: { chatId: skillChat.id, messageId: skillMessageId, skill: "athletics", dc: 10, preRolledD20: 20 },
    });
    assert.equal(skillResponse.statusCode, 200);
    const resolvedSkillMessage = await chats.getMessageWithActiveSwipe(skillMessageId);
    assert.ok(resolvedSkillMessage);
    assert.match(resolvedSkillMessage.content, /^active narration \[skill_check:/);
    assert.match(resolvedSkillMessage.content, /result=/);
    assert.doesNotMatch(resolvedSkillMessage.content, /stale envelope/);
  } finally {
    await gameRouteApp.close();
  }

  const retryRouteRegistry = createActiveGenerationRegistry();
  const retryRouteApp = Fastify({ logger: false });
  retryRouteApp.decorate("db", await dbModule.getDB());
  retryRouteApp.decorate("activeGenerations", retryRouteRegistry);
  await retryRouteApp.register(registerRetryAgentsRoute, { prefix: "/api/generate" });
  await retryRouteApp.ready();
  try {
    const heldRetryLease = acquireActiveGenerationLease(retryRouteRegistry, routeGuardChat.id);
    assert.ok(heldRetryLease);
    const busyRetryResponse = await retryRouteApp.inject({
      method: "POST",
      url: "/api/generate/retry-agents",
      payload: { chatId: routeGuardChat.id, agentTypes: ["lorebook-keeper"] },
    });
    assert.equal(busyRetryResponse.statusCode, 409);
    assert.equal(busyRetryResponse.json().error, "A generation is already in progress for this chat");
    assert.equal(heldRetryLease.release(), true);
    const postBusyRetryLease = acquireActiveGenerationLease(retryRouteRegistry, routeGuardChat.id);
    assert.ok(postBusyRetryLease);
    assert.equal(postBusyRetryLease.release(), true);

    const damagedRetryChat = await chats.create({
      name: "Damaged active swipe retry",
      mode: "conversation",
      characterIds: [macroLeo.id, macroDan.id],
    });
    const [missingActiveSwipeMessageId] = await chats.createMessagesBatch(damagedRetryChat.id, [
      {
        role: "assistant",
        characterId: macroLeo.id,
        content: "damaged active swipe pointer",
        activeSwipeIndex: 7,
        extra: { generationReplay: { conversationScope: { mode: "focused", characterId: macroLeo.id } } },
      },
    ]);
    assert.ok(missingActiveSwipeMessageId);
    const missingActiveSwipe = await chats.getMessageWithActiveSwipe(missingActiveSwipeMessageId);
    assert.ok(missingActiveSwipe);
    assert.equal(missingActiveSwipe.activeSwipeFound, false);

    const damagedRetryResponse = await retryRouteApp.inject({
      method: "POST",
      url: "/api/generate/retry-agents",
      payload: { chatId: damagedRetryChat.id, agentTypes: ["lorebook-keeper"] },
    });
    assert.equal(damagedRetryResponse.statusCode, 200);
    assert.match(damagedRetryResponse.body, /active_swipe_not_found/);
    assert.doesNotMatch(damagedRetryResponse.body, /"type":"agent_start"/);
    assert.equal(
      retryRouteRegistry.has(damagedRetryChat.id),
      false,
      "a fail-closed authoritative-swipe error must release the retry-owned generation lease",
    );
    const postDamagedRetryLease = acquireActiveGenerationLease(retryRouteRegistry, damagedRetryChat.id);
    assert.ok(postDamagedRetryLease);
    assert.equal(postDamagedRetryLease.release(), true);
  } finally {
    await retryRouteApp.close();
  }

  console.info("Conversation scope resolver regressions passed.");
} finally {
  if (closeDatabase) await closeDatabase();
  await rm(tempRoot, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
}
