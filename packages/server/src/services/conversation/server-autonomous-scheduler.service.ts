import type { FastifyInstance } from "fastify";
import { logger } from "../../lib/logger.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import {
  clearGenerationInProgress,
  getActivityState,
  getRecentAutonomousClientPresence,
} from "./autonomous.service.js";
import { isIntentOnCooldown, resolveIntent, type MessageIntent } from "./intent.service.js";
import { getBusyDelay, getEffectiveCurrentStatus, type WeekSchedule } from "./schedule.service.js";
import { parseConversationStatusOverrides } from "../generation/conversation-context-utils.js";
import {
  getProfileAssetMaintenanceEpoch,
  runWithDetachedProfileAssetMutation,
} from "../import/profile-asset-mutation-gate.js";
import { resolveConversationTimeZone, toZonedWallClockDate } from "./timezone.js";

const SERVER_AUTONOMOUS_INITIAL_DELAY_MS = 20_000;
const SERVER_AUTONOMOUS_POLL_MS = 60_000;
const RECENT_CLIENT_PRESENCE_MS = 75_000;
const OFFLINE_MAX_FOLLOWUPS = 2;
const MAX_SERVER_AUTONOMOUS_CONCURRENT_EVALUATIONS = 2;
const AUTONOMOUS_FAILURE_BASE_BACKOFF_MS = 5 * 60_000;
const AUTONOMOUS_FAILURE_MAX_BACKOFF_MS = 60 * 60_000;
const AUTONOMOUS_HARD_FAILURE_BACKOFF_MS = 30 * 60_000;

type AutonomousFailureBackoff = {
  attempts: number;
  nextAllowedAt: number;
  lastError: string;
  hardFailure: boolean;
};

type RawChat = {
  id: string;
  mode?: string | null;
  metadata?: string | Record<string, unknown> | null;
};

type AutonomousCheckResult = {
  shouldTrigger?: boolean;
  characterIds?: string[];
  reason?: string;
  inactivityMs?: number;
  generationStartedAt?: number;
};

function resolveAvailableIntent(
  chatId: string,
  characterId: string,
  schedule: WeekSchedule | null,
  chatMeta: Record<string, unknown>,
  now: Date,
): { intent: MessageIntent | null; onCooldown: boolean; disabled: boolean } {
  if (!schedule) return { intent: null, onCooldown: false, disabled: false };

  const state = getActivityState(chatId);
  const msSinceUserLastSpoke = state ? Date.now() - state.lastUserMessageAt : 0;
  const hadUnansweredUserMessage = state ? state.lastUserMessageAt > state.lastAssistantMessageAt : false;
  const intent = resolveIntent(schedule, msSinceUserLastSpoke, hadUnansweredUserMessage, now);

  return {
    intent,
    onCooldown: isIntentOnCooldown(chatMeta, characterId, intent),
    disabled: intent !== "check_in" && (schedule.disabledAutonomousIntents?.includes(intent) ?? false),
  };
}

function parseMetadata(raw: RawChat["metadata"]): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw;
}

function shouldConsiderChat(chat: RawChat): boolean {
  if (chat.mode !== "conversation") return false;
  const meta = parseMetadata(chat.metadata);
  if (meta.internalAssistant === "professor-mari") return false;
  return meta.autonomousMessages === true && meta.sceneStatus !== "active";
}

function parseSsePayload(payload: string): { done: boolean; discarded: boolean; error: string | null } {
  let done = false;
  let discarded = false;
  let error: string | null = null;

  for (const block of payload.split(/\n\n/u)) {
    const line = block
      .split(/\n/u)
      .find((entry) => entry.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { type?: string; data?: unknown };
      if (event.type === "done") done = true;
      if (event.type === "generation_discarded") discarded = true;
      if (event.type === "error") {
        error = typeof event.data === "string" ? event.data : "Generation failed";
      }
    } catch {
      continue;
    }
  }

  return { done, discarded, error };
}

function isHardGenerationFailure(error: string, statusCode?: number): boolean {
  if (statusCode !== undefined) {
    return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 409 && statusCode !== 429;
  }
  return /\b(?:400|401|403|404|405|410|422)\b/u.test(error);
}

export function startServerAutonomousScheduler(app: FastifyInstance) {
  const chats = createChatsStorage(app.db);
  const runningChats = new Set<string>();
  const failureBackoffByChat = new Map<string, AutonomousFailureBackoff>();
  let stopped = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const delayedGenerations = new Map<
    ReturnType<typeof setTimeout>,
    { chatId: string; claimedAt: number | undefined }
  >();
  let observedMaintenanceEpoch = getProfileAssetMaintenanceEpoch();

  const scheduleNext = (delayMs = SERVER_AUTONOMOUS_POLL_MS) => {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      void poll();
    }, delayMs);
    pollTimer.unref?.();
  };

  const synchronizeMaintenanceEpoch = () => {
    const currentEpoch = getProfileAssetMaintenanceEpoch();
    if (currentEpoch === observedMaintenanceEpoch) return false;
    for (const [timer, pending] of delayedGenerations) {
      clearTimeout(timer);
      clearGenerationInProgress(pending.chatId, pending.claimedAt);
    }
    delayedGenerations.clear();
    runningChats.clear();
    failureBackoffByChat.clear();
    observedMaintenanceEpoch = currentEpoch;
    return true;
  };

  const isChatOnFailureBackoff = (chatId: string) => {
    const backoff = failureBackoffByChat.get(chatId);
    if (!backoff) return false;
    if (Date.now() < backoff.nextAllowedAt) return true;
    return false;
  };

  const clearFailureBackoff = (chatId: string) => {
    failureBackoffByChat.delete(chatId);
  };

  const recordFailureBackoff = (chatId: string, error: string, statusCode?: number) => {
    const previous = failureBackoffByChat.get(chatId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const hardFailure = isHardGenerationFailure(error, statusCode);
    const delayMs = hardFailure
      ? Math.min(AUTONOMOUS_FAILURE_MAX_BACKOFF_MS, AUTONOMOUS_HARD_FAILURE_BACKOFF_MS * attempts)
      : Math.min(
          AUTONOMOUS_FAILURE_MAX_BACKOFF_MS,
          AUTONOMOUS_FAILURE_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
        );
    failureBackoffByChat.set(chatId, {
      attempts,
      nextAllowedAt: Date.now() + delayMs,
      lastError: error,
      hardFailure,
    });
    logger.warn(
      "[autonomous-scheduler] Pausing retries for chat %s for %d seconds after %s failure: %s",
      chatId,
      Math.ceil(delayMs / 1000),
      hardFailure ? "hard" : "transient",
      error,
    );
  };

  const generateAutonomousMessage = async (
    chatId: string,
    characterId: string,
    schedule: WeekSchedule | null,
    chatMeta: Record<string, unknown>,
    claimedAt?: number,
  ): Promise<boolean> => {
    const promptTimeZone = resolveConversationTimeZone(chatMeta);
    const promptNow = toZonedWallClockDate(new Date(), promptTimeZone);
    const { intent, onCooldown, disabled } = resolveAvailableIntent(chatId, characterId, schedule, chatMeta, promptNow);
    if (onCooldown || disabled) {
      clearGenerationInProgress(chatId, claimedAt);
      return false;
    }
    const response = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: {
        chatId,
        connectionId: null,
        forCharacterId: characterId,
        streaming: false,
        userStatus: "idle",
        userActivity: "away or offline",
        autonomous: true,
        skipPresenceDelay: true,
        autonomousIntentKey: intent ?? "",
        userTimeZone: promptTimeZone,
      },
    });

    if (response.statusCode === 409) {
      clearGenerationInProgress(chatId, claimedAt);
      return false;
    }

    if (response.statusCode !== 200) {
      clearGenerationInProgress(chatId, claimedAt);
      recordFailureBackoff(chatId, response.payload.slice(0, 300), response.statusCode);
      logger.warn(
        "[autonomous-scheduler] Generate failed for chat %s with status %d: %s",
        chatId,
        response.statusCode,
        response.payload.slice(0, 300),
      );
      return false;
    }

    const result = parseSsePayload(response.payload);
    if (result.error) {
      clearGenerationInProgress(chatId, claimedAt);
      recordFailureBackoff(chatId, result.error);
      logger.warn("[autonomous-scheduler] Generate failed for chat %s: %s", chatId, result.error);
      return false;
    }
    if (!result.done) {
      clearGenerationInProgress(chatId, claimedAt);
      logger.warn("[autonomous-scheduler] Generate ended without a done event for chat %s", chatId);
      return false;
    }

    if (result.discarded) {
      clearFailureBackoff(chatId);
      return false;
    }

    clearFailureBackoff(chatId);
    await chats.markAutonomousUnread(chatId, { characterId });
    return true;
  };

  // Runs after a busy delay on a per-chat timer so the poll loop isn't blocked.
  // Owns the runningChats slot until it finishes.
  const scheduleDelayedGeneration = (chatId: string, claimedAt: number | undefined, delayMs: number) => {
    const scheduledEpoch = getProfileAssetMaintenanceEpoch();
    const timer = setTimeout(() => {
      delayedGenerations.delete(timer);
      void runWithDetachedProfileAssetMutation(async () => {
        let activeClaimedAt = claimedAt;
        let rescheduled = false;
        try {
          // A restore may reuse the same chat UUID. Old process-memory claims,
          // character selection, and activity timestamps are not valid across
          // that boundary; let the next fresh poll reconstruct them.
          const epochChanged = synchronizeMaintenanceEpoch();
          if (epochChanged || scheduledEpoch !== getProfileAssetMaintenanceEpoch()) {
            clearGenerationInProgress(chatId, activeClaimedAt);
            return;
          }
          if (stopped) {
            clearGenerationInProgress(chatId, activeClaimedAt);
            return;
          }
          if (getRecentAutonomousClientPresence(chatId, RECENT_CLIENT_PRESENCE_MS)) {
            clearGenerationInProgress(chatId, activeClaimedAt);
            return;
          }
          if (isChatOnFailureBackoff(chatId)) {
            clearGenerationInProgress(chatId, activeClaimedAt);
            return;
          }

          // Never pass the pre-delay claim or character selection to generate.
          clearGenerationInProgress(chatId, activeClaimedAt);
          activeClaimedAt = undefined;
          const checkResponse = await app.inject({
            method: "POST",
            url: "/api/conversation/autonomous/check",
            payload: {
              chatId,
              userStatus: "idle",
              maxFollowups: OFFLINE_MAX_FOLLOWUPS,
              source: "server",
            },
          });
          if (checkResponse.statusCode !== 200) return;
          const result = JSON.parse(checkResponse.payload) as AutonomousCheckResult;
          activeClaimedAt = result.generationStartedAt;
          const characterId = result.shouldTrigger ? result.characterIds?.[0] : null;
          if (!characterId) return;

          await chats.inheritFreshConversationSchedules(chatId);
          const freshChat = await chats.getById(chatId);
          if (!freshChat || !shouldConsiderChat(freshChat)) {
            clearGenerationInProgress(chatId, activeClaimedAt);
            return;
          }
          const freshMeta = parseMetadata(freshChat.metadata);
          const freshSchedules = (freshMeta.characterSchedules ?? {}) as Record<string, WeekSchedule>;
          const schedule = freshSchedules[characterId] ?? null;
          if (schedule) {
            const promptTimeZone = resolveConversationTimeZone(freshMeta);
            const nowInstant = new Date();
            const promptNow = toZonedWallClockDate(nowInstant, promptTimeZone);
            const statusOverrides = parseConversationStatusOverrides(freshMeta.conversationStatusOverrides);
            const { status } = getEffectiveCurrentStatus(
              schedule,
              statusOverrides[characterId],
              nowInstant,
              "free time",
              promptNow,
            );
            if (status === "offline") {
              clearGenerationInProgress(chatId, activeClaimedAt);
              return;
            }
            const nextDelayMs = getBusyDelay(status, schedule);
            if (nextDelayMs > 0) {
              rescheduled = true;
              scheduleDelayedGeneration(chatId, activeClaimedAt, nextDelayMs);
              return;
            }
          }
          const generated = await generateAutonomousMessage(chatId, characterId, schedule, freshMeta, activeClaimedAt);
          if (generated) {
            logger.info("[autonomous-scheduler] Generated autonomous message for chat %s (after delay)", chatId);
          }
        } catch (err) {
          clearGenerationInProgress(chatId, activeClaimedAt);
          logger.warn(err, "[autonomous-scheduler] Failed during delayed generation for chat %s", chatId);
        } finally {
          if (!rescheduled) runningChats.delete(chatId);
        }
      }).catch((err) => {
        clearGenerationInProgress(chatId, claimedAt);
        runningChats.delete(chatId);
        logger.warn(err, "[autonomous-scheduler] Failed to admit delayed generation for chat %s", chatId);
      });
    }, delayMs);
    delayedGenerations.set(timer, { chatId, claimedAt });
    timer.unref?.();
  };

  const evaluateChat = async (chatId: string) => {
    if (runningChats.has(chatId)) return;
    runningChats.add(chatId);
    let generationStartedAt: number | undefined;
    let handedOffToTimer = false;
    try {
      // Poll snapshots are only candidate IDs. Re-read the chat after fresh
      // admission so a restore cannot leave this detached evaluation acting on
      // metadata captured from the old profile.
      await runWithDetachedProfileAssetMutation(async () => {
        synchronizeMaintenanceEpoch();
        runningChats.add(chatId);
        if (stopped) return;
        const chat = await chats.getById(chatId);
        if (!chat || !shouldConsiderChat(chat) || isChatOnFailureBackoff(chatId)) return;
        const activeGenerations = (app as unknown as { activeGenerations?: Map<string, unknown> }).activeGenerations;
        if (activeGenerations?.has(chatId)) return;
        if (getRecentAutonomousClientPresence(chatId, RECENT_CLIENT_PRESENCE_MS)) return;

        const checkResponse = await app.inject({
          method: "POST",
          url: "/api/conversation/autonomous/check",
          payload: {
            chatId,
            userStatus: "idle",
            maxFollowups: OFFLINE_MAX_FOLLOWUPS,
            source: "server",
          },
        });

        if (checkResponse.statusCode !== 200) {
          logger.warn(
            "[autonomous-scheduler] Eligibility check failed for chat %s with status %d",
            chatId,
            checkResponse.statusCode,
          );
          return;
        }

        const result = JSON.parse(checkResponse.payload) as AutonomousCheckResult;
        generationStartedAt = result.generationStartedAt;
        const characterId = result.shouldTrigger ? result.characterIds?.[0] : null;
        if (!characterId) return;

        await chats.inheritFreshConversationSchedules(chatId);
        const freshChat = await chats.getById(chatId);
        if (!freshChat || !shouldConsiderChat(freshChat)) return;
        const freshMeta = parseMetadata(freshChat.metadata);
        const promptTimeZone = resolveConversationTimeZone(freshMeta);
        const nowInstant = new Date();
        const promptNow = toZonedWallClockDate(nowInstant, promptTimeZone);
        const freshSchedules = (freshMeta.characterSchedules ?? {}) as Record<string, WeekSchedule>;
        const statusOverrides = parseConversationStatusOverrides(freshMeta.conversationStatusOverrides);
        const schedule = freshSchedules[characterId] ?? null;

        if (schedule) {
          const { status } = getEffectiveCurrentStatus(
            schedule,
            statusOverrides[characterId],
            nowInstant,
            "free time",
            promptNow,
          );
          if (status === "offline") {
            clearGenerationInProgress(chatId, generationStartedAt);
            return;
          }
          const delayMs = getBusyDelay(status, schedule);
          if (delayMs > 0) {
            handedOffToTimer = true;
            scheduleDelayedGeneration(chatId, generationStartedAt, delayMs);
            return;
          }
        }

        const generated = await generateAutonomousMessage(
          chatId,
          characterId,
          schedule,
          freshMeta,
          generationStartedAt,
        );
        if (generated) {
          logger.info("[autonomous-scheduler] Generated autonomous message for chat %s", chatId);
        }
      });
    } catch (err) {
      clearGenerationInProgress(chatId, generationStartedAt);
      recordFailureBackoff(chatId, err instanceof Error ? err.message : String(err));
      logger.warn(err, "[autonomous-scheduler] Failed while evaluating chat %s", chatId);
    } finally {
      if (!handedOffToTimer) runningChats.delete(chatId);
    }
  };

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      synchronizeMaintenanceEpoch();
      const allChats = (await chats.list()) as RawChat[];
      for (const chat of allChats) {
        if (stopped) return;
        if (runningChats.size >= MAX_SERVER_AUTONOMOUS_CONCURRENT_EVALUATIONS) break;
        if (!shouldConsiderChat(chat)) continue;
        void evaluateChat(chat.id);
      }
    } catch (err) {
      logger.warn(err, "[autonomous-scheduler] Poll failed");
    } finally {
      polling = false;
      scheduleNext();
    }
  };

  const stop = () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    for (const [timer, pending] of delayedGenerations) {
      clearTimeout(timer);
      clearGenerationInProgress(pending.chatId, pending.claimedAt);
    }
    delayedGenerations.clear();
    runningChats.clear();
  };

  scheduleNext(SERVER_AUTONOMOUS_INITIAL_DELAY_MS);
  app.addHook("onClose", async () => {
    stop();
  });

  logger.info("[autonomous-scheduler] Server-side autonomous scheduler started");

  return {
    stop,
    // Deterministic regression seam for restore-vs-timer ordering. Production
    // callers use only stop(); keeping the real closure here avoids a mock-only
    // copy of the safety-critical delayed path.
    scheduleDelayedGenerationForRegression: scheduleDelayedGeneration,
  };
}
