import { createHash } from "node:crypto";
import { z } from "zod";
import {
  personalExtensionCoordinationCmbCompressionRecordSchema,
  type PersonalExtensionCoordinationCmbCompressionApplyInput,
  type PersonalExtensionCoordinationCmbCompressionRecord,
  type LorebookEntry,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, eq, inArray } from "../../db/file-query.js";
import {
  appSettings,
  characters,
  chats,
  installedExtensions,
  lorebookEntries,
  lorebooks,
  memoryChunks,
  personalExtensionCoordination,
} from "../../db/schema/index.js";
import { isApprovedClientCmb, parseCmbConfig } from "../conversation/autonomous-cmb-context.service.js";
import {
  parsePersonalExtensionProtectedResourceRegistry,
  PersonalExtensionCoordinationKernelError,
} from "../extensions/personal-extension-coordination-kernel.service.js";

const KEY = "convoMemoryBridgeCompression";
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const cast = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const stamp = z.string().refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
});
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), createdAt: stamp, lastEditedAt: stamp }).strict(),
  z
    .object({
      kind: z.literal("native-memory-chunk"),
      canonicalFingerprint: id,
      firstMessageAt: stamp,
      lastMessageAt: stamp,
      occurrences: z
        .array(
          z
            .object({ chatId: id, chatRole: z.enum(["rp", "group", "dm"]), chunkId: id, locatorFingerprint: id })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
]);
const bridgeSchema = z.object({
  schemaVersion: z.literal(1),
  memoryId: id,
  ensembleId: id,
  unknownToCastIds: z.array(cast).max(32),
  rosterBindings: z
    .array(z.object({ castId: cast, characterId: id }).strict())
    .min(1)
    .max(32),
  source: sourceSchema,
  sourceStatus: z.null().optional(),
  ambiguousProvenance: z.literal(false).optional(),
});
// Metadata-only management views must retain held source states without reading a body.
export const cmbCatalogBridgeSchema = bridgeSchema
  .extend({
    source: z.discriminatedUnion("kind", [
      sourceSchema.options[0],
      sourceSchema.options[1].extend({
        occurrences: z.array(sourceSchema.options[1].shape.occurrences.element).max(8),
      }),
    ]),
    sourceStatus: z.literal("missing").nullable().optional(),
    ambiguousProvenance: z.boolean().optional(),
  })
  .refine(
    (value) =>
      (value.sourceStatus === "missing") ===
      (value.source.kind === "native-memory-chunk" && value.source.occurrences.length === 0),
    { message: "Source status must match the available native occurrences" },
  );
const day = z.number().int().nonnegative().safe().nullable();
const agingSchema = z.object({
  schemaVersion: z.literal(1),
  rooms: z
    .array(
      z.object({
        chatId: id,
        clock: z.enum(["default", "real", "story"]),
        detailedRecall: z.boolean(),
        timelineId: z.string().max(256),
        currentDay: day,
      }),
    )
    .max(64),
  memoryTimes: z
    .array(
      z.object({
        memoryId: id,
        sourceRevision: z.string().min(1).max(1000),
        chatId: id,
        timelineId: z.string().max(256),
        day,
      }),
    )
    .max(10000),
});
const namespaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    history: z
      .array(z.object({ castId: cast, record: personalExtensionCoordinationCmbCompressionRecordSchema }).strict())
      .max(1024)
      .optional(),
    byCast: z
      .record(cast, personalExtensionCoordinationCmbCompressionRecordSchema)
      .refine((value) => Object.keys(value).length <= 32),
  })
  .strict();
const modes = ["auto", "detail", "core"] as const;
type Mode = (typeof modes)[number];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function json(value: string): unknown {
  if (value.length > 1_000_000) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = object(value);
  if (record)
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  a.every((value) => b.includes(value));

export type CmbCompressionInspection = {
  basisFingerprint: string | null;
  eligibility: { status: "ready" | "held"; reason: string | null };
  current: PersonalExtensionCoordinationCmbCompressionRecord | null;
  state: "active" | "held" | "released" | "none";
  reason: string | null;
  detailedRecall: boolean;
  characterId: string | null;
  characterName: string | null;
  sourceChatId: string | null;
  clock: "real" | "story" | null;
  stageDays: number | null;
};

/** Server-owned basis; neither UI snapshots nor edited summaries grant knowledge. No body is returned. */
export async function inspectCmbCompression(
  db: DB,
  entry: LorebookEntry,
  castId: string,
  importanceMode: Mode = "auto",
  extensionId?: string,
  admittedMutation = false,
): Promise<CmbCompressionInspection> {
  const rawNamespace = entry.dynamicState?.[KEY];
  const parsedNamespace = namespaceSchema.safeParse(rawNamespace);
  const current =
    parsedNamespace.success && Object.hasOwn(parsedNamespace.data.byCast, castId)
      ? parsedNamespace.data.byCast[castId]!
      : null;
  const result: CmbCompressionInspection = {
    basisFingerprint: null,
    eligibility: { status: "held", reason: null },
    current,
    state: current?.active
      ? "held"
      : current
        ? "released"
        : rawNamespace !== undefined && !parsedNamespace.success
          ? "held"
          : "none",
    reason: null,
    detailedRecall: false,
    characterId: null,
    characterName: null,
    sourceChatId: null,
    clock: null,
    stageDays: null,
  };
  const held = (reason: string) => ({ ...result, reason, eligibility: { status: "held" as const, reason } });
  const currentEntryMatches = async () => {
    const row = (
      await db
        .select({
          content: lorebookEntries.content,
          dynamicState: lorebookEntries.dynamicState,
          enabled: lorebookEntries.enabled,
          characterFilterMode: lorebookEntries.characterFilterMode,
          characterFilterIds: lorebookEntries.characterFilterIds,
          lorebookId: lorebookEntries.lorebookId,
          folderId: lorebookEntries.folderId,
        })
        .from(lorebookEntries)
        .where(eq(lorebookEntries.id, entry.id))
    )[0];
    return (
      row &&
      row.content === entry.content &&
      row.lorebookId === entry.lorebookId &&
      (row.folderId ?? null) === (entry.folderId ?? null) &&
      row.enabled === String(entry.enabled) &&
      row.characterFilterMode === entry.characterFilterMode &&
      stable(json(row.characterFilterIds)) === stable(entry.characterFilterIds) &&
      stable(json(row.dynamicState)) === stable(entry.dynamicState)
    );
  };
  if (!(await currentEntryMatches())) return held("entry-changed");
  if (rawNamespace !== undefined && !parsedNamespace.success) return held("invalid-compression");
  if (!cast.safeParse(castId).success || !modes.includes(importanceMode)) return held("invalid-request");
  const parsedBridge = bridgeSchema.safeParse(entry.dynamicState?.convoMemoryBridge);
  if (!parsedBridge.success || entry.tag !== "convo-memory-bridge") return held("invalid-memory");
  const bridge = parsedBridge.data;
  const extensionRows = await db
    .select()
    .from(installedExtensions)
    .where(and(eq(installedExtensions.name, "Convo Memory Bridge"), eq(installedExtensions.runtime, "client")))
    .limit(9);
  if (extensionRows.length > 8) return held("extension-unavailable");
  const extensions = extensionRows.filter(isApprovedClientCmb);
  if (extensions.length !== 1 || (extensionId && extensions[0]!.id !== extensionId))
    return held("extension-unavailable");
  const extension = extensions[0]!;
  const coordination = (
    await db
      .select()
      .from(personalExtensionCoordination)
      .where(eq(personalExtensionCoordination.extensionId, extension.id))
  )[0];
  if (!coordination || coordination.mode !== "active" || coordination.contentHash !== extension.contentHash)
    return held("coordination-unavailable");
  try {
    const registry = parsePersonalExtensionProtectedResourceRegistry(coordination.protectedLorebookRegistry);
    if (!Object.hasOwn(registry.lorebooks, entry.lorebookId)) return held("unmanaged-memory");
  } catch {
    return held("coordination-unavailable");
  }
  const setting = (
    await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, `extension-storage:${extension.id}`))
  )[0];
  const storage = setting ? object(json(setting.value)) : null;
  const config = parseCmbConfig(storage?.convoMemoryBridgeV1);
  const ensembles =
    config?.ensembles.filter((item) => item.ensembleId === bridge.ensembleId && item.lorebookId === entry.lorebookId) ??
    [];
  if (ensembles.length !== 1) return held("source-unmapped");
  const ensemble = ensembles[0]!;
  const rawConfig = object(storage?.convoMemoryBridgeV1);
  const rawEnsemble = Array.isArray(rawConfig?.ensembles)
    ? rawConfig.ensembles.find((item) => object(item)?.ensembleId === ensemble.ensembleId)
    : null;
  const recoveryReasons = object(object(rawEnsemble)?.runtime)?.manualRecoveryReasons;
  if (
    recoveryReasons !== undefined &&
    (!Array.isArray(recoveryReasons) ||
      recoveryReasons.some((reason) => !admittedMutation || reason !== "mutation-ambiguous"))
  )
    return held("recovery-required");
  const target = ensemble.members.find((item) => item.castId === castId);
  if (!target) return held("character-unmapped");
  result.characterId = target.characterId;
  const expectedRoster = ensemble.members.map(({ castId: memberCast, characterId }) => `${memberCast}\0${characterId}`);
  if (
    !sameSet(
      expectedRoster,
      bridge.rosterBindings.map((item) => `${item.castId}\0${item.characterId}`),
    )
  )
    return held("roster-changed");
  const castIds = ensemble.members.map((item) => item.castId);
  if (
    new Set(bridge.unknownToCastIds).size !== bridge.unknownToCastIds.length ||
    bridge.unknownToCastIds.some((value) => !castIds.includes(value)) ||
    bridge.unknownToCastIds.includes(castId)
  )
    return held("character-unaware");
  const knownIds = ensemble.members
    .filter((member) => !bridge.unknownToCastIds.includes(member.castId))
    .map((member) => member.characterId);
  if (entry.characterFilterMode !== "include" || !sameSet(entry.characterFilterIds, knownIds))
    return held("visibility-changed");
  const book = (await db.select().from(lorebooks).where(eq(lorebooks.id, entry.lorebookId)))[0];
  if (!entry.enabled || book?.enabled !== "true" || entry.folderId) return held("memory-disabled");
  const mapped = [
    { chatId: ensemble.rpChatId, role: "rp" },
    ...ensemble.groupConvoChatIds.map((chatId) => ({ chatId, role: "group" })),
    ...ensemble.members.map((member) => ({ chatId: member.dmChatId, role: "dm" })),
  ];
  const scope = object(json(book.scope));
  if (
    scope?.mode !== "specific" ||
    !Array.isArray(scope.chatIds) ||
    !sameSet(
      scope.chatIds as string[],
      mapped.map((item) => item.chatId),
    )
  )
    return held("scope-changed");
  const rooms = await db
    .select({ id: chats.id, mode: chats.mode, characterIds: chats.characterIds, metadata: chats.metadata })
    .from(chats)
    .where(
      inArray(
        chats.id,
        mapped.map((item) => item.chatId),
      ),
    );
  if (rooms.length !== mapped.length) return held("source-missing");
  for (const mappedRoom of mapped) {
    const room = rooms.find((item) => item.id === mappedRoom.chatId)!;
    const ids = json(room.characterIds);
    const metadata = object(json(room.metadata));
    const expected =
      mappedRoom.role === "dm"
        ? [ensemble.members.find((item) => item.dmChatId === room.id)!.characterId]
        : ensemble.members.map((item) => item.characterId);
    if (
      !Array.isArray(ids) ||
      !sameSet(ids as string[], expected) ||
      !metadata ||
      metadata.sceneStatus != null ||
      room.mode !== (mappedRoom.role === "rp" ? "roleplay" : "conversation") ||
      (Array.isArray(metadata.inactiveCharacterIds) &&
        expected.some((value) => (metadata.inactiveCharacterIds as unknown[]).includes(value)))
    )
      return held("topology-changed");
  }
  // Visibility is established before accessing the event body or character context.
  const prefix = `[Knowledge boundary]\nUnknown to cast IDs: ${bridge.unknownToCastIds.join(", ") || "none"}\n\n[Memory]\n`;
  if (!entry.content.startsWith(prefix)) return held("invalid-memory");
  const original = entry.content.slice(prefix.length);
  if (!original.trim() || original.length > 50000) return held("invalid-memory-content");
  const cardRow = (
    await db.select({ data: characters.data }).from(characters).where(eq(characters.id, target.characterId))
  )[0];
  const card = cardRow ? object(json(cardRow.data)) : null;
  if (!card || typeof card.name !== "string" || !card.name.trim()) return held("character-missing");
  const characterBasis = {
    characterId: target.characterId,
    name: card.name,
    ...Object.fromEntries(
      ["description", "personality", "scenario"].map((key) => [key, typeof card[key] === "string" ? card[key] : ""]),
    ),
  };
  if (stable(characterBasis).length > 20000) return held("character-context-too-large");
  result.characterName = card.name;
  const source = bridge.source;
  const sourceRevision =
    source.kind === "manual" ? JSON.stringify([source.createdAt, source.lastEditedAt]) : source.canonicalFingerprint;
  if (source.kind === "manual" && source.lastEditedAt < source.createdAt) return held("date-unknown");
  if (source.kind === "native-memory-chunk") {
    if (source.firstMessageAt > source.lastMessageAt) return held("date-unknown");
    for (const occurrence of source.occurrences) {
      const row = (
        await db
          .select({
            id: memoryChunks.id,
            content: memoryChunks.content,
            firstMessageAt: memoryChunks.firstMessageAt,
            lastMessageAt: memoryChunks.lastMessageAt,
            messageCount: memoryChunks.messageCount,
          })
          .from(memoryChunks)
          .where(and(eq(memoryChunks.chatId, occurrence.chatId), eq(memoryChunks.id, occurrence.chunkId)))
      )[0];
      if (
        !row ||
        row.content !== original ||
        row.firstMessageAt !== source.firstMessageAt ||
        row.lastMessageAt !== source.lastMessageAt
      )
        return held("source-changed");
      const part = /^\[Memory chunk part (\d+)\/(\d+)\]\n/u.exec(row.content);
      if (!part && row.content.startsWith("[Memory chunk part ")) return held("source-changed");
      const partIndex = part ? Number(part[1]) : 1;
      const partTotal = part ? Number(part[2]) : 1;
      if (
        !Number.isSafeInteger(partIndex) ||
        !Number.isSafeInteger(partTotal) ||
        partIndex < 1 ||
        partIndex > partTotal ||
        !Number.isSafeInteger(row.messageCount) ||
        row.messageCount < 0
      )
        return held("source-changed");
      const canonical = hash(
        JSON.stringify({
          firstMessageAt: row.firstMessageAt,
          lastMessageAt: row.lastMessageAt,
          messageCount: row.messageCount,
          partIndex,
          partTotal,
          content: part ? row.content.slice(part[0].length) : row.content,
        }),
      );
      const locator = hash(
        JSON.stringify({
          chatId: occurrence.chatId,
          firstMessageAt: row.firstMessageAt,
          lastMessageAt: row.lastMessageAt,
          partIndex,
          partTotal,
        }),
      );
      if (canonical !== source.canonicalFingerprint || locator !== occurrence.locatorFingerprint)
        return held("source-changed");
    }
  }
  const agingRoot = object(storage?.convoMemoryBridgeAgingV1);
  const agingRows =
    agingRoot?.schemaVersion === 1 && Array.isArray(agingRoot.ensembles)
      ? agingRoot.ensembles.filter((item) => object(item)?.ensembleId === ensemble.ensembleId)
      : [];
  if (agingRows.length > 1 || (agingRoot && agingRoot.schemaVersion !== 1)) return held("invalid-time-settings");
  const aging = agingSchema.safeParse(
    agingRows.length ? object(agingRows[0])?.aging : { schemaVersion: 1, rooms: [], memoryTimes: [] },
  );
  if (!aging.success) return held("invalid-time-settings");
  const times = aging.data.memoryTimes.filter((item) => item.memoryId === bridge.memoryId);
  if (times.length > 1) return held("ambiguous-source");
  const time = times[0];
  const sourceIds =
    source.kind === "native-memory-chunk"
      ? [...new Set(source.occurrences.map((item) => item.chatId))]
      : time
        ? [time.chatId]
        : [];
  if (sourceIds.length !== 1) return held("source-missing");
  const sourceChatId = sourceIds[0]!;
  const sourceRoom = mapped.find((item) => item.chatId === sourceChatId);
  if (
    !sourceRoom ||
    (source.kind === "native-memory-chunk" && source.occurrences.some((item) => item.chatRole !== sourceRoom.role))
  )
    return held("source-unmapped");
  if (time && (time.sourceRevision !== sourceRevision || time.chatId !== sourceChatId)) return held("stale-time");
  const policies = aging.data.rooms.filter((item) => item.chatId === sourceChatId);
  if (policies.length > 1) return held("ambiguous-source");
  const policy = policies[0] ?? {
    chatId: sourceChatId,
    clock: "default",
    detailedRecall: false,
    timelineId: "",
    currentDay: null,
  };
  const clock = policy.clock === "default" ? (sourceRoom.role === "rp" ? "story" : "real") : policy.clock;
  let elapsed: number;
  if (clock === "real")
    elapsed = (Date.now() - Date.parse(source.kind === "manual" ? source.createdAt : source.lastMessageAt)) / 86400000;
  else {
    if (
      !policy.timelineId ||
      policy.currentDay === null ||
      !time ||
      time.day === null ||
      time.timelineId !== policy.timelineId
    )
      return held("story-time-unknown");
    elapsed = policy.currentDay - time.day;
  }
  if (elapsed < 0) return held("future-time");
  const stageDays = [90, 60, 30, 21, 14, 7, 3].find((value) => elapsed >= value);
  if (stageDays === undefined) return held("memory-too-recent");
  result.sourceChatId = sourceChatId;
  result.clock = clock;
  result.stageDays = stageDays;
  result.detailedRecall = policy.detailedRecall;
  // Runtime journal/config revisions and the opt-in recall switch do not change the summary basis.
  const basis = hash(
    stable({
      ensemble,
      bridge,
      original,
      characterBasis,
      importanceMode,
      clock,
      stageDays,
      sourceChatId,
      timeCriteria: { clock: policy.clock, timelineId: policy.timelineId, currentDay: policy.currentDay, times },
    }),
  );
  if (!(await currentEntryMatches())) return held("entry-changed");
  result.basisFingerprint = basis;
  result.eligibility = { status: "ready", reason: null };
  if (current?.active) {
    result.state = current.basisFingerprint === basis && current.importanceMode === importanceMode ? "active" : "held";
    result.reason = result.state === "held" ? "basis-changed" : null;
  }
  return result;
}

/** Validate edited output again on the host; literal evidence is necessary, not semantic proof. */
export function validateCmbCompressionEvidence(
  entry: LorebookEntry,
  input: PersonalExtensionCoordinationCmbCompressionApplyInput,
): boolean {
  const bridge = bridgeSchema.safeParse(entry.dynamicState?.convoMemoryBridge);
  if (!bridge.success) return false;
  const prefix = `[Knowledge boundary]\nUnknown to cast IDs: ${bridge.data.unknownToCastIds.join(", ") || "none"}\n\n[Memory]\n`;
  if (!entry.content.startsWith(prefix)) return false;
  const original = entry.content.slice(prefix.length);
  const quotes = new Set(input.evidence.map((item) => item.quote));
  return (
    quotes.size === input.evidence.length &&
    input.evidence.every((item) => original.includes(item.quote)) &&
    input.facts.every(
      (fact) =>
        quotes.has(fact.evidenceQuote) &&
        fact.actors.every((actor) => fact.evidenceQuote.includes(actor) && input.summary.includes(actor)) &&
        [fact.negation, fact.condition, fact.status].every(
          (fragment) =>
            fragment === null || (fact.evidenceQuote.includes(fragment) && input.summary.includes(fragment)),
        ),
    ) &&
    (input.importanceMode !== "detail" || input.retention === "detail") &&
    (input.importanceMode !== "core" || input.retention === "essentials")
  );
}

export function setCmbCompressionRecord(
  entry: LorebookEntry,
  castId: string,
  record: PersonalExtensionCoordinationCmbCompressionRecord,
): Record<string, unknown> {
  const previous = entry.dynamicState?.[KEY];
  const parsed = namespaceSchema.safeParse(previous);
  if (previous !== undefined && !parsed.success)
    throw new PersonalExtensionCoordinationKernelError("coordination-validation-failed");
  const prior = parsed.success && Object.hasOwn(parsed.data.byCast, castId) ? parsed.data.byCast[castId] : null;
  const history = [
    ...(parsed.success ? (parsed.data.history ?? []) : []),
    ...(prior ? [{ castId, record: prior }] : []),
  ];
  if (history.length > 1024) throw new PersonalExtensionCoordinationKernelError("coordination-validation-failed");
  const next = {
    ...entry.dynamicState,
    [KEY]: { schemaVersion: 1, byCast: { ...(parsed.success ? parsed.data.byCast : {}), [castId]: record }, history },
  };
  if (JSON.stringify(next).length > 1_000_000)
    throw new PersonalExtensionCoordinationKernelError("coordination-validation-failed");
  return next;
}
