/**
 * Dependency-free helpers for the RP-side CMB Convo routes marker, shared by storage and routes.
 * Once the key exists (even OFF or unreadable), the RP keeps notes/influences instead of pruning
 * or deleting them.
 */
export const CMB_CONVO_ROUTES_KEY = "cmbConvoRoutes";

export type CmbConvoRoutesPolicy = {
  schemaVersion: 1;
  enabled: boolean;
  ensembleId: string;
  defaultOocChatId: string | null;
  revision: number;
  updatedAt: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

export function parseChatMetadataRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return record(value) ?? {};
  if (value.length > 4 * 1024 * 1024) return {};
  try {
    return record(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

/** `null` = never opted in; `"invalid"` = a marker exists but is unreadable (still counts as once opted). */
export function readCmbConvoRoutesPolicy(metadata: Record<string, unknown>): CmbConvoRoutesPolicy | "invalid" | null {
  if (!Object.hasOwn(metadata, CMB_CONVO_ROUTES_KEY)) return null;
  const value = record(metadata[CMB_CONVO_ROUTES_KEY]);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.enabled !== "boolean" ||
    !stableId(value.ensembleId) ||
    !(value.defaultOocChatId === null || stableId(value.defaultOocChatId)) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.updatedAt !== "string"
  )
    return "invalid";
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    ensembleId: value.ensembleId,
    defaultOocChatId: value.defaultOocChatId as string | null,
    revision: value.revision as number,
    updatedAt: value.updatedAt,
  };
}

export function isCmbConvoRoutesOnceOpted(metadata: Record<string, unknown>): boolean {
  return Object.hasOwn(metadata, CMB_CONVO_ROUTES_KEY);
}
