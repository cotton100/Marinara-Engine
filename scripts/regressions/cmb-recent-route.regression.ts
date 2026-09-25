import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "../../packages/server/node_modules/typescript/lib/typescript.js";

type ContextResult = { block: string | null; scope: "managed" | "unmanaged" | "unavailable"; rpChatId: string | null };
type Fixture = {
  chatMode?: string;
  input?: Record<string, unknown>;
  chatMeta?: Record<string, unknown>;
  activeCharacterIds?: string[];
  lateCharacterIds?: string[];
  appendLateCharacter?: string;
  result?: ContextResult;
  autonomousResult?: ContextResult;
  connectedChatId?: string;
};

const managed: ContextResult = { block: "SHARED_CONTEXT", scope: "managed", rpChatId: "registered-rp" };

// Execute production AST expressions, not a reimplementation of their guards.
// The builder is a synthetic stub: this proves route wiring, not provider/DB delivery.
function routeSlice(source: string) {
  const file = ts.createSourceFile("generate.routes.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  function one<T extends ts.Node>(guard: (node: ts.Node) => node is T, label: string): T {
    const matches = nodes.filter(guard);
    assert.equal(matches.length, 1, `${label}: identify one production node`);
    return matches[0]!;
  }
  const variable = (name: string) =>
    one(
      (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(file) === name,
      name,
    );
  const audience = variable("ordinaryCmbAudience");
  const individual = variable("ordinaryCmbIndividualRoleplay");
  const promise = variable("ordinaryCmbRecentContextPromise");
  const result = variable("cmbRecentContextResult");
  const block = variable("ordinaryCmbRecentContextBlock");
  const blocks = variable("conversationAwarenessBlocks");
  const roster = one(
    (node): node is ts.BinaryExpression =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(file) === "characterIds",
    "activity roster update",
  );
  const omit = one(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === "omitRoleplayTranscript" &&
      node.parent.parent.getText(file).startsWith("resolveConversationConnectedChatContext("),
    "native RP transcript decision",
  );
  let followUp: ts.Node | undefined = result.parent;
  while (followUp && !ts.isWhileStatement(followUp)) followUp = followUp.parent;
  assert.ok(followUp && ts.isWhileStatement(followUp), "result must be awaited inside the follow-up loop");
  assert.ok(roster.getEnd() < audience.getStart(file), "ordinary audience must follow the activity roster update");
  assert.ok(promise.getEnd() < followUp.getStart(file), "one ordinary read must start outside the follow-up loop");
  const allBuilderCalls = nodes.filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText(file) === "buildCmbRecentContext",
  );
  assert.equal(
    allBuilderCalls.length,
    3,
    "only autonomous, shared ordinary, and cached RP-speaker reads call the builder",
  );
  assert.ok(
    allBuilderCalls.every((node) => node.getEnd() < followUp!.getStart(file)),
    "follow-ups must not rescan CMB",
  );
  const builderCalls = allBuilderCalls.filter(
    (node) => node.getStart(file) >= promise.getStart(file) && node.getEnd() <= promise.getEnd(),
  );
  assert.equal(builderCalls.length, 1, "ordinary promise must have exactly one bounded builder call");
  const args = builderCalls[0]!.arguments[0];
  assert.ok(args && ts.isObjectLiteralExpression(args));
  const builderProperty = (name: string) => {
    const property = args.properties.find(
      (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && node.name.getText(file) === name,
    );
    assert.ok(property, `builder argument ${name} is required`);
    return property;
  };
  assert.equal(builderProperty("generation").initializer.getText(file), '"ordinary"');
  assert.equal(builderProperty("targetCharacterIds").initializer.getText(file), "ordinaryCmbAudience");
  assert.equal(builderProperty("signal").initializer.getText(file), "abortController.signal");
  const script = ts.transpileModule(
    `return (async () => {
    const chatMode = fixture.chatMode ?? "conversation";
    const input = { chatId: "target-room", forCharacterId: "A", ...fixture.input };
    const chatMeta = fixture.chatMeta ?? {};
    const chat = { connectedChatId: fixture.connectedChatId ?? "registered-rp" };
    let characterIds = ["A", "B", "old-inactive"];
    const selectedActivity = { activeCharacterIds: [...(fixture.activeCharacterIds ?? ["A", "B"])] };
    const app = { db: {} }, abortController = new AbortController();
    const promptTimeZone = "UTC", resolvedPreset = null;
    const normalizePromptWrapFormat = (value) => value;
    const calls = [];
    const buildCmbRecentContext = async (args) => {
      calls.push({ ...args, targetCharacterIds: [...args.targetCharacterIds] });
      return fixture.result ?? managed;
    };
    const autonomousCmbRecentContextPromise = Promise.resolve(fixture.autonomousResult ?? null);
    ${roster.getText(file)};
    const ${audience.getText(file)};
    const ${individual.getText(file)};
    const ${promise.getText(file)};
    const audienceSnapshot = ordinaryCmbAudience ? [...ordinaryCmbAudience] : null;
    if (fixture.lateCharacterIds) characterIds = [...fixture.lateCharacterIds];
    if (fixture.appendLateCharacter) characterIds.push(fixture.appendLateCharacter);
    const iterations = [];
    for (let pass = 0; pass < 3; pass++) {
      const ${result.getText(file)};
      const omitRoleplayTranscript = ${omit.initializer.getText(file)};
      const ${block.getText(file)};
      const convoAwarenessBlock = null, autonomousCmbPendingContextBlock = null;
      const ${blocks.getText(file)};
      iterations.push({ block: ordinaryCmbRecentContextBlock, omitRoleplayTranscript, blocks: conversationAwarenessBlocks });
    }
    return { audience: audienceSnapshot, calls, iterations, signal: abortController.signal, db: app.db };
  })();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const run = new Function("fixture", "managed", script);
  const replace = (node: ts.Node, replacement: string) =>
    source.slice(0, node.getStart(file)) + replacement + source.slice(node.getEnd());
  return {
    run: (fixture: Fixture = {}) => run(fixture, managed),
    mutations: {
      optIn: replace(
        audience.initializer!,
        audience.initializer!.getText(file).replace("chatMeta.cmbRecentContextEnabled === true", "true"),
      ),
      audience: replace(
        audience.initializer!,
        audience.initializer!.getText(file).replace("[...characterIds]", "[input.forCharacterId]"),
      ),
      lateRoster: replace(block.initializer!, "cmbRecentContextResult?.block ?? null"),
      nativeFallback: replace(omit.initializer, "false"),
    },
  };
}

async function verifyRoute(source: string) {
  const { run } = routeSlice(source);
  for (const [label, fixture, enabled] of [
    ["default OFF", {}, false],
    ["false OFF", { chatMeta: { cmbRecentContextEnabled: false } }, false],
    ["truthy nonboolean OFF", { chatMeta: { cmbRecentContextEnabled: "true" } }, false],
    ["ordinary Conversation", { chatMeta: { cmbRecentContextEnabled: true } }, true],
    ["ordinary RP", { chatMode: "roleplay", chatMeta: { cmbRecentContextEnabled: true } }, true],
    [
      "autonomous ignores ordinary",
      { input: { autonomous: true }, chatMeta: { cmbRecentContextEnabled: true } },
      false,
    ],
    ["autonomous option does not enable ordinary", { chatMeta: { autonomousCmbContextRefreshEnabled: true } }, false],
    ["impersonation", { input: { impersonate: true }, chatMeta: { cmbRecentContextEnabled: true } }, false],
    ["regeneration", { input: { regenerateMessageId: "old" }, chatMeta: { cmbRecentContextEnabled: true } }, false],
    ["continuation", { input: { continueMessageId: "old" }, chatMeta: { cmbRecentContextEnabled: true } }, false],
    ["game bots", { input: { turnGameBots: true }, chatMeta: { cmbRecentContextEnabled: true } }, false],
    ["Game", { chatMode: "game", chatMeta: { cmbRecentContextEnabled: true } }, false],
    [
      "active scene",
      { chatMode: "roleplay", chatMeta: { cmbRecentContextEnabled: true, sceneStatus: "active" } },
      false,
    ],
    [
      "concluded scene",
      { chatMode: "roleplay", chatMeta: { cmbRecentContextEnabled: true, sceneStatus: "concluded" } },
      false,
    ],
    ["empty roster", { activeCharacterIds: [], chatMeta: { cmbRecentContextEnabled: true } }, false],
  ] satisfies Array<[string, Fixture, boolean]>) {
    const actual = await run(fixture);
    assert.deepEqual(actual.audience, enabled ? ["A", "B"] : null, `gate: ${label}`);
    assert.equal(actual.calls.length, enabled ? 1 : 0, `one read across follow-ups: ${label}`);
    for (const iteration of actual.iterations) {
      assert.equal(iteration.block, enabled ? managed.block : null, `block: ${label}`);
      assert.deepEqual(iteration.blocks, enabled ? [managed.block] : [], `injection: ${label}`);
      assert.equal(iteration.omitRoleplayTranscript, enabled, `native path remains unchanged without opt-in: ${label}`);
    }
    if (enabled) {
      const call = actual.calls[0];
      assert.deepEqual(
        call.targetCharacterIds,
        ["A", "B"],
        "builder receives whole post-activity audience despite forCharacterId",
      );
      assert.equal(call.generation, "ordinary");
      assert.equal(call.targetChatId, "target-room");
      assert.equal(call.signal, actual.signal);
      assert.equal(call.db, actual.db);
    }
  }
  for (const [changes, expected] of [
    [{ lateCharacterIds: ["B", "A"] }, managed.block],
    [{ lateCharacterIds: ["A"] }, null],
    [{ lateCharacterIds: ["A", "outsider"] }, null],
    [{ appendLateCharacter: "new-character" }, null],
  ] satisfies Array<[Partial<Fixture>, string | null]>) {
    const actual = await run({ chatMeta: { cmbRecentContextEnabled: true }, ...changes });
    for (const iteration of actual.iterations) assert.equal(iteration.block, expected, "late audience gate");
  }
  for (const [result, connectedChatId, omitted] of [
    [managed, "registered-rp", true],
    [{ ...managed, block: null }, "registered-rp", true],
    [managed, "unrelated-rp", false],
    [{ block: null, scope: "unavailable", rpChatId: null }, "registered-rp", true],
    [{ block: null, scope: "unavailable", rpChatId: null }, "unrelated-rp", true],
    [{ block: null, scope: "unmanaged", rpChatId: null }, "registered-rp", false],
  ] satisfies Array<[ContextResult, string, boolean]>) {
    const actual = await run({ chatMeta: { cmbRecentContextEnabled: true }, result, connectedChatId });
    for (const iteration of actual.iterations)
      assert.equal(iteration.omitRoleplayTranscript, omitted, "native fallback boundary");
  }
  const autonomous = await run({
    input: { autonomous: true },
    chatMeta: { cmbRecentContextEnabled: true },
    autonomousResult: managed,
  });
  assert.equal(autonomous.calls.length, 0);
  assert.equal(autonomous.iterations[0].block, null);
  assert.equal(autonomous.iterations[0].omitRoleplayTranscript, true, "autonomous managed result keeps native bypass");
}

const source = readFileSync(new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url), "utf8");
await verifyRoute(source);
for (const [name, mutant] of Object.entries(routeSlice(source).mutations)) {
  assert.notEqual(mutant, source, `${name}: mutation must alter production source`);
  await assert.rejects(
    () => verifyRoute(mutant),
    assert.AssertionError,
    `${name}: proof must reject dangerous mutation`,
  );
}

const ui = readFileSync(
  new URL("../../packages/client/src/components/chat/ChatSettingsDrawer.tsx", import.meta.url),
  "utf8",
);
assert.match(ui, /checked=\{metadata\.cmbRecentContextEnabled === true\}/u);
assert.match(ui, /updateMeta\.mutate\(\{ id: chat\.id, cmbRecentContextEnabled \}\)/u);
assert.match(ui, /metadata\.sceneStatus != null \? null/u);
for (const section of ["conversation", "roleplay"]) {
  const start = ui.indexOf(`id="${section}-connected-chats"`);
  assert.ok(start >= 0);
  assert.match(ui.slice(start, ui.indexOf("</Section>", start)), /renderCmbRecentContextToggle\(\)/u);
}
console.info("CMB recent route regression passed (runtime gates, audience, native bypass, four negative controls).");
