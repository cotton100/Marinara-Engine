// ──────────────────────────────────────────────
// Storage: Synced App Settings (key/value)
// ──────────────────────────────────────────────
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { appSettings } from "../../db/schema/index.js";
import { now } from "../../utils/id-generator.js";

export function createAppSettingsStorage(db: DB) {
  return {
    async get(key: string): Promise<string | null> {
      const rows = await db.select().from(appSettings).where(eq(appSettings.key, key));
      return rows[0]?.value ?? null;
    },

    async set(key: string, value: string): Promise<void> {
      // The existence check and mutation are one logical write. Reserving the
      // transaction lane here prevents an exclusive profile restore from
      // deleting the row between SELECT and UPDATE.
      await db.transaction(async (tx) => {
        const timestamp = now();
        const existing = await tx.select().from(appSettings).where(eq(appSettings.key, key));
        if (existing.length > 0) {
          await tx.update(appSettings).set({ value, updatedAt: timestamp }).where(eq(appSettings.key, key));
        } else {
          await tx.insert(appSettings).values({ key, value, updatedAt: timestamp });
        }
      });
    },

    async remove(key: string): Promise<void> {
      await db.delete(appSettings).where(eq(appSettings.key, key));
    },
  };
}
