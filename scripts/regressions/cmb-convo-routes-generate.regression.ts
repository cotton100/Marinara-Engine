// CMB Convo routes through the real POST /api/generate route with a local mock provider. Checks the
// final model input, where OOC/DM/Influence actually land, and when influences are consumed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-cmb-routes-generate-"));
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB } = await import("../../packages/server/src/db/connection.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { chats: chatsTable, oocInfluences } = await import("../../packages/server/src/db/schema/index.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createCmbCompressionFixture } = await import("./helpers/cmb-compression-fixture.js");

type ProviderCall = { messages: Array<{ role: string; content: unknown }>; stream: boolean };
const providerCalls: ProviderCall[] = [];
const replies: Array<string | number> = [];
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end("unexpected provider path");
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderCall;
  providerCalls.push(body);
  const next = replies.shift();
  if (next === undefined || typeof next === "number") {
    response.writeHead(typeof next === "number" ? next : 500).end("fixture provider failure");
    return;
  }
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: next } }] })}\n\n`);
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "fixture",
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: next } }],
    }),
  );
});

const db = await getDB();
const chats = createChatsStorage(db);
const connections = createConnectionsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(generateRoutes, { prefix: "/api/generate" });
await app.register(chatsRoutes, { prefix: "/api/chats" });
const promptText = (call: ProviderCall) =>
  call.messages
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
const generate = async (payload: Record<string, unknown>) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: { streaming: false, skipPresenceDelay: true, ...payload },
  });
  return { status: response.statusCode, body: response.body };
};

let checks = 0;
try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const connection = await connections.create({
    name: "Mock text provider",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: "fixture",
  });
  const fixture = await createCmbCompressionFixture(db as never);
  for (const id of ["rp", "group", "dm-a", "dm-b"])
    await db.update(chatsTable).set({ connectionId: connection.id }).where(eq(chatsTable.id, id));
  await chats.patchMetadata("rp", { roleplayCommandsEnabled: true, roleplayCommandToggles: { dm: true } });
  const enable = await app.inject({
    method: "PUT",
    url: "/api/chats/rp/cmb-routes",
    payload: { enabled: true, defaultOocChatId: "group", expectedRevision: 0 },
  });
  assert.equal(enable.statusCode, 200, enable.body);
  void fixture;
  const chatCount = async () => (await db.select({ id: chatsTable.id }).from(chatsTable)).length;
  const before = await chatCount();

  // ── RP turn: influence reaches the prompt, OOC and DM land in the right rooms ──
  const steer = await chats.createInfluence("dm-a", "rp", "STEER: meet at the harbor at dawn", "dm-a-msg");
  replies.push(
    'The harbor is quiet.\n<ooc from="보라">That scene was intense!</ooc>\n[dm: character="아린", message="Did you see that?"]',
  );
  const rpTurn = await generate({ chatId: "rp", userMessage: "We walk to the pier." });
  assert.equal(rpTurn.status, 200, rpTurn.body);
  const rpPrompt = promptText(providerCalls.at(-1)!);
  assert.match(rpPrompt, /STEER: meet at the harbor at dawn/u, "the influence is in the final RP input");
  assert.match(rpPrompt, /<ooc_instruction>[\s\S]*room="group-1"/u, "the managed OOC instruction is offered");
  assert.doesNotMatch(rpPrompt, /dm-a|dm-b/u, "database IDs are never shown to the model");
  const rpMessages = await chats.listMessages("rp");
  const rpReply = rpMessages.filter((message) => message.role === "assistant").at(-1)!;
  assert.doesNotMatch(rpReply.content, /<ooc|That scene was intense|\[dm:/u);
  assert.deepEqual(
    (await chats.listMessages("group")).map((message) => [message.characterId, message.content]),
    [["character-b", "That scene was intense!"]],
    "the OOC goes to the default group as the named speaker",
  );
  const dmA = await chats.listMessages("dm-a");
  assert.deepEqual(
    dmA.filter((message) => message.role === "assistant").map((message) => [message.characterId, message.content]),
    [["character-a", "Did you see that?"]],
    "the DM goes to the sender's own registered DM",
  );
  assert.equal((await chats.listMessages("dm-b")).length, 0);
  assert.equal(await chatCount(), before, "no new chat is created");
  const consumed = (await db.select().from(oocInfluences).where(eq(oocInfluences.id, steer)))[0]!;
  assert.equal(consumed.consumed, "true", "consumed once the reply was saved");
  const replyExtra = JSON.parse(String((await chats.getMessage(rpReply.id))!.extra ?? "{}")) as Record<string, unknown>;
  assert.deepEqual(replyExtra.cmbConsumedInfluenceIds, [steer]);
  checks++;

  // ── A failed RP generation leaves a new influence pending ──
  const pending = await chats.createInfluence("group", "rp", "STEER: storm incoming", "group-msg");
  replies.push(500);
  await generate({ chatId: "rp", userMessage: "Look at the sky." });
  assert.match(promptText(providerCalls.at(-1)!), /STEER: storm incoming/u);
  assert.equal(
    (await db.select().from(oocInfluences).where(eq(oocInfluences.id, pending)))[0]!.consumed,
    "false",
    "a failed reply never consumes",
  );
  checks++;

  // ── Swipe reproduces the consumed influence without consuming the next one twice ──
  replies.push("The storm arrives.");
  const retry = await generate({ chatId: "rp", userMessage: null, regenerateMessageId: rpReply.id });
  assert.equal(retry.status, 200, retry.body);
  const swipePrompt = promptText(providerCalls.at(-1)!);
  assert.match(swipePrompt, /STEER: meet at the harbor at dawn/u, "the regenerated reply keeps its influence");
  assert.match(swipePrompt, /STEER: storm incoming/u);
  assert.equal((await db.select().from(oocInfluences).where(eq(oocInfluences.id, pending)))[0]!.consumed, "true");
  checks++;

  // ── Conversation turn in a registered DM without a native link ──
  replies.push("Sure thing! <influence>Everyone gathers at the lighthouse.</influence>");
  const dmTurn = await generate({ chatId: "dm-b", userMessage: "Tell the others to go to the lighthouse." });
  assert.equal(dmTurn.status, 200, dmTurn.body);
  const dmPrompt = promptText(providerCalls.at(-1)!);
  assert.match(dmPrompt, /<influence>/u, "the Influence command is offered through the CMB route");
  assert.doesNotMatch(dmPrompt, /The harbor is quiet|The storm arrives/u, "the RP transcript is not copied in");
  const created = await db.select().from(oocInfluences).where(eq(oocInfluences.sourceChatId, "dm-b"));
  assert.deepEqual(
    created.map((row) => [row.targetChatId, row.content]),
    [["rp", "Everyone gathers at the lighthouse."]],
  );
  checks++;

  // ── OFF: the RP stops offering routes and posting OOC; nothing is rerouted ──
  const off = await app.inject({
    method: "PUT",
    url: "/api/chats/rp/cmb-routes",
    payload: { enabled: false, defaultOocChatId: "group", expectedRevision: 1 },
  });
  assert.equal(off.statusCode, 200, off.body);
  replies.push('Quiet night. <ooc from="보라">Night!</ooc>');
  await generate({ chatId: "rp", userMessage: "We rest." });
  assert.doesNotMatch(promptText(providerCalls.at(-1)!), /Everyone gathers at the lighthouse|ooc_instruction/u);
  assert.equal((await chats.listMessages("group")).length, 1, "no OOC is posted while OFF");
  assert.equal(
    (await db.select().from(oocInfluences).where(eq(oocInfluences.sourceChatId, "dm-b")))[0]!.consumed,
    "false",
    "OFF keeps the stored influence untouched",
  );
  checks++;

  // ── Individual mode: every speaker's reply records the influences; consumption happens once ──
  const on = await app.inject({
    method: "PUT",
    url: "/api/chats/rp/cmb-routes",
    payload: { enabled: true, defaultOocChatId: "group", expectedRevision: 2 },
  });
  assert.equal(on.statusCode, 200, on.body);
  await chats.patchMetadata("rp", { groupChatMode: "individual" });
  const shared = await chats.createInfluence("dm-a", "rp", "STEER: shared lantern", "dm-a-shared");
  // The dm-b influence stored while OFF is pending too, so both are injected and recorded.
  const pendingBefore = (await chats.listPendingInfluences("rp")).map((row) => row.id).sort();
  assert.ok(pendingBefore.includes(shared));
  replies.push("Arin lights the lantern.", "Bora follows.");
  const individual = await generate({ chatId: "rp", userMessage: "Who has the lantern?" });
  assert.equal(individual.status, 200, individual.body);
  const individualReplies = (await chats.listMessages("rp"))
    .filter((message) => message.role === "assistant")
    .slice(-2);
  assert.equal(individualReplies.length, 2);
  for (const replyRow of individualReplies) {
    const extra = JSON.parse(String((await chats.getMessage(replyRow.id))!.extra ?? "{}")) as Record<string, unknown>;
    assert.deepEqual(
      [...(extra.cmbConsumedInfluenceIds as string[])].sort(),
      pendingBefore,
      "each speaker's reply records every injected influence",
    );
  }
  assert.equal((await db.select().from(oocInfluences).where(eq(oocInfluences.id, shared)))[0]!.consumed, "true");
  replies.push("Bora follows, again.");
  const secondSwipe = await generate({
    chatId: "rp",
    userMessage: null,
    regenerateMessageId: individualReplies[1]!.id,
  });
  assert.equal(secondSwipe.status, 200, secondSwipe.body);
  assert.match(promptText(providerCalls.at(-1)!), /STEER: shared lantern/u, "the second speaker's swipe reproduces it");
  checks++;

  // ── Consumption and the reply's record are one transaction: a failure leaves everything pending ──
  const firstPending = await chats.createInfluence("dm-a", "rp", "STEER: first pending", "dm-a-p1");
  const secondPending = await chats.createInfluence("group", "rp", "STEER: second pending", "group-p2");
  const originalUpdate = db.update.bind(db);
  (db as unknown as { update: unknown }).update = (table: unknown) => {
    const builder = originalUpdate(table as never);
    if (table === oocInfluences) {
      const originalSet = builder.set.bind(builder);
      builder.set = ((patch: Record<string, unknown>) => {
        if (patch.consumed === "true") throw new Error("SYNTHETIC_CONSUME_WRITE_FAILURE");
        return originalSet(patch as never);
      }) as typeof builder.set;
    }
    return builder;
  };
  replies.push("Arin waits.", "Bora waits.");
  const failing = await generate({ chatId: "rp", userMessage: "Wait for the signal." });
  (db as unknown as { update: unknown }).update = originalUpdate;
  assert.equal(failing.status, 200, failing.body);
  const failedReplies = (await chats.listMessages("rp")).filter((message) => message.role === "assistant").slice(-2);
  // The first record rolled back with its failed consumption; later replies still record what they
  // saw, and nothing is consumed once any record failed.
  const failedExtras = await Promise.all(
    failedReplies.map(
      async (replyRow) =>
        JSON.parse(String((await chats.getMessage(replyRow.id))!.extra ?? "{}")) as Record<string, unknown>,
    ),
  );
  assert.equal(failedExtras[0]!.cmbConsumedInfluenceIds, undefined, "the rolled-back record leaves nothing");
  assert.deepEqual(
    [...(failedExtras[1]!.cmbConsumedInfluenceIds as string[])].sort(),
    [firstPending, secondPending].sort(),
    "the next speaker still records what it saw",
  );
  for (const id of [firstPending, secondPending])
    assert.equal(
      (await db.select().from(oocInfluences).where(eq(oocInfluences.id, id)))[0]!.consumed,
      "false",
      "nothing is half-consumed",
    );
  const retryPendingBefore = (await chats.listPendingInfluences("rp")).map((row) => row.id).sort();
  assert.deepEqual(retryPendingBefore, [firstPending, secondPending].sort());
  replies.push("Arin acts.", "Bora acts.");
  const retryTurn = await generate({ chatId: "rp", userMessage: "Now." });
  assert.equal(retryTurn.status, 200, retryTurn.body);
  const retryPrompt = promptText(providerCalls.at(-1)!);
  assert.match(retryPrompt, /STEER: first pending/u, "both influences come back on the next input");
  assert.match(retryPrompt, /STEER: second pending/u);
  for (const id of [firstPending, secondPending])
    assert.equal((await db.select().from(oocInfluences).where(eq(oocInfluences.id, id)))[0]!.consumed, "true");
  const retryReplies = (await chats.listMessages("rp")).filter((message) => message.role === "assistant").slice(-2);
  for (const replyRow of retryReplies) {
    const extra = JSON.parse(String((await chats.getMessage(replyRow.id))!.extra ?? "{}")) as Record<string, unknown>;
    assert.deepEqual([...(extra.cmbConsumedInfluenceIds as string[])].sort(), [firstPending, secondPending].sort());
  }
  checks++;
  console.log(`cmb-convo-routes-generate: ${checks} regression groups passed`);
} finally {
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB?.();
  rmSync(fixtureDir, { recursive: true, force: true });
}
