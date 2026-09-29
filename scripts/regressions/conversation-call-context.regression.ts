import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  chats,
  lorebookEntries,
  lorebooks,
  memoryChunks,
  messages,
} from "../../packages/server/src/db/schema/index.js";
import { createCapabilityResourceHost } from "../../packages/server/src/services/capability-packages/capability-resources.service.js";
import { createCmbCompressionFixture } from "./helpers/cmb-compression-fixture.js";

const directory = mkdtempSync(join(tmpdir(), "marinara-call-context-"));
const previousDirectory = process.env.FILE_STORAGE_DIR;
const previousLogLevel = process.env.LOG_LEVEL;
process.env.FILE_STORAGE_DIR = directory;
process.env.LOG_LEVEL = "silent";
// Windows lacks directory fsync; this fixture checks read/permission behavior, not durability.
let originalReads = 0;
const nativeDb = await createFileNativeDB({
  fileOperations: { flushDirectory: async () => {} },
  afterCmbOriginalRead: () => {
    originalReads++;
  },
});
const db = nativeDb as unknown as DB;
let checks = 0;
try {
  const fixture = await createCmbCompressionFixture(db);
  const resources = createCapabilityResourceHost(db);
  assert.equal(typeof resources.resolveConversationCallContext, "function");
  const context = (audienceCharacterIds = ["character-a", "character-b"], chatId = "group") =>
    resources.resolveConversationCallContext!({ chatId, audienceCharacterIds, query: "harbor" });
  const today = new Date().toISOString().slice(0, 10);
  const stamp = (second: number) => `${today}T00:00:${String(second).padStart(2, "0")}.000Z`;
  const metadata = (extra: Record<string, unknown> = {}) =>
    db
      .update(chats)
      .set({
        metadata: JSON.stringify({ activeLorebookIds: [fixture.bookId], crossChatAwareness: false, ...extra }),
      })
      .where(eq(chats.id, "group"));

  await assert.rejects(context([], "group"), /audience/u);
  await assert.rejects(context(["not-in-chat"]), /audience/u);
  await assert.rejects(context(["character-b"], "dm-a"), /audience/u);
  await assert.rejects(context(["character-a"], "missing-chat"), /audience/u);
  checks++;

  await db.insert(lorebookEntries).values({
    id: "ordinary",
    lorebookId: fixture.bookId,
    name: "Old ordinary lore",
    content: "OLD_NORMAL_CONTENT",
    createdAt: fixture.stamp,
    updatedAt: fixture.stamp,
  });
  await db.insert(messages).values([
    { id: "old-message", chatId: "group", role: "user", content: "YESTERDAY", createdAt: fixture.stamp },
    ...Array.from({ length: 45 }, (_, index) => ({
      id: `today-${index}`,
      chatId: "group",
      role: "user",
      content: `TODAY_${index}`,
      createdAt: stamp(index),
    })).reverse(),
  ]);
  const ordinary = await context();
  assert.equal(ordinary.lorebookEntries[0]?.content, "OLD_NORMAL_CONTENT", "old ordinary entries remain eligible");
  assert.equal(ordinary.recentMessages.length, 40);
  assert.equal(ordinary.recentMessages[0]?.content, "TODAY_5");
  assert.equal(ordinary.recentMessages.at(-1)?.content, "TODAY_44", "query sorts and limits the current UTC day");
  assert.deepEqual(Object.keys(ordinary.lorebookEntries[0]!).sort(), ["content", "id", "name"]);
  assert.deepEqual(Object.keys(ordinary.recentMessages[0]!).sort(), ["characterId", "content", "createdAt", "role"]);
  const messageExtra = (index: number, extra: Record<string, unknown>) =>
    db
      .update(messages)
      .set({ extra: JSON.stringify(extra) })
      .where(eq(messages.id, `today-${index}`));
  await messageExtra(40, { isConversationStart: true, hiddenFromAI: true });
  assert.deepEqual(
    (await context()).recentMessages.map((message) => message.content),
    ["TODAY_41", "TODAY_42", "TODAY_43", "TODAY_44"],
    "a hidden global reset still prevents pre-reset history from entering the call",
  );
  await messageExtra(40, {});
  await messageExtra(38, { conversationStartForCharacterIds: ["character-b"], hiddenFromAI: true });
  assert.equal((await context()).recentMessages[0]?.content, "TODAY_39");
  assert.equal((await context(["character-b"])).recentMessages[0]?.content, "TODAY_39");
  assert.equal((await context(["character-a"])).recentMessages[0]?.content, "TODAY_5");
  await messageExtra(41, { conversationStartForCharacterIds: ["character-a"] });
  assert.equal((await context()).recentMessages[0]?.content, "TODAY_41", "latest audience reset wins");
  await messageExtra(41, {});
  await messageExtra(38, { conversationStartForCharacterIds: ["unrelated-character"] });
  assert.equal((await context()).recentMessages[0]?.content, "TODAY_5");
  await messageExtra(38, { conversationStartForCharacterIds: "malformed" });
  assert.deepEqual((await context()).recentMessages, [], "an unknown reset scope fails closed");
  await messageExtra(38, {});
  checks++;
  await db
    .update(lorebookEntries)
    .set({ characterFilterMode: "include", characterFilterIds: '["character-a"]' })
    .where(eq(lorebookEntries.id, "ordinary"));
  assert.deepEqual((await context()).lorebookEntries, [], "ordinary entry filters apply to every call speaker");
  assert.equal((await context(["character-a"])).lorebookEntries[0]?.id, "ordinary");
  await db
    .update(lorebookEntries)
    .set({
      characterFilterMode: "any",
      characterFilterIds: "[]",
      generationTriggerFilterMode: "include",
      generationTriggerFilters: '["manual"]',
    })
    .where(eq(lorebookEntries.id, "ordinary"));
  assert.deepEqual((await context()).lorebookEntries, [], "call trigger does not activate an unrelated entry");
  await db
    .update(lorebookEntries)
    .set({ generationTriggerFilterMode: "any", generationTriggerFilters: "[]" })
    .where(eq(lorebookEntries.id, "ordinary"));
  checks++;

  const merged = await fixture.createMemory({ id: "merged", appliedTo: ["a", "b"] });
  const mixed = await fixture.createMemory({ id: "mixed", appliedTo: ["a"] });
  const disabledCompression = await fixture.createMemory({ id: "off", appliedTo: [] });
  const privateMemory = await fixture.createMemory({
    id: "private",
    appliedTo: [],
    unknownTo: ["b"],
    original: "PRIVATE_DETAIL",
  });
  const all = await context();
  assert.match(all.lorebookEntries.find((entry) => entry.id === merged.id)!.content, /SHORT_A[\s\S]*SHORT_B/u);
  assert.doesNotMatch(all.lorebookEntries.find((entry) => entry.id === merged.id)!.content, /only after Bora arrived/u);
  assert.ok(
    !all.lorebookEntries.some((entry) => entry.id === mixed.id),
    "mixed compressed/original audience cannot share raw content",
  );
  assert.equal(
    all.lorebookEntries.find((entry) => entry.id === disabledCompression.id)?.content,
    disabledCompression.content,
  );
  assert.ok(!all.lorebookEntries.some((entry) => entry.id === privateMemory.id));
  assert.match(
    (await context(["character-a"])).lorebookEntries.find((entry) => entry.id === privateMemory.id)!.content,
    /PRIVATE_DETAIL/u,
  );
  checks++;

  await metadata({ entryStateOverrides: { merged: { enabled: false }, ordinary: { enabled: false } } });
  const hidden = await context();
  assert.ok(!hidden.lorebookEntries.some((entry) => [merged.id, "ordinary"].includes(entry.id)));
  await metadata({ excludedLorebookIds: [fixture.bookId] });
  assert.deepEqual((await context()).lorebookEntries, []);
  await metadata();
  await db
    .update(lorebooks)
    .set({ scope: JSON.stringify({ mode: "specific", chatIds: ["dm-a"] }) })
    .where(eq(lorebooks.id, fixture.bookId));
  assert.deepEqual((await context()).lorebookEntries, []);
  await db
    .update(lorebooks)
    .set({ scope: JSON.stringify({ mode: "specific", chatIds: ["rp", "group", "dm-a", "dm-b"] }) })
    .where(eq(lorebooks.id, fixture.bookId));
  checks++;

  // Original integrity remains part of summary eligibility, including format-7 cold storage.
  const archived = await nativeDb.transaction(async (tx) => {
    const state = await tx._fileStore.archiveCmbOriginal(merged.id);
    await tx._fileStore.flushStrict();
    return state;
  });
  assert.equal(archived.state, "archived");
  assert.match((await context()).lorebookEntries.find((entry) => entry.id === merged.id)!.content, /SHORT_A/u);
  await metadata({ entryStateOverrides: { merged: { enabled: false } } });
  originalReads = 0;
  await context();
  assert.equal(originalReads, 0, "hidden archived originals are not hydrated");
  await metadata();
  const blob = join(directory, "cmb-originals", `${archived.sha256}.json`);
  const originalBlob = readFileSync(blob, "utf8");
  writeFileSync(blob, '"damaged original"');
  assert.ok(
    !(await context()).lorebookEntries.some((entry) => entry.id === merged.id),
    "damaged archive never returns summary or raw fallback",
  );
  writeFileSync(blob, originalBlob);
  checks++;

  const native = await fixture.createMemory({ id: "native-private", native: true, appliedTo: [], unknownTo: ["b"] });
  const nativeDynamic = structuredClone(native.dynamicState) as Record<string, any>;
  const source = nativeDynamic.convoMemoryBridge.source;
  source.firstMessageAt = stamp(20);
  source.lastMessageAt = stamp(30);
  source.occurrences[0].chatId = "group";
  source.occurrences[0].chatRole = "group";
  await fixture.writeDynamic(native.id, nativeDynamic);
  await db
    .update(memoryChunks)
    .set({ chatId: "group", firstMessageAt: stamp(20), lastMessageAt: stamp(30) })
    .where(eq(memoryChunks.id, `chunk-${native.id}`));
  const restricted = await context();
  assert.ok(
    !restricted.recentMessages.some((message) => message.content === "TODAY_25"),
    "unknown-to source cannot bypass through today's messages",
  );
  assert.ok(
    restricted.recentMessages.some((message) => message.content === "TODAY_31"),
    "uncovered normal history remains available",
  );
  assert.ok((await context(["character-a"])).recentMessages.some((message) => message.content === "TODAY_25"));
  await metadata({ entryStateOverrides: { [native.id]: { enabled: false } } });
  assert.ok(
    !(await context(["character-a"])).recentMessages.some((message) => message.content === "TODAY_25"),
    "hidden entry also hides its raw source",
  );
  await metadata();
  // A stale/held derivative still owns its raw coverage until explicitly released.
  nativeDynamic.convoMemoryBridgeCompression = {
    schemaVersion: 1,
    byCast: structuredClone((mixed.dynamicState as Record<string, any>).convoMemoryBridgeCompression.byCast),
  };
  await fixture.writeDynamic(native.id, nativeDynamic);
  assert.ok(!(await context(["character-a"])).recentMessages.some((message) => message.content === "TODAY_25"));
  checks++;

  await db
    .update(messages)
    .set({ extra: JSON.stringify({ hiddenFromAICharacterIds: ["character-b"] }) })
    .where(eq(messages.id, "today-44"));
  await db
    .update(messages)
    .set({ extra: JSON.stringify({ commandOnly: true }) })
    .where(eq(messages.id, "today-43"));
  await db
    .update(messages)
    .set({ extra: JSON.stringify({ hiddenFromAI: true }) })
    .where(eq(messages.id, "today-42"));
  const visible = await context();
  assert.ok(!visible.recentMessages.some((message) => ["TODAY_42", "TODAY_43", "TODAY_44"].includes(message.content)));
  assert.ok((await context(["character-a"])).recentMessages.some((message) => message.content === "TODAY_44"));
  checks++;

  // CMB sync marks a vanished source chunk as `missing` with no occurrences. That normal state must
  // not erase today's history from every call; only a restricted one holds its own ensemble rooms.
  await db.insert(chats).values({
    id: "outside",
    name: "outside",
    mode: "conversation",
    characterIds: JSON.stringify(["character-a", "character-b"]),
    metadata: JSON.stringify({ crossChatAwareness: false }),
    createdAt: fixture.stamp,
    updatedAt: fixture.stamp,
  });
  await db
    .insert(messages)
    .values({ id: "outside-today", chatId: "outside", role: "user", content: "OUTSIDE_TODAY", createdAt: stamp(1) });
  const markMissing = async (entry: Awaited<ReturnType<typeof fixture.createMemory>>) => {
    const dynamic = structuredClone(entry.dynamicState) as Record<string, any>;
    dynamic.convoMemoryBridge.source.occurrences = [];
    dynamic.convoMemoryBridge.sourceStatus = "missing";
    await fixture.writeDynamic(entry.id, dynamic);
  };
  const outside = () =>
    resources.resolveConversationCallContext!({
      chatId: "outside",
      audienceCharacterIds: ["character-a", "character-b"],
      query: "harbor",
    });
  await markMissing(await fixture.createMemory({ id: "lost-open", native: true, appliedTo: [] }));
  assert.ok(
    (await context()).recentMessages.some((message) => message.content === "TODAY_31"),
    "an unrestricted missing-source memory does not hold its ensemble's calls",
  );
  assert.deepEqual(
    (await outside()).recentMessages.map((message) => message.content),
    ["OUTSIDE_TODAY"],
  );
  await markMissing(await fixture.createMemory({ id: "lost-private", native: true, appliedTo: [], unknownTo: ["b"] }));
  assert.deepEqual(
    (await context()).recentMessages,
    [],
    "a restricted memory with an unknown source still holds its own ensemble rooms",
  );
  assert.ok(
    (await context(["character-a"])).recentMessages.some((message) => message.content === "TODAY_31"),
    "the restriction applies only to audiences it restricts",
  );
  assert.deepEqual(
    (await outside()).recentMessages.map((message) => message.content),
    ["OUTSIDE_TODAY"],
    "a chat outside every ensemble is never held by another room's lost source",
  );
  await db.delete(lorebookEntries).where(eq(lorebookEntries.id, "lost-private"));
  checks++;

  for (let index = 0; index < 35; index++)
    await db.insert(lorebookEntries).values({
      id: `normal-${index}`,
      lorebookId: fixture.bookId,
      name: `Normal ${index}`,
      content: `NORMAL_${index}`,
      createdAt: fixture.stamp,
      updatedAt: fixture.stamp,
    });
  assert.equal((await context()).lorebookEntries.length, 30);
  checks++;
  console.log(`conversation-call-context: ${checks} regression groups passed`);
} finally {
  await nativeDb._fileStore.close();
  if (previousDirectory === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousDirectory;
  if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLogLevel;
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}marinara-call-context-`));
  rmSync(directory, { recursive: true, force: true });
}
