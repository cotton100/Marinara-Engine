import { personalExtensionStoragePatchSchema, type PersonalExtensionStoragePatchInput } from "@marinara-engine/shared";
import { and, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { personalExtensionCoordination } from "../../db/schema/index.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import {
  PersonalExtensionCoordinationKernelError,
  type PersonalExtensionFencedMutationContext,
} from "./personal-extension-coordination-kernel.service.js";
import type { PersonalExtensionCoordinationService } from "./personal-extension-coordination.service.js";

const STORAGE_KEY_PREFIX = "extension-storage:";

type AppSettingsStorage = ReturnType<typeof createAppSettingsStorage>;

type PersonalExtensionSettingsOptions = {
  db?: DB;
  coordination?: Pick<PersonalExtensionCoordinationService, "runFencedResourceMutation" | "runLegacyInactiveMutation">;
};

function storageKey(extensionId: string): string {
  return `${STORAGE_KEY_PREFIX}${extensionId}`;
}

function parseStoredValue(raw: string | null): PersonalExtensionStoragePatchInput {
  if (!raw) return {};
  try {
    const parsed = personalExtensionStoragePatchSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function unavailable(): never {
  throw new PersonalExtensionCoordinationKernelError("coordination-unavailable");
}

function resourceConflict(): never {
  throw new PersonalExtensionCoordinationKernelError("storage-revision-conflict");
}

export function createPersonalExtensionSettingsStorage(
  appSettings: AppSettingsStorage,
  options: PersonalExtensionSettingsOptions = {},
) {
  const get = async (extensionId: string) => parseStoredValue(await appSettings.get(storageKey(extensionId)));
  const scoped = (tx: DB) => createAppSettingsStorage(tx);

  const getRevisioned = async (extensionId: string) => {
    if (!options.db) return { value: await get(extensionId), configRevision: 0 };
    return options.db.transaction(async (tx) => {
      const settings = scoped(tx);
      const [value, rows] = await Promise.all([
        settings.get(storageKey(extensionId)),
        tx
          .select({ configRevision: personalExtensionCoordination.configRevision })
          .from(personalExtensionCoordination)
          .where(eq(personalExtensionCoordination.extensionId, extensionId)),
      ]);
      return { value: parseStoredValue(value), configRevision: rows[0]?.configRevision ?? 0 };
    });
  };

  const patchWith = async (
    store: AppSettingsStorage,
    extensionId: string,
    patch: PersonalExtensionStoragePatchInput,
  ) => {
    const next = personalExtensionStoragePatchSchema.parse({
      ...parseStoredValue(await store.get(storageKey(extensionId))),
      ...patch,
    });
    await store.set(storageKey(extensionId), JSON.stringify(next));
    return next;
  };

  const requireCoordination = () => {
    if (!options.db || !options.coordination) unavailable();
    return { coordination: options.coordination };
  };

  const updateConfigRevision = async (tx: DB, extensionId: string, expectedConfigRevision: number) => {
    const rows = await tx
      .select({ configRevision: personalExtensionCoordination.configRevision })
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, extensionId));
    if (rows[0]?.configRevision !== expectedConfigRevision) resourceConflict();
    if (expectedConfigRevision >= Number.MAX_SAFE_INTEGER - 1) unavailable();
    await tx
      .update(personalExtensionCoordination)
      .set({ configRevision: expectedConfigRevision + 1, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(personalExtensionCoordination.extensionId, extensionId),
          eq(personalExtensionCoordination.configRevision, expectedConfigRevision),
        ),
      );
  };

  return {
    get,
    getRevisioned,
    async patch(extensionId: string, patch: PersonalExtensionStoragePatchInput) {
      return patchWith(appSettings, extensionId, patch);
    },
    async remove(extensionId: string) {
      await appSettings.remove(storageKey(extensionId));
    },
    async patchLegacy(extensionId: string, patch: PersonalExtensionStoragePatchInput) {
      const guarded = requireCoordination();
      return guarded.coordination.runLegacyInactiveMutation(extensionId, async (tx) =>
        patchWith(scoped(tx), extensionId, patch),
      );
    },
    async removeLegacy(extensionId: string) {
      const guarded = requireCoordination();
      await guarded.coordination.runLegacyInactiveMutation(extensionId, async (tx) => {
        await scoped(tx).remove(storageKey(extensionId));
      });
    },
    async patchFenced(
      context: PersonalExtensionFencedMutationContext,
      expectedConfigRevision: number,
      patch: PersonalExtensionStoragePatchInput,
    ) {
      const guarded = requireCoordination();
      if (!Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision < 0) unavailable();
      const committed = await guarded.coordination.runFencedResourceMutation(
        context,
        [{ kind: "extension-storage", resourceId: context.extensionId, expectedRevision: expectedConfigRevision }],
        async (tx) => {
          const value = await patchWith(scoped(tx), context.extensionId, patch);
          await updateConfigRevision(tx, context.extensionId, expectedConfigRevision);
          return value;
        },
      );
      return { value: committed.result, configRevision: expectedConfigRevision + 1 };
    },
    async removeFenced(context: PersonalExtensionFencedMutationContext, expectedConfigRevision: number) {
      const guarded = requireCoordination();
      if (!Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision < 0) unavailable();
      await guarded.coordination.runFencedResourceMutation(
        context,
        [{ kind: "extension-storage", resourceId: context.extensionId, expectedRevision: expectedConfigRevision }],
        async (tx) => {
          await scoped(tx).remove(storageKey(context.extensionId));
          await updateConfigRevision(tx, context.extensionId, expectedConfigRevision);
        },
      );
      return { value: {}, configRevision: expectedConfigRevision + 1 };
    },
  };
}
