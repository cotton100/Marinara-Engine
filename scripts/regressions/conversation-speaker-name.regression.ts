import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "../../packages/server/node_modules/typescript/lib/typescript.js";
import {
  decodeEncodedSpeakerTags,
  formatTextQuotes,
  normalizeSpeakerName,
  normalizeTextForMatch,
  parseGroupedSpeakerSegments,
  type GroupedSegment,
  type QuoteFormat,
} from "../../packages/shared/src/index.js";
import { createMessageMacroResolver } from "../../packages/client/src/lib/chat-macros.js";
import { parseCharacterCommandsBySpeaker } from "../../packages/server/src/services/conversation/character-commands.js";
import { retainConversationSpeaker } from "../../packages/server/src/services/conversation/transcript-sanitize.js";

type Character = { id: string; name: string; convoDisplayName?: string };
type NameMaps = { charByName: Map<string, Character>; charIdByName: Map<string, string> };
type SegmentIdentity = { segChar?: Character; segSelfId: string; segName: string };

function readAst(name: string) {
  const file = `packages/client/src/components/chat/${name}.tsx`;
  return ts.createSourceFile(
    file,
    readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function uniqueNode(source: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  const matches: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1, `${source.fileName}: uniquely locate production expression`);
  return matches[0]!;
}

function evaluate<T>(body: string, env: Record<string, unknown>): T {
  const compiled = ts.transpileModule(`function run() { ${body} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(env), `${compiled}\nreturn run();`)(...Object.values(env)) as T;
}

// Run the actual UI name-map callback and both actual card/id/name lookups.
// This does not mount React or claim browser proof; it prevents a substitute
// test-only map from hiding a stale normalizer in a production consumer.
const messageSource = readAst("ConversationMessage");
const mapDeclaration = uniqueNode(
  messageSource,
  (node) =>
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.name.elements.some((item) => item.name.getText(messageSource) === "charByName"),
) as ts.VariableDeclaration;
assert.ok(mapDeclaration.initializer && ts.isCallExpression(mapDeclaration.initializer));
const mapCallback = mapDeclaration.initializer.arguments[0];
assert.ok(mapCallback && ts.isArrowFunction(mapCallback) && ts.isBlock(mapCallback.body));
const mapBody = mapCallback.body.getText(messageSource).slice(1, -1);
const lookupBodies = ["ConversationMessageGrouped", "ConversationMessageBubble"].map((file) => {
  const source = readAst(file);
  return (
    ["segChar", "segSelfId", "segName"]
      .map((name) => {
        const node = uniqueNode(
          source,
          (item) => ts.isVariableDeclaration(item) && ts.isIdentifier(item.name) && item.name.text === name,
        ) as ts.VariableDeclaration;
        assert.ok(node.initializer);
        return `const ${name} = ${node.initializer.getText(source)};`;
      })
      .join("\n") + "\nreturn { segChar, segSelfId, segName };"
  );
});
const viewSource = readAst("ConversationView");
const viewBody = ["getKnownChatMemberNames", "hasNamePrefixFormat", "getGroupedSegmentCount"]
  .map((name) =>
    uniqueNode(viewSource, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(viewSource),
  )
  .join("\n");

function uiMaps(characters: Character[], selectedId: string, body = mapBody): NameMaps {
  return evaluate(body, {
    scopedCharacterMap: new Map(characters.map((character) => [character.id, character])),
    message: { characterId: selectedId },
    normalizeSpeakerName,
    normalizeTextForMatch,
  });
}

function displayGroups(text: string, characters: Character[], selectedId: string, format: QuoteFormat) {
  const maps = uiMaps(characters, selectedId);
  const context = { primaryCharacter: characters.find((character) => character.id === selectedId)!, characters };
  const displayed = createMessageMacroResolver(context)(formatTextQuotes(text, format));
  const knownNames = new Set(maps.charByName.keys());
  const groups = parseGroupedSpeakerSegments(displayed, knownNames, context.primaryCharacter.name);
  assert.ok(groups?.length, "nonempty fixture must produce real display groups");
  return { maps, groups };
}

function identities(groups: GroupedSegment[], maps: NameMaps, body: string): SegmentIdentity[] {
  return groups.map((grp) =>
    evaluate(body, { grp, ...maps, selfCharacterId: "fallback", normalizeSpeakerName, normalizeTextForMatch }),
  );
}

const pairs: Array<[string, string]> = [
  ["O'Neil", "O’Neil"],
  ["O’Neil", "O'Neil"],
  ["D'Arcy", "D‘Arcy"],
  ['Mr "Boss" Kim', "Mr “Boss” Kim"],
  ["Mr “Boss” Kim", 'Mr "Boss" Kim'],
  ["Chuck 'C' Lee", "Chuck ‘C’ Lee"],
  ["Chuck ‘C’ Lee", "Chuck 'C' Lee"],
  ["O'Neil", "O＇Neil"],
  ["O'Neil", "O‚Neil"],
  ['Mr "Boss" Kim', "Mr „Boss‟ Kim"],
];
let displayChecks = 0;
for (const [canonical, variant] of pairs) {
  assert.equal(normalizeSpeakerName(canonical), normalizeSpeakerName(variant));
  assert.equal(normalizeSpeakerName(normalizeSpeakerName(variant)), normalizeSpeakerName(variant));
  for (const alias of [false, true]) {
    const b: Character = alias ? { id: "b", name: "B", convoDisplayName: canonical } : { id: "b", name: canonical };
    const characters: Character[] = [{ id: "a", name: "A" }, b];
    const original = structuredClone(characters);
    const raw = `A: first\n${variant}: rejected [selfie]\ncontinued\nA: last`;
    const accepted = retainConversationSpeaker(raw, "a", characters);
    assert.equal(accepted, "first\nlast", `${canonical}/${variant}: reject the whole wrong-speaker turn`);
    assert.equal(retainConversationSpeaker(`${variant}: rejected`, "a", characters), "");
    assert.equal(retainConversationSpeaker(`${variant}: legitimate`, "b", characters), "legitimate");
    const commands = parseCharacterCommandsBySpeaker(`A: first [selfie]\n${variant}: last [selfie]`, characters, "a");
    assert.deepEqual(commands.commandCharacterIds, ["a", "b"], "ordinary command prefix includes name aliases");
    assert.equal(parseCharacterCommandsBySpeaker(accepted, characters, "a").commands.length, 0);

    const view = evaluate<{ names: Set<string>; detected: boolean; count: number }>(
      `${viewBody}\nconst names = getKnownChatMemberNames(characterMap, ids);\n` +
        "return { names, detected: hasNamePrefixFormat(content, names), count: getGroupedSegmentCount(content, names) };",
      {
        characterMap: new Map(characters.map((character) => [character.id, character])),
        ids: characters.map((character) => character.id),
        content: `${variant}: legitimate`,
        normalizeSpeakerName,
        normalizeTextForMatch,
        parseGroupedSpeakerSegments,
      },
    );
    assert.ok(view.names.has(normalizeSpeakerName(variant)) && view.detected);
    assert.equal(view.count, 1);
    for (const format of ["straight", "typographic"] as const) {
      const displayedAccepted = createMessageMacroResolver({ primaryCharacter: characters[0]!, characters })(
        formatTextQuotes(accepted, format),
      );
      assert.equal(displayedAccepted, "first\nlast");
      assert.equal(
        parseGroupedSpeakerSegments(displayedAccepted, view.names, "A"),
        null,
        "accepted unlabelled text stays in the message owner's ordinary layout, without a new B segment",
      );
      for (const [text, selected, expectedIds] of [
        [raw, "a", ["a", "b", "a"]],
        [`${variant}: legitimate`, "b", ["b"]],
      ] as const) {
        const { maps, groups } = displayGroups(text, characters, selected, format);
        for (const lookup of lookupBodies) {
          const actual = identities(groups, maps, lookup);
          assert.deepEqual(
            actual.map((item) => item.segSelfId),
            expectedIds,
            `${canonical}/${variant}/${format}`,
          );
          assert.deepEqual(
            actual.map((item) => item.segChar?.id),
            expectedIds,
            "real avatar/card ownership",
          );
          for (const item of actual) {
            assert.equal(item.segName, item.segChar?.convoDisplayName || item.segChar?.name, "original display label");
          }
          displayChecks++;
        }
      }
    }
    assert.deepEqual(characters, original, "card names and aliases must never be rewritten");
  }
}

// Name comparison is distinct from body formatting and general text matching.
assert.equal(normalizeSpeakerName(null), "");
assert.equal(normalizeSpeakerName("  Ｏ’Ｎｅｉｌ  "), "o'neil");
assert.notEqual(normalizeTextForMatch("O'Neil"), normalizeTextForMatch("O’Neil"));
const plain = `A: He said “hello” to O’Neil; keep 'these' quotes.`;
assert.equal(retainConversationSpeaker(plain, "a", [{ id: "a", name: "A" }]), plain.slice(3));

const tagCharacters = [
  { id: "a", name: "A" },
  { id: "b", name: "O'Neil" },
];
for (const name of ["O'Neil", "O’Neil"]) {
  for (const tag of [
    `<speaker="${name}">rejected</speaker>`,
    `&lt;speaker=&quot;${name}&quot;&gt;rejected&lt;/speaker&gt;`,
  ]) {
    assert.equal(retainConversationSpeaker(tag, "a", tagCharacters), "");
    assert.equal(retainConversationSpeaker(tag, "b", tagCharacters), "rejected");
    for (const format of ["straight", "typographic"] as const) {
      const { maps, groups } = displayGroups(tag, tagCharacters, "a", format);
      for (const lookup of lookupBodies) assert.equal(identities(groups, maps, lookup)[0]!.segSelfId, "b");
    }
  }
}
const unsupportedOpening = "&lt;speaker='Mr &quot;Boss&quot; Kim'&gt;";
assert.equal(
  decodeEncodedSpeakerTags(unsupportedOpening),
  unsupportedOpening,
  "inner double quotes need a separate escape contract",
);

// Existing collision policy: selected message speaker wins for display/filter;
// ordinary prefix-based command attribution remains first-registration-wins.
const collision = [
  { id: "b", name: "O'Neil" },
  { id: "a", name: "O’Neil" },
];
assert.equal(retainConversationSpeaker("O'Neil: selected", "a", collision), "selected");
const collisionMaps = uiMaps(collision, "a");
assert.equal(collisionMaps.charIdByName.get(normalizeSpeakerName("O'Neil")), "a");
assert.deepEqual(parseCharacterCommandsBySpeaker("O’Neil: [selfie]", collision, "a").commandCharacterIds, ["b"]);

// Behavioral negative controls: reverting either the real map producer or a
// real layout lookup must lose the expected card/id, not merely change a regex.
const mutantCharacters = [
  { id: "a", name: "A" },
  { id: "b", name: "O’Neil" },
];
const mutantGroups = displayGroups("O'Neil: text", mutantCharacters, "a", "straight").groups;
const mutantMaps = uiMaps(mutantCharacters, "a", mapBody.replaceAll("normalizeSpeakerName(", "normalizeTextForMatch("));
assert.notEqual(identities(mutantGroups, mutantMaps, lookupBodies[0]!)[0]!.segSelfId, "b");
const correctMaps = uiMaps(mutantCharacters, "a");
const curlyGroups = displayGroups("O'Neil: text", mutantCharacters, "a", "typographic").groups;
for (const lookup of lookupBodies) {
  const mutant = lookup.replaceAll("normalizeSpeakerName(", "normalizeTextForMatch(");
  assert.notEqual(identities(curlyGroups, correctMaps, mutant)[0]!.segSelfId, "b");
}
console.log(
  `Conversation speaker names passed (${pairs.length} quote pairs, names + aliases, ${displayChecks} real UI card/id checks, commands, tags and 3 UI mutations).`,
);
