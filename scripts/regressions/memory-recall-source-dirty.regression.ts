import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { personalExtensionCoordination } from "../../packages/server/src/db/schema/index.js";
import {
  createMemoryRecallSourceDirtyPublisher,
  runMemoryRecallMutationWithDirtyHint,
} from "../../packages/server/src/services/memory-recall-source-dirty.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-memory-recall-source-dirty-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;

const activeExtensionIds = ["memory-dirty-active-a", "memory-dirty-active-b"];
const inactiveExtensionId = "memory-dirty-inactive";
const chatId = "memory-dirty-chat";
const timestamp = new Date(0).toISOString();
let clockMs = 10_000;

try {
  const fileDb = await createFileNativeDB();
  const db = fileDb as unknown as DB;
  for (const [extensionId, mode] of [
    [activeExtensionIds[0], "active"],
    [inactiveExtensionId, "inactive"],
    [activeExtensionIds[1], "active"],
  ] as const) {
    await db.insert(personalExtensionCoordination).values({
      extensionId,
      contentHash: `sha256:${"a".repeat(64)}`,
      mode,
      serverBootId: "memory-dirty-boot",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const published: Array<{ extensionId: string; draft: unknown }> = [];
  const publisher = createMemoryRecallSourceDirtyPublisher(db, {
    now: () => clockMs,
    eventService: {
      publish(extensionId, draft) {
        published.push({ extensionId, draft });
        return draft;
      },
    },
  });

  await publisher.publish(chatId);
  assert.deepEqual(
    published.map((entry) => entry.extensionId).sort(),
    [...activeExtensionIds].sort(),
    "only active coordination extensions may receive server-origin source hints",
  );
  for (const entry of published) {
    assert.deepEqual(entry.draft, { type: "source-dirty", chatId });
    assert.deepEqual(Object.keys(entry.draft as object).sort(), ["chatId", "type"]);
  }

  await publisher.publish(chatId);
  assert.equal(published.length, 2, "same-extension/chat hints must coalesce inside two seconds");
  clockMs += 2_000;
  await publisher.publish(chatId);
  assert.equal(published.length, 4, "the coalesce window must reopen without a timer-owned state change");

  const attempts: string[] = [];
  const failingPublisher = createMemoryRecallSourceDirtyPublisher(db, {
    now: () => clockMs,
    eventService: {
      publish(extensionId) {
        attempts.push(extensionId);
        if (extensionId === activeExtensionIds[0]) throw new Error("simulated event publication failure");
        return null;
      },
    },
  });
  await failingPublisher.publish(chatId);
  assert.deepEqual(
    attempts.sort(),
    [...activeExtensionIds].sort(),
    "one extension's broken event stream must not block the remaining active extensions",
  );

  let mutationCompleted = false;
  const mutationResult = await runMemoryRecallMutationWithDirtyHint(
    {
      async publish() {
        assert.equal(mutationCompleted, true, "the source hint must follow materialization completion");
        throw new Error("simulated best-effort hint failure");
      },
    },
    chatId,
    async () => {
      mutationCompleted = true;
      return { rebuilt: 3 };
    },
  );
  assert.deepEqual(mutationResult, { rebuilt: 3 }, "hint failure must not reverse the Memory Recall result");

  let hintAfterFailedMutation = 0;
  await assert.rejects(
    runMemoryRecallMutationWithDirtyHint(
      {
        async publish() {
          hintAfterFailedMutation += 1;
        },
      },
      chatId,
      async () => {
        throw new Error("simulated source mutation failure");
      },
    ),
    /simulated source mutation failure/u,
  );
  assert.equal(hintAfterFailedMutation, 0, "a failed source mutation must not claim successful materialization");

  const chatsRouteSource = readFileSync(
    new URL("../../packages/server/src/routes/chats.routes.ts", import.meta.url),
    "utf8",
  );
  const generateRouteSource = readFileSync(
    new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    (chatsRouteSource.match(/runMemoryRecallMutationWithDirtyHint\(/gu) ?? []).length,
    4,
    "import, refresh, all-delete, and single-delete must all publish after completion",
  );
  assert.match(
    generateRouteSource,
    /runMemoryRecallMutationWithDirtyHint\([\s\S]*?chunkAndEmbedMessages\(/u,
    "background chunk materialization must publish only through the completion wrapper",
  );

  await fileDb._fileStore.close();
} finally {
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}

console.info("Memory Recall source-dirty regression passed.");
