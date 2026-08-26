// ──────────────────────────────────────────────
// Schema: Personal Extension Operation Journal
// ──────────────────────────────────────────────
// This is durable recovery evidence, not an authority store. Operation and
// lease secrets are represented only by the already-server-owned SHA-256
// operation digest. User memory/config content must never be copied here.
import { integer, fileTable, text } from "../file-schema.js";

export const PERSONAL_EXTENSION_OPERATION_JOURNAL_PHASES = ["prepared", "dispatching", "final"] as const;
export type PersonalExtensionOperationJournalPhase = (typeof PERSONAL_EXTENSION_OPERATION_JOURNAL_PHASES)[number];

export const personalExtensionOperationJournal = fileTable("personal_extension_operation_journal", {
  // The operation digest is random, fixed-width and unique for the operation.
  // Using it as the key avoids persisting the raw operation handle.
  operationDigest: text("operation_digest").primaryKey(),
  extensionId: text("extension_id").notNull(),
  targetEnsembleId: text("target_ensemble_id").notNull(),
  operationKind: text("operation_kind", { enum: ["mutation", "vectorize"] as const }).notNull(),
  fence: integer("fence").notNull(),
  phase: text("phase", { enum: PERSONAL_EXTENSION_OPERATION_JOURNAL_PHASES }).notNull(),
  // Closed JSON array of {kind,resourceId,presence,resourceRevision}. It
  // contains only resource identities/revisions and never memory or
  // extension-storage data.
  protectedResourceRevisions: text("protected_resource_revisions").notNull().default("[]"),
  preparedAt: text("prepared_at").notNull(),
  dispatchingAt: text("dispatching_at"),
  finalAt: text("final_at"),
  updatedAt: text("updated_at").notNull(),
});

export type PersonalExtensionOperationJournalRow = typeof personalExtensionOperationJournal.$inferSelect;
export type PersonalExtensionOperationJournalInsert = typeof personalExtensionOperationJournal.$inferInsert;
