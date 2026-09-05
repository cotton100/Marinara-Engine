import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "../../packages/server/node_modules/typescript/lib/typescript.js";
import {
  decodeEncodedSpeakerTags,
  formatTextQuotes,
  normalizeTextForMatch,
  parseGroupedSpeakerSegments,
} from "../../packages/shared/src/index.js";
import { buildMessageMacroContext, createMessageMacroResolver } from "../../packages/client/src/lib/chat-macros.js";
import { resolvePromptMessageMacros } from "../../packages/server/src/services/prompt/macro-context.js";
import { parseCharacterCommandsBySpeaker } from "../../packages/server/src/services/conversation/character-commands.js";
import {
  retainConversationSpeaker,
  stripConversationPromptTimestamps,
  stripConversationResponseEnvelope,
} from "../../packages/server/src/services/conversation/transcript-sanitize.js";
import { conversationPromptHistoryContent } from "../../packages/server/src/routes/generate/conversation-prompt-formatting.js";
import { textRewriteDropsProtectedMarkup } from "../../packages/server/src/services/generation/text-rewrite-safety.js";

const characters = [
  { id: "a", name: "A", convoDisplayName: "알파" },
  { id: "b", name: "B", convoDisplayName: "베타" },
];
const knownNames = new Set(
  characters.flatMap((character) => [character.name, character.convoDisplayName]).map(normalizeTextForMatch),
);
const targetNames = new Set(["a", "알파"]);
const cases: Array<[string, string, string]> = [
  ["plain", "hello", "hello"],
  ["target prefix", "A: hello", "hello"],
  ["wrong only", "B: rejected", ""],
  ["wrong multiline", "B: rejected\ncontinuation", ""],
  ["mixed", "A: first\nB: rejected\nA: last", "first\nlast"],
  ["unlabelled leading", "first\nB: rejected", "first"],
  ["target alias", "알파: hello", "hello"],
  ["wrong alias", "베타: rejected", ""],
  ["unicode normalization", "Ａ: hello\nＢ: rejected", "hello"],
  ["timestamp and CRLF", "[11.07 15:53] 알파: first\r\n[15:54] 베타: rejected\r\nA: last", "first\nlast"],
  ["duplicate target", "A: A: hello", "hello"],
  ["revealed wrong prefix", "A:B: rejected", ""],
  ["wrong tag", '<speaker="B">rejected</speaker>', ""],
  ["target tag", '<speaker="A">hello</speaker>', "hello"],
  ["unknown tag", '<speaker="Unknown">rejected</speaker>', ""],
  ["mixed tag and prefix", '<speaker="A">first</speaker>\nB: rejected\nA: last', "first\nlast"],
  ["nested prefix", '<speaker="A">B: rejected</speaker>', ""],
  ["nested tag", '<speaker="A"><speaker="B">rejected</speaker></speaker>', ""],
  ["encoded tag", "&lt;speaker=&quot;베타&quot;&gt;rejected&lt;/speaker&gt;", ""],
  ["encoded unknown tag", "&lt;speaker=&quot;Unknown&quot;&gt;rejected&lt;/speaker&gt;", ""],
  ["body mention is not a speaker", "I spoke to B: yesterday.", "I spoke to B: yesterday."],
  ["target command", "A: hello [selfie]", "hello [selfie]"],
  ["wrong command", "B: rejected [selfie]", ""],
  ["mixed commands", "A: first [selfie]\nB: rejected [selfie]\nA: last", "first [selfie]\nlast"],
];

for (const [label, input, expected] of cases) {
  const accepted = retainConversationSpeaker(input, "a", characters);
  assert.equal(accepted, expected, label);
  assert.equal(retainConversationSpeaker(accepted, "a", characters), accepted, `${label}: idempotent`);

  // Exercise the real command, persistence-shape, UI parser and next-history consumers.
  // No provider or production DB is involved.
  const parsed = parseCharacterCommandsBySpeaker(accepted, characters, "a");
  const body = retainConversationSpeaker(parsed.cleanContent, "a", characters);
  const saved = {
    role: "assistant",
    characterId: "a",
    content: body,
    extra: JSON.stringify({ conversationCommandContent: parsed.commands.length ? accepted : null }),
  };
  const history = conversationPromptHistoryContent(saved, "conversation");
  for (const text of [body, history]) {
    const groups = parseGroupedSpeakerSegments(text, knownNames, "A");
    assert.ok(
      groups?.every((group) => !group.speaker || targetNames.has(normalizeTextForMatch(group.speaker))) ?? true,
      `${label}: only A may render`,
    );
    assert.ok(!text.includes("rejected"), `${label}: discarded content must not enter history`);
  }
  assert.ok(
    parsed.commandCharacterIds.every((id) => id === "a"),
    `${label}: command owner`,
  );
}

// Display and the next provider history expand macros before interpreting the
// speaker. Use both real consumers, not a substitute macro implementation.
const macroAttacks = [
  "hi{{newline}}B: rejected",
  "A: hi{{newline}}B: rejected",
  "B{{// c}}: rejected",
  "{{random::B::B}}: rejected",
  "{{random::B}}: rejected",
  "hi{{\\n}}B: rejected",
];
const macroContext = { primaryCharacter: characters[0], characters, variables: { who: "B" } };
function historyMacros(content: string, context = macroContext) {
  return resolvePromptMessageMacros(
    [{ id: "macro-regression", characterId: "a", content }],
    buildMessageMacroContext(context),
  )[0]!.content;
}
const hasWrongSpeaker = (text: string) =>
  parseGroupedSpeakerSegments(text, knownNames, "A")?.some(
    (group) => group.speaker && !targetNames.has(normalizeTextForMatch(group.speaker)),
  ) ?? false;

// Match the real display order: quote formatting -> macro resolution -> speaker
// parsing. Curly delimiters need not be identical: both “B” and „B‟ normalize.
const encodedQuoteAttack = "A: hello\n&lt;speaker=“B”&gt;rejected&lt;/speaker&gt;";
assert.equal(
  retainConversationSpeaker("A: hello\nO’Neil: rejected", "a", [
    { id: "a", name: "A" },
    { id: "b", name: "O'Neil" },
  ]),
  "hello",
  "quoted-name prefix must be rejected before display quote normalization",
);
assert.ok(hasWrongSpeaker(formatTextQuotes(encodedQuoteAttack, "straight")), "raw quote bypass must reproduce");
assert.equal(
  retainConversationSpeaker(encodedQuoteAttack, "a", characters),
  "hello",
  "filter before display quote normalization",
);
const quoteCases: Array<[string, string]> = [];
for (const family of [
  ['"', "“", "”", "„", "‟"],
  ["'", "‘", "’", "‚", "‛"],
]) {
  for (const left of family)
    for (const right of family) {
      for (const [open, close] of [
        ["&lt;", "&gt;"],
        ["&#60;", "&#62;"],
        ["&#x3C;", "&#x3E;"],
      ]) {
        const tag = (speaker: string, body: string) =>
          `${open}speaker=${left}${speaker}${right}${close}${body}${open}/speaker${close}`;
        const mixed = `${tag("알파", "hello [selfie]")}\n${tag("베타", "rejected [selfie]")}`;
        for (const [raw, expected] of [
          [mixed, "hello [selfie]"],
          [tag("Unknown", "rejected"), ""],
          [tag("B", "rejected"), ""],
        ]) {
          const accepted = retainConversationSpeaker(raw!, "a", characters);
          assert.equal(accepted, expected, `encoded quote delimiters ${left}${right}`);
          assert.equal(retainConversationSpeaker(accepted, "a", characters), accepted);
          const commands = parseCharacterCommandsBySpeaker(accepted, characters, "a");
          assert.ok(commands.commandCharacterIds.every((id) => id === "a"));
          assert.equal(
            commands.commands.length,
            expected ? 1 : 0,
            "wrong-speaker commands are removed with their text",
          );
          for (const quoteFormat of ["straight", "typographic"] as const) {
            const displayed = createMessageMacroResolver(macroContext)(formatTextQuotes(accepted, quoteFormat));
            assert.ok(!hasWrongSpeaker(displayed), "display preprocessing cannot reveal another speaker");
            assert.ok(!hasWrongSpeaker(historyMacros(accepted)), "direct history remains single-speaker");
          }
        }
        assert.deepEqual(
          parseGroupedSpeakerSegments(mixed, knownNames, "A")?.map((group) => group.speaker),
          ["알파", "베타"],
          "ordinary merged replies still recognize both encoded speakers",
        );
        quoteCases.push([mixed, "hello [selfie]"]);
      }
    }
}
for (const raw of ["&lt;div title=“B”&gt;text&lt;/div&gt;", "<speaker=“B”>literal</speaker>", "&lt;speaker=“B’&gt;"]) {
  assert.equal(decodeEncodedSpeakerTags(raw), raw, "unrelated, literal or mixed quote-family markup is unchanged");
}

for (const raw of macroAttacks) {
  assert.ok(
    hasWrongSpeaker(createMessageMacroResolver(macroContext)(raw)),
    `raw display bypass: ${JSON.stringify(raw)}`,
  );
  assert.ok(hasWrongSpeaker(historyMacros(raw)), `raw history bypass: ${JSON.stringify(raw)}`);
}
assert.ok(
  hasWrongSpeaker(createMessageMacroResolver(macroContext)("B\x00TRIM_START\x00: rejected")),
  "internal trim markers also bypass the raw speaker parser",
);
console.log("Macro bypass negative controls reproduced (6 display + 6 history + internal display trim marker).");

const macroCases = [
  ...macroAttacks,
  "hi{{\n}}B: rejected",
  "B{{noop}}: rejected",
  "B{{trim}}: rejected",
  "{{group}}: generated group",
  "{{char}}: generated name",
  "{{getvar::who}}: rejected",
  "{{setvar::who::B}}{{getvar::who}}: rejected [selfie]",
  "{{#if 1}}B{{/if}}: rejected",
  "{{description}}: generated field",
  "{{unknown_macro}}: may become defined on a later turn",
  "{{{newline}}}B: adjacent braces",
  "{{{{random::B}}}}: nested braces",
  "B\x00TRIM_START\x00: rejected",
  "B\x00TRIM_END\x00: rejected",
  "\x1eMARINARA_DEFERRED_CHARACTER_CHAR\x1f: deferred name",
  "A: {<date>{newline}}B: braces exposed by envelope removal",
  "B\x00\x00: rejected",
  "B\x1e: rejected",
  "A: {[selfie]{newline}}B: braces exposed by command removal",
];
for (const raw of macroCases) {
  const accepted = retainConversationSpeaker(raw, "a", characters);
  assert.ok(accepted, "macro-looking replies are retained as literal text, not wholly discarded");
  assert.ok(!accepted.includes("{{") && !/[\x00\x1e]/.test(accepted), "no executable macro introducer survives");
  assert.equal(retainConversationSpeaker(accepted, "a", characters), accepted, "macro literalization is idempotent");
  const parsed = parseCharacterCommandsBySpeaker(accepted, characters, "a");
  const body = retainConversationSpeaker(parsed.cleanContent, "a", characters);
  const saved = {
    role: "assistant",
    characterId: "a",
    content: body,
    extra: JSON.stringify({ conversationCommandContent: parsed.commands.length ? accepted : null }),
  };
  const history = conversationPromptHistoryContent(saved, "conversation");
  assert.ok(
    parsed.commandCharacterIds.every((id) => id === "a"),
    "macro commands remain selected-speaker owned",
  );
  for (const primaryCharacter of characters) {
    const variables = { who: "unchanged", unknown_macro: "B" };
    const context = { primaryCharacter, characters, variables };
    const resolveDisplay = createMessageMacroResolver(context, { randomSeed: primaryCharacter.id });
    for (const text of [body, history]) {
      for (let pass = 0; pass < 3; pass++) {
        assert.equal(resolveDisplay(text), text, "display cannot expand a stored CMB reply, even after focus changes");
        assert.equal(historyMacros(text, context), text, "next-turn history cannot re-expand a CMB reply");
      }
      assert.ok(!hasWrongSpeaker(text), "literal macro text cannot become a B bubble or history segment");
    }
    assert.deepEqual(variables, { who: "unchanged", unknown_macro: "B" }, "no generated variable write executes");
  }
}
for (let braces = 2; braces <= 32; braces++) {
  const accepted = retainConversationSpeaker(`${"{".repeat(braces)}newline}}`, "a", characters);
  assert.ok(!accepted.includes("{{"), "overlapping brace pairs cannot survive literalization");
  assert.equal(createMessageMacroResolver(macroContext)(accepted), accepted);
}
assert.equal(retainConversationSpeaker("{{newline}}", "a", characters), "{ {newline}}", "visible literal spelling");
assert.equal(retainConversationSpeaker("plain { text }", "a", characters), "plain { text }", "single braces unchanged");
assert.equal(createMessageMacroResolver(macroContext)("{{char}}{{newline}}hello"), "A\nhello");
assert.equal(historyMacros("{{char}}{{newline}}hello"), "A\nhello", "ordinary history macros still execute");
for (const raw of ["plain {{char}}", "plain { { text }}", "plain \x00TRIM_START\x00", "plain \x1eplaceholder"]) {
  assert.equal(stripConversationPromptTimestamps(raw), raw, "ordinary timestamp cleanup does not literalize macros");
  assert.equal(
    stripConversationResponseEnvelope(`A: ${raw}`, { speakerName: "A" }),
    raw,
    "ordinary single-speaker envelope keeps macros",
  );
  assert.equal(
    stripConversationResponseEnvelope(raw, { preserveSpeakerPrefix: true }),
    raw,
    "ordinary merged envelope keeps macros",
  );
}

assert.equal(retainConversationSpeaker("hello", null, characters), "", "no target fails closed");
assert.equal(retainConversationSpeaker("hello", "missing", characters), "", "missing target fails closed");
assert.equal(
  retainConversationSpeaker("B: hello", "a", [{ id: "a", name: "A", convoDisplayName: "B" }, characters[1]!]),
  "hello",
  "target wins alias collision, as in the UI",
);
assert.equal(
  retainConversationSpeaker(`${'<speaker="A">'.repeat(20)}hello${"</speaker>".repeat(20)}`, "a", characters),
  "",
  "excessively nested output fails closed",
);
assert.equal(
  parseCharacterCommandsBySpeaker(retainConversationSpeaker("B: [selfie]", "a", characters), characters, "a").commands
    .length,
  0,
);
assert.equal(
  parseCharacterCommandsBySpeaker(retainConversationSpeaker("A: [selfie]", "a", characters), characters, "a").commands
    .length,
  1,
);
assert.equal(
  parseCharacterCommandsBySpeaker(
    retainConversationSpeaker("A: first [selfie]\nB: rejected [selfie]", "a", characters),
    characters,
    "a",
  ).commands.length,
  1,
  "wrong-speaker commands are discarded, not reassigned",
);

// A rewrite is accepted only if the retained result is nonempty; otherwise the
// route's existing changedMessage gate preserves the original valid response.
const original = "valid A response";
assert.equal(retainConversationSpeaker("B: rejected rewrite", "a", characters) || original, original);
assert.equal(retainConversationSpeaker("알파: accepted rewrite", "a", characters) || original, "accepted rewrite");

// Normal multi-speaker merged replies still use the existing envelope/parser.
const ordinary = "A: first [selfie]\nB: second [selfie]";
assert.equal(
  stripConversationResponseEnvelope(ordinary, {
    speakerName: "A",
    speakerNames: ["A", "B"],
    preserveSpeakerPrefix: true,
  }),
  ordinary,
);
assert.deepEqual(parseCharacterCommandsBySpeaker(ordinary, characters, "a").commandCharacterIds, ["a", "b"]);
assert.deepEqual(
  parseGroupedSpeakerSegments("A: first\nB: second", knownNames, "A")?.map((group) => group.speaker),
  ["A", "B"],
);

// Execute the real route guards as well as the helper: a working helper with a
// disconnected call, premature command capture, or raw SSE bypass is not enough.
const routeSource = readFileSync(
  new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
  "utf8",
);
const source = ts.createSourceFile("generate.routes.ts", routeSource, ts.ScriptTarget.Latest, true);
const nodes: ts.Node[] = [];
const visit = (node: ts.Node) => {
  nodes.push(node);
  ts.forEachChild(node, visit);
};
visit(source);
const declaration = (name: string) => {
  const matches = nodes.filter(ts.isVariableDeclaration).filter((node) => node.name.getText(source) === name);
  assert.equal(matches.length, 1, `${name}: unique route declaration`);
  return matches[0]!;
};
const guards = nodes
  .filter(ts.isIfStatement)
  .filter(
    (node) =>
      node.expression.getText(source) === "holdForCmbSpeakerValidation" &&
      node.thenStatement.getText(source).includes("retainConversationSpeaker("),
  );
assert.equal(guards.length, 3, "pre-command, final body, and rewrite filters must all be wired");
assert.ok(
  guards[0]!.pos < declaration("responseBeforeCommandParsing").pos,
  "filter before raw command-history capture",
);
assert.ok(
  guards[1]!.pos > declaration("responseBeforeCommandParsing").pos,
  "refilter visible body after command removal",
);
assert.ok(guards[2]!.pos < declaration("changedMessage").pos, "filter rewrite before its acceptance and persistence");
assert.ok(
  guards[2]!.pos < declaration("droppedProtectedMarkup").pos,
  "protected markup must be checked on the retained rewrite, not the rejected speaker's text",
);

const holdInitializer = declaration("holdForCmbSpeakerValidation").initializer!.getText(source);
const evaluateHold = new Function("autonomousCmbSingleSpeaker", "allCharacterIds", `return ${holdInitializer};`) as (
  single: boolean,
  ids: string[],
) => boolean;
assert.equal(evaluateHold(true, ["a", "b"]), true);
assert.equal(evaluateHold(false, ["a", "b"]), false, "ordinary merged is unchanged");
assert.equal(evaluateHold(true, ["a"]), false, "1:1 is unchanged");

function runGuard(index: number, input: string, enabled: boolean) {
  const run = new Function(
    "retainConversationSpeaker",
    "fullResponse",
    "holdForCmbSpeakerValidation",
    "cmbResponseSpeakers",
    `
    const targetCharId = "a", rewriteCharacterId = "a";
    let sanitizedEditedText = fullResponse, contentReplaced = false;
    const sendSseEvent = () => {}, reply = {};
    ${guards[index]!.getText(source)}
    return { fullResponse, sanitizedEditedText, contentReplaced };
  `,
  );
  return run(retainConversationSpeaker, input, enabled, characters) as {
    fullResponse: string;
    sanitizedEditedText: string;
    contentReplaced: boolean;
  } | null;
}
assert.equal(
  runGuard(0, "B: rejected [selfie]", true),
  null,
  "wrong-only stops before implicit command recovery and storage",
);
assert.equal(runGuard(0, "A: first [selfie]\nB: rejected", true)?.fullResponse, "first [selfie]");
assert.equal(
  runGuard(0, "hello", true)?.contentReplaced,
  true,
  "held valid tokens must be published even when unchanged",
);
assert.equal(runGuard(0, "B: unchanged", false)?.fullResponse, "B: unchanged");
assert.equal(runGuard(1, "B: rejected", true)?.fullResponse, "");
assert.equal(runGuard(2, "B: rejected", true)?.sanitizedEditedText, "");
assert.equal(runGuard(2, "알파: accepted", true)?.sanitizedEditedText, "accepted");
assert.equal(runGuard(2, "B: unchanged", false)?.sanitizedEditedText, "B: unchanged");
for (const raw of macroCases) {
  const expected = retainConversationSpeaker(raw, "a", characters);
  assert.equal(runGuard(0, raw, true)?.fullResponse, expected, "literalize before command-history capture");
  assert.equal(runGuard(1, raw, true)?.fullResponse, expected, "literalize the final body after command removal");
  assert.equal(runGuard(2, raw, true)?.sanitizedEditedText, expected, "literalize rewrites before persistence");
  assert.equal(runGuard(0, raw, false)?.fullResponse, raw, "ordinary replies retain their macro syntax");
  assert.equal(runGuard(2, raw, false)?.sanitizedEditedText, raw, "ordinary rewrites retain their macro syntax");
}
for (const [raw, expected] of quoteCases) {
  assert.equal(runGuard(0, raw, true)?.fullResponse, expected, "quote validation before command capture");
  assert.equal(runGuard(1, raw, true)?.fullResponse, expected, "quote validation after command removal");
  assert.equal(runGuard(2, raw, true)?.sanitizedEditedText, expected, "quote validation before rewrite persistence");
}
const protectedOriginal = "<div>A original</div>";
const misleadingRewrite = '<speaker="B"><div>B rejected</div></speaker>\nA: plain';
assert.equal(
  textRewriteDropsProtectedMarkup(protectedOriginal, misleadingRewrite),
  false,
  "negative control: raw B markup masks the loss",
);
assert.equal(
  textRewriteDropsProtectedMarkup(protectedOriginal, runGuard(2, misleadingRewrite, true)!.sanitizedEditedText),
  true,
  "reject a rewrite that loses protected markup after B is discarded",
);

const tokenSender = declaration("sendTokenTextChunked");
const tokenJavascript = ts.transpileModule(tokenSender.parent.parent.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
async function observedTokens(enabled: boolean) {
  const tokens: string[] = [];
  const send = new Function(
    "holdForCmbSpeakerValidation",
    "recordReasoningDuration",
    "spatialDirectiveStreamFilter",
    "emitTokenTextChunked",
    `${tokenJavascript}; return sendTokenTextChunked;`,
  )(
    enabled,
    () => {},
    null,
    async (text: string) => {
      tokens.push(text);
    },
  );
  await send("B: raw provider tokens");
  return tokens;
}
assert.deepEqual(await observedTokens(true), [], "unvalidated CMB tokens cannot flash under B's avatar");
assert.deepEqual(await observedTokens(false), ["B: raw provider tokens"], "ordinary token streaming is unchanged");

console.log(
  `Autonomous CMB speaker regression passed (${cases.length} body/history + ${macroCases.length} macro + ${quoteCases.length} quote combinations, brace runs, route guards and ordinary controls).`,
);
