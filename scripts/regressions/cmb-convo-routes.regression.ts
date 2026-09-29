// CMB Convo routes: one ensemble RP ↔ its registered DMs and full-roster groups. Real FileNativeDB,
// real chat routes (Fastify inject) and the real runtimes; synthetic data only, no model calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import type { DB } from "../../packages/server/src/db/connection.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { characters, chats, conversationNotes, oocInfluences } from "../../packages/server/src/db/schema/index.js";
import { chatsRoutes } from "../../packages/server/src/routes/chats.routes.js";
import { injectConnectedConversationPromptBlocks } from "../../packages/server/src/routes/generate/connected-conversation-injections.js";
import {
  cmbRoutesFingerprint,
  resolveCmbConversationRoute,
  resolveCmbRoleplayRoutes,
  resolveCmbRoleplaySourceChatIds,
  type CmbRoleplayRoutes,
} from "../../packages/server/src/services/conversation/cmb-convo-routes.js";
import { handleConversationSideEffectCommand } from "../../packages/server/src/services/generation/conversation-side-effect-command-runtime.js";
import { handleRoleplayDmCommand } from "../../packages/server/src/services/generation/roleplay-dm-command-runtime.js";
import { normalizeDmTargetName } from "../../packages/server/src/services/generation/roleplay-dm-utils.js";
import {
  buildManagedRoleplayOocInstruction,
  extractRoleplayOocMessages,
  planCmbDirectMessage,
  planManagedRoleplayOoc,
  type RoleplayOocMessage,
} from "../../packages/server/src/services/generation/roleplay-ooc-runtime.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { createCmbCompressionFixture } from "./helpers/cmb-compression-fixture.js";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;

const directory = mkdtempSync(join(tmpdir(), "marinara-cmb-convo-routes-"));
const previousDirectory = process.env.FILE_STORAGE_DIR;
const previousLogLevel = process.env.LOG_LEVEL;
process.env.FILE_STORAGE_DIR = directory;
process.env.LOG_LEVEL = "silent";
const nativeDb = await createFileNativeDB({ fileOperations: { flushDirectory: async () => {} } });
const db = nativeDb as unknown as DB;
const app = Fastify();
app.decorate("db", db);
let checks = 0;

type Active = Extract<CmbRoleplayRoutes, { state: "active" }>;
const active = (routes: CmbRoleplayRoutes): Active => {
  assert.equal(routes.state, "active", JSON.stringify(routes));
  return routes as Active;
};
const ooc = (overrides: Partial<RoleplayOocMessage>): RoleplayOocMessage => ({
  text: "out of character",
  room: null,
  from: null,
  speakerCharacterId: null,
  ...overrides,
});

try {
  await app.register(chatsRoutes, { prefix: "/api/chats" });
  await app.ready();
  const fixture = await createCmbCompressionFixture(db);
  const storage = createChatsStorage(db);
  const stamp = fixture.stamp;
  const trio = ["character-a", "character-b", "character-c"];

  // ── Fixture: RP 1 + DM 3 + groups 2 (one full roster, one partial) ──
  await db.insert(characters).values([
    { id: "character-c", data: JSON.stringify({ name: "차오" }), createdAt: stamp, updatedAt: stamp },
    { id: "character-x", data: JSON.stringify({ name: "엑스" }), createdAt: stamp, updatedAt: stamp },
  ]);
  const insertChat = (id: string, mode: string, characterIds: string[], metadata: Record<string, unknown> = {}) =>
    db.insert(chats).values({
      id,
      name: id,
      mode,
      characterIds: JSON.stringify(characterIds),
      metadata: JSON.stringify(metadata),
      createdAt: stamp,
      updatedAt: stamp,
    });
  await insertChat("dm-c", "conversation", ["character-c"]);
  await insertChat("group-partial", "conversation", ["character-a", "character-b"]);
  await insertChat("outsider", "conversation", ["character-a"]);
  await insertChat("other-rp", "roleplay", ["character-a"]);
  await insertChat("legacy-rp", "roleplay", ["character-a"]);
  await insertChat("legacy-convo", "conversation", ["character-a"]);
  for (const id of ["rp", "group"])
    await db
      .update(chats)
      .set({ characterIds: JSON.stringify([...trio, ...(id === "rp" ? ["character-x"] : [])]) })
      .where(eq(chats.id, id));
  const ensemble = fixture.stored.convoMemoryBridgeV1.ensembles[0]!;
  ensemble.members.push({ castId: "c", characterId: "character-c", dmChatId: "dm-c" });
  ensemble.groupConvoChatIds = ["group", "group-partial"];
  await fixture.saveSettings();
  const countChats = async () => (await db.select({ id: chats.id }).from(chats)).length;

  // ── Resolution and the dedicated API ──
  const get = async (chatId = "rp") => {
    const response = await app.inject({ method: "GET", url: `/api/chats/${chatId}/cmb-routes` });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const put = (body: Record<string, unknown>, chatId = "rp") =>
    app.inject({ method: "PUT", url: `/api/chats/${chatId}/cmb-routes`, payload: body });
  const initial = await get();
  assert.equal(initial.state, "none");
  assert.equal(initial.available, true);
  assert.deepEqual(
    initial.members.map((member: { dm: { chatId: string } | null }) => member.dm?.chatId),
    ["dm-a", "dm-b", "dm-c"],
  );
  assert.deepEqual(
    initial.groups.map((room: { chatId: string }) => room.chatId),
    ["group"],
  );
  assert.deepEqual(initial.excluded, [{ chatId: "group-partial", kind: "group", reason: "partial-roster" }]);
  // An OFF write on a Roleplay that never used the routes must not create the once-opted mark.
  assert.equal((await put({ enabled: false, defaultOocChatId: "group", expectedRevision: 0 })).statusCode, 400);
  assert.equal((await get()).state, "none");
  assert.equal(
    (await put({ enabled: true, defaultOocChatId: " group", expectedRevision: 0 })).statusCode,
    400,
    "a padded ID is refused up front instead of being stored as an unreadable policy",
  );
  assert.equal((await put({ enabled: true, defaultOocChatId: "outsider", expectedRevision: 0 })).statusCode, 400);
  assert.equal((await put({ enabled: true, defaultOocChatId: null, expectedRevision: 0 }, "other-rp")).statusCode, 409);
  assert.equal((await put({ enabled: true, defaultOocChatId: "group", expectedRevision: 0 })).statusCode, 200);
  assert.equal(
    (await put({ enabled: true, defaultOocChatId: "group", expectedRevision: 0 })).statusCode,
    409,
    "a stale revision never overwrites another device's change",
  );
  await app.inject({
    method: "PATCH",
    url: "/api/chats/rp/metadata",
    payload: {
      cmbConvoRoutes: {
        schemaVersion: 1,
        enabled: false,
        ensembleId: "x",
        defaultOocChatId: null,
        revision: 99,
        updatedAt: stamp,
      },
    },
  });
  const enabled = await get();
  assert.equal(enabled.state, "active");
  assert.equal(enabled.policy.revision, 1, "generic metadata PATCH cannot write routes");
  assert.equal((await resolveCmbConversationRoute(db, "dm-b"))?.rpChatId, "rp");
  assert.equal(await resolveCmbConversationRoute(db, "group-partial"), null, "partial rosters are out of scope");
  assert.equal(await resolveCmbConversationRoute(db, "outsider"), null);
  // A registered room natively linked to another story is a conflict, not a second route.
  await db.update(chats).set({ connectedChatId: "other-rp" }).where(eq(chats.id, "dm-c"));
  const conflicted = active(await resolveCmbRoleplayRoutes(db, "rp"));
  assert.equal(
    conflicted.members.find((member) => member.characterId === "character-c")?.dmReason,
    "native-link-conflict",
  );
  assert.equal(await resolveCmbConversationRoute(db, "dm-c"), null);
  await db.update(chats).set({ connectedChatId: null }).where(eq(chats.id, "dm-c"));
  // A DM room is private to its one character: another character in it excludes the room.
  const dmARow = (await db.select().from(chats).where(eq(chats.id, "dm-a")))[0]!;
  await db
    .update(chats)
    .set({ characterIds: JSON.stringify(["character-a", "character-b"]) })
    .where(eq(chats.id, "dm-a"));
  const crowded = active(await resolveCmbRoleplayRoutes(db, "rp"));
  assert.equal(crowded.members.find((member) => member.characterId === "character-a")?.dmReason, "dm-not-private");
  assert.equal(crowded.members.find((member) => member.characterId === "character-a")?.dm, null);
  assert.equal(await resolveCmbConversationRoute(db, "dm-a"), null, "a crowded DM cannot reach the RP either");
  await db.update(chats).set({ characterIds: dmARow.characterIds }).where(eq(chats.id, "dm-a"));
  assert.equal(active(await resolveCmbRoleplayRoutes(db, "rp")).members[0]?.dm?.chatId, "dm-a");
  checks++;

  // ── OOC: speaker and destination are resolved or held; nothing is rerouted ──
  const atStart = active(await resolveCmbRoleplayRoutes(db, "rp"));
  const plan = (messages: RoleplayOocMessage[], now: CmbRoleplayRoutes = atStart, activeIds = trio) =>
    planManagedRoleplayOoc({ messages, routesAtStart: atStart, routesNow: now, activeCharacterIds: activeIds });
  assert.deepEqual(plan([ooc({ from: "보라" })]), [
    { action: "post", chatId: "group", characterId: "character-b", text: "out of character" },
  ]);
  assert.deepEqual(plan([ooc({ speakerCharacterId: "character-a" })])[0], {
    action: "post",
    chatId: "group",
    characterId: "character-a",
    text: "out of character",
  });
  assert.equal(plan([ooc({})])[0]!.action === "hold" && plan([ooc({})])[0]!.reason, "speaker-unknown");
  assert.deepEqual(plan([ooc({})], atStart, ["character-c"])[0], {
    action: "post",
    chatId: "group",
    characterId: "character-c",
    text: "out of character",
  });
  assert.equal((plan([ooc({ from: "아린", room: "group-1" })])[0] as { chatId: string }).chatId, "group");
  assert.deepEqual(plan([ooc({ from: "아린", room: "nowhere" })])[0], {
    action: "hold",
    reason: "room-unknown",
    text: "out of character",
  });
  assert.equal(
    (plan([ooc({ from: "아린", speakerCharacterId: "character-b" })])[0] as { reason: string }).reason,
    "speaker-mismatch",
  );
  assert.equal(
    (plan([ooc({ from: "엑스" })])[0] as { reason: string }).reason,
    "speaker-unresolved",
    "a non-member cannot post",
  );
  await db
    .update(characters)
    .set({ data: JSON.stringify({ name: "보라" }) })
    .where(eq(characters.id, "character-c"));
  const sharedNow = await resolveCmbRoleplayRoutes(db, "rp");
  assert.equal(
    (plan([ooc({ from: "보라" })], sharedNow)[0] as { characterId: string }).characterId,
    "character-b",
    "a name the model was shown keeps its start identity when another character takes it meanwhile",
  );
  const sharedAtStart = active(sharedNow);
  assert.equal(
    (
      planManagedRoleplayOoc({
        messages: [ooc({ from: "보라" })],
        routesAtStart: sharedAtStart,
        routesNow: sharedAtStart,
        activeCharacterIds: trio,
      })[0] as { reason: string }
    ).reason,
    "speaker-unresolved",
    "a name shared by two characters at start is not a confirmed speaker",
  );
  await db
    .update(characters)
    .set({ data: JSON.stringify({ name: "차오" }) })
    .where(eq(characters.id, "character-c"));
  // A mid-generation change holds everything instead of choosing another room.
  assert.equal((await put({ enabled: true, defaultOocChatId: "dm-a", expectedRevision: 1 })).statusCode, 200);
  const changed = plan([ooc({ from: "아린" })], await resolveCmbRoleplayRoutes(db, "rp"));
  assert.deepEqual(changed, [{ action: "hold", reason: "routes-changed", text: "out of character" }]);
  const dmDefault = active(await resolveCmbRoleplayRoutes(db, "rp"));
  const planNow = (messages: RoleplayOocMessage[]) =>
    planManagedRoleplayOoc({ messages, routesAtStart: dmDefault, routesNow: dmDefault, activeCharacterIds: trio });
  assert.equal((planNow([ooc({ from: "보라" })])[0] as { reason: string }).reason, "speaker-not-in-room");
  assert.equal((planNow([ooc({ from: "아린" })])[0] as { chatId: string }).chatId, "dm-a");
  assert.equal((await put({ enabled: true, defaultOocChatId: null, expectedRevision: 2 })).statusCode, 200);
  const noDefault = active(await resolveCmbRoleplayRoutes(db, "rp"));
  assert.equal(
    (
      planManagedRoleplayOoc({
        messages: [ooc({ from: "아린" })],
        routesAtStart: noDefault,
        routesNow: noDefault,
        activeCharacterIds: trio,
      })[0] as { reason: string }
    ).reason,
    "no-default-room",
  );
  assert.equal((await put({ enabled: false, defaultOocChatId: null, expectedRevision: 3 })).statusCode, 200);
  assert.equal(
    (
      planManagedRoleplayOoc({
        messages: [ooc({ from: "아린" })],
        routesAtStart: noDefault,
        routesNow: await resolveCmbRoleplayRoutes(db, "rp"),
        activeCharacterIds: trio,
      })[0] as { reason: string }
    ).reason,
    "routes-changed",
    "OFF during generation holds",
  );
  assert.equal((await put({ enabled: true, defaultOocChatId: "group", expectedRevision: 4 })).statusCode, 200);
  const live = active(await resolveCmbRoleplayRoutes(db, "rp"));
  // The CMB mapping can change while the policy revision stays the same: a swapped DM or reordered
  // groups hold delivery instead of being reinterpreted against the new rooms.
  await insertChat("dm-a-new", "conversation", ["character-a"]);
  const memberA = ensemble.members.find((member) => member.characterId === "character-a")!;
  memberA.dmChatId = "dm-a-new";
  ensemble.groupConvoChatIds = ["group-partial", "group"];
  await fixture.saveSettings();
  const remapped = await resolveCmbRoleplayRoutes(db, "rp");
  assert.equal(active(remapped).policy.revision, live.policy.revision, "the RP-side policy did not change");
  assert.equal(active(remapped).groups[0]?.label, "group-2");
  assert.deepEqual(
    planManagedRoleplayOoc({
      messages: [ooc({ from: "아린", room: "group-1" }), ooc({ from: "아린" })],
      routesAtStart: live,
      routesNow: remapped,
      activeCharacterIds: trio,
    }).map((delivery) => delivery.action === "hold" && delivery.reason),
    ["routes-changed", "routes-changed"],
  );
  assert.deepEqual(
    planCmbDirectMessage({
      routesAtStart: live,
      routesNow: remapped,
      requestedName: "아린",
      resolvedCharacterId: "character-a",
      roleplayCharacters: [{ id: "character-a", name: "아린" }],
      normalizeName: normalizeDmTargetName,
    }),
    { held: "routes-changed" },
  );
  memberA.dmChatId = "dm-a";
  ensemble.groupConvoChatIds = ["group", "group-partial"];
  await fixture.saveSettings();
  assert.equal(
    cmbRoutesFingerprint(active(await resolveCmbRoleplayRoutes(db, "rp"))),
    cmbRoutesFingerprint(live),
    "the restored mapping matches the start again",
  );
  // Names are what the model was shown: with the mapping unchanged, a room renamed meanwhile is
  // still resolved by its name at start, and the new name (never shown) is unknown.
  const groupRowBefore = (await db.select().from(chats).where(eq(chats.id, "group")))[0]!;
  await db.update(chats).set({ name: "Harbor" }).where(eq(chats.id, "group"));
  const namedAtStart = active(await resolveCmbRoleplayRoutes(db, "rp"));
  await db.update(chats).set({ name: "Pier" }).where(eq(chats.id, "group"));
  const renamedNow = await resolveCmbRoleplayRoutes(db, "rp");
  assert.equal(
    cmbRoutesFingerprint(active(renamedNow)),
    cmbRoutesFingerprint(namedAtStart),
    "a rename is not a mapping change",
  );
  assert.deepEqual(
    planManagedRoleplayOoc({
      messages: [ooc({ from: "아린", room: "Harbor" }), ooc({ from: "아린", room: "Pier" })],
      routesAtStart: namedAtStart,
      routesNow: renamedNow,
      activeCharacterIds: trio,
    }).map((delivery) => (delivery.action === "post" ? delivery.chatId : delivery.reason)),
    ["group", "room-unknown"],
  );
  await db.update(chats).set({ name: groupRowBefore.name }).where(eq(chats.id, "group"));
  // Extraction understands attributes only on the managed path; the native path keeps its syntax.
  const managedExtract = extractRoleplayOocMessages(
    'Story.\n<ooc from="보라" room="group-1">hey</ooc>\n<ooc>plain</ooc>',
    {
      managed: true,
      speakerCharacterId: null,
    },
  );
  assert.equal(managedExtract.response, "Story.");
  assert.deepEqual(
    managedExtract.messages.map((message) => [message.text, message.from, message.room]),
    [
      ["hey", "보라", "group-1"],
      ["plain", null, null],
    ],
  );
  const legacyExtract = extractRoleplayOocMessages('A <ooc room="x">kept</ooc> <ooc>plain</ooc>', {
    managed: false,
    speakerCharacterId: null,
  });
  assert.deepEqual(
    legacyExtract.messages.map((message) => message.text),
    ["plain"],
  );
  const instruction = buildManagedRoleplayOocInstruction(live, (value) => value);
  assert.match(instruction, /room="group-1": group/u);
  assert.doesNotMatch(instruction, /group-partial|dm-a/u, "partial rosters and database IDs are never offered");
  checks++;

  // ── Character DMs go to each character's own DM; failures never create or reroute ──
  const chatsBefore = await countChats();
  const rpChat = (await storage.getById("rp"))!;
  const dmHeld: string[] = [];
  const sendDm = (character: string, resolvedCharacterId: string, routesNow?: CmbRoleplayRoutes) =>
    handleRoleplayDmCommand({
      command: {
        type: "dm",
        character,
        message: `hi from ${character}`,
        resolvedCharacterId,
        resolvedCharacterName: character,
      },
      chatId: "rp",
      sourceChat: rpChat,
      messageId: "rp-message",
      allChatMessages: [],
      chats: storage,
      sendAssistantAction: () => {},
      cmbDmRoute: async (dm) =>
        planCmbDirectMessage({
          routesAtStart: live,
          routesNow: routesNow ?? (await resolveCmbRoleplayRoutes(db, "rp")),
          requestedName: dm.character,
          resolvedCharacterId: dm.resolvedCharacterId,
          roleplayCharacters: [
            { id: "character-a", name: "아린" },
            { id: "character-b", name: "보라" },
            { id: "character-c", name: "차오" },
            { id: "character-x", name: "엑스" },
          ],
          normalizeName: normalizeDmTargetName,
        }),
      onCmbHeld: (hold) => dmHeld.push(hold.reason),
    });
  await sendDm("보라", "character-b");
  const dmB = await storage.listMessages("dm-b");
  assert.deepEqual(
    dmB.map((message) => [message.role, message.characterId, message.content]),
    [["assistant", "character-b", "hi from 보라"]],
  );
  assert.equal((await storage.listMessages("dm-a")).length, 0, "no other character's DM receives it");
  await sendDm("엑스", "character-x");
  assert.deepEqual(dmHeld, ["not-ensemble-member"]);
  await sendDm("아린", "character-a", { state: "off", policy: live.policy });
  assert.deepEqual(dmHeld, ["not-ensemble-member", "routes-changed"]);
  assert.equal(await countChats(), chatsBefore, "no DM chat is created on the managed path");
  checks++;

  // ── Convo → RP Influence/Note: route re-checked, confirmed member only, deduplicated ──
  const held: string[] = [];
  // Like the generate route: the CMB route is offered only when the conversation had no native
  // link when the generation started (`startedOnCmb` forces that view for a link added later).
  const sideEffect = async (
    command: { type: "influence" | "note"; content: string },
    chatId: string,
    characterId: string | null,
    messageId: string,
    startedOnCmb?: boolean,
  ) => {
    const linkedAtStart = Boolean((await storage.getById(chatId))?.connectedChatId);
    return handleConversationSideEffectCommand({
      command,
      characterId,
      chatId,
      messageId,
      chars: { getById: async () => null, list: async () => [], update: async () => undefined },
      chats: storage,
      resolveCmbRoute:
        (startedOnCmb ?? !linkedAtStart) ? async () => resolveCmbConversationRoute(db, chatId) : undefined,
      onHeld: (hold) => held.push(`${hold.command}:${hold.reason}`),
    });
  };
  await sideEffect({ type: "influence", content: "Meet at the harbor" }, "dm-a", "character-a", "dm-a-1");
  await sideEffect({ type: "influence", content: "Meet at the harbor" }, "dm-a", "character-a", "dm-a-1");
  await sideEffect({ type: "influence", content: "No speaker" }, "dm-a", null, "dm-a-2");
  await sideEffect({ type: "influence", content: "Wrong speaker" }, "group", "character-x", "group-1");
  await sideEffect({ type: "influence", content: "Partial room" }, "group-partial", "character-a", "gp-1");
  await sideEffect({ type: "note", content: "Bora keeps the key" }, "group", "character-b", "group-2");
  const influences = await db.select().from(oocInfluences).where(eq(oocInfluences.targetChatId, "rp"));
  assert.deepEqual(
    influences.map((row) => [row.sourceChatId, row.content]),
    [["dm-a", "Meet at the harbor"]],
    "one influence per source message; no speakerless, non-member or partial-room writes",
  );
  assert.deepEqual(held, ["influence:speaker-unknown", "influence:speaker-not-member"]);
  assert.equal(
    (await db.select().from(oocInfluences).where(eq(oocInfluences.sourceChatId, "group-partial"))).length,
    0,
  );
  // A native link that appears after a CMB-path generation started is a route change: held, never redirected.
  await db.update(chats).set({ connectedChatId: "other-rp" }).where(eq(chats.id, "dm-b"));
  await sideEffect({ type: "note", content: "Late link" }, "dm-b", "character-b", "dm-b-late", true);
  assert.equal(held.at(-1), "note:routes-changed");
  assert.equal(
    (await db.select().from(conversationNotes).where(eq(conversationNotes.targetChatId, "other-rp"))).length,
    0,
    "nothing is written to the newly linked RP",
  );
  assert.equal(
    (await storage.listNotes("rp")).some((note) => note.content === "Late link"),
    false,
  );
  await db.update(chats).set({ connectedChatId: null }).where(eq(chats.id, "dm-b"));
  // Two concurrent runs of the same command produce one row, for notes and influences alike.
  const [noteX, noteY] = await Promise.all([
    storage.createNote("group", "rp", "Concurrent fact", "group-conc"),
    storage.createNote("group", "rp", "Concurrent fact", "group-conc"),
  ]);
  assert.equal(noteX, noteY);
  assert.equal((await storage.listNotes("rp")).filter((note) => note.content === "Concurrent fact").length, 1);
  const [influenceX, influenceY] = await Promise.all([
    storage.createInfluence("dm-a", "rp", "Concurrent steer", "dm-a-conc"),
    storage.createInfluence("dm-a", "rp", "Concurrent steer", "dm-a-conc"),
  ]);
  assert.equal(influenceX, influenceY);
  assert.equal((await db.select().from(oocInfluences).where(eq(oocInfluences.content, "Concurrent steer"))).length, 1);
  await storage.deleteNoteForChat("rp", noteX);
  await db.delete(oocInfluences).where(eq(oocInfluences.id, influenceX));
  checks++;

  // ── Notes budget: a once-opted RP refuses instead of pruning ──
  const bulk = "n".repeat(1990);
  await storage.createNote("group", "rp", bulk, "bulk-1");
  await storage.createNote("group", "rp", bulk, "bulk-2");
  await sideEffect({ type: "note", content: "one more fact that does not fit" }, "dm-b", "character-b", "dm-b-9");
  assert.equal(held.at(-1), "note:notes-budget-full");
  assert.deepEqual(
    (await storage.listNotes("rp")).map((note) => note.content.length).sort((a, b) => a - b),
    [18, 1990, 1990],
    "existing notes are never pushed out",
  );
  // A never-opted RP keeps the original prune-oldest behavior (distinct timestamps define "oldest").
  const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 5));
  await storage.createNote("legacy-convo", "legacy-rp", bulk, "l-1");
  await tick();
  await storage.createNote("legacy-convo", "legacy-rp", bulk, "l-2");
  await tick();
  await storage.createNote("legacy-convo", "legacy-rp", "x".repeat(100), "l-3");
  assert.deepEqual(
    (await storage.listNotes("legacy-rp")).map((note) => note.content.length).sort((a, b) => a - b),
    [100, 1990],
    "the oldest note is pruned as before",
  );
  checks++;

  // ── RP injection: allowed sources only, consumed after save, reproducible, OFF keeps records ──
  await storage.createInfluence("outsider", "rp", "Outsider steer", "o-1");
  const injectFor = async (routes: CmbRoleplayRoutes, replayInfluenceIds: string[] = []) => {
    const finalMessages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "user" },
    ];
    const result = await injectConnectedConversationPromptBlocks({
      chatMode: "roleplay",
      connectedChatId: null,
      isSceneChat: false,
      chatId: "rp",
      chats: storage,
      finalMessages,
      cmb: {
        allowedSourceChatIds: await resolveCmbRoleplaySourceChatIds(db, "rp", routes),
        replayInfluenceIds,
        oocInstruction: routes.state === "active" ? buildManagedRoleplayOocInstruction(routes, (value) => value) : null,
      },
    });
    return { text: finalMessages.map((message) => message.content).join("\n"), ids: result.injectedInfluenceIds };
  };
  const first = await injectFor(live);
  assert.match(first.text, /Meet at the harbor/u);
  assert.match(first.text, /Bora keeps the key/u);
  assert.doesNotMatch(first.text, /Outsider steer/u, "unregistered sources stay stored but unused");
  assert.match(first.text, /<ooc_instruction>[\s\S]*room="group-1"/u);
  assert.equal(first.ids.length, 1);
  assert.equal((await storage.listPendingInfluences("rp")).length, 2, "injection alone never consumes");
  // A failed or cancelled reply leaves it pending; a saved one consumes it.
  assert.match((await injectFor(live)).text, /Meet at the harbor/u);
  for (const id of first.ids) await storage.markInfluenceConsumed(id, "rp");
  assert.doesNotMatch((await injectFor(live)).text, /Meet at the harbor/u, "no second consumption next turn");
  assert.match((await injectFor(live, first.ids)).text, /Meet at the harbor/u, "a swipe reproduces it");
  assert.equal((await put({ enabled: false, defaultOocChatId: "group", expectedRevision: 5 })).statusCode, 200);
  const offText = (await injectFor(await resolveCmbRoleplayRoutes(db, "rp"))).text;
  assert.doesNotMatch(offText, /Bora keeps the key|ooc_instruction/u, "OFF stops injection");
  assert.equal((await storage.listNotes("rp")).length, 3, "OFF keeps every note");
  assert.equal((await injectFor(await resolveCmbRoleplayRoutes(db, "rp"))).ids.length, 0);
  // Scene chats stay self-contained.
  const scene = [{ role: "system" as const, content: "s" }];
  await injectConnectedConversationPromptBlocks({
    chatMode: "roleplay",
    connectedChatId: "dm-a",
    isSceneChat: true,
    chatId: "rp",
    chats: storage,
    finalMessages: scene,
    cmb: { allowedSourceChatIds: new Set(["dm-a", "group"]), replayInfluenceIds: [], oocInstruction: null },
  });
  assert.deepEqual(scene, [{ role: "system", content: "s" }]);
  checks++;

  // ── Native 1:1 keeps its meaning; unlinking a once-opted RP never deletes its records ──
  await storage.connectChats("rp", "dm-a");
  const nativeAllowed = await resolveCmbRoleplaySourceChatIds(db, "rp", await resolveCmbRoleplayRoutes(db, "rp"));
  assert.deepEqual([...nativeAllowed], ["dm-a"], "while OFF only the live native partner is injected");
  await sideEffect({ type: "note", content: "Native note" }, "dm-a", null, "dm-a-native");
  assert.ok(
    (await storage.listNotes("rp")).some((note) => note.content === "Native note") === false,
    "the native path still respects the once-opted budget",
  );
  // Make room, then let the native partner write a note that the unlink must keep.
  const bulkNote = (await storage.listNotes("rp")).find((note) => note.content === bulk)!;
  await storage.deleteNoteForChat("rp", bulkNote.id);
  await sideEffect({ type: "note", content: "Native note" }, "dm-a", null, "dm-a-native-2");
  assert.ok((await storage.listNotes("rp")).some((note) => note.content === "Native note"));
  const disconnect = await app.inject({ method: "POST", url: "/api/chats/dm-a/disconnect" });
  assert.equal(disconnect.statusCode, 200);
  assert.ok(
    (await storage.listNotes("rp")).some((note) => note.content === "Native note"),
    "unlinking a once-opted RP keeps the partner's notes",
  );
  assert.equal((await storage.listNotes("rp")).length, 3);
  assert.equal((await db.select().from(oocInfluences).where(eq(oocInfluences.targetChatId, "rp"))).length, 2);
  // A never-opted pair keeps the original disconnect cleanup.
  await storage.connectChats("legacy-rp", "legacy-convo");
  await storage.createInfluence("legacy-convo", "legacy-rp", "legacy steer");
  const legacyMessages = [{ role: "user" as const, content: "u" }];
  await injectConnectedConversationPromptBlocks({
    chatMode: "roleplay",
    connectedChatId: "legacy-convo",
    isSceneChat: false,
    chatId: "legacy-rp",
    chats: storage,
    finalMessages: legacyMessages,
  });
  assert.equal((await storage.listPendingInfluences("legacy-rp")).length, 0, "legacy injection consumes as before");
  assert.equal((await app.inject({ method: "POST", url: "/api/chats/legacy-convo/disconnect" })).statusCode, 200);
  assert.equal((await storage.listNotes("legacy-rp")).length, 0);
  assert.equal(
    (await db.select().from(conversationNotes).where(eq(conversationNotes.targetChatId, "legacy-rp"))).length,
    0,
  );
  checks++;

  // ── A default room that became invalid never blocks OFF; ON needs a valid default or none ──
  const stale = await get();
  assert.equal(stale.state, "off");
  assert.equal(stale.policy.defaultOocChatId, "group");
  const groupRow = (await db.select().from(chats).where(eq(chats.id, "group")))[0]!;
  await db
    .update(chats)
    .set({ characterIds: JSON.stringify(["character-a", "character-b"]) })
    .where(eq(chats.id, "group"));
  const revision = stale.policy.revision as number;
  assert.equal(
    (await put({ enabled: true, defaultOocChatId: "group", expectedRevision: revision })).statusCode,
    400,
    "ON with a default that is no longer a full-roster group is refused",
  );
  assert.equal((await put({ enabled: true, defaultOocChatId: null, expectedRevision: revision })).statusCode, 200);
  assert.equal(
    (await put({ enabled: true, defaultOocChatId: "dm-b", expectedRevision: revision + 1 })).statusCode,
    200,
  );
  const dmBRow = (await db.select().from(chats).where(eq(chats.id, "dm-b")))[0]!;
  await db
    .update(chats)
    .set({ characterIds: JSON.stringify(["character-b", "character-a"]) })
    .where(eq(chats.id, "dm-b"));
  assert.equal((await get()).defaultOocReason, "default-room-unavailable");
  assert.equal(
    (await put({ enabled: false, defaultOocChatId: "dm-b", expectedRevision: revision + 2 })).statusCode,
    200,
    "OFF never depends on the default room",
  );
  assert.equal((await get()).state, "off");
  assert.equal(
    (await put({ enabled: false, defaultOocChatId: null, expectedRevision: revision + 3 })).statusCode,
    200,
    "the default can be cleared while OFF",
  );
  assert.equal(
    (await put({ enabled: true, defaultOocChatId: "dm-b", expectedRevision: revision + 4 })).statusCode,
    400,
  );
  await db.update(chats).set({ characterIds: dmBRow.characterIds }).where(eq(chats.id, "dm-b"));
  await db.update(chats).set({ characterIds: groupRow.characterIds }).where(eq(chats.id, "group"));
  assert.equal(
    (await put({ enabled: true, defaultOocChatId: "group", expectedRevision: revision + 4 })).statusCode,
    200,
  );
  checks++;
  console.log(`cmb-convo-routes: ${checks} regression groups passed`);
} finally {
  await app.close();
  await nativeDb._fileStore.close();
  if (previousDirectory === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousDirectory;
  if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLogLevel;
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}marinara-cmb-convo-routes-`));
  rmSync(directory, { recursive: true, force: true });
}
