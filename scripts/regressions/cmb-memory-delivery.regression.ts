import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { characters, lorebookEntries, lorebooks } from "../../packages/server/src/db/schema/index.js";
import {
  processLorebooks,
  resolveAndBudgetActivatedLorebookEntries,
  resolveBudgetAndRecursivelyActivateLorebookEntries,
} from "../../packages/server/src/services/lorebook/index.js";
import { isCmbMemoryOnlyFromChat } from "../../packages/server/src/services/lorebook/cmb-provenance.js";
import { formatMemoryTranscriptLine } from "../../packages/server/src/services/memory-recall.js";
import { createLorebookEntrySchema } from "../../packages/shared/src/schemas/lorebook.schema.js";
import type { LorebookEntry } from "../../packages/shared/src/types/lorebook.js";
import type { ActivatedEntry } from "../../packages/server/src/services/lorebook/keyword-scanner.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-cmb-delivery-"));
const previous = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = dir;
const at = "2026-10-02T00:00:00.000Z";
const dynamic = (chatId: string) => ({
  convoMemoryBridge: {
    schemaVersion: 1,
    memoryId: chatId,
    ensembleId: "ensemble",
    rosterBindings: [{ castId: "a", characterId: "character-a" }],
    unknownToCastIds: [],
    source: {
      kind: "native-memory-chunk",
      firstMessageAt: at,
      lastMessageAt: at,
      occurrences: [{ chatId, chatRole: "rp", chunkId: chatId, locatorFingerprint: "fixture" }],
    },
  },
});
function entry(id: string, chatId: string, vector: number[]): LorebookEntry {
  return {
    ...createLorebookEntrySchema.parse({
      lorebookId: "book",
      name: id,
      content: id + " synthetic memory.",
      tag: "convo-memory-bridge",
      dynamicState: dynamic(chatId),
      preventRecursion: true,
      excludeRecursion: true,
    }),
    id,
    embedding: vector,
  } as LorebookEntry;
}
const local = entry("local", "current-rp", [1, 0]),
  external = entry("external", "other-room", [0.8, 0.6]);
const active = (e: LorebookEntry): ActivatedEntry => ({
  entry: e,
  matchedKeys: ["[semantic:0.8]"],
  activationSources: ["semantic"],
  injectionOrder: e.order,
});
const books = new Map([["book", { name: "Memories", tokenBudget: 0, entryLimit: 100 }]]);
let db: Awaited<ReturnType<typeof createFileNativeDB>> | undefined;
try {
  db = await createFileNativeDB();
  await db.insert(characters).values({ id: "character-a", data: '{"name":"Alice"}', createdAt: at, updatedAt: at });
  await db.insert(lorebooks).values({
    id: "book",
    name: "Memories",
    enabled: "true",
    excludeFromVectorization: "false",
    vectorMaxResults: 1,
    vectorScoreThreshold: 0,
    createdAt: at,
    updatedAt: at,
  });
  for (const e of [local, external])
    await db.insert(lorebookEntries).values({
      id: e.id,
      lorebookId: "book",
      name: e.name,
      content: e.content,
      tag: e.tag,
      keys: "[]",
      enabled: "true",
      characterFilterMode: "include",
      characterFilterIds: '["character-a"]',
      preventRecursion: "true",
      dynamicState: JSON.stringify(e.dynamicState),
      embedding: JSON.stringify(e.embedding),
      createdAt: at,
      updatedAt: at,
    });
  const result = await processLorebooks(db, [{ role: "user", content: "remember" }], null, {
    chatId: "current-rp",
    characterIds: ["character-a"],
    activeLorebookIds: ["book"],
    chatEmbedding: [1, 0],
  });
  assert.deepEqual(
    result.activatedEntryIds,
    ["external"],
    "local similarity winner must be excluded before semantic top-K",
  );
  assert.ok(result.worldInfoBefore.includes("external synthetic memory."));
  assert.ok(!result.worldInfoBefore.includes("local synthetic memory."));
  const forced = await processLorebooks(db, [{ role: "user", content: "remember" }], null, {
    chatId: "current-rp",
    characterIds: ["character-a"],
    forcedEntriesOnly: true,
    forcedEntryIds: ["local"],
  });
  assert.deepEqual(forced.activatedEntryIds, ["local"], "explicit recall remains available");
  const rows = await db.select().from(lorebookEntries);
  assert.equal(rows.find((row) => row.id === "local")!.content, local.content);
  assert.equal(rows.find((row) => row.id === "local")!.embedding, JSON.stringify(local.embedding));

  assert.equal(isCmbMemoryOnlyFromChat(local, "current-rp"), true);
  assert.equal(isCmbMemoryOnlyFromChat(local, "other-room"), false);
  assert.equal(isCmbMemoryOnlyFromChat({ ...local, tag: "ordinary" }, "current-rp"), false);
  for (const patch of [
    { sourceStatus: "missing" },
    { ambiguousProvenance: true },
    { source: { kind: "manual" } },
    { source: { ...dynamic("current-rp").convoMemoryBridge.source, firstMessageAt: "invalid" } },
    {
      source: {
        ...dynamic("current-rp").convoMemoryBridge.source,
        occurrences: [
          ...dynamic("current-rp").convoMemoryBridge.source.occurrences,
          { chatId: "other-room", chatRole: "group" },
        ],
      },
    },
  ])
    assert.equal(
      isCmbMemoryOnlyFromChat(
        {
          ...local,
          dynamicState: {
            convoMemoryBridge: {
              ...dynamic("current-rp").convoMemoryBridge,
              ...patch,
            },
          },
        },
        "current-rp",
      ),
      false,
      "manual/missing/ambiguous/multi-room provenance is retained",
    );

  const selected = resolveAndBudgetActivatedLorebookEntries([active(local), active(external)], books, 0, 50);
  assert.equal(selected.length, 2);
  assert.equal(
    selected
      .map((a) => a.entry.content)
      .join("\n")
      .split("Record times are not in-world event dates.").length - 1,
    1,
  );
  for (const a of selected)
    assert.ok(a.entry.content.includes(at) && a.entry.content.includes("Recorded source room(s)"));
  const repeated = resolveAndBudgetActivatedLorebookEntries(selected, books, 0, 50);
  assert.deepEqual(
    repeated.map((a) => a.entry.content),
    selected.map((a) => a.entry.content),
  );
  const recursive = resolveBudgetAndRecursivelyActivateLorebookEntries(
    [{ role: "user", content: "seed" }],
    [
      { ...local, keys: ["seed"], content: "next-key", preventRecursion: false, excludeRecursion: false },
      { ...external, keys: ["next-key"], preventRecursion: false, excludeRecursion: false },
    ],
    { activeCharacterIds: ["character-a"] },
    2,
    books,
    0,
    50,
  );
  assert.equal(recursive.length, 2, "recursive fixture must reach a second batch");
  assert.equal(
    recursive
      .map((a) => a.entry.content)
      .join("\n")
      .split("Record times are not in-world event dates.").length - 1,
    1,
    "a recursive batch must not repeat guidance already injected by its first batch",
  );
  const names = { userName: "User", characterNames: { a: "Alice", b: "O'Neil" } };
  for (const content of [
    "Alice: hello",
    "Alice: hello\nO’Neil: reply",
    '<speaker="O’Neil">reply</speaker>',
    "O’Neil: reply",
  ])
    assert.equal(formatMemoryTranscriptLine({ role: "assistant", characterId: "a", content }, names), content);
  assert.equal(
    formatMemoryTranscriptLine({ role: "assistant", characterId: "a", content: "plain" }, names),
    "Alice: plain",
  );
  assert.equal(
    formatMemoryTranscriptLine({ role: "assistant", characterId: "a", content: "intro\nO’Neil: reply" }, names),
    "Alice: intro\nO’Neil: reply",
  );
  assert.equal(
    formatMemoryTranscriptLine({ role: "user", characterId: null, content: "Alice: quote" }, names),
    "User: Alice: quote",
  );
  console.info(
    "CMB delivery: actual scan/top-K, explicit selection, immutable originals, single guidance and speaker labels PASS",
  );
} finally {
  await db?._fileStore.close();
  if (previous === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
}
