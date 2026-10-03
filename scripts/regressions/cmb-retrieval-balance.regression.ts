import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIMITS } from "../../packages/shared/src/constants/defaults.js";
import { createLorebookEntrySchema } from "../../packages/shared/src/schemas/lorebook.schema.js";
import type { LorebookEntry } from "../../packages/shared/src/types/lorebook.js";
import { scanForActivatedEntries } from "../../packages/server/src/services/lorebook/keyword-scanner.js";
import { resolveAndBudgetActivatedLorebookEntries } from "../../packages/server/src/services/lorebook/index.js";
import {
  cmbSourceRoom,
  CMB_PROVENANCE_GUIDANCE,
  dedupeCmbProvenanceGuidance,
  withCmbProvenance,
} from "../../packages/server/src/services/lorebook/cmb-provenance.js";
import { wrapContent } from "../../packages/server/src/services/prompt/format-engine.js";

const at = "2026-10-04T00:00:00.000Z";
function entry(id: string, room: string, score: number, book = "book"): LorebookEntry {
  return {
    ...createLorebookEntrySchema.parse({
      lorebookId: book,
      name: id,
      content: id + " synthetic memory.",
      tag: "convo-memory-bridge",
      characterFilterMode: "include",
      characterFilterIds: ["a"],
      dynamicState: {
        convoMemoryBridge: {
          schemaVersion: 1,
          memoryId: id,
          ensembleId: "ensemble",
          unknownToCastIds: [],
          rosterBindings: [{ castId: "a", characterId: "a" }],
          source: {
            kind: "native-memory-chunk",
            firstMessageAt: at,
            lastMessageAt: at,
            occurrences: [{ chatId: room, chatRole: room === "group" ? "group" : "dm", chunkId: id }],
          },
        },
      },
    }),
    id,
    embedding: [score, Math.sqrt(1 - score * score)],
    embeddingSpaceId: "fixture-space",
  } as LorebookEntry;
}
const group = Array.from({ length: 12 }, (_, i) => entry(`g${i}`, "group", 0.9 - i * 0.01));
const dm = Array.from({ length: 12 }, (_, i) => entry(`d${i}`, "dm", 0.7 - i * 0.01));
const candidates = [...group, ...dm];
const original = JSON.stringify(candidates);
function scan(entries = candidates, limit = 10, threshold = 0.3) {
  return scanForActivatedEntries([{ role: "user", content: "remember" }], entries, {
    activeCharacterIds: ["a"],
    chatEmbedding: [1, 0],
    semanticEmbeddingSpaceId: "fixture-space",
    semanticThreshold: threshold,
    semanticMaxMatchesByLorebookId: new Map([
      ["book", limit],
      ["second", limit],
    ]),
  });
}
assert.equal(LIMITS.LOREBOOK_VECTOR_MAX_RESULTS_DEFAULT, 10);
assert.equal(LIMITS.LOREBOOK_VECTOR_MAX_RESULTS_MIN, 1);
assert.equal(LIMITS.LOREBOOK_VECTOR_MAX_RESULTS_MAX, 100);
assert.deepEqual(
  scan().map((a) => a.entry.id),
  ["g0", "d0", "g1", "d1", "g2", "d2", "g3", "d3", "g4", "d4"],
);
assert.deepEqual(
  scan(candidates, 1).map((a) => a.entry.id),
  ["g0"],
  "one slot retains highest similarity",
);
assert.equal(scan(candidates, 100).length, 24, "configured limit changes capacity, not stored memory count");
assert.ok(
  scan(candidates, 10, 0.75).every((a) => a.entry.id.startsWith("g")),
  "never lower relevance threshold to fill a room",
);
assert.deepEqual(
  scan([...group, dm[0]!], 10).map((a) => a.entry.id),
  ["g0", "d0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"],
  "unused quota returns to available rooms",
);
const extraBook = candidates.map((a) => ({ ...a, id: "second-" + a.id, lorebookId: "second" }));
const twoBooks = scan([...candidates, ...extraBook], 2);
assert.equal(twoBooks.length, 4);
assert.equal(twoBooks.filter((a) => a.entry.lorebookId === "second").length, 2);
for (const patch of [
  { enabled: false },
  { characterFilterIds: ["b"] },
  { excludeFromVectorization: true },
  { embeddingSpaceId: "other-space" },
  { embedding: [1, 0, 0] },
  { probability: 0 },
]) {
  const result = scan([...group, ...dm.map((a) => ({ ...a, ...patch }))]);
  assert.equal(result.length, 10);
  assert.ok(
    result.every((a) => a.entry.id.startsWith("g")),
    JSON.stringify(patch),
  );
}
const ordinary = candidates.map((a) => ({ ...a, tag: "ordinary" }));
assert.deepEqual(
  scan(ordinary).map((a) => a.entry.id),
  group.slice(0, 10).map((a) => a.id),
  "ordinary lore ranking unchanged",
);
const mixed = scan([{ ...entry("ordinary-top", "room", 0.99), tag: "ordinary" }, ...candidates]);
assert.deepEqual(
  mixed.slice(0, 3).map((a) => a.entry.id),
  ["ordinary-top", "g0", "d0"],
);
const selected = resolveAndBudgetActivatedLorebookEntries(
  scan(),
  new Map([["book", { name: "Memories", tokenBudget: 6144, entryLimit: 100 }]]),
  0,
  100,
);
assert.equal(selected.filter((a) => cmbSourceRoom(a.entry) === "group").length, 5);
assert.equal(selected.filter((a) => cmbSourceRoom(a.entry) === "dm").length, 5);
assert.equal(
  resolveAndBudgetActivatedLorebookEntries(
    scan(),
    new Map([["book", { name: "Memories", tokenBudget: 1, entryLimit: 100 }]]),
    0,
    100,
  ).length,
  0,
  "balance never bypasses token budget",
);
assert.equal(JSON.stringify(candidates), original, "selection never edits source content, vectors or settings");
for (const source of [
  null,
  {},
  { kind: "manual" },
  {
    kind: "native-memory-chunk",
    occurrences: [
      { chatId: "dm", chatRole: "dm" },
      { chatId: "group", chatRole: "group" },
    ],
  },
]) {
  assert.equal(
    cmbSourceRoom({ ...group[0]!, dynamicState: { convoMemoryBridge: { schemaVersion: 1, source } } }),
    null,
  );
}

const guidanceCount = (value: string) => value.split(CMB_PROVENANCE_GUIDANCE).length - 1;
for (const format of ["none", "xml", "markdown"] as const) {
  const lore = wrapContent(withCmbProvenance(group[0]!, "Group body."), "World Info", format);
  const recent = wrapContent(withCmbProvenance(dm[0]!, "DM body."), "CMB Recent DM Memory", format);
  const messages = [
    { role: "assistant", contextKind: "history", content: lore },
    { role: "system", content: lore },
    { role: "system", content: recent },
  ];
  dedupeCmbProvenanceGuidance(messages);
  assert.equal(messages[0]!.content, lore, "historical assistant text remains verbatim");
  assert.equal(
    guidanceCount(
      messages
        .slice(1)
        .map((a) => a.content)
        .join("\n"),
    ),
    1,
  );
  assert.ok(messages[2]!.content.includes(at) && messages[2]!.content.includes('dm chat ID "dm"'));
  assert.ok(messages[2]!.content.includes("DM body."));
  const once = JSON.stringify(messages);
  dedupeCmbProvenanceGuidance(messages);
  assert.equal(JSON.stringify(messages), once);
  const dmOnly = [{ role: "system", content: recent }];
  dedupeCmbProvenanceGuidance(dmOnly);
  assert.equal(dmOnly[0]!.content, recent, "DM keeps guidance when general lore has no permitted selection");
  const merged = [{ role: "system", content: lore + "\n\n" + recent }];
  dedupeCmbProvenanceGuidance(merged);
  assert.equal(guidanceCount(merged[0]!.content), 1);
}
const quoted = [
  { role: "system", content: CMB_PROVENANCE_GUIDANCE },
  { role: "system", content: withCmbProvenance(group[0]!, CMB_PROVENANCE_GUIDANCE) },
  { role: "system", content: withCmbProvenance(dm[0]!, "body") },
];
dedupeCmbProvenanceGuidance(quoted);
assert.equal(
  guidanceCount(quoted.map((a) => a.content).join("\n")),
  3,
  "only header instructions are deduplicated, not matching leaf text",
);
const route = readFileSync(new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url), "utf8");
const dedupeAt = route.indexOf("dedupeCmbProvenanceGuidance(preparedMessagesForGen)");
assert.ok(dedupeAt > route.indexOf("const scopedLorebookScan = await scopedScanPromise"));
assert.ok(dedupeAt > route.indexOf("const individualRpCmbContextBlock = await"));
assert.ok(dedupeAt < route.indexOf("const toProviderMessages ="));
console.info(
  "CMB search balance: configured limits, relevant/visible candidates, ordinary lore, budgets and per-responder single guidance PASS",
);
