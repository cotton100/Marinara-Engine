// ──────────────────────────────────────────────
// Schema: Personal Extension Coordination
// ──────────────────────────────────────────────
// This row is intentionally created only by the future operator-controlled
// activation transition. Reading inactive coordination state must not create it.
import { fileTable, integer, text } from "../file-schema.js";

export const PERSONAL_EXTENSION_COORDINATION_MODES = [
  "inactive",
  "activating",
  "active",
  "draining-deactivate",
  "restoring",
  "blocked",
] as const;
export type PersonalExtensionCoordinationMode = (typeof PERSONAL_EXTENSION_COORDINATION_MODES)[number];

export const personalExtensionCoordination = fileTable("personal_extension_coordination", {
  extensionId: text("extension_id").primaryKey(),
  contentHash: text("content_hash").notNull().default(""),
  mode: text("mode", { enum: PERSONAL_EXTENSION_COORDINATION_MODES }).notNull().default("inactive"),
  serverBootId: text("server_boot_id").notNull().default(""),
  fence: integer("fence").notNull().default(0),
  leaseTokenDigest: text("lease_token_digest"),
  holderSessionId: text("holder_session_id"),
  expiresAt: text("expires_at"),
  configRevision: integer("config_revision").notNull().default(0),
  protectedLorebookRegistry: text("protected_lorebook_registry").notNull().default("{}"),
  handoffRequestId: text("handoff_request_id"),
  handoffRequester: text("handoff_requester"),
  handoffDeadlineAt: text("handoff_deadline_at"),
  activeOperations: text("active_operations").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type PersonalExtensionCoordinationRow = typeof personalExtensionCoordination.$inferSelect;
export type PersonalExtensionCoordinationInsert = typeof personalExtensionCoordination.$inferInsert;
