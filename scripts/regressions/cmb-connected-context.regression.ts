import assert from "node:assert/strict";

import { resolveConversationConnectedChatContext } from "../../packages/server/src/routes/generate/conversation-connected-context.js";

type ContextInput = Parameters<typeof resolveConversationConnectedChatContext>[0];

function fixture(mode: "roleplay" | "game", omitRoleplayTranscript?: boolean) {
  let messageReads = 0;
  const input: ContextInput = {
    connectedChatId: "linked-room",
    conversationCommandsEnabled: true,
    chatMeta: {},
    personaName: "Test User",
    omitRoleplayTranscript,
    wrapFormat: "xml",
    chats: {
      async getById(id) {
        assert.equal(id, "linked-room");
        return { id, name: "Test Story", mode, characterIds: '["character-a"]', metadata: {} };
      },
      async listMessages(id) {
        assert.equal(id, "linked-room");
        messageReads += 1;
        assert.ok(!(mode === "roleplay" && omitRoleplayTranscript), "managed RP must not read native messages");
        return Array.from({ length: 25 }, (_, index) => ({
          role: "assistant",
          characterId: "character-a",
          content: `TRANSCRIPT_${String(index).padStart(2, "0")}`,
        }));
      },
    },
    chars: {
      async getById(id) {
        assert.equal(id, "character-a");
        return { data: JSON.stringify({ name: "Test Character" }) };
      },
    },
    gameStateStore: {
      async getLatestCommitted() {
        return null;
      },
      async getLatest() {
        return null;
      },
    },
  };
  return { input, messageReads: () => messageReads };
}

for (const wrapFormat of ["xml", "markdown", "none"] as const) {
  const managed = fixture("roleplay", true);
  managed.input.wrapFormat = wrapFormat;
  const result = await resolveConversationConnectedChatContext(managed.input);
  assert.equal(managed.messageReads(), 0);
  assert.equal(result.connectedChatBlock, null);
  assert.ok(result.systemPromptAppend);
  assert.match(result.systemPromptAppend, /Test Story/);
  assert.match(result.systemPromptAppend, /Test Character/);
  assert.match(result.systemPromptAppend, /<influence>/);
  assert.match(result.systemPromptAppend, /<note>/);
  assert.match(result.systemPromptAppend, /only when relevant context is actually supplied/);
  assert.doesNotMatch(result.systemPromptAppend, /Recent messages from that roleplay are provided|TRANSCRIPT_/);
}

for (const [influence, note] of [
  [false, true],
  [true, false],
  [false, false],
] as const) {
  const managed = fixture("roleplay", true);
  managed.input.chatMeta = { conversationCommandToggles: { influence, note } };
  const result = await resolveConversationConnectedChatContext(managed.input);
  assert.equal(managed.messageReads(), 0);
  assert.equal(result.connectedChatBlock, null);
  assert.equal(result.systemPromptAppend?.includes("<influence>") ?? false, influence);
  assert.equal(result.systemPromptAppend?.includes("<note>") ?? false, note);
  if (!influence && !note) assert.equal(result.systemPromptAppend, null);
}

const commandsDisabled = fixture("roleplay", true);
commandsDisabled.input.conversationCommandsEnabled = false;
assert.deepEqual(await resolveConversationConnectedChatContext(commandsDisabled.input), {
  connectedChatBlock: null,
  systemPromptAppend: null,
});
assert.equal(commandsDisabled.messageReads(), 0);

const defaultNative = fixture("roleplay");
const explicitNative = fixture("roleplay", false);
const nativeResult = await resolveConversationConnectedChatContext(defaultNative.input);
assert.deepEqual(await resolveConversationConnectedChatContext(explicitNative.input), nativeResult);
assert.equal(defaultNative.messageReads(), 1);
assert.equal(explicitNative.messageReads(), 1);
assert.ok(nativeResult.connectedChatBlock);
assert.equal(nativeResult.connectedChatBlock.match(/TRANSCRIPT_\d{2}/gu)?.length, 20);
assert.doesNotMatch(nativeResult.connectedChatBlock, /TRANSCRIPT_0[0-4]/u);
assert.match(nativeResult.connectedChatBlock, /TRANSCRIPT_05/u);
assert.match(nativeResult.connectedChatBlock, /TRANSCRIPT_24/u);
assert.match(nativeResult.systemPromptAppend ?? "", /Recent messages from that roleplay are provided/u);

const defaultGame = fixture("game");
const flaggedGame = fixture("game", true);
const gameResult = await resolveConversationConnectedChatContext(defaultGame.input);
assert.deepEqual(await resolveConversationConnectedChatContext(flaggedGame.input), gameResult);
assert.equal(defaultGame.messageReads(), 1);
assert.equal(flaggedGame.messageReads(), 1);
assert.ok(gameResult.connectedChatBlock);
assert.equal(gameResult.connectedChatBlock.match(/TRANSCRIPT_\d{2}/gu)?.length, 20);
assert.match(gameResult.systemPromptAppend ?? "", /<influence>/u);
assert.match(gameResult.systemPromptAppend ?? "", /<note>/u);

console.info("CMB connected-context regression passed.");
