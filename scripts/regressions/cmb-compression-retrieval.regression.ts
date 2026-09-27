import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  characters,
  lorebookEntries,
  lorebooks,
  memoryChunks,
  messages,
} from "../../packages/server/src/db/schema/index.js";
import { createCmbCompressionFixture } from "./helpers/cmb-compression-fixture.js";
import {
  resolveCmbCompressionEntries,
  hasActiveCmbCompression,
  createCmbDetailedRecallBudget,
} from "../../packages/server/src/services/lorebook/cmb-compression-retrieval.js";
import {
  resolveCmbSourceRestrictions,
  isCmbSourceMessageRestricted,
} from "../../packages/server/src/services/conversation/cmb-source-visibility.js";
import {
  processLorebooks,
  scopeLorebookScanResultToCharacter,
} from "../../packages/server/src/services/lorebook/index.js";
import {
  resolveGenerationTools,
  type ResolveGenerationToolsArgs,
} from "../../packages/server/src/services/generation/tool-resolution-runtime.js";
import { recallMemories } from "../../packages/server/src/services/memory-recall.js";
import { executeToolCallForModel } from "../../packages/server/src/services/tools/tool-executor.js";
import { buildCmbRecentContext } from "../../packages/server/src/services/conversation/autonomous-cmb-context.service.js";

const directory = mkdtempSync(join(tmpdir(), "marinara-cmb-compression-retrieval-"));
const previous = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = directory;
process.env.LOG_LEVEL = "silent";
let checks = 0;
try {
  const db = (await createFileNativeDB()) as unknown as DB;
  const fixture = await createCmbCompressionFixture(db);
  const select = (
    entries: Parameters<typeof resolveCmbCompressionEntries>[1],
    audience = ["character-a"],
    query = "harbor",
  ) => resolveCmbCompressionEntries(db, entries, { audienceCharacterIds: audience, query });
  const first = await fixture.createMemory({ id: "first", appliedTo: ["a", "b"] });
  const originalSnapshot = JSON.stringify(first);
  const selected = await select([first]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.id, first.id);
  assert.match(selected[0]!.content, /아린.*\nSHORT_A/u);
  assert.doesNotMatch(selected[0]!.content, /only after Bora arrived/u);
  assert.equal(JSON.stringify(first), originalSnapshot);
  assert.equal((await fixture.storage.getEntry(first.id))!.content, first.content);
  checks++;

  const merged = await select([first], ["character-a", "character-b"]);
  assert.equal(merged.length, 1);
  assert.match(merged[0]!.content, /SHORT_A[\s\S]*SHORT_B/u);
  const onlyA = await fixture.createMemory({ id: "only-a" });
  assert.deepEqual(
    await select([onlyA], ["character-a", "character-b"]),
    [],
    "missing one recipient's derivative cannot reveal the original",
  );
  assert.equal(
    (await select([onlyA], ["character-b"]))[0]!.content,
    onlyA.content,
    "an unapplied character retains their existing original path",
  );
  const releasedA = structuredClone(first.dynamicState);
  (releasedA.convoMemoryBridgeCompression as { byCast: { a: { active: boolean } } }).byCast.a.active = false;
  const perCastReleased = await fixture.writeDynamic(first.id, releasedA);
  assert.equal(
    (await select([perCastReleased]))[0]!.content,
    first.content,
    "A undo restores A while B remains compressed",
  );
  assert.match((await select([perCastReleased], ["character-b"]))[0]!.content, /SHORT_B/u);
  assert.deepEqual(await select([perCastReleased], ["character-a", "character-b"]), []);
  await fixture.writeDynamic(first.id, first.dynamicState);
  assert.deepEqual(await select([first], ["outsider"]), []);
  const hidden = await fixture.createMemory({ id: "hidden", unknownTo: ["b"] });
  assert.deepEqual(await select([hidden], ["character-b"]), []);
  assert.deepEqual(await select([hidden], ["character-a", "character-b"]), []);
  checks++;

  const plain = await fixture.createMemory({ id: "plain", appliedTo: [] });
  assert.equal((await select([plain]))[0]!.content, plain.content);
  const malformed = {
    ...first,
    dynamicState: { ...first.dynamicState, convoMemoryBridgeCompression: { schemaVersion: 2 } },
  };
  assert.deepEqual(await select([malformed]), []);
  assert.equal(hasActiveCmbCompression(malformed.dynamicState), true);
  const historical = structuredClone(first.dynamicState);
  const historicalNamespace = historical.convoMemoryBridgeCompression as {
    byCast: Record<string, { active: boolean }>;
    history?: unknown[];
  };
  historicalNamespace.history = [{ castId: "a", record: structuredClone(historicalNamespace.byCast.a) }];
  for (const item of Object.values(historicalNamespace.byCast)) item.active = false;
  assert.equal(
    hasActiveCmbCompression(historical),
    false,
    "retained historical active records do not reactivate a released memory",
  );
  checks++;

  await db
    .update(characters)
    .set({ data: JSON.stringify({ name: "아린", description: "Changed card basis." }) })
    .where(eq(characters.id, "character-a"));
  assert.deepEqual(await select([first]), [], "current card change invalidates a stored derivative");
  await db
    .update(characters)
    .set({
      data: JSON.stringify({
        name: "아린",
        description: "A fictional test character.",
        personality: "Values promises.",
        scenario: "At the harbor.",
      }),
    })
    .where(eq(characters.id, "character-a"));
  await db
    .update(lorebookEntries)
    .set({ content: first.content + " Edited." })
    .where(eq(lorebookEntries.id, first.id));
  assert.deepEqual(await select([first]), [], "entry snapshot cannot bypass a current body edit");
  assert.deepEqual(await select([(await fixture.storage.getEntry(first.id))!]), []);
  const semanticAfterStale = await processLorebooks(db, [{ role: "user", content: "unmatched query" }], null, {
    chatId: "dm-a",
    characterIds: ["character-a"],
    activeLorebookIds: [fixture.bookId],
    chatEmbedding: [1, 0, 0, 0],
    semanticEmbeddingSpaceId: "fixture",
  });
  assert.equal(
    semanticAfterStale.activatedEntryIds.length,
    1,
    "a held top semantic candidate cannot consume the book's sole result slot",
  );
  assert.notEqual(semanticAfterStale.activatedEntryIds[0], first.id);
  await db.update(lorebookEntries).set({ content: first.content }).where(eq(lorebookEntries.id, first.id));
  fixture.aging.rooms[0]!.currentDay = 31;
  await fixture.saveSettings();
  assert.deepEqual(await select([first]), [], "story day changes invalidate the prepared basis");
  fixture.aging.rooms[0]!.currentDay = 30;
  await fixture.saveSettings();
  checks++;

  fixture.aging.rooms[0]!.detailedRecall = true;
  await fixture.saveSettings();
  assert.match(
    (await select([first], ["character-a"], "harbor"))[0]!.content,
    /SHORT_A/u,
    "one generic token cannot expand details",
  );
  assert.match((await select([first], ["character-a"], "harbor key"))[0]!.content, /only after Bora arrived/u);
  const second = await fixture.createMemory({ id: "second" });
  const third = await fixture.createMemory({ id: "third" });
  const bounded = await select([first, second, third], ["character-a"], "harbor key");
  assert.equal(bounded.filter((item) => item.content.includes("recalled original details")).length, 2);
  const long = await fixture.createMemory({ id: "long", original: "Arin kept the harbor key. " + "x".repeat(3500) });
  const long2 = await fixture.createMemory({ id: "long-2", original: "Arin kept the harbor key. " + "y".repeat(3500) });
  const charsBounded = await select([long, long2], ["character-a"], "harbor key");
  assert.equal(charsBounded.filter((item) => item.content.includes("recalled original details")).length, 1);
  const budget = createCmbDetailedRecallBudget();
  for (const item of [first, second, third])
    await resolveCmbCompressionEntries(db, [item], {
      audienceCharacterIds: ["character-a"],
      query: "harbor key",
      detailBudget: budget,
    });
  assert.equal(budget.count, 2, "tool calls share the detail ceiling");
  fixture.aging.rooms[0]!.detailedRecall = false;
  await fixture.saveSettings();
  checks++;

  const scan = (overrides = {}) =>
    processLorebooks(db, [{ role: "user", content: "harbor" }], null, {
      chatId: "dm-a",
      characterIds: ["character-a", "user-identity"],
      cmbAudienceCharacterIds: ["character-a"],
      activeLorebookIds: [fixture.bookId],
      forcedEntriesOnly: true,
      forcedEntryIds: [first.id],
      currentLocationTokenBudget: 512,
      ...overrides,
    });
  const scanned = await scan();
  assert.deepEqual(scanned.activatedEntryIds, [first.id]);
  assert.match(scanned.activatedEntries[0]!.content, /CMB memory provenance[\s\S]*SHORT_A/u);
  assert.doesNotMatch(scanned.activatedEntries[0]!.content, /only after Bora arrived/u);
  assert.deepEqual((await scan({ entryStateOverrides: { [first.id]: { enabled: false } } })).activatedEntryIds, []);
  await db.update(lorebooks).set({ enabled: "false" }).where(eq(lorebooks.id, fixture.bookId));
  assert.deepEqual((await scan()).activatedEntryIds, []);
  await db.update(lorebooks).set({ enabled: "true" }).where(eq(lorebooks.id, fixture.bookId));
  const sharedScan = await processLorebooks(db, [{ role: "user", content: "harbor" }], null, {
    chatId: "rp",
    characterIds: ["character-a", "character-b", "user-identity"],
    cmbAudienceCharacterIds: ["character-a", "character-b"],
    activeLorebookIds: [fixture.bookId],
    forcedEntriesOnly: true,
    forcedEntryIds: [onlyA.id],
    entryStateOverrides: { [onlyA.id]: { ephemeral: 2 } },
  });
  assert.deepEqual(sharedScan.activatedEntryIds, []);
  const speakerA = await scopeLorebookScanResultToCharacter(db, sharedScan, "character-a");
  const speakerB = await scopeLorebookScanResultToCharacter(db, sharedScan, "character-b");
  assert.deepEqual(
    speakerA.activatedEntryIds,
    [onlyA.id],
    "fresh speaker scan recovers a candidate held from the merged audience",
  );
  assert.match(speakerA.activatedEntries[0]!.content, /SHORT_A/u);
  assert.match(speakerB.activatedEntries[0]!.content, /only after Bora arrived/u);
  assert.equal(
    speakerA.updatedEntryStateOverrides,
    undefined,
    "speaker rescan must not consume ephemeral state a second time",
  );
  assert.equal(speakerA.updatedEntryTimingStates, undefined);
  assert.equal((await fixture.storage.getEntry(onlyA.id))!.content, onlyA.content);
  checks++;

  const toolArgs = {
    db,
    requestBody: {},
    chatId: "dm-a",
    chatMetadata: {},
    chats: {},
    agentsStore: {},
    customToolsStore: { listEnabled: async () => [] },
    lorebooksStore: fixture.storage,
    resolvedAgents: [],
    enabledConfigs: [],
    promptCharacterIds: ["character-a"],
    lorebookCharacterIds: ["character-a", "user-identity"],
    personaId: null,
    activeLorebookIds: [fixture.bookId],
    excludedLorebookIds: [],
    excludedSourceAgentIds: [],
    gameState: null,
    gameSpotifyMusicEnabled: false,
    agentContext: { chatMode: "conversation", characters: [], recentMessages: [], memory: {} },
    emitMetadataPatch: () => {},
    lorebookEmbeddingOptions: {
      embeddingSource: {
        spaceId: "fixture",
        label: "synthetic",
        embed: async (texts: string[]) => texts.map((_, index) => (index === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0])),
      },
    },
  } as unknown as ResolveGenerationToolsArgs;
  const tools = await resolveGenerationTools(toolArgs);
  const results = await tools.baseToolExecutionContext.searchLorebook!("harbor");
  const firstResult = results.find((item) => item.name === first.name)!;
  assert.match(firstResult.content, /SHORT_A/u);
  assert.doesNotMatch(firstResult.content, /only after Bora arrived/u);
  assert.equal(results.filter((item) => item.name === first.name).length, 1);
  assert.deepEqual(
    await tools.baseToolExecutionContext.searchLorebook!("harbor"),
    [],
    "repeated calls do not return the same CMB event twice",
  );
  const speakerTools = await resolveGenerationTools({
    ...toolArgs,
    promptCharacterIds: ["character-a", "character-b"],
    lorebookCharacterIds: ["character-a", "character-b", "user-identity"],
  });
  const runTool = async (caller: string, query = "harbor") =>
    JSON.parse(
      await executeToolCallForModel(
        {
          id: "synthetic-call",
          type: "function",
          function: { name: "search_lorebook", arguments: JSON.stringify({ query }) },
        },
        { ...speakerTools.baseToolExecutionContext, callingCharacterId: caller },
      ),
    ) as { results: Array<{ name: string; content: string }> };
  const resultA = await runTool("character-a");
  const resultB = await runTool("character-b");
  assert.match(resultA.results.find((item) => item.name === first.id)!.content, /SHORT_A/u);
  assert.doesNotMatch(resultA.results.find((item) => item.name === first.id)!.content, /SHORT_B/u);
  assert.match(resultA.results.find((item) => item.name === onlyA.id)!.content, /SHORT_A/u);
  assert.match(resultB.results.find((item) => item.name === first.id)!.content, /SHORT_B/u);
  assert.equal(
    resultB.results.some((item) => item.name === hidden.id),
    false,
  );
  assert.deepEqual((await runTool("character-a")).results, []);
  checks++;

  fixture.aging.rooms[0]!.detailedRecall = true;
  await fixture.saveSettings();
  const detailPrompt = await processLorebooks(db, [{ role: "user", content: "harbor key" }], null, {
    chatId: "dm-a",
    characterIds: ["character-a"],
    activeLorebookIds: [fixture.bookId],
    forcedEntriesOnly: true,
    forcedEntryIds: [first.id, second.id],
  });
  assert.equal(
    detailPrompt.activatedEntries.filter((item) => item.content.includes("recalled original details")).length,
    2,
  );
  speakerTools.setCmbPromptMemories(["character-a"], detailPrompt.activatedEntries);
  const afterPrompt = await runTool("character-a", "harbor key");
  assert.equal(
    afterPrompt.results.some((item) => [first.id, second.id].includes(item.name)),
    false,
    "automatic memory IDs are not returned again by tools",
  );
  assert.equal(
    afterPrompt.results.some((item) => item.content.includes("recalled original details")),
    false,
    "automatic details consume the same per-answer tool ceiling",
  );
  assert.deepEqual((await runTool("character-a", "harbor key")).results, []);
  fixture.aging.rooms[0]!.detailedRecall = false;
  await fixture.saveSettings();
  const raceTools = await resolveGenerationTools({
    ...toolArgs,
    lorebookEmbeddingOptions: {
      embeddingSource: {
        spaceId: "fixture",
        label: "synthetic",
        embed: async (texts) => {
          await db
            .update(lorebookEntries)
            .set({ content: first.content + " Changed during the embedding await." })
            .where(eq(lorebookEntries.id, first.id));
          return texts.map((_, index) => (index === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0]));
        },
      },
    },
  });
  assert.equal(
    (await raceTools.baseToolExecutionContext.searchLorebook!("harbor")).some((item) => item.name === first.id),
    false,
  );
  await db.update(lorebookEntries).set({ content: first.content }).where(eq(lorebookEntries.id, first.id));
  await db.insert(lorebookEntries).values({
    id: "tag-filtered",
    lorebookId: fixture.bookId,
    name: "tag-filtered",
    content: "A navigator watches the harbor.",
    keys: '["harbor"]',
    characterFilterMode: "include",
    characterFilterIds: '["character-a"]',
    characterTagFilterMode: "include",
    characterTagFilters: '["navigator"]',
    generationTriggerFilterMode: "include",
    generationTriggerFilters: '["continue"]',
    createdAt: fixture.stamp,
    updatedAt: fixture.stamp,
  });
  await db
    .update(characters)
    .set({
      data: JSON.stringify({
        name: "아린",
        description: "A fictional test character.",
        personality: "Values promises.",
        scenario: "At the harbor.",
        tags: ["navigator"],
      }),
    })
    .where(eq(characters.id, "character-a"));
  const taggedTools = await resolveGenerationTools({
    ...toolArgs,
    lorebookGenerationTriggers: ["conversation", "continue"],
  });
  assert.equal(
    (await taggedTools.baseToolExecutionContext.searchLorebook!("harbor")).some((item) => item.name === "tag-filtered"),
    true,
    "current card tags and generation trigger keep eligible entries searchable",
  );
  const wrongTriggerTools = await resolveGenerationTools({
    ...toolArgs,
    lorebookGenerationTriggers: ["conversation", "chat"],
  });
  assert.equal(
    (await wrongTriggerTools.baseToolExecutionContext.searchLorebook!("harbor")).some(
      (item) => item.name === "tag-filtered",
    ),
    false,
  );
  checks++;

  const native = await fixture.createMemory({ id: "native", native: true });
  await db.insert(memoryChunks).values({
    id: "rebuilt-native",
    chatId: "rp",
    content: "Rebuilt old original.",
    firstMessageAt: "2026-06-01T00:02:00.000Z",
    lastMessageAt: "2026-06-01T00:06:00.000Z",
    messageCount: 5,
    embedding: "[1,0,0,0]",
    embeddingSpaceId: "fixture",
    createdAt: fixture.stamp,
  });
  await db.insert(memoryChunks).values({
    id: "unrelated-native",
    chatId: "rp",
    content: "Unrelated later memory.",
    firstMessageAt: "2026-06-02T00:00:00.000Z",
    lastMessageAt: "2026-06-02T00:04:00.000Z",
    messageCount: 5,
    embedding: "[1,0,0,0]",
    embeddingSpaceId: "fixture",
    createdAt: fixture.stamp,
  });
  const recall = () =>
    recallMemories(db, "harbor", ["rp"], {
      topK: 1,
      embeddingSource: { spaceId: "fixture", label: "synthetic", embed: async () => [[1, 0, 0, 0]] },
    });
  assert.deepEqual(
    (await recall()).map((item) => item.content),
    ["Unrelated later memory."],
    "original and overlapping rebuilt chunks are removed before topK",
  );
  const row = {
    id: native.id,
    enabled: "true",
    characterFilterMode: native.characterFilterMode,
    characterFilterIds: JSON.stringify(native.characterFilterIds),
    dynamicState: JSON.stringify(native.dynamicState),
  };
  const restrictions = resolveCmbSourceRestrictions([row], fixture.ensemble, ["character-a"]);
  assert.ok(restrictions);
  assert.equal(isCmbSourceMessageRestricted(restrictions, "rp", "2026-06-01T00:02:00.000Z"), true);
  const movedFirst = "2026-06-03T00:00:00.000Z";
  const movedLast = "2026-06-03T00:04:00.000Z";
  await db
    .update(memoryChunks)
    .set({ firstMessageAt: movedFirst, lastMessageAt: movedLast })
    .where(eq(memoryChunks.id, "chunk-native"));
  assert.deepEqual(
    (await recall()).map((item) => item.content),
    ["Unrelated later memory."],
    "same chunk ID stays blocked after its timestamps leave the original span",
  );
  for (const [id, chatId, createdAt, content] of [
    ["raw-old", "rp", "2026-06-01T00:02:00.000Z", "OLD_SOURCE_RAW"],
    ["raw-moved", "rp", "2026-06-03T00:02:00.000Z", "MOVED_SOURCE_RAW"],
    ["raw-outside", "rp", "2026-06-04T00:02:00.000Z", "OUTSIDE_SOURCE_RAW"],
    ["raw-group", "group", "2026-06-04T00:03:00.000Z", "OTHER_SOURCE_CHAT_RAW"],
  ])
    await db
      .insert(messages)
      .values({ id: id!, chatId: chatId!, role: "user", content: content!, extra: "{}", createdAt: createdAt! });
  const recent = () =>
    buildCmbRecentContext({
      db,
      targetChatId: "dm-a",
      targetCharacterIds: ["character-a"],
      generation: "ordinary",
      timeZone: "UTC",
    });
  const movedRecent = await recent();
  assert.equal(movedRecent.scope, "managed");
  assert.match(movedRecent.block ?? "", /OUTSIDE_SOURCE_RAW/u);
  assert.match(movedRecent.block ?? "", /OTHER_SOURCE_CHAT_RAW/u);
  assert.doesNotMatch(
    movedRecent.block ?? "",
    /OLD_SOURCE_RAW|MOVED_SOURCE_RAW/u,
    "recent raw coverage includes both old and current source spans",
  );
  await db.delete(memoryChunks).where(eq(memoryChunks.id, "chunk-native"));
  assert.deepEqual(await recall(), [], "an unresolved active source locator holds its source chat's raw recall");
  const missingRecent = await recent();
  assert.doesNotMatch(missingRecent.block ?? "", /OLD_SOURCE_RAW|MOVED_SOURCE_RAW|OUTSIDE_SOURCE_RAW/u);
  assert.match(
    missingRecent.block ?? "",
    /OTHER_SOURCE_CHAT_RAW/u,
    "a missing locator must not suppress other source chats",
  );
  await db.insert(memoryChunks).values({
    id: "chunk-native",
    chatId: "rp",
    content: native.content.split("\n\n[Memory]\n")[1]!,
    firstMessageAt: movedFirst,
    lastMessageAt: movedLast,
    messageCount: 5,
    embedding: "[1,0,0,0]",
    embeddingSpaceId: "fixture",
    createdAt: fixture.stamp,
  });
  const released = structuredClone(native.dynamicState);
  (released.convoMemoryBridgeCompression as { byCast: { a: { active: boolean } } }).byCast.a.active = false;
  const restored = await fixture.writeDynamic(native.id, released);
  assert.equal((await select([restored]))[0]!.content, native.content);
  const releasedNative = await recallMemories(db, "harbor", ["rp"], {
    embeddingSource: { spaceId: "fixture", label: "synthetic", embed: async () => [[1, 0, 0, 0]] },
  });
  assert.ok(releasedNative.some((item) => item.content.includes("only after Bora arrived")));
  const releasedRecent = await recent();
  assert.match(releasedRecent.block ?? "", /OLD_SOURCE_RAW/u);
  assert.match(releasedRecent.block ?? "", /MOVED_SOURCE_RAW/u);
  assert.deepEqual(
    resolveCmbSourceRestrictions([{ ...row, dynamicState: JSON.stringify(released) }], fixture.ensemble, [
      "character-a",
    ]),
    [],
  );
  checks++;
  console.log(`CMB compression retrieval synthetic scenarios: ${checks} passed.`);
} finally {
  if (previous === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
}
