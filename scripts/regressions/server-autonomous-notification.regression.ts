import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getServerAutonomousBusyDelayPolicyKey,
  parseServerAutonomousGenerationSse,
  shouldRescheduleServerAutonomousBusyDelay,
} from "../../packages/server/src/services/conversation/server-autonomous-scheduler.service.js";

type ParsedAutonomousGeneration = ReturnType<typeof parseServerAutonomousGenerationSse> & {
  visibleAssistantMessageSaved?: boolean;
};

function sse(...events: Array<{ type: string; data: unknown }>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function parse(...events: Array<{ type: string; data: unknown }>): ParsedAutonomousGeneration {
  return parseServerAutonomousGenerationSse(sse(...events)) as ParsedAutonomousGeneration;
}

const visibleStringExtra = parse(
  {
    type: "message_saved",
    data: {
      id: "visible-string-extra",
      chatId: "conversation-chat",
      role: "assistant",
      content: "A visible reply",
      extra: JSON.stringify({ isGenerated: true }),
    },
  },
  { type: "done", data: "" },
);
assert.equal(visibleStringExtra.done, true);
assert.equal(
  Boolean(visibleStringExtra.visibleAssistantMessageSaved),
  true,
  "a completed generation with a durable visible assistant message must increment autonomous unread",
);

const visibleObjectExtra = parse(
  {
    type: "message_saved",
    data: {
      id: "visible-object-extra",
      chatId: "conversation-chat",
      role: "assistant",
      content: "A visible post-processing placeholder",
      extra: { isGenerated: true, postProcessingPending: { agentType: "prose-guardian" } },
    },
  },
  { type: "done", data: "" },
);
assert.equal(
  Boolean(visibleObjectExtra.visibleAssistantMessageSaved),
  true,
  "message_saved payloads may carry an object-valued extra after post-processing setup",
);

const hiddenAnchor = parse(
  {
    type: "message_saved",
    data: {
      id: "hidden-anchor",
      chatId: "conversation-chat",
      role: "assistant",
      content: "",
      extra: JSON.stringify({ hiddenFromUser: true, commandOnly: true }),
    },
  },
  { type: "done", data: "" },
);
assert.equal(
  Boolean(hiddenAnchor.visibleAssistantMessageSaved),
  false,
  "a hidden command anchor must not increment autonomous unread",
);

const commandOnlyAnchor = parse(
  {
    type: "message_saved",
    data: {
      id: "command-only-anchor",
      chatId: "conversation-chat",
      role: "assistant",
      content: "",
      extra: { commandOnly: true },
    },
  },
  { type: "done", data: "" },
);
assert.equal(
  Boolean(commandOnlyAnchor.visibleAssistantMessageSaved),
  false,
  "a command-only anchor must remain non-notifying even if hiddenFromUser is absent",
);

const userMessage = parse(
  {
    type: "message_saved",
    data: {
      id: "user-message",
      chatId: "conversation-chat",
      role: "user",
      content: "Impersonated text",
      extra: {},
    },
  },
  { type: "done", data: "" },
);
assert.equal(
  Boolean(userMessage.visibleAssistantMessageSaved),
  false,
  "user messages must not increment autonomous unread",
);

const doneOnly = parse({ type: "done", data: "" });
assert.deepEqual(
  doneOnly,
  {
    done: true,
    discarded: false,
    error: null,
    visibleAssistantMessageSaved: false,
  },
  "done without message_saved must not increment autonomous unread",
);

for (const invalidExtra of [undefined, null, "{malformed"] as const) {
  const invalidSavedPayload = parse(
    {
      type: "message_saved",
      data: {
        id: "invalid-extra",
        chatId: "conversation-chat",
        role: "assistant",
        content: "Visibility cannot be established",
        extra: invalidExtra,
      },
    },
    { type: "done", data: "" },
  );
  assert.equal(
    Boolean(invalidSavedPayload.visibleAssistantMessageSaved),
    false,
    "missing or malformed extra must fail closed instead of creating an unread alert",
  );
}

const schedulerSource = await readFile(
  new URL("../../packages/server/src/services/conversation/server-autonomous-scheduler.service.ts", import.meta.url),
  "utf8",
);
const visibleGateIndex = schedulerSource.indexOf("if (!result.visibleAssistantMessageSaved) return false;");
const unreadWriteIndex = schedulerSource.indexOf("await chats.markAutonomousUnread", visibleGateIndex);
assert.ok(
  visibleGateIndex >= 0 && unreadWriteIndex > visibleGateIndex && unreadWriteIndex - visibleGateIndex < 200,
  "the production unread write must remain directly gated by a visible assistant message_saved event",
);

const idleDefaultPolicy = getServerAutonomousBusyDelayPolicyKey("character-a", "idle", {});
assert.equal(
  getServerAutonomousBusyDelayPolicyKey("character-a", "idle", {}),
  idleDefaultPolicy,
  "a sustained idle status must retain one policy identity even though each default delay sample is randomized",
);
assert.notEqual(
  getServerAutonomousBusyDelayPolicyKey("character-a", "dnd", {}),
  idleDefaultPolicy,
  "a status transition may require a fresh busy delay",
);
assert.notEqual(
  getServerAutonomousBusyDelayPolicyKey("character-b", "idle", {}),
  idleDefaultPolicy,
  "a different selected character must satisfy its own busy delay",
);
assert.notEqual(
  getServerAutonomousBusyDelayPolicyKey("character-a", "idle", { idleResponseDelayMinutes: 2 }),
  idleDefaultPolicy,
  "a changed configured delay may require a fresh busy delay",
);
assert.equal(
  getServerAutonomousBusyDelayPolicyKey("character-a", "idle", { idleResponseDelayMinutes: -5 }),
  getServerAutonomousBusyDelayPolicyKey("character-a", "idle", { idleResponseDelayMinutes: 0 }),
  "policy identity must use the same clamped delay semantics as generation",
);
assert.equal(
  getServerAutonomousBusyDelayPolicyKey("character-a", "online", {}),
  null,
  "online status has no busy-delay policy",
);
assert.equal(
  shouldRescheduleServerAutonomousBusyDelay(idleDefaultPolicy, idleDefaultPolicy, 120_000),
  false,
  "a sustained idle or DND policy must generate after its first satisfied delay instead of rescheduling forever",
);
assert.equal(
  shouldRescheduleServerAutonomousBusyDelay(
    idleDefaultPolicy,
    getServerAutonomousBusyDelayPolicyKey("character-a", "dnd", {}),
    120_000,
  ),
  true,
  "a changed busy policy may schedule one fresh delay",
);

console.log("server autonomous notification regression: passed");
