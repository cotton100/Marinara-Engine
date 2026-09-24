import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../../packages/server/src/db/file-backed-store.js";
import { MariDbService } from "../../../packages/server/src/services/mari-db/mari-db.service.js";
import { PROFESSOR_MARI_APP_DATA_ACTIONS } from "../../../packages/server/src/services/professor-mari/workspace-agent.service.js";
import { createChatsStorage } from "../../../packages/server/src/services/storage/chats.storage.js";

const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const dir = mkdtempSync(join(tmpdir(), "marinara-mari-chat-app-data-"));
process.env.FILE_STORAGE_DIR = dir;

try {
  let db = await createFileNativeDB();
  try {
    let chats = createChatsStorage(db);
    const chat = await chats.create({
      name: "App data chat regression",
      mode: "roleplay",
      characterIds: ["character-a"],
    });
    assert.ok(chat);
    await chats.createMessage({ chatId: chat.id, role: "user", content: "First" });
    await chats.createMessage({ chatId: chat.id, role: "assistant", content: "Second" });
    await chats.createMessage({ chatId: chat.id, role: "user", content: "Third" });

    const sibling = await chats.create({ name: "Unrelated cold chat", mode: "roleplay", characterIds: [] });
    await chats.createMessage({ chatId: sibling.id, role: "user", content: "Do not load this other room" });
    await db._fileStore.close();
    let afterChatRead: (() => Promise<void>) | undefined;
    db = await createFileNativeDB({
      afterTableRead: async (table) => {
        if (table !== "chats" || !afterChatRead) return;
        const callback = afterChatRead;
        afterChatRead = undefined;
        await callback();
      },
    });
    chats = createChatsStorage(db);
    const assertScopedRead = () => {
      assert.equal(
        db._fileStore.getFullyResidentLazyTables().has("messages"),
        false,
        "one chat must not lease all messages",
      );
      assert.equal(db._fileStore.getResidentChatUnits().has(sibling.id), false, "unrelated room must remain cold");
      assert.equal(
        db._fileStore.getResidentLazyRows("messages").some((row) => row.chatId === sibling.id),
        false,
      );
    };

    const mari = new MariDbService(db);
    assert.ok(PROFESSOR_MARI_APP_DATA_ACTIONS.includes("chat.messages"));

    const fetched = await mari.executeAction({ action: "chat.get", chatId: chat.id });
    assert.equal(fetched.ok, true);
    assert.equal((fetched.output as { messageCount?: number }).messageCount, 3);
    assertScopedRead();

    // A restore may acquire its exclusive barrier after chat lookup but before
    // counting messages. The second read must wait just like ordinary select.
    let releaseRestore!: () => void;
    let enteredRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const restoreEntered = new Promise<void>((resolve) => {
      enteredRestore = resolve;
    });
    let restoring: Promise<void> | undefined;
    afterChatRead = async () => {
      restoring = db._fileStore.runExclusiveTransactions(async () => {
        enteredRestore();
        await restoreGate;
      });
      await restoreEntered;
    };
    let finished = false;
    const duringRestore = mari.executeAction({ action: "chat.get", chatId: chat.id }).then((result) => {
      finished = true;
      return result;
    });
    try {
      await restoreEntered;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(finished, false, "message count must wait behind an exclusive restore");
    } finally {
      releaseRestore();
      await restoring;
      await duringRestore;
    }
    assert.equal(((await duringRestore).output as { messageCount: number }).messageCount, 3);
    assertScopedRead();

    const messages = await mari.executeAction({ action: "chat.messages", chatId: chat.id, last: 2 });
    assertScopedRead();
    assert.deepEqual(
      (messages.output as { messages: Array<{ postNumber: number; content: string }> }).messages.map(
        ({ postNumber, content }) => ({ postNumber, content }),
      ),
      [
        { postNumber: 2, content: "Second" },
        { postNumber: 3, content: "Third" },
      ],
    );

    const oversizedContent = "x".repeat(40_000);
    await chats.createMessage({ chatId: chat.id, role: "assistant", content: oversizedContent });
    const bounded = await mari.executeAction({ action: "chat.messages", chatId: chat.id, last: 1 });
    assert.equal(bounded.truncation?.truncated, true);
    assert.ok(JSON.stringify(bounded.output).length < 28_000, "chat message pages must stay under the hard cap");

    const contentWindow = await mari.executeAction({
      action: "chat.messages",
      chatId: chat.id,
      last: 1,
      field: "messages[0].content",
      offset: 20_000,
      limit: 20_000,
    });
    assert.equal(contentWindow.output, oversizedContent.slice(20_000));
    assert.equal(contentWindow.truncation?.field?.offset, 20_000);

    const tailWindow = await mari.executeAction({
      action: "chat.messages",
      chatId: chat.id,
      last: 2,
      tail: true,
      field: "messages[0].content",
      offset: 30_000,
      limit: 10_000,
    });
    assert.equal(tailWindow.output, oversizedContent.slice(30_000));

    const search = await mari.executeAction({ action: "chats.search", query: "App data chat" });
    assert.equal(search.ok, true, "plural chat action aliases should resolve");
    assert.equal((search.output as Array<{ id: string }>)[0]?.id, chat.id);
  } finally {
    await db._fileStore.close();
  }
} finally {
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(dir, { recursive: true, force: true });
}

console.log("Mari chat app_data regressions passed.");
