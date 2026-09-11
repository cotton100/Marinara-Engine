import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { chats, messages, messageSwipes } from "../../packages/server/src/db/schema/index.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { chatsRoutes } from "../../packages/server/src/routes/chats.routes.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { handleConversationCrossPostCommand } from "../../packages/server/src/services/generation/conversation-cross-post-command-runtime.js";

type Event = { id: string; chatId: string; characterId: string | null; createdAt: string };
type Page = { version: number; events: Event[]; nextCursor: string | null; hasMore: boolean };

const storageDir = mkdtempSync(join(tmpdir(), "marinara-autonomous-feed-"));
const oldStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;
let db = await createFileNativeDB();
const app = Fastify();
app.decorate("db", db);
const originalNow = Date.now;

try {
  await app.register(chatsRoutes, { prefix: "/api/chats" });
  await app.ready();
  await db.insert(chats).values([
    { id: "first", name: "First", mode: "conversation", metadata: "{}" },
    { id: "second", name: "Second", mode: "conversation", metadata: "{}" },
    { id: "roleplay", name: "Roleplay", mode: "roleplay" },
    { id: "mari", name: "Mari", mode: "conversation", metadata: '{"internalAssistant":"professor-mari"}' },
  ]);
  const storage = createChatsStorage(db);
  const secondFacade = createChatsStorage(db);
  const request = async (query = ""): Promise<Page> => {
    const response = await app.inject({ method: "GET", url: `/api/chats/autonomous-notifications${query}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes("private fixture body"), false, "the feed must never expose message content");
    return response.json();
  };
  assert.deepEqual(await request("?baseline=true"), {
    version: 1,
    events: [],
    nextCursor: null,
    hasMore: false,
  });
  const generic = {
    chatId: "first",
    role: "assistant" as const,
    characterId: "actor-a",
    content: "private fixture body",
  };
  const excludedWrites = [
    await storage.createMessage({ ...generic, extra: { autonomousNotificationAt: "2099-01-01T00:00:00.000Z" } }),
  ];
  const forgedInput = { ...generic, autonomousNotificationAt: "2099-01-01T00:00:00.000Z" };
  excludedWrites.push(await storage.createMessage(forgedInput));
  for (const excludedInput of [
    { ...generic, chatId: "roleplay" },
    { ...generic, chatId: "mari" },
    { ...generic, role: "user" },
    { ...generic, content: " " },
  ]) {
    excludedWrites.push(await storage.createMessage(excludedInput, undefined, { autonomousNotification: true }));
  }
  for (const extra of [{ hiddenFromUser: true }, { commandOnly: true }]) {
    excludedWrites.push(
      await storage.createMessage({ ...generic, extra }, undefined, { autonomousNotification: true }),
    );
  }
  for (const excluded of excludedWrites) {
    assert.equal(excluded!.autonomousNotificationAt, null, "excluded writes must not allocate a notification marker");
  }
  assert.equal((await request()).events.length, 0, "manual, old, hidden, roleplay and Mari messages are unmarked");

  Date.now = () => Date.parse("2026-09-11T00:00:00.000Z");
  const created = await Promise.all(
    Array.from({ length: 260 }, (_, index) => {
      const facade = index % 2 ? storage : secondFacade;
      return facade.createMessage(
        {
          ...generic,
          chatId: index % 2 ? "first" : "second",
          characterId: index % 3 ? "actor-a" : "actor-b",
        },
        undefined,
        { autonomousNotification: true },
      );
    }),
  );
  const recordedTimes = created.map((row) => row!.autonomousNotificationAt!);
  assert.equal(new Set(recordedTimes).size, 260, "same-ms writes across facades receive unique monotonic clocks");
  assert.deepEqual(recordedTimes, [...recordedTimes].sort());
  assert.equal(
    created.every((row) => row!.content === generic.content),
    true,
  );
  const baseline = await request("?baseline=true");
  assert.equal(baseline.nextCursor, recordedTimes.at(-1));
  assert.deepEqual(baseline.events, [], "first discovery baselines without replaying existing events");

  await storage.markAutonomousUnread("first", { characterId: "actor-a" });
  await storage.clearAutonomousUnread("first");
  const allEvents: Event[] = [];
  let cursor: string | null = null;
  let more = true;
  let pageCount = 0;
  while (more) {
    const page = await request(`?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
    allEvents.push(...page.events);
    cursor = page.nextCursor;
    more = page.hasMore;
    pageCount++;
    assert.ok(pageCount < 5, "pagination must make progress");
  }
  assert.equal(pageCount, 3);
  assert.deepEqual(
    allEvents.map((event) => event.id),
    created.map((row) => row!.id),
  );
  assert.deepEqual(Object.keys(allEvents[0]).sort(), ["characterId", "chatId", "createdAt", "id"]);
  assert.equal(
    allEvents.some((event) => event.characterId === "actor-b"),
    true,
  );
  assert.deepEqual((await request(`?after=${encodeURIComponent(cursor!)}`)).events, [], "same cursor does not replay");

  const rawCopyIds = await storage.createMessagesBatch("second", [{ ...created[0]! }]);
  assert.equal(
    (await storage.getMessage(rawCopyIds[0]!))!.autonomousNotificationAt,
    null,
    "raw copied rows cannot carry the original notification marker into a branch or import",
  );
  await storage.addSwipe(created[0]!.id, "edited private fixture body");
  await storage.updateMessageContent(created[1]!.id, "rewritten private fixture body");
  assert.deepEqual(
    (await request(`?after=${encodeURIComponent(cursor!)}`)).events,
    [],
    "imports, rewrites and swipes create no events",
  );

  // Excluded rows still consume scan positions; a hidden or changed-mode page cannot block later replies.
  await storage.updateMessageExtra(created[0]!.id, { hiddenFromUser: true });
  await db.update(chats).set({ mode: "roleplay" }).where(eq(chats.id, "first"));
  const skipped = await request("?limit=2");
  assert.deepEqual(skipped.events, []);
  assert.equal(skipped.nextCursor, recordedTimes[1]);
  assert.equal(skipped.hasMore, true);
  await storage.patchMetadata("second", { internalAssistant: "professor-mari" });
  const becameMari = await request(`?limit=1&after=${encodeURIComponent(recordedTimes[1])}`);
  assert.deepEqual(becameMari.events, [], "the feed excludes chats currently reserved for Mari");
  assert.equal(becameMari.nextCursor, recordedTimes[2]);
  await storage.patchMetadata("second", { internalAssistant: undefined });
  await db.update(chats).set({ mode: "conversation" }).where(eq(chats.id, "first"));
  await storage.updateMessageContent(created[2]!.id, " ");
  const becameBlank = await request(`?limit=1&after=${encodeURIComponent(recordedTimes[1])}`);
  assert.deepEqual(becameBlank.events, [], "a marked reply edited to blank is excluded at read time");
  assert.equal(becameBlank.nextCursor, recordedTimes[2]);
  await storage.updateMessageExtra(created[4]!.id, { commandOnly: true });
  const becameCommandOnly = await request(`?limit=1&after=${encodeURIComponent(recordedTimes[3])}`);
  assert.deepEqual(becameCommandOnly.events, [], "a marked reply changed to a command-only anchor is excluded");
  assert.equal(becameCommandOnly.nextCursor, recordedTimes[4]);

  // An insertion failure after the marked row must roll that row back, too.
  const originalInsert = db.insert;
  db.insert = ((table: typeof messageSwipes) => {
    if (table === messageSwipes) throw new Error("fixture swipe insert failure");
    return originalInsert(table);
  }) as typeof db.insert;
  try {
    await assert.rejects(storage.createMessage(generic, undefined, { autonomousNotification: true }), /fixture swipe/);
  } finally {
    db.insert = originalInsert;
  }
  assert.deepEqual((await request(`?after=${encodeURIComponent(cursor!)}`)).events, []);

  // Readers must wait for an in-progress insertion rather than emitting a row that later rolls back.
  let releaseSwipe: () => void = () => {};
  let enteredSwipe: () => void = () => {};
  const swipeEntered = new Promise<void>((resolve) => {
    enteredSwipe = resolve;
  });
  const swipeRelease = new Promise<void>((resolve) => {
    releaseSwipe = resolve;
  });
  db.insert = ((table: typeof messageSwipes) => {
    if (table !== messageSwipes) return originalInsert(table);
    return {
      values: async () => {
        enteredSwipe();
        await swipeRelease;
        throw new Error("fixture delayed swipe failure");
      },
    };
  }) as typeof db.insert;
  try {
    const failedSave = storage.createMessage(generic, undefined, { autonomousNotification: true });
    const saveRejected = assert.rejects(failedSave, /fixture delayed swipe/);
    await swipeEntered;
    let feedSettled = false;
    const concurrentFeed = storage.listAutonomousNotifications({ after: cursor!, limit: 100 }).then((page) => {
      feedSettled = true;
      return page;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(feedSettled, false, "the feed cannot read an uncommitted notification row");
    releaseSwipe();
    await saveRejected;
    assert.deepEqual((await concurrentFeed).events, []);
  } finally {
    releaseSwipe();
    db.insert = originalInsert;
  }

  for (const query of [
    "?limit=0",
    "?limit=251",
    "?limit=01",
    "?limit=2x",
    "?baseline=false",
    "?after=",
    "?after=wrong",
    "?after=2026-02-30T00:00:00.000Z",
    "?baseline=true&after=2026-09-11T00:00:00.000Z",
  ]) {
    const response = await app.inject({ method: "GET", url: `/api/chats/autonomous-notifications${query}` });
    assert.equal(response.statusCode, 400, query);
  }

  await app.close();
  await db._fileStore.close();
  db = await createFileNativeDB();
  const restarted = createChatsStorage(db);
  const reopened = await restarted.listAutonomousNotifications({ after: cursor!, limit: 100 });
  assert.equal(reopened.events.length, 0);
  Date.now = () => Date.parse("2020-01-01T00:00:00.000Z");
  const next = await restarted.createMessage({ ...generic, characterId: null }, undefined, {
    autonomousNotification: true,
  });
  assert.ok(next!.autonomousNotificationAt! > cursor!, "restart uses persisted floor even with a backward clock");
  const resumed = await restarted.listAutonomousNotifications({ after: cursor!, limit: 100 });
  assert.deepEqual(resumed.events, [
    { id: next!.id, chatId: "first", characterId: null, createdAt: next!.autonomousNotificationAt },
  ]);
  await restarted.removeMessage(next!.id);
  const afterDeletion = await restarted.createMessage(generic, undefined, { autonomousNotification: true });
  assert.ok(
    afterDeletion!.autonomousNotificationAt! > next!.autonomousNotificationAt!,
    "process floor survives latest-event deletion",
  );

  // Cross-post moves a saved reply rather than copying history. Its settled feed must identify
  // the visible target row. A consumer that polled before the move may already have seen the source.
  const beforeCrossPost = afterDeletion!.autonomousNotificationAt!;
  const movedSource = await restarted.createMessage(generic, undefined, { autonomousNotification: true });
  const crossPostEvents: Record<string, unknown>[] = [];
  const crossPost = (messageId: string, target: string) =>
    handleConversationCrossPostCommand({
      command: { type: "cross_post", target },
      characterId: generic.characterId,
      chatId: generic.chatId,
      messageId,
      fullResponse: "fallback must not replace saved content",
      chats: restarted,
      sendCrossPost: (data) => crossPostEvents.push(data),
    });
  assert.equal(await crossPost(movedSource!.id, "second"), true);
  assert.equal(await restarted.getMessage(movedSource!.id), null, "cross-post removes the original row");
  const movedPage = await restarted.listAutonomousNotifications({ after: beforeCrossPost, limit: 100 });
  assert.equal(movedPage.events.length, 1, "cross-post must retain one target notification after the move");
  assert.equal(movedPage.events[0].chatId, "second");
  assert.equal(movedPage.events[0].characterId, generic.characterId);
  assert.notEqual(movedPage.events[0].id, movedSource!.id);
  assert.equal((await restarted.getMessage(movedPage.events[0].id))!.content, generic.content);
  assert.ok(movedPage.nextCursor! > movedSource!.autonomousNotificationAt!);
  assert.deepEqual(
    crossPostEvents.map((event) => event.targetChatId),
    ["second"],
  );

  const manualSource = await restarted.createMessage(generic);
  await crossPost(manualSource!.id, "second");
  assert.equal(await restarted.getMessage(manualSource!.id), null);
  assert.deepEqual(
    (await restarted.listAutonomousNotifications({ after: movedPage.nextCursor!, limit: 100 })).events,
    [],
    "manual cross-post must not turn a manual reply into an autonomous notification",
  );

  const protectedSource = await restarted.createMessage(generic, undefined, { autonomousNotification: true });
  await crossPost(protectedSource!.id, "roleplay");
  assert.ok(await restarted.getMessage(protectedSource!.id), "unsupported target modes cannot consume the source");
  assert.equal(crossPostEvents.length, 2, "unsupported target modes emit no cross-post event");
  const protectedPage = await restarted.listAutonomousNotifications({ after: movedPage.nextCursor!, limit: 100 });
  assert.deepEqual(
    protectedPage.events.map((event) => event.chatId),
    ["first"],
  );

  // Mari has conversation mode but remains excluded by the storage-owned eligibility check.
  await crossPost(protectedSource!.id, "mari");
  assert.equal(await restarted.getMessage(protectedSource!.id), null);
  assert.deepEqual(
    (await restarted.listAutonomousNotifications({ after: movedPage.nextCursor!, limit: 100 })).events,
    [],
    "moving to an internal assistant chat does not allocate a notification marker",
  );

  const generationSource = readFileSync(
    new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    (generationSource.match(/autonomousNotification:/gu) ?? []).length,
    1,
    "only the new visible-save path can request event creation",
  );
  assert.match(
    generationSource,
    /savedMsg = await chats\.createMessage\(\s*\{\s*chatId: input\.chatId,\s*role: input\.impersonate \? "user" : "assistant",\s*characterId: input\.impersonate \? null : targetCharId,\s*content: fullResponse,\s*\},\s*undefined,\s*\{ autonomousNotification: shouldAccountAutonomousGeneration && !input\.continueMessageId \},\s*\)/u,
    "notification eligibility must stay on the visible newly generated message, never a hidden anchor",
  );
  assert.match(
    generationSource,
    /requestChatMode === "conversation" &&\s+input\.autonomous === true &&[\s\S]{0,220}!input\.impersonate &&\s+!input\.regenerateMessageId/u,
  );
  assert.ok(await restarted.getMessage(created[2]!.id), "notification consumption does not remove messages");
  assert.equal(db.count(messages, eq(messages.autonomousNotificationAt, next!.autonomousNotificationAt)), 0);
  console.info("Autonomous notification feed regression passed.");
} finally {
  Date.now = originalNow;
  await app.close();
  await db._fileStore.close();
  if (oldStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = oldStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}
