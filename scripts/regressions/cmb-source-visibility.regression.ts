import assert from "node:assert/strict";
import {
  isCmbSourceMessageRestricted,
  resolveCmbSourceRestrictions,
} from "../../packages/server/src/services/conversation/cmb-source-visibility.js";

const ensemble = {
  ensembleId: "ensemble-1",
  rpChatId: "rp-1",
  groupConvoChatIds: ["group-1", "group-2"],
  members: [
    { castId: "a", characterId: "character-a", dmChatId: "dm-a" },
    { castId: "b", characterId: "character-b", dmChatId: "dm-b" },
  ],
};
const first = "2026-09-24T08:00:00.000Z";
const last = "2026-09-24T08:05:00.000Z";
const before = "2026-09-24T07:59:59.999Z";
const after = "2026-09-24T08:05:00.001Z";
const occurrence = { chatId: "group-1", chatRole: "group", chunkId: "chunk-1", locatorFingerprint: "locator-1" };
const source = {
  kind: "native-memory-chunk",
  canonicalFingerprint: "canonical-1",
  firstMessageAt: first,
  lastMessageAt: last,
  occurrences: [occurrence],
};
const bridge = {
  schemaVersion: 1,
  memoryId: "memory-1",
  ensembleId: ensemble.ensembleId,
  rosterBindings: ensemble.members.map(({ castId, characterId }) => ({ castId, characterId })),
  unknownToCastIds: [] as string[],
  ambiguousProvenance: false,
  source,
};
const row = {
  id: "entry-1",
  enabled: "true",
  characterFilterMode: "include",
  characterFilterIds: JSON.stringify(ensemble.members.map(({ characterId }) => characterId)),
  dynamicState: JSON.stringify({ convoMemoryBridge: bridge }),
};
const audience = ["character-a"];
const snapshot = JSON.stringify({ ensemble, row, bridge, audience });
const withBridge = (patch: Record<string, unknown>) => ({
  ...row,
  dynamicState: JSON.stringify({ convoMemoryBridge: { ...bridge, ...patch } }),
});
const resolve = (entry = row, readers = audience) => resolveCmbSourceRestrictions([entry], ensemble, readers);
const interval = [{ chatId: "group-1", firstMessageAt: first, lastMessageAt: last }];

// A materialized, eligible memory must not hide the same recent raw messages.
assert.deepEqual(resolve(), []);
assert.equal(isCmbSourceMessageRestricted(resolve()!, "group-1", first), false);
assert.equal(
  Array.from({ length: 5 }, (_, minute) => `2026-09-24T08:0${minute}:00.000Z`).filter(
    (createdAt) => !isCmbSourceMessageRestricted(resolve()!, "group-1", createdAt),
  ).length,
  5,
  "all five recent messages remain available even after CMB materialization",
);
assert.deepEqual(resolve(withBridge({ unknownToCastIds: ["b"] })), []);
assert.deepEqual(resolve(withBridge({ unknownToCastIds: ["a"] })), interval);
assert.deepEqual(resolve(withBridge({ unknownToCastIds: ["b"] }), ["character-a", "character-b"]), interval);
assert.deepEqual(resolve({ ...row, characterFilterIds: '["character-b"]' }), interval);
assert.deepEqual(resolve({ ...row, characterFilterMode: "exclude", characterFilterIds: '["character-a"]' }), interval);
assert.deepEqual(resolve({ ...row, characterFilterMode: "exclude", characterFilterIds: '["character-b"]' }), []);
for (const filter of ["CHARACTER-A", "Character-A"]) {
  assert.deepEqual(
    resolve({ ...row, characterFilterMode: "exclude", characterFilterIds: JSON.stringify([filter]) }),
    interval,
    "exclude comparisons use the same case folding as lorebook selection",
  );
  assert.deepEqual(resolve({ ...row, characterFilterIds: JSON.stringify([filter]) }), []);
}
const upperEnsemble = {
  ...ensemble,
  members: ensemble.members.map((member) => ({ ...member, characterId: member.characterId.toUpperCase() })),
};
const upperRow = withBridge({
  rosterBindings: upperEnsemble.members.map(({ castId, characterId }) => ({ castId, characterId })),
});
assert.deepEqual(resolveCmbSourceRestrictions([upperRow], upperEnsemble, ["CHARACTER-A"]), []);
assert.deepEqual(
  resolveCmbSourceRestrictions(
    [{ ...upperRow, characterFilterMode: "exclude", characterFilterIds: '["character-a"]' }],
    upperEnsemble,
    ["CHARACTER-A"],
  ),
  interval,
);
assert.deepEqual(resolve({ ...row, characterFilterMode: "any", characterFilterIds: '["character-a"]' }), []);
assert.deepEqual(resolve({ ...row, characterFilterIds: "[]" }), [], "empty filters match the host's any behavior");
assert.deepEqual(resolve({ ...row, enabled: "false" }), interval);
for (const time of [first, "2026-09-24T08:02:00.000Z", last]) {
  assert.equal(isCmbSourceMessageRestricted(interval, "group-1", time), true);
}
for (const time of [before, after]) assert.equal(isCmbSourceMessageRestricted(interval, "group-1", time), false);
assert.equal(isCmbSourceMessageRestricted(interval, "group-2", first), false);
assert.equal(isCmbSourceMessageRestricted(interval, "group-1", "invalid"), true);

const multipleSource = {
  ...source,
  occurrences: [occurrence, { ...occurrence, chatId: "rp-1", chatRole: "rp", locatorFingerprint: "locator-2" }],
};
const multiple = resolve(withBridge({ source: multipleSource, unknownToCastIds: ["a"], ambiguousProvenance: true }));
assert.deepEqual(multiple, [
  { chatId: "group-1", firstMessageAt: null, lastMessageAt: null },
  { chatId: "rp-1", firstMessageAt: null, lastMessageAt: null },
]);
assert.equal(isCmbSourceMessageRestricted(multiple!, "rp-1", after), true);
assert.deepEqual(resolve(withBridge({ source: multipleSource, ambiguousProvenance: true })), []);
assert.deepEqual(
  resolve(
    withBridge({
      source: { ...source, occurrences: [{ ...occurrence, chatId: "dm-a", chatRole: "dm" }] },
      unknownToCastIds: ["a"],
    }),
  ),
  [],
  "private DMs are never promoted by the raw shared-source reader",
);
assert.equal(resolve(withBridge({ unknownToCastIds: ["a"], ambiguousProvenance: true })), null);

const manualSource = { kind: "manual", createdAt: first, lastEditedAt: last };
assert.deepEqual(resolve(withBridge({ source: manualSource, unknownToCastIds: ["a"] })), []);
assert.deepEqual(resolve({ ...withBridge({ source: manualSource }), enabled: "false" }), []);
assert.deepEqual(resolve(withBridge({ source: { ...source, occurrences: [] }, sourceStatus: "missing" })), []);
assert.equal(
  resolve(withBridge({ source: { ...source, occurrences: [] }, sourceStatus: "missing", unknownToCastIds: ["a"] })),
  null,
);

for (const patch of [
  { schemaVersion: 2 },
  { ensembleId: "other-ensemble" },
  { rosterBindings: [] },
  { rosterBindings: [{ castId: "a", characterId: "character-b" }, bridge.rosterBindings[1]] },
  { rosterBindings: [bridge.rosterBindings[0], bridge.rosterBindings[0]] },
  { rosterBindings: [{ castId: "unknown" }, bridge.rosterBindings[1]] },
  { unknownToCastIds: ["unknown"] },
  { unknownToCastIds: ["a", "a"] },
  { ambiguousProvenance: "true" },
  { sourceStatus: "unknown" },
  { sourceStatus: "missing" },
  { source: null },
  { source: { ...source, occurrences: [] } },
  { source: { ...source, firstMessageAt: "2026-02-30T08:00:00.000Z" } },
  { source: { ...source, firstMessageAt: last, lastMessageAt: first } },
  { source: { ...source, occurrences: [{ ...occurrence, chatId: "other-group" }] } },
  { source: { ...source, occurrences: [{ ...occurrence, chatRole: "dm" }] } },
  { source: { ...source, occurrences: [{ ...occurrence, chatRole: ["group"] }] } },
  { source: { ...manualSource, createdAt: last, lastEditedAt: first } },
  { source: { ...manualSource, occurrences: [occurrence] } },
]) {
  assert.equal(resolve(withBridge(patch)), null, JSON.stringify(patch));
}
for (const invalid of [
  { ...row, dynamicState: "{" },
  { ...row, dynamicState: "{}" },
  { ...row, characterFilterIds: "[" },
  { ...row, characterFilterMode: "unknown" },
  { ...row, enabled: "unknown" },
]) {
  assert.equal(resolve(invalid), null);
}
assert.equal(resolve(row, []), null);
assert.equal(resolve(row, ["other-character"]), null);
assert.equal(resolveCmbSourceRestrictions([row, row], ensemble, audience), null);
const occurrenceRows = Array.from({ length: 129 }, (_, index) => ({
  ...occurrence,
  chunkId: `chunk-${index}`,
  locatorFingerprint: `locator-${index}`,
}));
assert.deepEqual(resolve(withBridge({ source: { ...source, occurrences: occurrenceRows.slice(0, 128) } })), []);
assert.equal(resolve(withBridge({ source: { ...source, occurrences: occurrenceRows } })), null);
const paddedRow = withBridge({ fixturePadding: "x".repeat(850_000) });
const boundedMetadataRows = Array.from({ length: 5 }, (_, index) => ({ ...paddedRow, id: `padded-${index}` }));
assert.deepEqual(resolveCmbSourceRestrictions(boundedMetadataRows.slice(0, 4), ensemble, audience), []);
assert.equal(
  resolveCmbSourceRestrictions(boundedMetadataRows, ensemble, audience),
  null,
  "aggregate metadata over 4 MiB fails closed even when each JSON row is below its individual limit",
);
assert.equal(JSON.stringify({ ensemble, row, bridge, audience }), snapshot, "metadata inputs stay unchanged");
console.log(
  "CMB source visibility: eligible, private, disabled, ambiguous, missing, malformed and immutable fixtures PASS",
);
