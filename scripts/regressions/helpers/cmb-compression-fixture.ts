import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { LorebookEntry } from "@marinara-engine/shared";
import type { DB } from "../../../packages/server/src/db/connection.js";
import { eq } from "../../../packages/server/src/db/file-query.js";
import {
  appSettings,
  characters,
  chats,
  installedExtensions,
  lorebookEntries,
  lorebooks,
  memoryChunks,
  personalExtensionCoordination,
} from "../../../packages/server/src/db/schema/index.js";
import { computePersonalExtensionHash } from "../../../packages/server/src/services/extensions/personal-extension-hash.js";
import { inspectCmbCompression } from "../../../packages/server/src/services/lorebook/cmb-compression.js";
import { createLorebooksStorage } from "../../../packages/server/src/services/storage/lorebooks.storage.js";

/** Synthetic local DB only. Direct fixture writes deliberately do not test the guarded mutation API. */
export async function createCmbCompressionFixture(db: DB) {
  const stamp = "2026-06-01T00:00:00.000Z";
  const extensionId = "cmb-compression-fixture";
  const bookId = "cmb-book";
  const ensemble = {
    ensembleId: "cmb-ensemble",
    name: "Synthetic cast",
    rpChatId: "rp",
    groupConvoChatIds: ["group"],
    lorebookId: bookId,
    autoSync: true,
    embedding: { connectionId: "fixture-embedding", model: "fixture-model" },
    runtime: {},
    members: [
      { castId: "a", characterId: "character-a", dmChatId: "dm-a" },
      { castId: "b", characterId: "character-b", dmChatId: "dm-b" },
    ],
  };
  const aging = {
    schemaVersion: 1,
    rooms: [{ chatId: "rp", clock: "story", detailedRecall: false, timelineId: "fixture-story", currentDay: 30 }],
    memoryTimes: [] as Array<{
      memoryId: string;
      sourceRevision: string;
      chatId: string;
      timelineId: string;
      day: number;
    }>,
  };
  const stored = {
    convoMemoryBridgeV1: { schemaVersion: 1, ensembles: [ensemble] },
    convoMemoryBridgeAgingV1: { schemaVersion: 1, ensembles: [{ ensembleId: ensemble.ensembleId, aging }] },
  };
  const contentHash = computePersonalExtensionHash({
    runtime: "client",
    capabilities: [],
    css: null,
    js: "(() => undefined)();",
    serverJs: null,
  });
  await db.insert(installedExtensions).values({
    id: extensionId,
    name: "Convo Memory Bridge",
    version: "fixture",
    description: "fixture",
    runtime: "client",
    capabilities: "[]",
    css: null,
    js: "(() => undefined)();",
    serverJs: null,
    enabled: "true",
    contentHash,
    approvedHash: contentHash,
    source: "local",
    revisions: "[]",
    installedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
  });
  await db.insert(personalExtensionCoordination).values({
    extensionId,
    contentHash,
    mode: "active",
    serverBootId: "fixture-boot",
    protectedLorebookRegistry: JSON.stringify({
      version: 1,
      extensionStorage: { resourceRevision: 0 },
      lorebooks: { [bookId]: { resourceRevision: 0 } },
    }),
    createdAt: stamp,
    updatedAt: stamp,
  });
  await db
    .insert(appSettings)
    .values({ key: `extension-storage:${extensionId}`, value: JSON.stringify(stored), updatedAt: stamp });
  for (const member of ensemble.members) {
    await db.insert(characters).values({
      id: member.characterId,
      data: JSON.stringify({
        name: member.castId === "a" ? "아린" : "보라",
        description: "A fictional test character.",
        personality: "Values promises.",
        scenario: "At the harbor.",
      }),
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  for (const [chatId, mode, ids] of [
    ["rp", "roleplay", ensemble.members.map((item) => item.characterId)],
    ["group", "conversation", ensemble.members.map((item) => item.characterId)],
    ...ensemble.members.map((item) => [item.dmChatId, "conversation", [item.characterId]]),
  ] as Array<[string, string, string[]]>) {
    await db.insert(chats).values({
      id: chatId,
      name: chatId,
      mode,
      characterIds: JSON.stringify(ids),
      metadata: JSON.stringify({ crossChatAwareness: false, activeLorebookIds: [bookId] }),
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  await db.insert(lorebooks).values({
    id: bookId,
    name: "Synthetic CMB memories",
    enabled: "true",
    isGlobal: "true",
    excludeFromVectorization: "false",
    vectorMaxResults: 1,
    scope: JSON.stringify({ mode: "specific", chatIds: ["rp", "group", "dm-a", "dm-b"] }),
    createdAt: stamp,
    updatedAt: stamp,
  });
  const storage = createLorebooksStorage(db);
  async function readFixtureEntry(id: string): Promise<LorebookEntry> {
    const entry = (await storage.getEntry(id)) as unknown as LorebookEntry | null;
    assert.ok(entry, `fixture entry missing: ${id}`);
    assert.equal(entry.id, id);
    assert.equal(entry.lorebookId, bookId);
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.content, "string");
    return entry;
  }
  async function saveSettings() {
    await db
      .update(appSettings)
      .set({ value: JSON.stringify(stored) })
      .where(eq(appSettings.key, `extension-storage:${extensionId}`));
  }
  async function writeDynamic(entryId: string, dynamicState: Record<string, unknown>) {
    await db
      .update(lorebookEntries)
      .set({ dynamicState: JSON.stringify(dynamicState) })
      .where(eq(lorebookEntries.id, entryId));
    return readFixtureEntry(entryId);
  }
  async function createMemory(options: {
    id: string;
    original?: string;
    native?: boolean;
    appliedTo?: string[];
    unknownTo?: string[];
    summary?: string;
  }) {
    const original =
      options.original ?? "Arin promised to return the harbor key only after Bora arrived. The promise is unresolved.";
    const unknownTo = options.unknownTo ?? [];
    const firstMessageAt = "2026-06-01T00:00:00.000Z";
    const lastMessageAt = "2026-06-01T00:04:00.000Z";
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const source = options.native
      ? {
          kind: "native-memory-chunk",
          canonicalFingerprint: hash({
            firstMessageAt,
            lastMessageAt,
            messageCount: 5,
            partIndex: 1,
            partTotal: 1,
            content: original,
          }),
          firstMessageAt,
          lastMessageAt,
          occurrences: [
            {
              chatId: "rp",
              chatRole: "rp",
              chunkId: `chunk-${options.id}`,
              locatorFingerprint: hash({ chatId: "rp", firstMessageAt, lastMessageAt, partIndex: 1, partTotal: 1 }),
            },
          ],
        }
      : { kind: "manual", createdAt: stamp, lastEditedAt: stamp };
    if (options.native)
      await db.insert(memoryChunks).values({
        id: `chunk-${options.id}`,
        chatId: "rp",
        content: original,
        firstMessageAt,
        lastMessageAt,
        messageCount: 5,
        embedding: "[1,0,0,0]",
        embeddingSpaceId: "fixture",
        createdAt: stamp,
      });
    aging.memoryTimes.push({
      memoryId: options.id,
      sourceRevision: options.native ? source.canonicalFingerprint! : JSON.stringify([stamp, stamp]),
      chatId: "rp",
      timelineId: "fixture-story",
      day: 0,
    });
    await saveSettings();
    const bridge = {
      schemaVersion: 1,
      memoryId: options.id,
      ensembleId: ensemble.ensembleId,
      rosterBindings: ensemble.members.map(({ castId, characterId }) => ({ castId, characterId })),
      unknownToCastIds: unknownTo,
      ambiguousProvenance: false,
      source,
    };
    await db.insert(lorebookEntries).values({
      id: options.id,
      lorebookId: bookId,
      name: options.id,
      content: `[Knowledge boundary]\nUnknown to cast IDs: ${unknownTo.join(", ") || "none"}\n\n[Memory]\n${original}`,
      keys: '["harbor"]',
      tag: "convo-memory-bridge",
      characterFilterMode: "include",
      characterFilterIds: JSON.stringify(
        ensemble.members.filter((item) => !unknownTo.includes(item.castId)).map((item) => item.characterId),
      ),
      dynamicState: JSON.stringify({ convoMemoryBridge: bridge }),
      excludeFromVectorization: "false",
      embedding: "[1,0,0,0]",
      embeddingSpaceId: "fixture",
      createdAt: stamp,
      updatedAt: stamp,
    });
    let entry = await readFixtureEntry(options.id);
    const byCast: Record<string, unknown> = {};
    for (const castId of options.appliedTo ?? ["a"]) {
      const inspected = await inspectCmbCompression(db, entry, castId);
      assert.equal(inspected.eligibility.status, "ready", `fixture preparation held: ${inspected.reason}`);
      const quote = original.slice(0, 200);
      byCast[castId] = {
        revision: 1,
        active: true,
        basisFingerprint: inspected.basisFingerprint,
        importanceMode: "auto",
        summary: options.summary ?? `SHORT_${castId.toUpperCase()}: Arin's harbor promise remains unresolved.`,
        importanceReason: "An unresolved promise.",
        retention: "essentials",
        evidence: [{ quote }],
        facts: [{ actors: ["Arin"], negation: null, condition: null, status: null, evidenceQuote: quote }],
        appliedAt: stamp,
        sourceChatId: "rp",
        clock: "story",
        stageDays: 30,
      };
    }
    if (Object.keys(byCast).length)
      entry = await writeDynamic(entry.id, {
        ...entry.dynamicState,
        convoMemoryBridgeCompression: { schemaVersion: 1, byCast },
      });
    return entry;
  }
  return {
    db,
    stamp,
    extensionId,
    contentHash,
    bookId,
    ensemble,
    aging,
    stored,
    storage,
    saveSettings,
    writeDynamic,
    createMemory,
  };
}
