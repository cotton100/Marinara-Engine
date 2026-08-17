import { PERSONAL_EXTENSION_FULL_PAGE_CAPABILITY } from "@marinara-engine/shared";
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import {
  apiConnections,
  appSettings,
  characters,
  chats,
  personalExtensionCoordination,
  type PersonalExtensionCoordinationRow,
} from "../../db/schema/index.js";
import { resolveEmbeddedCharacterId } from "../lorebook/character-book-sync.js";
import { createLorebooksStorage } from "../storage/lorebooks.storage.js";
import {
  canExecutePersonalExtension,
  getPersonalExtensionPolicy,
  isExternalPersonalExtensionSource,
} from "./personal-extension-policy.service.js";
import { createPersonalExtensionsStorage } from "./personal-extension-storage.service.js";
import {
  createPersonalExtensionCoordinationKernel,
  parsePersonalExtensionProtectedResourceRegistry,
  PersonalExtensionCoordinationKernelError,
  PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
  type PersonalExtensionActivationSnapshot,
  type PersonalExtensionBlockedJournalRecoveryProof,
  type PersonalExtensionCoordinationKernelOptions,
  type PersonalExtensionOperationConclusionEvidence,
  type PersonalExtensionOperationDispatchMarkerProof,
  type PersonalExtensionProtectedResourceRegistry,
} from "./personal-extension-coordination-kernel.service.js";

const STORAGE_KEY = "convoMemoryBridgeV1";
const STORAGE_KEY_PREFIX = "extension-storage:";
const EMPTY_BOOTSTRAP_STORAGE_VALUE = JSON.stringify({
  [STORAGE_KEY]: { schemaVersion: 1, ensembles: [] },
});
const MANAGED_LOREBOOK_TAG = "convo-memory-bridge";
const PROVISIONING_TAG_PREFIX = "convo-memory-bridge-ensemble:";
const POLICY_ENTRY_TAG = "convo-memory-bridge-policy";
const POLICY_NAME = "Convo Memory Bridge Cast Policy";
const POLICY_DESCRIPTION = "Stable cast-ID knowledge policy for managed memories.";
const LOCAL_SIDECAR_CONNECTION_ID = "__local_sidecar__";
const LOCAL_SIDECAR_MODEL = "local-sidecar";
const CAST_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TARGET_ENSEMBLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SEMANTIC_STATUSES = new Set(["unknown", "ready", "pending", "profile-changed"]);
const MANUAL_RECOVERY_REASONS = new Set([
  "source-read-incomplete",
  "mutation-ambiguous",
  "vectorization-pending",
  "profile-changed",
  "setup-attach-ambiguous",
  "setup-reconcile-ambiguous",
]);
const SETUP_RECOVERY_REASONS = new Set(["setup-attach-ambiguous", "setup-reconcile-ambiguous"]);

type CmbEmbeddingProfile = { connectionId: string; model: string };
type CmbRuntime = {
  semanticStatus: string;
  lastSuccessfulEmbeddingProfile: CmbEmbeddingProfile | null;
  pendingEmbeddingProfile: CmbEmbeddingProfile | null;
  manualRecoveryReasons: string[];
  lastSuccessfulSyncAt: string | null;
};
type CmbMember = { castId: string; characterId: string; dmChatId: string };
type CmbEnsemble = {
  ensembleId: string;
  name: string;
  rpChatId: string;
  groupConvoChatIds: string[];
  lorebookId: string;
  autoSync: boolean;
  embedding: CmbEmbeddingProfile;
  runtime: CmbRuntime;
  members: CmbMember[];
};
type CmbConfig = { schemaVersion: 1; ensembles: CmbEnsemble[] };
type CmbStorageSnapshot = {
  rawStorageValue: string;
  configRevision: number;
  config: CmbConfig;
};

function validationError(): PersonalExtensionCoordinationKernelError {
  return new PersonalExtensionCoordinationKernelError("coordination-validation-failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function stableString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

function exactIsoTimestamp(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseEmbeddingProfile(value: unknown, nullable: true): CmbEmbeddingProfile | null;
function parseEmbeddingProfile(value: unknown, nullable?: false): CmbEmbeddingProfile;
function parseEmbeddingProfile(value: unknown, nullable = false): CmbEmbeddingProfile | null {
  if (value === null && nullable) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["connectionId", "model"])) throw validationError();
  const connectionId = stableString(value.connectionId);
  const rawModel = typeof value.model === "string" && value.model.trim() === value.model ? value.model : null;
  if (!connectionId || rawModel === null || (connectionId !== LOCAL_SIDECAR_CONNECTION_ID && !rawModel)) {
    throw validationError();
  }
  return {
    connectionId,
    model: connectionId === LOCAL_SIDECAR_CONNECTION_ID ? LOCAL_SIDECAR_MODEL : rawModel,
  };
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw validationError();
  const values = value.map(stableString);
  if (values.some((item) => item === null)) throw validationError();
  return values as string[];
}

function parseRuntime(value: unknown): CmbRuntime {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "semanticStatus",
      "lastSuccessfulEmbeddingProfile",
      "pendingEmbeddingProfile",
      "manualRecoveryReasons",
      "lastSuccessfulSyncAt",
    ]) ||
    typeof value.semanticStatus !== "string" ||
    !SEMANTIC_STATUSES.has(value.semanticStatus) ||
    !Array.isArray(value.manualRecoveryReasons) ||
    value.manualRecoveryReasons.some((reason) => typeof reason !== "string" || !MANUAL_RECOVERY_REASONS.has(reason)) ||
    new Set(value.manualRecoveryReasons).size !== value.manualRecoveryReasons.length ||
    (value.lastSuccessfulSyncAt !== null && !exactIsoTimestamp(value.lastSuccessfulSyncAt))
  ) {
    throw validationError();
  }
  return {
    semanticStatus: value.semanticStatus,
    lastSuccessfulEmbeddingProfile: parseEmbeddingProfile(value.lastSuccessfulEmbeddingProfile, true),
    pendingEmbeddingProfile: parseEmbeddingProfile(value.pendingEmbeddingProfile, true),
    manualRecoveryReasons: [...value.manualRecoveryReasons] as string[],
    lastSuccessfulSyncAt: value.lastSuccessfulSyncAt as string | null,
  };
}

function parseCmbConfig(value: unknown): CmbConfig {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "ensembles"]) || value.schemaVersion !== 1) {
    throw validationError();
  }
  // An exact empty configuration is a valid bootstrap state. Coordination
  // must be active before the new CMB runtime can use its guarded Setup path
  // to create the first ensemble; all non-empty ensembles are still validated
  // below with the full resource contract.
  if (!Array.isArray(value.ensembles)) throw validationError();
  const ensembles = value.ensembles.map((candidate): CmbEnsemble => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "ensembleId",
        "name",
        "rpChatId",
        "groupConvoChatIds",
        "lorebookId",
        "autoSync",
        "embedding",
        "runtime",
        "members",
      ]) ||
      typeof candidate.autoSync !== "boolean" ||
      !Array.isArray(candidate.members) ||
      candidate.members.length === 0
    ) {
      throw validationError();
    }
    const members = candidate.members.map((member): CmbMember => {
      if (!isRecord(member) || !hasExactKeys(member, ["castId", "characterId", "dmChatId"])) {
        throw validationError();
      }
      const castId = stableString(member.castId);
      const characterId = stableString(member.characterId);
      const dmChatId = stableString(member.dmChatId);
      if (!castId || !CAST_ID_PATTERN.test(castId) || !characterId || !dmChatId) throw validationError();
      return { castId, characterId, dmChatId };
    });
    const ensembleId = stableString(candidate.ensembleId);
    const name = stableString(candidate.name);
    const rpChatId = stableString(candidate.rpChatId);
    const lorebookId =
      typeof candidate.lorebookId === "string" && candidate.lorebookId.trim() === candidate.lorebookId
        ? candidate.lorebookId
        : null;
    if (!ensembleId || !TARGET_ENSEMBLE_ID_PATTERN.test(ensembleId) || !name || !rpChatId || lorebookId === null) {
      throw validationError();
    }
    const groupConvoChatIds = parseStringArray(candidate.groupConvoChatIds);
    if (
      new Set(members.map((member) => member.castId)).size !== members.length ||
      new Set(members.map((member) => member.characterId)).size !== members.length ||
      new Set(members.map((member) => member.dmChatId)).size !== members.length
    ) {
      throw validationError();
    }
    return {
      ensembleId,
      name,
      rpChatId,
      groupConvoChatIds,
      lorebookId,
      autoSync: candidate.autoSync,
      embedding: parseEmbeddingProfile(candidate.embedding),
      runtime: parseRuntime(candidate.runtime),
      members,
    };
  });
  const nonEmptyLorebookIds = ensembles.map((ensemble) => ensemble.lorebookId).filter(Boolean);
  if (
    new Set(ensembles.map((ensemble) => ensemble.ensembleId)).size !== ensembles.length ||
    new Set(nonEmptyLorebookIds).size !== nonEmptyLorebookIds.length
  ) {
    throw validationError();
  }
  const chatIds = ensembles.flatMap((ensemble) => [
    ensemble.rpChatId,
    ...ensemble.groupConvoChatIds,
    ...ensemble.members.map((member) => member.dmChatId),
  ]);
  if (new Set(chatIds).size !== chatIds.length) throw validationError();
  return { schemaVersion: 1, ensembles };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) throw validationError();
    return parsed;
  } catch (error) {
    if (error instanceof PersonalExtensionCoordinationKernelError) throw error;
    throw validationError();
  }
}

async function readCmbStorageSnapshot(tx: DB, extensionId: string): Promise<CmbStorageSnapshot> {
  const [settingRows, coordinationRows] = await Promise.all([
    tx
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, `${STORAGE_KEY_PREFIX}${extensionId}`)),
    tx
      .select({ configRevision: personalExtensionCoordination.configRevision })
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, extensionId)),
  ]);
  const rawStorageValue = settingRows[0]?.value;
  if (typeof rawStorageValue !== "string") throw validationError();
  const stored = parseJsonRecord(rawStorageValue);
  if (!Object.hasOwn(stored, STORAGE_KEY)) throw validationError();
  return {
    rawStorageValue,
    configRevision: coordinationRows[0]?.configRevision ?? 0,
    config: parseCmbConfig(stored[STORAGE_KEY]),
  };
}

async function bootstrapEmptyCmbStorageForActivation(tx: DB, extensionId: string) {
  const storageKey = `${STORAGE_KEY_PREFIX}${extensionId}`;
  const [settingRows, coordinationRows] = await Promise.all([
    tx.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, storageKey)),
    tx
      .select({ extensionId: personalExtensionCoordination.extensionId })
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, extensionId)),
  ]);
  if (settingRows.length > 0 || coordinationRows.length > 0) return;

  await tx.insert(appSettings).values({
    key: storageKey,
    value: EMPTY_BOOTSTRAP_STORAGE_VALUE,
    updatedAt: new Date().toISOString(),
  });
  // The activation snapshot must never authorize guarded writes from an empty
  // config that existed only in memory. Persist the bootstrap row before the
  // kernel writes its provisional coordination barrier; failure rolls this
  // transaction back to the genuinely missing state.
  await tx._fileStore.flushStrict();
}

/**
 * Discover legacy CMB storage that predates the first coordination row. A
 * profile restore must preserve its recovery marker just as strictly as an
 * already-activated CMB row; otherwise a clean backup could erase the only
 * mutation-ambiguity evidence before coordination is ever enabled.
 */
export async function listCmbStorageExtensionIdsForProfileRestore(tx: DB) {
  const settingRows = await tx.select().from(appSettings);
  const extensionIds: string[] = [];
  for (const row of settingRows) {
    if (!row.key.startsWith(STORAGE_KEY_PREFIX)) continue;
    try {
      const stored = parseJsonRecord(row.value);
      if (!Object.hasOwn(stored, STORAGE_KEY)) continue;
      const extensionId = row.key.slice(STORAGE_KEY_PREFIX.length);
      if (extensionId) extensionIds.push(extensionId);
    } catch {
      // Without a coordination row a malformed generic extension-storage
      // envelope cannot be attributed to CMB. Existing rows are still checked
      // separately and fail closed through the authoritative parser below.
    }
  }
  return [...new Set(extensionIds)].sort();
}

/**
 * A profile restore is allowed to replace CMB storage only when no persisted
 * recovery evidence would be lost. Keep this proof beside the server-owned CMB
 * parser so the backup route cannot accidentally accept a malformed or partial
 * imitation of the extension storage envelope.
 */
export async function cmbStorageRequiresRecoveryBeforeProfileRestore(tx: DB, extensionId: string) {
  try {
    const fresh = await readCmbStorageSnapshot(tx, extensionId);
    return fresh.config.ensembles.some(
      (ensemble) =>
        ensemble.runtime.manualRecoveryReasons.length > 0 ||
        ensemble.runtime.pendingEmbeddingProfile !== null ||
        ensemble.runtime.semanticStatus === "pending" ||
        ensemble.runtime.semanticStatus === "profile-changed",
    );
  } catch {
    // Once a coordination row exists, unreadable extension storage is itself a
    // recovery condition. A bulk restore must not erase the only evidence that
    // the server can no longer prove safe.
    return true;
  }
}

/**
 * Server-owned proof used by operation/end. The client may request a
 * conclusive end, but only this fresh read can show that the operation's exact
 * ensemble is Ready, its durable marker is gone, and the journal's last
 * committed resource revisions still describe the current protected state.
 */
export async function proveCmbOperationConclusiveState(tx: DB, evidence: PersonalExtensionOperationConclusionEvidence) {
  try {
    const fresh = await readCmbStorageSnapshot(tx, evidence.journal.extensionId);
    const ensemble = fresh.config.ensembles.find(
      (candidate) => candidate.ensembleId === evidence.journal.targetEnsembleId,
    );
    if (
      !ensemble ||
      ensemble.runtime.semanticStatus !== "ready" ||
      ensemble.runtime.pendingEmbeddingProfile !== null ||
      ensemble.runtime.manualRecoveryReasons.length !== 0
    ) {
      return false;
    }
    const storageRevision = evidence.resourceRevisions.find(
      (resource) => resource.kind === "extension-storage" && resource.resourceId === evidence.journal.extensionId,
    );
    const lorebookRevisions = evidence.resourceRevisions.filter((resource) => resource.kind === "lorebook");
    return (
      storageRevision?.presence === "present" &&
      storageRevision.resourceRevision === fresh.configRevision &&
      lorebookRevisions.length > 0 &&
      lorebookRevisions.every(
        (resource) => resource.presence === "present" && resource.resourceId === ensemble.lorebookId,
      )
    );
  } catch {
    return false;
  }
}

/**
 * Fresh server-owned proof for the marker-before-mutation barrier. Merely
 * touching extension storage is not enough: the exact target ensemble must
 * own the generic marker at the journaled, current config revision. A setup
 * recovery may carry one setup-specific reason, but never an unpaired or
 * ambiguous pair of setup reasons.
 */
export const proveCmbOperationDispatchMarker: PersonalExtensionOperationDispatchMarkerProof = async (tx, evidence) => {
  try {
    const fresh = await readCmbStorageSnapshot(tx, evidence.journal.extensionId);
    const ensemble = fresh.config.ensembles.find(
      (candidate) => candidate.ensembleId === evidence.journal.targetEnsembleId,
    );
    if (!ensemble || fresh.configRevision !== evidence.coordination.configRevision) return false;
    const storageRevision = evidence.resourceRevisions.find(
      (resource) => resource.kind === "extension-storage" && resource.resourceId === evidence.journal.extensionId,
    );
    const reasons = ensemble.runtime.manualRecoveryReasons;
    const setupReasons = reasons.filter((reason) => SETUP_RECOVERY_REASONS.has(reason));
    const dispatchTargetsExactEnsemble = (() => {
      if (evidence.dispatch.kind === "resources") {
        const lorebooks = evidence.dispatch.resources.filter((resource) => resource.kind === "lorebook");
        return (
          ensemble.lorebookId !== "" &&
          lorebooks.length > 0 &&
          lorebooks.every((resource) => resource.resourceId === ensemble.lorebookId)
        );
      }
      if (evidence.dispatch.transition.action !== "bind") return false;
      return ensemble.lorebookId === "" && !evidence.resourceRevisions.some((resource) => resource.kind === "lorebook");
    })();
    return (
      storageRevision?.presence === "present" &&
      storageRevision.resourceRevision === fresh.configRevision &&
      reasons.includes("mutation-ambiguous") &&
      setupReasons.length <= 1 &&
      dispatchTargetsExactEnsemble
    );
  } catch {
    return false;
  }
};

/**
 * Operator recovery may close a dispatching journal only while the exact CMB
 * ensemble still carries the durable generic ambiguity marker. The marker is
 * deliberately not removed here: recovery closes stale server authority, not
 * the user's manual reconciliation obligation.
 */
export const proveCmbBlockedJournalRecovery: PersonalExtensionBlockedJournalRecoveryProof = async (tx, evidence) => {
  try {
    if (
      evidence.journal.phase !== "dispatching" ||
      evidence.journal.extensionId !== evidence.coordination.extensionId ||
      evidence.journal.fence < 0 ||
      evidence.journal.fence > evidence.coordination.fence
    ) {
      return false;
    }
    const fresh = await readCmbStorageSnapshot(tx, evidence.journal.extensionId);
    const ensemble = fresh.config.ensembles.find(
      (candidate) => candidate.ensembleId === evidence.journal.targetEnsembleId,
    );
    if (!ensemble || fresh.configRevision !== evidence.coordination.configRevision) return false;

    const storageRevisions = evidence.resourceRevisions.filter((resource) => resource.kind === "extension-storage");
    const lorebookRevisions = evidence.resourceRevisions.filter((resource) => resource.kind === "lorebook");
    const storageRevision = storageRevisions[0];
    const reasons = ensemble.runtime.manualRecoveryReasons;
    const setupReasons = reasons.filter((reason) => SETUP_RECOVERY_REASONS.has(reason));
    return (
      storageRevisions.length === 1 &&
      storageRevision?.resourceId === evidence.journal.extensionId &&
      storageRevision.presence === "present" &&
      storageRevision.resourceRevision === fresh.configRevision &&
      reasons.includes("mutation-ambiguous") &&
      setupReasons.length <= 1 &&
      (ensemble.lorebookId === ""
        ? lorebookRevisions.length === 0
        : lorebookRevisions.every(
            (resource) => resource.resourceId === ensemble.lorebookId && resource.presence === "present",
          ))
    );
  } catch {
    return false;
  }
};

function sameUniqueStrings(left: unknown, right: readonly string[]) {
  if (!Array.isArray(left) || left.some((value) => typeof value !== "string")) return false;
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

function policyMembers(ensemble: CmbEnsemble, displayNames: Map<string, string>) {
  return ensemble.members.map((member) => ({
    castId: member.castId,
    characterId: member.characterId,
    displayName: displayNames.get(member.characterId)!,
  }));
}

function policyContent(members: Array<{ castId: string; displayName: string }>) {
  return [
    "[Character knowledge boundary]",
    "Memory labels use stable cast IDs. Current cast ID map:",
    ...members.map(({ castId, displayName }) => `- ${castId} = ${displayName}`),
    "Each recalled memory declares which stable cast IDs do not know it.",
    'A character whose cast ID is listed under "Unknown to cast IDs" must not recall, mention, react to, infer, or act on that memory unless it becomes visible in the current conversation.',
    "Other characters may use it normally.",
  ].join("\n");
}

function expectedPolicy(ensemble: CmbEnsemble, displayNames: Map<string, string>) {
  const members = policyMembers(ensemble, displayNames);
  return {
    name: POLICY_NAME,
    description: POLICY_DESCRIPTION,
    content: policyContent(members),
    keys: [],
    secondaryKeys: [],
    enabled: true,
    constant: true,
    selective: false,
    characterFilterMode: "include",
    characterFilterIds: members.map(({ characterId }) => characterId),
    position: 0,
    depth: 4,
    order: -1_000_000,
    role: "system",
    preventRecursion: true,
    excludeRecursion: false,
    delayUntilRecursion: false,
    locked: true,
    tag: POLICY_ENTRY_TAG,
    relationships: {},
    activationConditions: [],
    schedule: null,
    excludeFromVectorization: true,
    policyMembers: members,
  };
}

function validatePolicyEntry(entry: Record<string, unknown>, ensemble: CmbEnsemble, displayNames: Map<string, string>) {
  const expected = expectedPolicy(ensemble, displayNames);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "policyMembers") continue;
    if (!sameValue(entry[key], value)) throw validationError();
  }
  const dynamicState = entry.dynamicState;
  const bridge =
    isRecord(dynamicState) && isRecord(dynamicState.convoMemoryBridge) ? dynamicState.convoMemoryBridge : null;
  if (
    !bridge ||
    bridge.schemaVersion !== 1 ||
    bridge.ensembleId !== ensemble.ensembleId ||
    !sameValue(bridge.policyMembers, expected.policyMembers)
  ) {
    throw validationError();
  }
}

function validateManagedEntries(entries: Record<string, unknown>[], ensemble: CmbEnsemble) {
  const memoryIds = new Set<string>();
  for (const entry of entries) {
    if (entry.tag !== MANAGED_LOREBOOK_TAG) continue;
    const dynamicState = entry.dynamicState;
    const bridge =
      isRecord(dynamicState) && isRecord(dynamicState.convoMemoryBridge) ? dynamicState.convoMemoryBridge : null;
    const memoryId = bridge && stableString(bridge.memoryId);
    const source = bridge && isRecord(bridge.source) ? bridge.source : null;
    if (
      !bridge ||
      bridge.schemaVersion !== 1 ||
      bridge.ensembleId !== ensemble.ensembleId ||
      !memoryId ||
      !source ||
      (source.kind !== "manual" && source.kind !== "native-memory-chunk") ||
      memoryIds.has(memoryId)
    ) {
      throw validationError();
    }
    memoryIds.add(memoryId);
  }
}

function parseChatJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw validationError();
  }
}

function validateChat(
  row: typeof chats.$inferSelect | undefined,
  role: "rp" | "group" | "dm",
  expectedCharacterIds: string[],
) {
  if (!row || row.mode === "game") throw validationError();
  if ((role === "rp" && row.mode !== "roleplay") || (role !== "rp" && row.mode !== "conversation")) {
    throw validationError();
  }
  const characterIds = parseChatJson(row.characterIds);
  const metadata = parseChatJson(row.metadata);
  if (!Array.isArray(characterIds) || !isRecord(metadata)) throw validationError();
  const inactive = Object.hasOwn(metadata, "inactiveCharacterIds") ? metadata.inactiveCharacterIds : [];
  if (!Array.isArray(inactive) || inactive.some((value) => typeof value !== "string")) throw validationError();
  const active = characterIds.filter(
    (value): value is string => typeof value === "string" && !inactive.includes(value),
  );
  if (!sameUniqueStrings(active, expectedCharacterIds)) throw validationError();
  if (role === "rp") {
    if ((metadata.groupChatMode ?? "merged") !== "merged") throw validationError();
  } else if (metadata.crossChatAwareness !== false) {
    throw validationError();
  }
  return { row, metadata };
}

function validateEmbeddingProfile(
  chat: typeof chats.$inferSelect,
  metadata: Record<string, unknown>,
  expected: CmbEmbeddingProfile,
  connectionMap: Map<string, typeof apiConnections.$inferSelect>,
) {
  if (chat.connectionId === LOCAL_SIDECAR_CONNECTION_ID) {
    if (expected.connectionId !== LOCAL_SIDECAR_CONNECTION_ID || expected.model !== LOCAL_SIDECAR_MODEL) {
      throw validationError();
    }
    return;
  }
  const activeConnection = chat.connectionId ? connectionMap.get(chat.connectionId) : null;
  if (!activeConnection) throw validationError();
  const metadataConnectionId = stableString(metadata.embeddingConnectionId) ?? "";
  const embeddingConnectionId = metadataConnectionId || activeConnection.embeddingConnectionId || chat.connectionId;
  if (!embeddingConnectionId) throw validationError();
  if (embeddingConnectionId === LOCAL_SIDECAR_CONNECTION_ID) {
    if (expected.connectionId !== LOCAL_SIDECAR_CONNECTION_ID || expected.model !== LOCAL_SIDECAR_MODEL) {
      throw validationError();
    }
    return;
  }
  const embeddingConnection = connectionMap.get(embeddingConnectionId);
  if (!embeddingConnection) throw validationError();
  const model = embeddingConnection.embeddingModel || activeConnection.embeddingModel || "";
  if (expected.connectionId !== embeddingConnectionId || expected.model !== model) throw validationError();
}

async function validateCmbResources(
  tx: DB,
  config: CmbConfig,
  registry: PersonalExtensionProtectedResourceRegistry,
  requireNoRecoveryMarkers: boolean,
) {
  if (registry.version !== PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION) throw validationError();
  const expectedLorebookIds = config.ensembles.map((ensemble) => ensemble.lorebookId).sort();
  if (!sameValue(Object.keys(registry.lorebooks).sort(), expectedLorebookIds)) throw validationError();

  const [characterRows, chatRows, connectionRows] = await Promise.all([
    tx.select().from(characters),
    tx.select().from(chats),
    tx.select().from(apiConnections),
  ]);
  const requiredCharacterIds = new Set(
    config.ensembles.flatMap((ensemble) => ensemble.members.map((member) => member.characterId)),
  );
  const displayNames = new Map<string, string>();
  for (const character of characterRows) {
    if (!requiredCharacterIds.has(character.id)) continue;
    const data = parseJsonRecord(character.data);
    const name = stableString(data.name);
    if (name) displayNames.set(character.id, name);
  }
  const chatMap = new Map(chatRows.map((chat) => [chat.id, chat]));
  const connectionMap = new Map(connectionRows.map((connection) => [connection.id, connection]));
  const lorebookStorage = createLorebooksStorage(tx);

  for (const ensemble of config.ensembles) {
    if (requireNoRecoveryMarkers && ensemble.runtime.manualRecoveryReasons.length > 0) throw validationError();
    if (ensemble.members.some((member) => !displayNames.has(member.characterId))) throw validationError();
    const allCharacterIds = ensemble.members.map((member) => member.characterId);
    const mappedChatIds = [
      ensemble.rpChatId,
      ...ensemble.groupConvoChatIds,
      ...ensemble.members.map((member) => member.dmChatId),
    ];
    const rp = validateChat(chatMap.get(ensemble.rpChatId), "rp", allCharacterIds);
    validateEmbeddingProfile(rp.row, rp.metadata, ensemble.embedding, connectionMap);
    for (const chatId of ensemble.groupConvoChatIds) {
      const group = validateChat(chatMap.get(chatId), "group", allCharacterIds);
      validateEmbeddingProfile(group.row, group.metadata, ensemble.embedding, connectionMap);
    }
    for (const member of ensemble.members) {
      const dm = validateChat(chatMap.get(member.dmChatId), "dm", [member.characterId]);
      validateEmbeddingProfile(dm.row, dm.metadata, ensemble.embedding, connectionMap);
    }

    const lorebook = (await lorebookStorage.getById(ensemble.lorebookId)) as Record<string, unknown> | null;
    if (!lorebook || !Array.isArray(lorebook.tags) || !lorebook.tags.includes(MANAGED_LOREBOOK_TAG)) {
      throw validationError();
    }
    const provisioningTags = lorebook.tags.filter(
      (tag): tag is string => typeof tag === "string" && tag.startsWith(PROVISIONING_TAG_PREFIX),
    );
    const exactProvisioningTag = `${PROVISIONING_TAG_PREFIX}${ensemble.ensembleId}`;
    if (
      provisioningTags.some((tag) => tag !== exactProvisioningTag) ||
      provisioningTags.filter((tag) => tag === exactProvisioningTag).length > 1
    ) {
      throw validationError();
    }
    if (!sameUniqueStrings(lorebook.characterIds, allCharacterIds)) throw validationError();
    const scope = isRecord(lorebook.scope) ? lorebook.scope : null;
    if (!scope || scope.mode !== "specific" || !sameUniqueStrings(scope.chatIds, mappedChatIds)) {
      throw validationError();
    }
    if (lorebook.excludeFromVectorization !== false) throw validationError();
    if (await resolveEmbeddedCharacterId(tx, ensemble.lorebookId, lorebook as never)) throw validationError();

    const entries = (await lorebookStorage.listEntries(ensemble.lorebookId)) as Record<string, unknown>[];
    const policies = entries.filter((entry) => entry.tag === POLICY_ENTRY_TAG);
    if (policies.length !== 1) throw validationError();
    validatePolicyEntry(policies[0]!, ensemble, displayNames);
    validateManagedEntries(entries, ensemble);
  }
}

async function requireApprovedFullPageExtension(tx: DB, extensionId: string) {
  const extension = await createPersonalExtensionsStorage(tx).getById(extensionId);
  const policy = await getPersonalExtensionPolicy(tx);
  if (
    !extension ||
    extension.runtime !== "client" ||
    !extension.enabled ||
    extension.approvedHash !== extension.contentHash ||
    !extension.capabilities.includes(PERSONAL_EXTENSION_FULL_PAGE_CAPABILITY) ||
    !isExternalPersonalExtensionSource(extension.source) ||
    !canExecutePersonalExtension(extension, policy)
  ) {
    throw new PersonalExtensionCoordinationKernelError("extension-runtime-changed");
  }
  return extension;
}

function provisionalRegistry(
  config: CmbConfig,
  configRevision: number,
  previousRow: PersonalExtensionCoordinationRow | undefined,
): PersonalExtensionProtectedResourceRegistry {
  const previous = previousRow
    ? parsePersonalExtensionProtectedResourceRegistry(previousRow.protectedLorebookRegistry)
    : null;
  return {
    version: PERSONAL_EXTENSION_PROTECTED_RESOURCE_REGISTRY_VERSION,
    extensionStorage: { resourceRevision: configRevision },
    lorebooks: Object.fromEntries(
      config.ensembles.map((ensemble) => [
        ensemble.lorebookId,
        { resourceRevision: previous?.lorebooks[ensemble.lorebookId]?.resourceRevision ?? 0 },
      ]),
    ),
  };
}

export function createPersonalExtensionCoordinationAdminService(
  db: DB,
  options: PersonalExtensionCoordinationKernelOptions = {},
) {
  const kernel = createPersonalExtensionCoordinationKernel(db, options);

  return {
    async activateCoordination(extensionId: string) {
      const initial = await db.transaction(async (tx) => {
        const extension = await requireApprovedFullPageExtension(tx, extensionId);
        await bootstrapEmptyCmbStorageForActivation(tx, extensionId);
        const [storage, rows] = await Promise.all([
          readCmbStorageSnapshot(tx, extensionId),
          tx
            .select()
            .from(personalExtensionCoordination)
            .where(eq(personalExtensionCoordination.extensionId, extensionId)),
        ]);
        return {
          extension,
          storage,
          registry: provisionalRegistry(storage.config, storage.configRevision, rows[0]),
        };
      });
      const snapshot: PersonalExtensionActivationSnapshot = {
        contentHash: initial.extension.contentHash,
        configRevision: initial.storage.configRevision,
        rawStorageValue: initial.storage.rawStorageValue,
        registry: initial.registry,
      };
      const barrier = await kernel.beginActivation(extensionId, snapshot);
      try {
        return await kernel.completeActivation(barrier, async (tx) => {
          const [extension, fresh] = await Promise.all([
            requireApprovedFullPageExtension(tx, extensionId),
            readCmbStorageSnapshot(tx, extensionId),
          ]);
          await validateCmbResources(tx, fresh.config, snapshot.registry, true);
          return {
            contentHash: extension.contentHash,
            configRevision: fresh.configRevision,
            rawStorageValue: fresh.rawStorageValue,
            registry: snapshot.registry,
          };
        });
      } catch (error) {
        try {
          await kernel.rollbackActivation(barrier);
        } catch {
          try {
            await kernel.blockActivation(barrier);
          } catch {
            // The durable activating row is already fail-closed. Preserve the
            // original error and leave operator recovery to the next boot.
          }
        }
        throw error;
      }
    },

    deactivateCoordination(extensionId: string) {
      return kernel.deactivateCoordination(extensionId);
    },

    recoverBlockedCoordination(extensionId: string) {
      return kernel.recoverBlockedCoordination(
        extensionId,
        async (tx, row) => {
          const fresh = await readCmbStorageSnapshot(tx, extensionId);
          const registry = parsePersonalExtensionProtectedResourceRegistry(row.protectedLorebookRegistry);
          if (
            registry.extensionStorage.resourceRevision !== row.configRevision ||
            fresh.configRevision !== row.configRevision
          ) {
            throw validationError();
          }
          await validateCmbResources(tx, fresh.config, registry, false);
          return {
            contentHash: row.contentHash,
            configRevision: fresh.configRevision,
            rawStorageValue: fresh.rawStorageValue,
            registry,
          };
        },
        proveCmbBlockedJournalRecovery,
      );
    },

    recoverStaleTransitions() {
      return kernel.recoverStaleTransitions();
    },
  };
}

export type PersonalExtensionCoordinationAdminService = ReturnType<
  typeof createPersonalExtensionCoordinationAdminService
>;
