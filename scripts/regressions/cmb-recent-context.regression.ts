import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  appSettings,
  characters,
  chats,
  installedExtensions,
  lorebookEntries,
  lorebookFolders,
  lorebooks,
  messages,
  personalExtensionCoordination,
} from "../../packages/server/src/db/schema/index.js";
import { buildCmbRecentContext } from "../../packages/server/src/services/conversation/autonomous-cmb-context.service.js";
import { computePersonalExtensionHash } from "../../packages/server/src/services/extensions/personal-extension-hash.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-cmb-recent-context-"));
const previousStorage = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;
const db = await createFileNativeDB();
const cast = ["character-a", "character-b"];
const extensionId = "cmb-fixture";
const bookId = "cmb-book";
const rpId = "rp-shared";
const groups = ["group-one", "group-two"];
const members = cast.map((characterId, index) => ({ castId: index ? "b" : "a", characterId, dmChatId: `dm-${index}` }));
const stamp = (minute: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + minute * 60_000).toISOString();
const sourceJs = "(() => undefined)();";
const contentHash = computePersonalExtensionHash({
  runtime: "client",
  capabilities: [],
  css: null,
  js: sourceJs,
  serverJs: null,
});
const failures: Error[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.info(`PASS: ${name}`);
  } catch (error) {
    failures.push(new Error(name, { cause: error }));
    console.error(`FAIL: ${name}`, error);
  }
}

function config(groupIds = groups) {
  return {
    schemaVersion: 1,
    ensembles: [
      {
        ensembleId: "ensemble",
        name: "Fixture cast",
        lorebookId: bookId,
        rpChatId: rpId,
        groupConvoChatIds: groupIds,
        members,
      },
    ],
  };
}

async function setConfig(groupIds = groups): Promise<void> {
  await db
    .update(appSettings)
    .set({ value: JSON.stringify({ convoMemoryBridgeV1: config(groupIds) }) })
    .where(eq(appSettings.key, `extension-storage:${extensionId}`));
  await db
    .update(lorebooks)
    .set({
      scope: JSON.stringify({
        mode: "specific",
        chatIds: [rpId, ...groupIds, ...members.map((member) => member.dmChatId)],
      }),
    })
    .where(eq(lorebooks.id, bookId));
}

type MessageFixture = { content: string; minute?: number; extra?: Record<string, unknown> };
async function setMessages(chatId: string, rows: MessageFixture[]): Promise<void> {
  await db.delete(messages).where(eq(messages.chatId, chatId));
  if (!rows.length) return;
  await db.insert(messages).values(
    rows.map((row, index) => ({
      id: `${chatId}-${index}`,
      chatId,
      role: "user" as const,
      content: row.content,
      extra: JSON.stringify(row.extra ?? {}),
      createdAt: stamp(row.minute ?? index + 1),
    })),
  );
}

async function clearManaged(): Promise<void> {
  await db.delete(lorebookEntries).where(eq(lorebookEntries.lorebookId, bookId));
}

async function managedRow(
  unknownToCastIds: string[] = [],
  overrides: {
    enabled?: string;
    characterFilterMode?: "include" | "exclude" | "any";
    characterFilterIds?: string;
  } = {},
): Promise<void> {
  await clearManaged();
  await db.insert(lorebookEntries).values({
    id: "managed-entry",
    lorebookId: bookId,
    name: "Synthetic memory",
    content: "Synthetic memory body must not be read by the recent-source helper",
    tag: "convo-memory-bridge",
    enabled: "true",
    characterFilterMode: "include",
    characterFilterIds: JSON.stringify(cast),
    dynamicState: JSON.stringify({
      convoMemoryBridge: {
        schemaVersion: 1,
        memoryId: "memory",
        ensembleId: "ensemble",
        rosterBindings: members.map(({ castId, characterId }) => ({ castId, characterId })),
        unknownToCastIds,
        ambiguousProvenance: false,
        source: {
          kind: "native-memory-chunk",
          canonicalFingerprint: "canonical",
          firstMessageAt: stamp(1),
          lastMessageAt: stamp(3),
          occurrences: [{ chatId: groups[0], chatRole: "group", chunkId: "chunk", locatorFingerprint: "locator" }],
        },
      },
    }),
    createdAt: stamp(3),
    updatedAt: stamp(3),
    ...overrides,
  });
}

async function setOwnDmMemory(content: string): Promise<void> {
  await managedRow();
  const [saved] = await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, "managed-entry"));
  const dynamic = JSON.parse(saved!.dynamicState);
  dynamic.convoMemoryBridge.source.occurrences[0] = {
    chatId: members[0]!.dmChatId,
    chatRole: "dm",
    chunkId: "chunk",
    locatorFingerprint: "locator",
  };
  await db
    .update(lorebookEntries)
    .set({ content, dynamicState: JSON.stringify(dynamic) })
    .where(eq(lorebookEntries.id, "managed-entry"));
}

async function build(
  targetChatId = rpId,
  targetCharacterIds = cast,
  generation: "ordinary" | "autonomous" = "ordinary",
) {
  return buildCmbRecentContext({ db, targetChatId, targetCharacterIds, generation, timeZone: "UTC" });
}

try {
  await db.insert(lorebooks).values({
    id: bookId,
    name: "Synthetic CMB book",
    enabled: "true",
    scope: JSON.stringify({
      mode: "specific",
      chatIds: [rpId, ...groups, ...members.map((member) => member.dmChatId)],
    }),
    createdAt: stamp(0),
    updatedAt: stamp(0),
  });
  await db.insert(installedExtensions).values({
    id: extensionId,
    name: "Convo Memory Bridge",
    version: "fixture",
    runtime: "client",
    capabilities: "[]",
    source: "local",
    enabled: "true",
    js: sourceJs,
    css: null,
    serverJs: null,
    contentHash,
    approvedHash: contentHash,
    installedAt: stamp(0),
    createdAt: stamp(0),
    updatedAt: stamp(0),
  });
  await db.insert(personalExtensionCoordination).values({
    extensionId,
    contentHash,
    mode: "active",
    serverBootId: "fixture",
    createdAt: stamp(0),
    updatedAt: stamp(0),
  });
  await db.insert(appSettings).values({
    key: `extension-storage:${extensionId}`,
    value: JSON.stringify({ convoMemoryBridgeV1: config() }),
    updatedAt: stamp(0),
  });
  await db
    .insert(characters)
    .values(cast.map((id) => ({ id, data: JSON.stringify({ name: id }), createdAt: stamp(0), updatedAt: stamp(0) })));
  await db.insert(chats).values([
    {
      id: rpId,
      name: "Shared RP",
      mode: "roleplay" as const,
      characterIds: JSON.stringify(cast),
      metadata: '{"groupChatMode":"merged"}',
      createdAt: stamp(0),
      updatedAt: stamp(0),
    },
    ...groups.map((id) => ({
      id,
      name: id,
      mode: "conversation" as const,
      characterIds: JSON.stringify(cast),
      metadata: '{"crossChatAwareness":false}',
      createdAt: stamp(0),
      updatedAt: stamp(0),
    })),
    ...members.map((member) => ({
      id: member.dmChatId,
      name: member.dmChatId,
      mode: "conversation" as const,
      characterIds: JSON.stringify([member.characterId]),
      metadata: '{"crossChatAwareness":false}',
      createdAt: stamp(0),
      updatedAt: stamp(0),
    })),
  ]);
  await setMessages(rpId, [{ content: "CURRENT-RP-ONLY" }]);
  await setMessages(members[0]!.dmChatId, [{ content: "PRIVATE-DM-A", minute: 90 }]);
  await setMessages(members[1]!.dmChatId, [{ content: "PRIVATE-DM-B", minute: 91 }]);

  await check("ordinary RP reads registered shared groups without current RP or DMs", async () => {
    await setMessages(groups[0]!, [{ content: "SHARED-GROUP-ONE" }]);
    await setMessages(groups[1]!, [{ content: "SHARED-GROUP-TWO" }]);
    const result = await build();
    assert.equal(result.scope, "managed");
    assert.equal(result.rpChatId, rpId);
    assert.ok(result.block?.includes("SHARED-GROUP-ONE"));
    assert.ok(result.block?.includes("SHARED-GROUP-TWO"));
    assert.doesNotMatch(result.block!, /PRIVATE-DM|CURRENT-RP-ONLY/u);
  });

  await check("ordinary groups require their full audience and omit the current room", async () => {
    const partial = await build(groups[0]!, [cast[0]!]);
    assert.equal(partial.block, null);
    const result = await build(groups[0]!);
    assert.ok(result.block?.includes("CURRENT-RP-ONLY"));
    assert.ok(result.block?.includes("SHARED-GROUP-TWO"));
    assert.doesNotMatch(result.block!, /SHARED-GROUP-ONE|PRIVATE-DM/u);
  });

  await check("RP sources allow merged or Individual without widening Conversation audiences", async () => {
    try {
      for (const groupChatMode of [undefined, "merged", "individual"]) {
        await db
          .update(chats)
          .set({ metadata: JSON.stringify({ groupChatMode }) })
          .where(eq(chats.id, rpId));
        for (const generation of ["ordinary", "autonomous"] as const) {
          const audience = generation === "ordinary" ? cast : [cast[0]!];
          const result = await build(groups[0]!, audience, generation);
          assert.ok(result.block?.includes("CURRENT-RP-ONLY"), `${generation}: ${groupChatMode}`);
          assert.doesNotMatch(result.block!, /PRIVATE-DM/u);
        }
        assert.equal((await build(groups[0]!, [cast[0]!])).block, null, "ordinary groups still require everyone");
      }
      for (const groupChatMode of [null, "unknown", "", false, 1, [], {}]) {
        await db
          .update(chats)
          .set({ metadata: JSON.stringify({ groupChatMode }) })
          .where(eq(chats.id, rpId));
        assert.equal((await build(groups[0]!)).block, null, "invalid RP source modes stay closed");
      }
    } finally {
      await db.update(chats).set({ metadata: '{"groupChatMode":"merged"}' }).where(eq(chats.id, rpId));
    }
  });

  await check("Individual RP requires one registered speaker and the entire registered active roster", async () => {
    try {
      await db.update(chats).set({ metadata: '{"groupChatMode":"individual"}' }).where(eq(chats.id, rpId));
      for (const speaker of cast) {
        const result = await build(rpId, [speaker]);
        assert.equal(result.scope, "managed");
        assert.ok(result.block?.includes("SHARED-GROUP-ONE"));
        assert.doesNotMatch(result.block!, /PRIVATE-DM|CURRENT-RP-ONLY/u);
      }
      for (const audience of [[], cast, [cast[0]!, cast[0]!], ["outsider"]]) {
        assert.equal((await build(rpId, audience)).block, null, "no implicit, combined, duplicate or unmapped speaker");
      }
      assert.equal((await build(rpId, [cast[0]!], "autonomous")).block, null, "autonomous RP remains unsupported");
      for (const patch of [
        { characterIds: JSON.stringify([cast[0]]) },
        { characterIds: JSON.stringify([...cast, "outsider"]) },
        {
          characterIds: JSON.stringify(cast),
          metadata: JSON.stringify({ groupChatMode: "individual", inactiveCharacterIds: [cast[1]] }),
        },
        { metadata: '{"groupChatMode":"individual","sceneStatus":"active"}' },
        { metadata: '{"groupChatMode":"unknown"}' },
        { metadata: '{"groupChatMode":"merged"}' },
      ]) {
        await db.update(chats).set(patch).where(eq(chats.id, rpId));
        assert.equal((await build(rpId, [cast[0]!])).block, null, "narrow audience never bypasses target validation");
      }
      assert.ok((await build()).block, "merged still accepts its complete audience");
      await db.update(chats).set({ metadata: "{}" }).where(eq(chats.id, rpId));
      assert.ok((await build()).block, "omitted mode defaults to merged with a full audience");
      assert.equal((await build(rpId, [cast[0]!])).block, null);
      for (const groupChatMode of [null, "unknown", "", false, 1, [], {}]) {
        await db
          .update(chats)
          .set({ metadata: JSON.stringify({ groupChatMode }) })
          .where(eq(chats.id, rpId));
        assert.equal((await build()).block, null, "malformed target mode cannot enter the merged path");
        assert.equal(
          (await build(rpId, [cast[0]!])).block,
          null,
          "malformed target mode cannot enter the speaker path",
        );
      }
    } finally {
      await db
        .update(chats)
        .set({ characterIds: JSON.stringify(cast), metadata: '{"groupChatMode":"merged"}' })
        .where(eq(chats.id, rpId));
    }
  });

  await check("Individual RP applies source visibility and conversation starts to its actual speaker", async () => {
    await setMessages(groups[0]!, [
      { content: "BEFORE-B-ONLY-START", minute: 1 },
      {
        content: "B-ONLY-START",
        minute: 2,
        extra: { conversationStartForCharacterIds: [cast[1]], hiddenFromAI: true },
      },
      { content: "FOR-A-ONLY", minute: 3, extra: { hiddenFromAICharacterIds: [cast[1]] } },
      { content: "FOR-B-ONLY", minute: 4, extra: { hiddenFromAICharacterIds: [cast[0]] } },
      { content: "SHARED-AFTER-START", minute: 5 },
      { content: "GLOBALLY-HIDDEN", minute: 6, extra: { hiddenFromAI: true } },
    ]);
    await setMessages(groups[1]!, []);
    try {
      await db.update(chats).set({ metadata: '{"groupChatMode":"individual"}' }).where(eq(chats.id, rpId));
      const a = await build(rpId, [cast[0]!]);
      assert.match(a.block!, /BEFORE-B-ONLY-START/u);
      assert.match(a.block!, /FOR-A-ONLY/u);
      assert.doesNotMatch(a.block!, /FOR-B-ONLY|GLOBALLY-HIDDEN|PRIVATE-DM|CURRENT-RP-ONLY/u);
      const b = await build(rpId, [cast[1]!]);
      assert.match(b.block!, /FOR-B-ONLY/u);
      assert.match(b.block!, /SHARED-AFTER-START/u);
      assert.doesNotMatch(b.block!, /BEFORE-B-ONLY-START|FOR-A-ONLY|GLOBALLY-HIDDEN|PRIVATE-DM|CURRENT-RP-ONLY/u);
      await db.update(chats).set({ metadata: '{"crossChatAwareness":true}' }).where(eq(chats.id, groups[0]!));
      assert.equal((await build(rpId, [cast[0]!])).block, null, "source CWA remains fail-closed");
    } finally {
      await db.update(chats).set({ metadata: '{"groupChatMode":"merged"}' }).where(eq(chats.id, rpId));
      await db.update(chats).set({ metadata: '{"crossChatAwareness":false}' }).where(eq(chats.id, groups[0]!));
    }
  });

  await check("Individual RP respects managed unknownTo, character filters and local OFF overrides", async () => {
    await setMessages(groups[0]!, [
      { content: "COVERED-INDIVIDUAL-CONTEXT", minute: 1 },
      { content: "UNCOVERED-INDIVIDUAL-CONTEXT", minute: 4 },
    ]);
    try {
      await db.update(chats).set({ metadata: '{"groupChatMode":"individual"}' }).where(eq(chats.id, rpId));
      for (const fixture of [
        { unknownTo: ["b"], overrides: {}, visible: [true, false] },
        { unknownTo: [], overrides: { characterFilterIds: JSON.stringify([cast[0]]) }, visible: [true, false] },
        {
          unknownTo: [],
          overrides: { characterFilterMode: "exclude" as const, characterFilterIds: JSON.stringify([cast[0]]) },
          visible: [false, true],
        },
        { unknownTo: [], overrides: { enabled: "false" }, visible: [false, false] },
      ]) {
        await managedRow(fixture.unknownTo, fixture.overrides);
        for (const [index, speaker] of cast.entries()) {
          const result = await build(rpId, [speaker]);
          assert.ok(result.block?.includes("UNCOVERED-INDIVIDUAL-CONTEXT"));
          assert.equal(result.block!.includes('message="COVERED-INDIVIDUAL-CONTEXT"'), fixture.visible[index]);
        }
      }
      await managedRow();
      await db
        .update(chats)
        .set({
          metadata: JSON.stringify({
            groupChatMode: "individual",
            entryStateOverrides: { "managed-entry": { enabled: false } },
          }),
        })
        .where(eq(chats.id, rpId));
      assert.doesNotMatch((await build(rpId, [cast[0]!])).block!, /message="COVERED-INDIVIDUAL-CONTEXT"/u);
      await db
        .update(chats)
        .set({ metadata: JSON.stringify({ groupChatMode: "individual", excludedLorebookIds: [bookId] }) })
        .where(eq(chats.id, rpId));
      assert.equal((await build(rpId, [cast[0]!])).block, null);
    } finally {
      await clearManaged();
      await db.update(chats).set({ metadata: '{"groupChatMode":"merged"}' }).where(eq(chats.id, rpId));
    }
  });

  await check("Individual RP pins only a permitted saved own-DM memory, never a DM transcript", async () => {
    try {
      await db.update(chats).set({ metadata: '{"groupChatMode":"individual"}' }).where(eq(chats.id, rpId));
      await managedRow();
      const [saved] = await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, "managed-entry"));
      const dynamic = JSON.parse(saved!.dynamicState);
      dynamic.convoMemoryBridge.source.occurrences[0] = {
        chatId: members[0]!.dmChatId,
        chatRole: "dm",
        chunkId: "chunk",
        locatorFingerprint: "locator",
      };
      const body = "SAVED-OWN-DM";
      await db
        .update(lorebookEntries)
        .set({ content: body, dynamicState: JSON.stringify(dynamic) })
        .where(eq(lorebookEntries.id, "managed-entry"));
      const a = await build(rpId, [cast[0]!]);
      assert.match(a.block!, /SAVED-OWN-DM/u);
      assert.match(a.block!, /<cmb_recent_dm_memory>/u);
      assert.match(a.block!, /2026-09-24T00:03:00.000Z/u);
      assert.ok(a.blockWithoutProvenanceGuidance?.includes(body));
      assert.ok(!a.blockWithoutProvenanceGuidance?.includes("Record times are not in-world event dates."));
      assert.equal(
        a.block!.replace(/^[ \t]*Record times are not in-world event dates[^\n]*\n/mu, ""),
        a.blockWithoutProvenanceGuidance,
      );
      assert.doesNotMatch(a.block!, /PRIVATE-DM-A|PRIVATE-DM-B/u);
      assert.doesNotMatch((await build(rpId, [cast[1]!])).block!, /SAVED-OWN-DM|PRIVATE-DM/u);
      await db.update(chats).set({ metadata: '{"groupChatMode":"merged"}' }).where(eq(chats.id, rpId));
      assert.doesNotMatch((await build()).block!, /SAVED-OWN-DM|PRIVATE-DM/u);
      await db.update(chats).set({ metadata: '{"groupChatMode":"individual"}' }).where(eq(chats.id, rpId));
      for (const patch of [
        { enabled: "false" },
        { enabled: "true", characterFilterIds: JSON.stringify([cast[1]]) },
        {
          characterFilterIds: JSON.stringify(cast),
          dynamicState: JSON.stringify({
            ...dynamic,
            convoMemoryBridge: { ...dynamic.convoMemoryBridge, unknownToCastIds: ["a"] },
          }),
        },
        { dynamicState: JSON.stringify({ ...dynamic, convoMemoryBridgeCompression: { schemaVersion: 2 } }) },
        { dynamicState: JSON.stringify(dynamic), content: "LARGE".repeat(1400) },
      ]) {
        await db.update(lorebookEntries).set(patch).where(eq(lorebookEntries.id, "managed-entry"));
        assert.doesNotMatch((await build(rpId, [cast[0]!])).block ?? "", /SAVED-OWN-DM|LARGE|PRIVATE-DM/u);
      }
      await db
        .update(lorebookEntries)
        .set({ content: body, dynamicState: JSON.stringify(dynamic) })
        .where(eq(lorebookEntries.id, "managed-entry"));
      await db
        .update(chats)
        .set({
          metadata: JSON.stringify({
            groupChatMode: "individual",
            entryStateOverrides: { "managed-entry": { enabled: false } },
          }),
        })
        .where(eq(chats.id, rpId));
      assert.doesNotMatch((await build(rpId, [cast[0]!])).block!, /SAVED-OWN-DM/u);
      await db.update(chats).set({ metadata: '{"groupChatMode":"individual"}' }).where(eq(chats.id, rpId));
      await db
        .update(chats)
        .set({ characterIds: JSON.stringify(cast) })
        .where(eq(chats.id, members[0]!.dmChatId));
      assert.equal((await build(rpId, [cast[0]!])).block, null, "a group mislabeled as the own DM stays closed");
      await db
        .update(chats)
        .set({ characterIds: JSON.stringify([cast[0]]) })
        .where(eq(chats.id, members[0]!.dmChatId));
      await setMessages(groups[0]!, [{ content: "x".repeat(1000) }]);
      await setMessages(groups[1]!, [{ content: "y".repeat(1000) }]);
      const final = await build(rpId, [cast[0]!]);
      assert.match(final.block!, /SAVED-OWN-DM/u);
      assert.ok(final.block!.length <= 12000);
      const [stored] = await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, "managed-entry"));
      assert.equal(stored!.content, body, "the prompt read never rewrites the original");
    } finally {
      await clearManaged();
      await db.update(chats).set({ metadata: '{"groupChatMode":"merged"}' }).where(eq(chats.id, rpId));
      await db
        .update(chats)
        .set({ characterIds: JSON.stringify([cast[0]]) })
        .where(eq(chats.id, members[0]!.dmChatId));
    }
  });

  await check("Individual RP pins its own saved DM even with no shared Conversation rooms", async () => {
    try {
      await setConfig([]);
      await db.update(chats).set({ metadata: '{"groupChatMode":"individual"}' }).where(eq(chats.id, rpId));
      await setOwnDmMemory("DM-ONLY-SAVED");
      const dmOnly = await build(rpId, [cast[0]!]);
      assert.match(dmOnly.block ?? "", /DM-ONLY-SAVED/u);
      assert.match(dmOnly.blockWithoutProvenanceGuidance ?? "", /DM-ONLY-SAVED/u);
      assert.equal(
        dmOnly.block!.replace(/^[ \t]*Record times are not in-world event dates[^\n]*\n/mu, ""),
        dmOnly.blockWithoutProvenanceGuidance,
      );
      assert.equal((await build(rpId, [cast[1]!])).block, null, "another cast member cannot read the saved DM");
      const [saved] = await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, "managed-entry"));
      const dynamic = JSON.parse(saved!.dynamicState);
      dynamic.convoMemoryBridge.unknownToCastIds = ["a"];
      await db
        .update(lorebookEntries)
        .set({ dynamicState: JSON.stringify(dynamic) })
        .where(eq(lorebookEntries.id, "managed-entry"));
      assert.equal((await build(rpId, [cast[0]!])).block, null, "unknownTo stays closed without shared sources");
      await setOwnDmMemory("DM-ONLY-SAVED");
      await db
        .update(chats)
        .set({ metadata: JSON.stringify({ crossChatAwareness: false, inactiveCharacterIds: [cast[0]] }) })
        .where(eq(chats.id, members[0]!.dmChatId));
      assert.equal((await build(rpId, [cast[0]!])).block, null, "inactive DM stays closed without shared sources");
      await db
        .update(chats)
        .set({ metadata: '{"crossChatAwareness":false}' })
        .where(eq(chats.id, members[0]!.dmChatId));
      await db.update(chats).set({ metadata: '{"groupChatMode":"merged"}' }).where(eq(chats.id, rpId));
      assert.equal((await build()).block, null, "merged RP cannot promote the private memory");
    } finally {
      await clearManaged();
      await setConfig();
      await db.update(chats).set({ metadata: '{"groupChatMode":"merged"}' }).where(eq(chats.id, rpId));
      await db
        .update(chats)
        .set({ metadata: '{"crossChatAwareness":false}' })
        .where(eq(chats.id, members[0]!.dmChatId));
    }
  });

  await check("Individual RP bounds the final multiline DM block in XML, markdown and none", async () => {
    try {
      await db.update(chats).set({ metadata: '{"groupChatMode":"individual"}' }).where(eq(chats.id, rpId));
      await setMessages(groups[0]!, []);
      await setMessages(groups[1]!, []);
      const body = "x\n".repeat(2500);
      await setOwnDmMemory(body);
      for (const wrapFormat of ["xml", "markdown", "none"] as const) {
        const result = await buildCmbRecentContext({
          db,
          targetChatId: rpId,
          targetCharacterIds: [cast[0]!],
          generation: "ordinary",
          timeZone: "UTC",
          wrapFormat,
        });
        assert.ok(
          result.block === null || result.block.length <= 12000,
          "post-wrap bound also applies without raw messages",
        );
        if (wrapFormat === "xml") assert.equal(result.block, null, "oversized XML memory is omitted whole");
        else assert.ok(result.block?.includes(body.trim()), "unexpanded body remains available within the bound");
      }
      await setMessages(groups[0]!, [{ content: "SMALL-SHARED-RAW" }]);
      const raw = await build(rpId, [cast[0]!]);
      assert.match(raw.block ?? "", /SMALL-SHARED-RAW/u);
      assert.doesNotMatch(raw.block ?? "", /<cmb_recent_dm_memory>/u);
      assert.ok(raw.block!.length <= 12000);
      const [saved] = await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, "managed-entry"));
      assert.equal(saved!.content, body, "rejecting the prompt block never clips stored memory");
    } finally {
      await clearManaged();
      await db.update(chats).set({ metadata: '{"groupChatMode":"merged"}' }).where(eq(chats.id, rpId));
    }
  });

  await check("a message hidden from any audience member stays private", async () => {
    await setMessages(groups[0]!, [
      { content: "VISIBLE-TO-ALL" },
      { content: "HIDDEN-FROM-B", extra: { hiddenFromAICharacterIds: [cast[1]] } },
    ]);
    await setMessages(groups[1]!, []);
    const shared = await build();
    assert.ok(shared.block?.includes("VISIBLE-TO-ALL"));
    assert.doesNotMatch(shared.block!, /HIDDEN-FROM-B/u);
    const privateAudience = await build(members[0]!.dmChatId, [cast[0]!]);
    assert.ok(privateAudience.block?.includes("HIDDEN-FROM-B"));
  });

  await check("disabled, missing or out-of-scope books retain managed scope without a raw fallback", async () => {
    try {
      for (const patch of [
        { enabled: "false" },
        { enabled: "true", scope: '{"mode":"disabled","chatIds":[]}' },
        { scope: JSON.stringify({ mode: "specific", chatIds: groups }) },
      ]) {
        await db.update(lorebooks).set(patch).where(eq(lorebooks.id, bookId));
        const result = await build();
        assert.deepEqual(result, { block: null, scope: "managed", rpChatId: rpId });
      }
      const missing = config();
      missing.ensembles[0]!.lorebookId = "missing-book";
      await db
        .update(appSettings)
        .set({ value: JSON.stringify({ convoMemoryBridgeV1: missing }) })
        .where(eq(appSettings.key, `extension-storage:${extensionId}`));
      assert.deepEqual(await build(), { block: null, scope: "managed", rpChatId: rpId });
    } finally {
      await db.update(lorebooks).set({ enabled: "true" }).where(eq(lorebooks.id, bookId));
      await setConfig();
    }
  });

  await check("per-chat excluded books cannot re-enter through recent context", async () => {
    const rows = await db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, rpId));
    const originalMetadata = rows[0]!.metadata;
    const metadata = JSON.parse(originalMetadata) as Record<string, unknown>;
    try {
      await db
        .update(chats)
        .set({ metadata: JSON.stringify({ ...metadata, excludedLorebookIds: [bookId] }) })
        .where(eq(chats.id, rpId));
      assert.deepEqual(await build(), { block: null, scope: "managed", rpChatId: rpId });
      await db
        .update(chats)
        .set({ metadata: JSON.stringify({ ...metadata, excludedLorebookIds: ["other-book"] }) })
        .where(eq(chats.id, rpId));
      assert.ok((await build()).block?.includes("VISIBLE-TO-ALL"), "excluding another book keeps CMB available");
      await db
        .update(chats)
        .set({ metadata: JSON.stringify({ ...metadata, excludedLorebookIds: { malformed: true } }) })
        .where(eq(chats.id, rpId));
      assert.deepEqual(await build(), { block: null, scope: "managed", rpChatId: rpId });
    } finally {
      await db.update(chats).set({ metadata: originalMetadata }).where(eq(chats.id, rpId));
    }
  });

  await check("global conversation starts cut older shared source text even when the marker is hidden", async () => {
    await setMessages(groups[0]!, [
      { content: "BEFORE-GLOBAL-START" },
      { content: "GLOBAL-START-MARKER", extra: { isConversationStart: true, hiddenFromAI: true } },
      { content: "AFTER-GLOBAL-START" },
    ]);
    const result = await build();
    assert.ok(result.block?.includes("AFTER-GLOBAL-START"));
    assert.doesNotMatch(result.block!, /BEFORE-GLOBAL-START|GLOBAL-START-MARKER/u);
  });

  await check("malformed global start flags omit recent context instead of reopening earlier history", async () => {
    for (const isConversationStart of ["true", "false", 1, 0, null, [], {}]) {
      await setMessages(groups[0]!, [
        { content: "BEFORE-MALFORMED-START" },
        { content: "MALFORMED-START-MARKER", extra: { isConversationStart, hiddenFromAI: true } },
        { content: "AFTER-MALFORMED-START" },
      ]);
      assert.deepEqual(await build(), { block: null, scope: "managed", rpChatId: rpId });
    }
    await setMessages(groups[0]!, [
      { content: "BEFORE-FALSE-FLAG" },
      { content: "FALSE-FLAG-MARKER", extra: { isConversationStart: false, hiddenFromAI: true } },
    ]);
    assert.ok((await build()).block?.includes("BEFORE-FALSE-FLAG"), "a valid false flag is not a reset");
  });

  await check("per-character starts cut shared audience history but not an unaffected DM audience", async () => {
    await setMessages(groups[0]!, [
      { content: "BEFORE-B-START" },
      { content: "B-START-MARKER", extra: { conversationStartForCharacterIds: [cast[1]], hiddenFromAI: true } },
      { content: "AFTER-B-START" },
    ]);
    const shared = await build();
    assert.ok(shared.block?.includes("AFTER-B-START"));
    assert.doesNotMatch(shared.block!, /BEFORE-B-START/u);
    const unaffected = await build(members[0]!.dmChatId, [cast[0]!]);
    assert.ok(unaffected.block?.includes("BEFORE-B-START"));
    const affected = await build(members[1]!.dmChatId, [cast[1]!]);
    assert.doesNotMatch(affected.block ?? "", /BEFORE-B-START/u);
  });

  await check("eligible materialized memory keeps recent text; unknownTo cannot be bypassed", async () => {
    await setMessages(groups[0]!, [
      { content: "COVERED-PRIVATE-ONE", minute: 1 },
      { content: "COVERED-PRIVATE-TWO", minute: 3 },
      { content: "OUTSIDE-MEMORY-RANGE", minute: 4 },
    ]);
    await managedRow();
    assert.ok((await build()).block?.includes("COVERED-PRIVATE-ONE"));
    await managedRow(["b"]);
    const shared = await build();
    assert.ok(shared.block?.includes("OUTSIDE-MEMORY-RANGE"));
    assert.doesNotMatch(shared.block!, /COVERED-PRIVATE/u);
    assert.ok((await build(members[0]!.dmChatId, [cast[0]!])).block?.includes("COVERED-PRIVATE-ONE"));
  });

  await check("per-chat entry OFF overrides restrict raw coverage without changing global entries", async () => {
    await managedRow();
    const [chat] = await db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, rpId));
    const originalMetadata = chat!.metadata;
    const metadata = JSON.parse(originalMetadata);
    try {
      for (const key of ["entryStateOverrides", "lorebookEntryStateOverrides"]) {
        await db
          .update(chats)
          .set({
            metadata: JSON.stringify({
              ...metadata,
              [key]: { "managed-entry": { enabled: false } },
            }),
          })
          .where(eq(chats.id, rpId));
        const result = await build();
        assert.ok(result.block?.includes("OUTSIDE-MEMORY-RANGE"));
        assert.doesNotMatch(result.block!, /COVERED-PRIVATE/u);
        assert.ok((await build(members[0]!.dmChatId, [cast[0]!])).block?.includes("COVERED-PRIVATE-ONE"));
      }
      await db
        .update(chats)
        .set({
          metadata: JSON.stringify({
            ...metadata,
            entryStateOverrides: { "managed-entry": { enabled: "false" } },
          }),
        })
        .where(eq(chats.id, rpId));
      assert.equal((await build()).block, null);
      const [stored] = await db
        .select({ enabled: lorebookEntries.enabled })
        .from(lorebookEntries)
        .where(eq(lorebookEntries.id, "managed-entry"));
      assert.equal(stored!.enabled, "true");
    } finally {
      await db.update(chats).set({ metadata: originalMetadata }).where(eq(chats.id, rpId));
      await clearManaged();
    }
  });

  await check("entry include/exclude filters and disabled rows restrict covered raw text", async () => {
    for (const override of [
      { characterFilterIds: JSON.stringify([cast[0]]) },
      { characterFilterMode: "exclude" as const, characterFilterIds: JSON.stringify([cast[1]]) },
      { enabled: "false" },
    ]) {
      await managedRow([], override);
      const result = await build();
      assert.ok(result.block?.includes("OUTSIDE-MEMORY-RANGE"));
      assert.doesNotMatch(result.block!, /COVERED-PRIVATE/u);
    }
    await clearManaged();
  });

  await check("disabled folders and ancestors restrict covered raw text without changing entry flags", async () => {
    await db.insert(lorebookFolders).values([
      {
        id: "folder-parent",
        lorebookId: bookId,
        name: "Parent",
        enabled: "false",
        createdAt: stamp(0),
        updatedAt: stamp(0),
      },
      {
        id: "folder-child",
        lorebookId: bookId,
        name: "Child",
        enabled: "true",
        parentFolderId: "folder-parent",
        createdAt: stamp(0),
        updatedAt: stamp(0),
      },
    ]);
    await managedRow();
    await db.update(lorebookEntries).set({ folderId: "folder-child" }).where(eq(lorebookEntries.id, "managed-entry"));
    const parentOff = await build();
    assert.equal(parentOff.scope, "managed");
    assert.ok(parentOff.block?.includes("OUTSIDE-MEMORY-RANGE"));
    assert.doesNotMatch(parentOff.block!, /COVERED-PRIVATE/u);
    await db.update(lorebookFolders).set({ enabled: "true" }).where(eq(lorebookFolders.id, "folder-parent"));
    assert.ok((await build()).block?.includes("COVERED-PRIVATE-ONE"));
    await db.update(lorebookFolders).set({ enabled: "false" }).where(eq(lorebookFolders.id, "folder-child"));
    const childOff = await build();
    assert.ok(childOff.block?.includes("OUTSIDE-MEMORY-RANGE"));
    assert.doesNotMatch(childOff.block!, /COVERED-PRIVATE/u);
    const rows = await db
      .select({ enabled: lorebookEntries.enabled })
      .from(lorebookEntries)
      .where(eq(lorebookEntries.id, "managed-entry"));
    assert.equal(rows[0]?.enabled, "true", "folder gating must not persist a changed entry flag");
    await clearManaged();
  });

  await check("at most four most recently updated source chats are read", async () => {
    await clearManaged();
    const sourceGroups = Array.from({ length: 6 }, (_, index) => `cap-group-${index}`);
    await db.insert(chats).values(
      sourceGroups.map((id, index) => ({
        id,
        name: id,
        mode: "conversation" as const,
        characterIds: JSON.stringify(cast),
        metadata: '{"crossChatAwareness":false}',
        createdAt: stamp(0),
        updatedAt: stamp(index + 1),
      })),
    );
    for (const [index, id] of sourceGroups.entries()) {
      await setMessages(id, [{ content: `CAP-SOURCE-${index}`, minute: 100 - index }]);
    }
    await setConfig(sourceGroups);
    let messageReads = 0;
    const observedDb = new Proxy(db, {
      get(target, key) {
        if (key !== "select") return Reflect.get(target, key);
        return (...args: unknown[]) => {
          const query = Reflect.apply(target.select, target, args);
          const originalFrom = query.from.bind(query);
          query.from = (table: unknown) => {
            if (table === messages) messageReads += 1;
            return originalFrom(table);
          };
          return query;
        };
      },
    });
    const result = await buildCmbRecentContext({
      db: observedDb,
      targetChatId: rpId,
      targetCharacterIds: cast,
      generation: "ordinary",
    });
    assert.equal(messageReads, 4);
    assert.doesNotMatch(
      result.block ?? "",
      /CAP-SOURCE-[01]/u,
      "older chat activity must not be read even if its message is newer",
    );
    for (const index of [2, 3, 4, 5]) assert.ok(result.block?.includes(`CAP-SOURCE-${index}`));
    await setConfig();
  });

  await check("a disabled CMB extension is unavailable, never an unmanaged native fallback", async () => {
    await db.update(installedExtensions).set({ enabled: "false" }).where(eq(installedExtensions.id, extensionId));
    try {
      const result = await build();
      assert.deepEqual(result, { block: null, scope: "unavailable", rpChatId: null });
    } finally {
      await db.update(installedExtensions).set({ enabled: "true" }).where(eq(installedExtensions.id, extensionId));
    }
  });

  await check("an already canceled signal performs no storage reads", async () => {
    let reads = 0;
    const canceledDb = {
      select() {
        reads += 1;
        throw new Error("canceled read");
      },
    } as unknown as typeof db;
    const controller = new AbortController();
    controller.abort();
    const result = await buildCmbRecentContext({
      db: canceledDb,
      targetChatId: rpId,
      targetCharacterIds: cast,
      generation: "ordinary",
      signal: controller.signal,
    });
    assert.deepEqual(result, { block: null, scope: "unavailable", rpChatId: null });
    assert.equal(reads, 0);
  });

  await check("ordinary and autonomous calls share the unfinished timeout slot", async () => {
    for (const firstMode of ["ordinary", "autonomous"] as const) {
      let release!: (rows: never[]) => void;
      const pending = new Promise<never[]>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      const query = {
        from() {
          return query;
        },
        where() {
          return query;
        },
        limit: () => pending,
      };
      const slowDb = {
        select() {
          reads += 1;
          return query;
        },
      } as unknown as typeof db;
      const input = { db: slowDb, targetChatId: members[0]!.dmChatId, targetCharacterIds: [cast[0]!], timeoutMs: 10 };
      const first = await buildCmbRecentContext({ ...input, generation: firstMode });
      assert.equal(first.block, null);
      const secondMode = firstMode === "ordinary" ? "autonomous" : "ordinary";
      await Promise.all(Array.from({ length: 5 }, () => buildCmbRecentContext({ ...input, generation: secondMode })));
      assert.equal(reads, 1, "unfinished work retains one shared slot after timeout");
      release([]);
      await new Promise((resolve) => setImmediate(resolve));
      query.limit = () => Promise.resolve([]);
      assert.equal((await buildCmbRecentContext({ ...input, generation: secondMode })).scope, "unmanaged");
      assert.equal(reads, 2, "settled work releases the slot for the other mode");
    }
  });
} finally {
  await db._fileStore.close();
  if (previousStorage === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorage;
  rmSync(storageDir, { recursive: true, force: true });
}

assert.equal(failures.length, 0, failures.map((error) => `${error.message}: ${String(error.cause)}`).join("\n"));
console.info(
  "CMB recent context: runtime shared sources, audience/start/privacy gates, bounded reads and cancellation PASS",
);
