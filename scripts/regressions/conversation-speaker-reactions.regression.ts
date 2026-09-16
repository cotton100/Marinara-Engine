import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "../../packages/server/node_modules/typescript/lib/typescript.js";
import {
  normalizeSpeakerName,
  normalizeTextForMatch,
  stripLeadingMessageTimestamps,
  type MessageReaction,
} from "../../packages/shared/src/index.js";
import {
  findRetargetableUserReaction,
  removeCharacterReaction,
  splitReactionsBySegment,
  toggleReaction,
} from "../../packages/client/src/lib/reactions.js";
import {
  addMessageReactor,
  annotateContentWithReactions,
  REACTION_ANNOTATION_CONTENT_CAP,
} from "../../packages/server/src/routes/generate/conversation-custom-assets.js";
import { handleConversationReactCommand } from "../../packages/server/src/services/generation/conversation-react-command-runtime.js";
import { parseExtra } from "../../packages/server/src/routes/generate/generate-route-utils.js";

const names: Array<[string, string]> = [
  ["O'Neil", "O’Neil"],
  ["O’Neil", "O'Neil"],
  ['Mr "Boss" Kim', "Mr “Boss” Kim"],
  ["Mr “Boss” Kim", 'Mr "Boss" Kim'],
];

// Execute the real private producer without starting history/storage services.
// Its only reads are synthetic args; downstream annotation uses the real helper.
const historySource = readFileSync(
  new URL("../../packages/server/src/routes/generate/conversation-history-runtime.ts", import.meta.url),
  "utf8",
);
const historyAst = ts.createSourceFile("history.ts", historySource, ts.ScriptTarget.Latest, true);
const producerNodes = historyAst.statements.filter(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "annotateConversationPromptReactions",
);
assert.equal(producerNodes.length, 1, "history reaction producer must be uniquely located");
const producerSource = producerNodes[0]!.getText(historyAst);

type ProducerArgs = {
  finalMessages: Array<{ id: string; content: string }>;
  chatMessages: Array<{ id: string; content: string; characterId: string; extra: string }>;
  charIdToName: Map<string, string>;
  allCharacterIds: string[];
  chars: { getById(id: string): Promise<{ data: { name: string } } | null> };
  personaName: string;
};

function runHistoryProducer(source: string, args: ProducerArgs, expectedName: string) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const annotate: typeof annotateContentWithReactions = (...params) => {
    assert.equal(
      params[3].get(normalizeSpeakerName(expectedName)),
      expectedName,
      "history must build the same quote-insensitive speaker key as the parser",
    );
    return annotateContentWithReactions(...params);
  };
  const producer = new Function(
    "normalizeSpeakerName",
    "normalizeTextForMatch",
    "parseExtra",
    "annotateContentWithReactions",
    "REACTION_ANNOTATION_CONTENT_CAP",
    "stripLeadingMessageTimestamps",
    `${compiled}\nreturn annotateConversationPromptReactions;`,
  )(
    normalizeSpeakerName,
    normalizeTextForMatch,
    parseExtra,
    annotate,
    REACTION_ANNOTATION_CONTENT_CAP,
    stripLeadingMessageTimestamps,
  ) as (input: ProducerArgs) => Promise<Array<{ id: string; content: string }>>;
  return producer(args);
}

for (const [canonical, rendered] of names) {
  const original: MessageReaction = { emoji: "❤️", by: ["x"], segment: 0, segmentSpeaker: canonical };
  const target = { segment: 0, speaker: rendered };
  const serverAdded = addMessageReactor([original], "❤️", "y", null, target);
  assert.equal(serverAdded.length, 1, `${canonical}: server must not create a duplicate quote-variant chip`);
  assert.deepEqual(serverAdded[0]!.by, ["x", "y"]);
  const clientAdded = toggleReaction([original], "❤️", "y", null, target);
  assert.deepEqual(clientAdded, serverAdded, "client and server must use the same identity");
  assert.deepEqual(toggleReaction([original], "❤️", "x", null, target), []);
  assert.deepEqual(removeCharacterReaction([original], { ...original, segmentSpeaker: rendered }), []);
  assert.deepEqual(original.by, ["x"], "helpers must preserve their input");

  const grouped = [{ speaker: rendered, lines: ["line"] }];
  const split = splitReactionsBySegment([original], grouped);
  assert.deepEqual(split.segmentReactions, [[original]]);
  assert.deepEqual(split.messageReactions, []);
  const userReaction = { ...original, by: ["user"] };
  assert.equal(findRetargetableUserReaction([userReaction], "❤️", { ...target, segment: 4 }), userReaction);

  for (const otherSpeaker of ["Different", null]) {
    const other = { segment: 0, speaker: otherSpeaker };
    assert.equal(addMessageReactor([original], "❤️", "y", null, other).length, 2);
    assert.equal(toggleReaction([original], "❤️", "y", null, other).length, 2);
    assert.deepEqual(
      splitReactionsBySegment([original], [{ speaker: otherSpeaker, lines: ["line"] }]).messageReactions,
      [original],
    );
    assert.equal(findRetargetableUserReaction([userReaction], "❤️", other), undefined);
  }

  const prompt = `${canonical}: line\nA: next`;
  const raw = `${rendered}: line\nA: next`;
  const reaction = { emoji: "❤️", by: ["user"], segment: 0, segmentSpeaker: rendered };
  const expected = `${canonical}: line\n[User reacted with ❤️]\nA: next`;
  const knownNames = new Map([
    [normalizeSpeakerName(canonical), canonical],
    [normalizeSpeakerName("A"), "A"],
  ]);
  assert.equal(
    annotateContentWithReactions(prompt, raw, [reaction], knownNames, () => "User"),
    expected,
  );
  assert.equal(
    annotateContentWithReactions(prompt, raw, [{ ...reaction, segmentSpeaker: "Different" }], knownNames, () => "User"),
    `${prompt}\n[User reacted with ❤️]`,
    "a different saved speaker must not attach inline to this character",
  );
  const producerArgs: ProducerArgs = {
    finalMessages: [{ id: "message", content: prompt }],
    chatMessages: [{ id: "message", content: raw, characterId: "b", extra: JSON.stringify({ reactions: [reaction] }) }],
    charIdToName: new Map([["a", "A"]]),
    allCharacterIds: ["a", "b"],
    chars: { getById: async (id) => (id === "b" ? { data: { name: canonical } } : null) },
    personaName: "User",
  };
  assert.equal((await runHistoryProducer(producerSource, producerArgs, canonical))[0]!.content, expected);

  // The public command handler operates only on these in-memory stores.
  const row = { id: "message", role: "assistant", content: raw, characterId: "a", extra: {} };
  const updates: Array<{ id: string; value: Record<string, unknown> }> = [];
  await handleConversationReactCommand({
    command: { type: "react", emoji: "❤️", targetCharacter: rendered },
    characterId: "a",
    chatMode: "conversation",
    chatMessages: [row],
    personaId: null,
    personaName: "User",
    conversationCustomEmojiUrlByName: new Map(),
    customEmojisStore: { getByName: async () => null },
    chars: { getById: async () => null },
    chats: {
      getMessage: async () => row,
      getSwipes: async () => [],
      updateMessageExtra: async (id, value) => {
        updates.push({ id, value });
      },
      updateSwipeExtra: async () => undefined,
    },
    getReactChatMembers: async () => [
      { id: "b", name: canonical },
      { id: "a", name: "A" },
    ],
  });
  assert.equal(updates.length, 1, "quote variants must resolve the intended react command target");
  assert.equal(updates[0]!.id, row.id);
  const savedReactions = updates[0]!.value.reactions as MessageReaction[];
  assert.equal(savedReactions[0]!.segment, 0);
  assert.equal(normalizeSpeakerName(savedReactions[0]!.segmentSpeaker), normalizeSpeakerName(canonical));
}

const narration: MessageReaction = { emoji: "❤️", by: ["x"], segment: 0, segmentSpeaker: null };
assert.equal(addMessageReactor([narration], "❤️", "y", null, { segment: 0, speaker: null }).length, 1);
assert.equal(toggleReaction([narration], "❤️", "y", null, { segment: 0, speaker: null }).length, 1);
assert.deepEqual(splitReactionsBySegment([narration], [{ speaker: null, lines: ["text"] }]).messageReactions, [
  narration,
]);

// Negative control: reverting the actual key-producing line must break the proof.
const oldKeySource = producerSource.replace(
  "const norm = normalizeSpeakerName(name);",
  "const norm = normalizeTextForMatch(name);",
);
assert.notEqual(oldKeySource, producerSource, "key producer mutation must apply");
await assert.rejects(
  runHistoryProducer(
    oldKeySource,
    {
      finalMessages: [{ id: "message", content: "O’Neil: line" }],
      chatMessages: [
        {
          id: "message",
          content: "O'Neil: line",
          characterId: "b",
          extra: JSON.stringify({ reactions: [{ emoji: "❤️", by: ["user"], segment: 0, segmentSpeaker: "O'Neil" }] }),
        },
      ],
      charIdToName: new Map(),
      allCharacterIds: ["b"],
      chars: { getById: async () => ({ data: { name: "O’Neil" } }) },
      personaName: "User",
    },
    "O’Neil",
  ),
  /same quote-insensitive speaker key/,
);

console.log(
  "Conversation speaker reaction regression passed (4 quote-name pairs, identity/null controls, history producer mutation).",
);
