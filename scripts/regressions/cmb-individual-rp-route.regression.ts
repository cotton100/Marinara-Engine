import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "../../packages/server/node_modules/typescript/lib/typescript.js";
import { selectCmbRecentContextGuidance } from "../../packages/server/src/services/lorebook/cmb-provenance.js";

type Fixture = {
  chatMode?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  roster?: string[];
  lateRoster?: string[];
  rosterDuringRead?: string[];
  speakers?: (string | null)[];
  singleSpeaker?: boolean;
  block?: string | null;
};

function routeSlice(source: string) {
  const file = ts.createSourceFile("generate.routes.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const variable = (name: string) => {
    const found = nodes.filter(
      (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(file) === name,
    );
    assert.equal(found.length, 1, `one production variable: ${name}`);
    return found[0]!;
  };
  const audience = variable("ordinaryCmbAudience");
  const individual = variable("ordinaryCmbIndividualRoleplay");
  const promise = variable("ordinaryCmbRecentContextPromise");
  const cache = variable("individualRpCmbContexts");
  const getter = variable("getIndividualRpCmbContextBlock");
  const generate = variable("generateForCharacter");
  const messages = variable("gameAwareMessagesForGen");
  const block = variable("individualRpCmbContextBlock");
  const injection = nodes.find(
    (node): node is ts.IfStatement =>
      ts.isIfStatement(node) && node.expression.getText(file) === "individualRpCmbContextBlock",
  );
  assert.ok(injection, "per-speaker block is injected by the production route");
  assert.ok(generate.getStart(file) < block.getStart(file) && injection.getEnd() < generate.getEnd());
  assert.ok(injection.getEnd() < variable("preparedMessagesForGen").getStart(file), "injection precedes provider prep");
  assert.equal(
    block.initializer!.getText(file).replace(/\s+/gu, ""),
    "awaitgetIndividualRpCmbContextBlock(targetCharId,speaksOnlyTargetCharacter,gameAwareMessagesForGen,)",
    "use the actual provider target and its single-speaker boundary",
  );
  const followUp = nodes.find((node): node is ts.WhileStatement => ts.isWhileStatement(node));
  assert.ok(followUp && getter.getEnd() < followUp.getStart(file), "cache survives follow-up passes");
  const script = ts.transpileModule(
    `return (async () => {
      const chatMode = fixture.chatMode ?? "roleplay";
      const chatMeta = { groupChatMode: "individual", cmbRecentContextEnabled: true, ...fixture.metadata };
      const input = {chatId: "rp-room", ...fixture.input};
      let characterIds = [...(fixture.roster ?? ["A", "B"])];
      const app = {db: {}}, abortController = new AbortController();
      const promptTimeZone = "UTC", resolvedPreset = null;
      const normalizePromptWrapFormat = value => value;
      const calls = [];
      const buildCmbRecentContext = async args => {
        calls.push({...args, targetCharacterIds: [...args.targetCharacterIds]});
        if (fixture.rosterDuringRead) characterIds = [...fixture.rosterDuringRead];
        return {block: Object.hasOwn(fixture, "block") ? fixture.block : "ONLY_" + args.targetCharacterIds.join("_"), scope: "managed", rpChatId: "rp-room"};
      };
      const ${audience.getText(file)};
      const ${individual.getText(file)};
      const ${promise.getText(file)};
      const ${cache.getText(file)};
      const ${getter.getText(file)};
      const sharedResult = await ordinaryCmbRecentContextPromise;
      const callsBeforeSpeakers = calls.length;
      if (fixture.lateRoster) characterIds = [...fixture.lateRoster];
      const base = [{role: "system", content: "CANON"}, {role: "user", content: "HELLO"}];
      const prepareConversationLorebookForResponder = async (target, messages) => messages;
      const outputs = [];
      for (const targetCharId of fixture.speakers ?? ["B", "A", "B", "A"]) {
        const speaksOnlyTargetCharacter = fixture.singleSpeaker ?? true;
        const messagesForGen = base;
        let ${messages.getText(file)};
        const ${block.getText(file)};
        ${injection.getText(file)}
        outputs.push(gameAwareMessagesForGen);
      }
      return {calls, callsBeforeSpeakers, sharedResult, base, outputs, signal: abortController.signal, db: app.db};
    })();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const run = new Function("fixture", "selectCmbRecentContextGuidance", script);
  const mutate = (node: ts.Node, text: string) =>
    source.slice(0, node.getStart(file)) + text + source.slice(node.getEnd());
  return {
    run: (fixture: Fixture = {}) => run(fixture, selectCmbRecentContextGuidance),
    mutations: {
      sharedPrefetch: mutate(
        promise.initializer!,
        promise.initializer!.getText(file).replace(" && !ordinaryCmbIndividualRoleplay", ""),
      ),
      wrongSpeaker: mutate(
        getter,
        getter.getText(file).replace("targetCharacterIds: [targetCharId]", 'targetCharacterIds: ["A"]'),
      ),
      sharedCache: mutate(
        getter,
        getter
          .getText(file)
          .replaceAll(".get(targetCharId)", '.get("all")')
          .replaceAll(".set(targetCharId, pending)", '.set("all", pending)'),
      ),
      noRosterGuard: mutate(getter, getter.getText(file).replaceAll("audienceStillMatches()", "true")),
      noSingleSpeakerGuard: mutate(getter, getter.getText(file).replace("!speaksOnlyTargetCharacter || ", "")),
      noInjection: mutate(injection, "{}"),
    },
  };
}

async function verify(source: string) {
  const { run } = routeSlice(source);
  const actual = await run();
  assert.equal(actual.callsBeforeSpeakers, 0, "Individual RP must not prefetch a cast-wide block");
  assert.equal(actual.sharedResult, null);
  assert.deepEqual(
    actual.calls.map((call: { targetCharacterIds: string[] }) => call.targetCharacterIds),
    [["B"], ["A"]],
  );
  for (const [i, target] of ["B", "A", "B", "A"].entries()) {
    assert.deepEqual(actual.outputs[i], [
      { role: "system", content: "CANON" },
      { role: "system", content: `ONLY_${target}` },
      { role: "user", content: "HELLO" },
    ]);
  }
  assert.deepEqual(
    actual.base,
    [
      { role: "system", content: "CANON" },
      { role: "user", content: "HELLO" },
    ],
    "shared message array must not be mutated",
  );
  for (const call of actual.calls) {
    assert.equal(call.generation, "ordinary");
    assert.equal(call.targetChatId, "rp-room");
    assert.equal(call.signal, actual.signal);
    assert.equal(call.db, actual.db);
  }
  const one = await run({ roster: ["A"], speakers: ["A", "A"] });
  assert.equal(one.calls.length, 1, "single-character Individual RP also uses its actual speaker");
  for (const fixture of [
    { metadata: { cmbRecentContextEnabled: false } },
    { metadata: { cmbRecentContextEnabled: "true" } },
    { metadata: { sceneStatus: "active" } },
    { input: { autonomous: true } },
    { input: { impersonate: true } },
    { input: { regenerateMessageId: "old" } },
    { input: { continueMessageId: "old" } },
    { input: { turnGameBots: true } },
    { roster: [] },
    { speakers: [null, "outsider"] },
    { singleSpeaker: false },
    { lateRoster: ["A"] },
    { lateRoster: ["A", "outsider"] },
    { lateRoster: ["A", "B", "new"] },
  ] satisfies Fixture[]) {
    const result = await run(fixture);
    assert.equal(result.calls.length, 0, JSON.stringify(fixture));
    assert.ok(result.outputs.every((messages: unknown) => JSON.stringify(messages) === JSON.stringify(result.base)));
  }
  const changedDuringRead = await run({ rosterDuringRead: ["A"], speakers: ["A"] });
  assert.equal(changedDuringRead.calls.length, 1);
  assert.deepEqual(changedDuringRead.outputs[0], changedDuringRead.base, "recheck roster after the read");
  const unavailable = await run({ block: null });
  assert.ok(
    unavailable.outputs.every((messages: unknown) => JSON.stringify(messages) === JSON.stringify(unavailable.base)),
  );
  for (const fixture of [{ metadata: { groupChatMode: "merged" } }, { chatMode: "conversation" }] satisfies Fixture[]) {
    const shared = await run(fixture);
    assert.equal(shared.callsBeforeSpeakers, 1, "existing non-Individual-RP request-level path remains");
    assert.deepEqual(shared.calls[0].targetCharacterIds, ["A", "B"]);
    assert.equal(shared.calls.length, 1);
    assert.ok(shared.outputs.every((messages: unknown) => JSON.stringify(messages) === JSON.stringify(shared.base)));
  }
}

const source = readFileSync(new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url), "utf8");
await verify(source);
for (const [name, mutant] of Object.entries(routeSlice(source).mutations)) {
  assert.notEqual(mutant, source, `${name}: nonempty mutation`);
  await assert.rejects(() => verify(mutant), assert.AssertionError, `${name}: rejected mutation`);
}
console.info(
  "CMB Individual RP route passed (actual responder, lazy cache, copied input, fail-closed gates, six mutations).",
);
