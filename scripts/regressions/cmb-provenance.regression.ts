import assert from "node:assert/strict";
import { createLorebookEntrySchema } from "../../packages/shared/src/schemas/lorebook.schema.js";
import { estimateTextTokens, type LorebookEntry } from "../../packages/shared/src/index.js";
import { withCmbProvenance } from "../../packages/server/src/services/lorebook/cmb-provenance.js";
import { resolveAndBudgetActivatedLorebookEntries } from "../../packages/server/src/services/lorebook/index.js";
import { processActivatedEntries } from "../../packages/server/src/services/lorebook/prompt-injector.js";
import type { ActivatedEntry } from "../../packages/server/src/services/lorebook/keyword-scanner.js";

const first = "2026-09-24T08:00:00.000Z";
const last = "2026-09-24T08:05:00.000Z";
const nativeSource = {
  kind: "native-memory-chunk",
  canonicalFingerprint: "fixture",
  firstMessageAt: first,
  lastMessageAt: last,
  occurrences: [{ chatId: "group-1", chatRole: "group", chunkId: "chunk-1", locatorFingerprint: "fixture" }],
};
const entry = {
  ...createLorebookEntrySchema.parse({
    lorebookId: "book",
    name: "Memory",
    content: "[Knowledge boundary]\nUnknown to cast IDs: none\n\n[Memory]\nLunch fragment.",
    tag: "convo-memory-bridge",
    preventRecursion: true,
    dynamicState: { convoMemoryBridge: { schemaVersion: 1, source: nativeSource, ambiguousProvenance: false } },
  }),
  id: "memory-1",
  embedding: [0.2, 0.8],
} as LorebookEntry;
const active: ActivatedEntry = {
  entry,
  matchedKeys: ["[semantic:0.8]"],
  activationSources: ["semantic"],
  injectionOrder: 100,
};
const books = new Map([["book", { name: "Memories", tokenBudget: 0, entryLimit: 50 }]]);
const original = JSON.stringify(entry);
const resolve = (rows: ActivatedEntry[], budget = 0) =>
  resolveAndBudgetActivatedLorebookEntries(rows, books, budget, 50);

// Exercise the real budget resolution and all injection destinations, not just the formatter.
for (const position of [0, 1, 2, 7] as const) {
  const selected = resolve([{ ...active, entry: { ...entry, position, outletName: "fixture" } }]);
  assert.equal(selected.length, 1);
  const content = selected[0]!.entry.content;
  assert.ok(content.includes(first) && content.includes(last));
  assert.ok(content.includes('group chat ID "group-1"'));
  assert.ok(content.includes("not in-world event dates"));
  assert.ok(content.endsWith(entry.content));
  const injected = processActivatedEntries(selected);
  const output =
    position === 0
      ? injected.worldInfoBefore
      : position === 1
        ? injected.worldInfoAfter
        : position === 2
          ? injected.depthEntries[0]!.content
          : injected.outlets.fixture;
  assert.equal(output, content);
  assert.equal(resolve(selected)[0]!.entry.content, content, "repeat resolution must not duplicate metadata");
}
assert.equal(JSON.stringify(entry), original, "stored content, metadata and embedding stay unchanged");
assert.equal(resolve([active], estimateTextTokens(entry.content)).length, 0, "metadata must count toward the budget");
const limitedBooks = new Map([
  ["book", { name: "Memories", tokenBudget: estimateTextTokens(entry.content), entryLimit: 50 }],
]);
assert.equal(resolveAndBudgetActivatedLorebookEntries([active], limitedBooks, 0, 50).length, 0);
const resolved = resolveAndBudgetActivatedLorebookEntries([active], books, 0, 50, (raw) => {
  assert.equal(raw, entry.content, "macro resolver receives only the original body");
  return raw.replace("Lunch", "Resolved lunch");
});
assert.ok(resolved[0]!.entry.content.endsWith(entry.content.replace("Lunch", "Resolved lunch")));
assert.equal(resolveAndBudgetActivatedLorebookEntries([active], books, 0, 50, () => "")[0]!.entry.content, "");
assert.equal(withCmbProvenance({ ...entry, tag: "ordinary" }, entry.content), entry.content);

function annotated(source: unknown, ambiguousProvenance = false) {
  return withCmbProvenance(
    { ...entry, dynamicState: { convoMemoryBridge: { schemaVersion: 1, source, ambiguousProvenance } } },
    entry.content,
  );
}
assert.ok(annotated({ kind: "manual", createdAt: first, lastEditedAt: last }).includes("no source chat asserted"));
assert.ok(annotated({ kind: "manual", createdAt: last, lastEditedAt: first }).includes("time: unknown"));
assert.ok(annotated(nativeSource, true).includes("marked ambiguous"));
assert.ok(annotated({ ...nativeSource, firstMessageAt: "2026-02-30T08:00:00.000Z" }).includes("time: unknown"));
assert.ok(annotated({ ...nativeSource, firstMessageAt: last, lastMessageAt: first }).includes("time: unknown"));
assert.ok(annotated(null).includes("Source room and record time: unknown"));
const missingSource = withCmbProvenance(
  {
    ...entry,
    dynamicState: {
      convoMemoryBridge: {
        schemaVersion: 1,
        source: { ...nativeSource, occurrences: [] },
        sourceStatus: "missing",
      },
    },
  },
  entry.content,
);
assert.ok(missingSource.includes("Original source is marked missing"));
assert.ok(missingSource.includes(first) && missingSource.includes(last));
assert.ok(missingSource.includes("Source room: unknown"));
assert.ok(!missingSource.includes("Recorded source room(s)"));
assert.ok(annotated({ ...nativeSource, occurrences: [] }).includes("Source room: unknown"));
for (const occurrence of [
  { ...nativeSource.occurrences[0], chatRole: ["dm"] },
  ...["   ", " group-1", "group-1 ", "x".repeat(257)].map((chatId) => ({
    ...nativeSource.occurrences[0],
    chatId,
  })),
]) {
  const invalidSource = annotated({ ...nativeSource, occurrences: [occurrence] });
  assert.ok(invalidSource.includes("Source room: unknown"));
  assert.ok(!invalidSource.includes("Recorded source room(s)"));
}
assert.ok(
  annotated({
    ...nativeSource,
    occurrences: Array.from({ length: 33 }, (_, index) => ({
      chatId: `group-${index}`,
      chatRole: "group",
      chunkId: `chunk-${index}`,
      locatorFingerprint: `fixture-${index}`,
    })),
  }).includes("Source room: unknown"),
);
assert.ok(
  annotated({ ...nativeSource, occurrences: [{ chatId: "{{user}}", chatRole: "dm" }] }).includes(
    "Source room: unknown",
  ),
);
assert.ok(
  annotated({
    ...nativeSource,
    occurrences: [...nativeSource.occurrences, { chatId: "rp-1", chatRole: "rp" }],
  }).includes("do not infer a unique original room"),
);
assert.ok(
  withCmbProvenance(
    { ...entry, dynamicState: { convoMemoryBridge: { schemaVersion: 2, source: nativeSource } } },
    entry.content,
  ).includes("unsupported"),
);
console.log("CMB provenance: destinations, budgets, repeat resolution, immutable storage and invalid metadata PASS");
