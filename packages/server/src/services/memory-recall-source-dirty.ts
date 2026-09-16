import { PERSONAL_EXTENSION_COORDINATION_DIRTY_COALESCE_MS } from "@marinara-engine/shared";
import type { DB } from "../db/connection.js";
import { eq } from "../db/file-query.js";
import { personalExtensionCoordination } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import { getPersonalExtensionCoordinationEventService } from "./extensions/personal-extension-coordination-events.service.js";

type SourceDirtyEventService = {
  publish(extensionId: string, draft: { type: "source-dirty"; chatId: string }): unknown;
};

export type MemoryRecallSourceDirtyPublisher = {
  publish(chatId: string): Promise<void>;
};

export type MemoryRecallSourceDirtyPublisherOptions = {
  eventService?: SourceDirtyEventService;
  now?: () => number;
};

/**
 * Publish a content-free hint to every currently active coordination runtime.
 * This is deliberately non-authoritative: storage revisions and cold scans
 * remain the proof, and event failures never change the source mutation result.
 */
export function createMemoryRecallSourceDirtyPublisher(
  db: DB,
  options: MemoryRecallSourceDirtyPublisherOptions = {},
): MemoryRecallSourceDirtyPublisher {
  const injectedEventService = options.eventService;
  const readNow = options.now ?? Date.now;
  const lastPublishedAt = new Map<string, number>();

  return {
    async publish(chatId: string) {
      let activeExtensions: Array<{ extensionId: string }>;
      let timestamp: number;
      try {
        timestamp = readNow();
        if (!Number.isFinite(timestamp)) throw new Error("invalid source-dirty clock");
        activeExtensions = await db
          .select({ extensionId: personalExtensionCoordination.extensionId })
          .from(personalExtensionCoordination)
          .where(eq(personalExtensionCoordination.mode, "active"));
      } catch {
        logger.warn("[memory-recall] Failed to discover active coordination targets for a source-dirty hint");
        return;
      }

      for (const [key, acceptedAt] of lastPublishedAt) {
        if (timestamp >= acceptedAt && timestamp - acceptedAt >= PERSONAL_EXTENSION_COORDINATION_DIRTY_COALESCE_MS) {
          lastPublishedAt.delete(key);
        }
      }

      for (const { extensionId } of activeExtensions) {
        const key = JSON.stringify([extensionId, chatId]);
        const acceptedAt = lastPublishedAt.get(key);
        if (
          acceptedAt !== undefined &&
          timestamp >= acceptedAt &&
          timestamp - acceptedAt < PERSONAL_EXTENSION_COORDINATION_DIRTY_COALESCE_MS
        ) {
          continue;
        }
        try {
          const eventService = injectedEventService ?? getPersonalExtensionCoordinationEventService(db);
          eventService.publish(extensionId, { type: "source-dirty", chatId });
          lastPublishedAt.set(key, timestamp);
        } catch {
          // A hint is only an acceleration path. Do not include the thrown
          // object: it can carry host/request context which events must omit.
          logger.warn("[memory-recall] Failed to publish a source-dirty hint");
        }
      }
    },
  };
}

const publishers = new WeakMap<DB, MemoryRecallSourceDirtyPublisher>();

export function getMemoryRecallSourceDirtyPublisher(db: DB): MemoryRecallSourceDirtyPublisher {
  let publisher = publishers.get(db);
  if (!publisher) {
    publisher = createMemoryRecallSourceDirtyPublisher(db);
    publishers.set(db, publisher);
  }
  return publisher;
}

export async function runMemoryRecallMutationWithDirtyHint<T>(
  publisher: MemoryRecallSourceDirtyPublisher,
  chatId: string,
  mutation: () => PromiseLike<T>,
): Promise<T> {
  const result = await mutation();
  try {
    await publisher.publish(chatId);
  } catch {
    // Custom/test publishers cannot be allowed to strengthen the best-effort
    // contract owned by this completion boundary.
    logger.warn("[memory-recall] Source-dirty hint failed after a completed mutation");
  }
  return result;
}
