import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AnthropicProvider } from "../../packages/server/src/services/llm/providers/anthropic.provider.js";
import type {
  ChatMessage,
  ChatOptions,
  LLMToolDefinition,
} from "../../packages/server/src/services/llm/base-provider.js";
import { shouldSuppressUnknownModelParameters } from "../../packages/shared/src/constants/model-lists.js";

// Synthetic requests only: no DB, webhook, external API, or stored connection is used.
const tool: LLMToolDefinition = {
  type: "function",
  function: {
    name: "creator_library_list",
    description: "List fixture documents",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};
const toolUse = { type: "tool_use", id: "toolu_fixture", name: tool.function.name, input: {} };
const requests: Array<{ path: string | undefined; body: Record<string, unknown> }> = [];
let replyWithTool = true;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  requests.push({ path: request.url, body });
  const stopReason = replyWithTool ? "tool_use" : "end_turn";
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        content: replyWithTool ? [toolUse] : [{ type: "text", text: "Fixture answer." }],
        stop_reason: stopReason,
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    return;
  }
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: replyWithTool ? toolUse : { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: replyWithTool
        ? { type: "input_json_delta", partial_json: "{}" }
        : { type: "text_delta", text: "Fixture answer." },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new AnthropicProvider(`http://127.0.0.1:${address.port}`, "fixture-not-a-secret");
  const cases = [
    { model: "claude-opus-5-5", suppressed: true },
    { model: "fixture-future-anthropic-model", suppressed: true },
    { model: "claude-opus-5", suppressed: false },
    { model: "claude-opus-4-6", suppressed: false },
    { model: "claude-opus-5", suppressModelParameters: true, suppressed: true },
  ];
  assert.equal(shouldSuppressUnknownModelParameters("anthropic", cases[0]!.model), true);
  assert.equal(shouldSuppressUnknownModelParameters("anthropic", cases[1]!.model), true);
  assert.equal(shouldSuppressUnknownModelParameters("anthropic", "claude-opus-5"), false);

  for (const scenario of cases) {
    for (const streaming of [false, true]) {
      const label = `${scenario.model}, suppressed=${scenario.suppressed}, streaming=${streaming}`;
      const tokens: string[] = [];
      const options: ChatOptions = {
        model: scenario.model,
        suppressModelParameters: scenario.suppressModelParameters,
        maxTokens: 20000,
        temperature: 0.7,
        topK: 40,
        stop: ["fixture-stop"],
        enableThinking: scenario.suppressed,
        reasoningEffort: "high",
        tools: [tool],
        toolChoice: "required",
        stream: streaming,
        ...(streaming
          ? {
              onToken: (text: string) => {
                tokens.push(text);
              },
            }
          : {}),
      };
      replyWithTool = true;
      const messages: ChatMessage[] = [{ role: "user", content: "List fixture documents." }];
      const first = await provider.chatComplete(messages, options);
      const sent = requests.at(-1)!;
      assert.equal(sent.path, "/messages", label);
      assert.deepEqual(
        sent.body.tools,
        [
          {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          },
        ],
        `${label}: tool schema must survive parameter suppression`,
      );
      assert.equal(sent.body.model, scenario.model, label);
      assert.equal(sent.body.max_tokens, 20000, `${label}: required output budget`);
      assert.equal(sent.body.stream, streaming, label);
      assert.deepEqual(sent.body.tool_choice, { type: "any" }, label);
      if (scenario.suppressed) {
        for (const key of ["temperature", "top_k", "top_p", "thinking", "output_config", "stop_sequences"]) {
          assert.equal(key in sent.body, false, `${label}: optional ${key} remains suppressed`);
        }
      } else if (scenario.model === "claude-opus-4-6") {
        assert.equal(sent.body.temperature, 0.7, label);
        assert.equal(sent.body.top_k, 40, label);
        assert.deepEqual(sent.body.stop_sequences, ["fixture-stop"], label);
      }
      assert.equal(first.finishReason, "tool_calls", label);
      assert.equal(first.content, null, label);
      assert.deepEqual(
        first.toolCalls,
        [
          {
            id: toolUse.id,
            type: "function",
            function: { name: tool.function.name, arguments: "{}" },
          },
        ],
        `${label}: parsed tool_use must reach the caller`,
      );
      assert.deepEqual(tokens, [], label);

      // Exercise the actual second request, not only a serializer in isolation.
      replyWithTool = false;
      const second = await provider.chatComplete(
        [
          ...messages,
          { role: "assistant", content: "", tool_calls: first.toolCalls },
          { role: "tool", tool_call_id: toolUse.id, content: '{"documents":[]}' },
        ],
        options,
      );
      const replay = requests.at(-1)!.body.messages as Array<{ role: string; content: unknown[] }>;
      assert.deepEqual(replay[1], { role: "assistant", content: [toolUse] }, label);
      assert.deepEqual(
        replay[2],
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: '{"documents":[]}' }],
        },
        `${label}: tool result must retain the matching call ID`,
      );
      assert.equal(second.content, "Fixture answer.", label);
      assert.deepEqual(second.toolCalls, [], label);
      assert.deepEqual(tokens, streaming ? ["Fixture answer."] : [], label);
    }
  }

  // No enabled tools must keep the ordinary chat path, with no invented tool schema.
  replyWithTool = false;
  for (const streaming of [false, true]) {
    const result = await provider.chatComplete([{ role: "user", content: "Hello." }], {
      model: "claude-opus-5-5",
      maxTokens: 20000,
      stream: streaming,
    });
    assert.equal(result.content, "Fixture answer.");
    assert.deepEqual(result.toolCalls, []);
    assert.equal("tools" in requests.at(-1)!.body, false);
    assert.equal("tool_choice" in requests.at(-1)!.body, false);
  }

  // Explicit custom parameters remain user-controlled even for an unknown model.
  await provider.chatComplete([{ role: "user", content: "Hello." }], {
    model: "fixture-future-anthropic-model",
    tools: [tool],
    stream: false,
    customParameters: { temperature: 0.2, top_k: 7, stop_sequences: ["custom-stop"] },
  });
  assert.equal(requests.at(-1)!.body.temperature, 0.2);
  assert.equal(requests.at(-1)!.body.top_k, 7);
  assert.deepEqual(requests.at(-1)!.body.stop_sequences, ["custom-stop"]);

  // Preserve explicit parameter opt-out and the buffered agent-loop convention.
  for (const model of ["fixture-future-anthropic-model", "claude-opus-4-6"]) {
    await provider.chatComplete([{ role: "user", content: "Hello." }], {
      model,
      tools: [tool],
      stream: true,
      maxTokens: 20000,
      temperature: 0.7,
      topK: 40,
      enabledParameters: { maxTokens: false, temperature: false, topK: false },
    });
    for (const key of ["max_tokens", "temperature", "top_k"]) {
      assert.equal(key in requests.at(-1)!.body, false, `${model}: explicit ${key} opt-out`);
    }
    assert.equal((requests.at(-1)!.body.tools as unknown[]).length, 1);
    assert.equal(requests.at(-1)!.body.stream, false, "stream:true without a token sink remains buffered");
    assert.deepEqual(requests.at(-1)!.body.tool_choice, { type: "auto" });
  }
  process.stdout.write(`Anthropic unknown-model tools regression passed (${requests.length} fixture requests).\n`);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
