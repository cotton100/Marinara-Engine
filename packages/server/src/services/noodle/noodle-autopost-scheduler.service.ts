import type { FastifyInstance } from "fastify";
import { logger } from "../../lib/logger.js";
import { sweepStagedImages } from "../image/image-generation.js";
import { createNoodleStorage } from "../storage/noodle.storage.js";
import { prepareNextNoodlerReservePost, reconcileNoodlerReserve } from "./noodle-noodler-reserve.operation.js";
import { runWithProfileAssetMutation } from "../import/profile-asset-mutation-gate.js";

const INITIAL_DELAY_MS = 30_000;
const POLL_MS = 60_000;

/**
 * Reserve work writes rows and gallery files in the same pass, and a backup collects tables and
 * assets separately. Running both at once can archive a row whose media is not in the zip, or
 * media no row owns, so the exporter holds this gate for the length of its snapshot.
 */
let pauseDepth = 0;
const activeWorks = new Set<Promise<void>>();

export async function runWithNoodleAutoPostAdmission<T>(work: () => Promise<T>): Promise<T | undefined> {
  return runWithProfileAssetMutation(async () => {
    // Recheck only after shared admission. A poll queued behind restore must
    // not become work that a snapshot already holding shared waits for.
    if (pauseDepth > 0) return undefined;
    const workPromise = Promise.resolve().then(work);
    const trackedWork = workPromise.then(
      () => undefined,
      () => undefined,
    );
    activeWorks.add(trackedWork);
    try {
      return await workPromise;
    } finally {
      activeWorks.delete(trackedWork);
    }
  });
}

export async function withNoodleAutoPostPaused<T>(run: () => Promise<T>): Promise<T> {
  pauseDepth += 1;
  try {
    // Only admitted work can block a snapshot. Queued gate waiters will see
    // pauseDepth after admission and return without touching rows or media.
    while (activeWorks.size > 0) await Promise.all([...activeWorks]);
    return await run();
  } finally {
    pauseDepth -= 1;
  }
}

export function startNoodleAutoPostScheduler(app: FastifyInstance) {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delay = POLL_MS) => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = poll();
    }, delay);
    timer.unref?.();
  };

  const poll = async () => {
    if (stopped) return;
    // A paused poll re-arms rather than skipping its turn: the backup it is waiting on is short.
    if (pauseDepth > 0) {
      schedule();
      return;
    }
    try {
      const outcome = await runWithNoodleAutoPostAdmission(async () => {
        await reconcileNoodlerReserve(app.db);
        return prepareNextNoodlerReservePost(app.db);
      });
      if (outcome === "prepared") logger.info("[noodle-autopost] Prepared one future NoodleR post");
    } catch (error) {
      logger.error(error, "[noodle-autopost] Reserve poll failed");
    } finally {
      schedule();
    }
  };

  // Own reserve-state initialization here so upgrades begin their hold at server startup,
  // even when automatic posting is disabled. Provider work still waits for the normal delay.
  running = runWithNoodleAutoPostAdmission(async () => {
    // Images staged by a process that was killed mid-preparation are referenced by nothing.
    const swept = sweepStagedImages();
    if (swept > 0) logger.info("[noodle-autopost] Reclaimed %d staged image file(s)", swept);
    await createNoodleStorage(app.db).ensureNoodlerReserveState();
    await reconcileNoodlerReserve(app.db);
  }).catch((error) => logger.error(error, "[noodle-autopost] Startup reconciliation failed"));
  schedule(INITIAL_DELAY_MS);
  app.addHook("onClose", async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running.catch(() => {});
  });
  logger.info("[noodle-autopost] Private reserve scheduler started");
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
