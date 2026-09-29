import type { DB } from "../../db/connection.js";
import { eq, inArray } from "../../db/file-query.js";
import { characters, chats } from "../../db/schema/index.js";
import { loadCmbConfig } from "./conversation-call-context.js";

import {
  parseChatMetadataRecord,
  readCmbConvoRoutesPolicy,
  type CmbConvoRoutesPolicy,
} from "./cmb-convo-routes-policy.js";

/**
 * CMB Convo <-> RP routes. The CMB ensemble mapping stays the single source of rooms and members;
 * the Roleplay chat only stores whether the routes are on, which ensemble they belong to, the
 * default OOC room and a revision (see cmb-convo-routes-policy.ts).
 */
export {
  CMB_CONVO_ROUTES_KEY,
  isCmbConvoRoutesOnceOpted,
  parseChatMetadataRecord,
  readCmbConvoRoutesPolicy,
  type CmbConvoRoutesPolicy,
} from "./cmb-convo-routes-policy.js";

export type CmbRouteRoom = {
  chatId: string;
  name: string;
  kind: "dm" | "group" | "native";
  characterIds: string[];
  /** Stable reference shown to the model instead of a database ID. */
  label: string;
};

export type CmbRouteMember = {
  characterId: string;
  castId: string;
  name: string;
  dm: CmbRouteRoom | null;
  dmReason: string | null;
};

export type CmbRouteExclusion = { chatId: string; kind: "dm" | "group"; reason: string };

export type CmbRoleplayTopology = {
  ensembleId: string;
  ensembleName: string;
  rpChatId: string;
  members: CmbRouteMember[];
  groups: CmbRouteRoom[];
  excluded: CmbRouteExclusion[];
  /** The mutually linked native OOC conversation when it is not already a registered room. */
  nativePartner: CmbRouteRoom | null;
};

export type CmbRoleplayRoutes =
  | { state: "none" }
  | { state: "invalid"; reason: "invalid-policy" }
  | { state: "off"; policy: CmbConvoRoutesPolicy }
  | { state: "unavailable"; policy: CmbConvoRoutesPolicy; reason: string }
  | ({
      state: "active";
      policy: CmbConvoRoutesPolicy;
      defaultOoc: CmbRouteRoom | null;
      defaultOocReason: string | null;
      /** Registered rooms whose Influence/Note may reach the RP through this route. */
      sourceChatIds: string[];
    } & CmbRoleplayTopology);

type ChatRow = {
  id: string;
  name: string | null;
  mode: string | null;
  characterIds: string | null;
  metadata: string | null;
  connectedChatId: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 4 * 1024 * 1024) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function idList(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

async function chatRows(db: DB, ids: string[]): Promise<Map<string, ChatRow>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = (await db
    .select({
      id: chats.id,
      name: chats.name,
      mode: chats.mode,
      characterIds: chats.characterIds,
      metadata: chats.metadata,
      connectedChatId: chats.connectedChatId,
    })
    .from(chats)
    .where(inArray(chats.id, unique))) as ChatRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

type CmbConfig = NonNullable<Awaited<ReturnType<typeof loadCmbConfig>>>;

/** Validate the registered rooms of the ensemble whose RP is `rpChatId`, re-read from storage every call. */
export async function inspectCmbRoleplayTopology(
  db: DB,
  rpChatId: string,
  loadedConfig?: CmbConfig | null,
): Promise<{ ok: true; topology: CmbRoleplayTopology } | { ok: false; reason: string }> {
  const config = loadedConfig === undefined ? await loadCmbConfig(db) : loadedConfig;
  if (!config) return { ok: false, reason: "cmb-unavailable" };
  const ensemble = config.ensembles.find((item) => item.rpChatId === rpChatId);
  if (!ensemble) return { ok: false, reason: "not-registered" };
  const rows = await chatRows(db, [
    rpChatId,
    ...ensemble.groupConvoChatIds,
    ...ensemble.members.map((member) => member.dmChatId),
  ]);
  const rp = rows.get(rpChatId);
  if (!rp || rp.mode !== "roleplay") return { ok: false, reason: "not-roleplay" };
  const cards = (await db
    .select({ id: characters.id, data: characters.data })
    .from(characters)
    .where(
      inArray(
        characters.id,
        ensemble.members.map((member) => member.characterId),
      ),
    )) as Array<{ id: string; data: string }>;
  const names = new Map(
    cards.map((card) => {
      const name = record(parseJson(card.data))?.name;
      return [card.id, typeof name === "string" && name.trim() ? name.trim() : ""] as const;
    }),
  );
  const memberIds = ensemble.members.map((member) => member.characterId);
  const excluded: CmbRouteExclusion[] = [];
  const roomProblem = (
    row: ChatRow | undefined,
    requiredCharacterIds: string[],
    kind: "dm" | "group",
  ): string | null => {
    if (!row) return "room-missing";
    if (row.mode !== "conversation") return "room-mode";
    const present = idList(row.characterIds);
    if (!requiredCharacterIds.every((id) => present.includes(id)))
      return kind === "group" ? "partial-roster" : "member-not-in-room";
    // A DM is private to its one character: another character in the room would read it.
    if (kind === "dm" && present.some((id) => !requiredCharacterIds.includes(id))) return "dm-not-private";
    // A native 1:1 link to another story would make one room answer two RPs.
    if (row.connectedChatId && row.connectedChatId !== rpChatId) return "native-link-conflict";
    return null;
  };
  const members: CmbRouteMember[] = ensemble.members.map((member) => {
    const row = rows.get(member.dmChatId);
    const reason = roomProblem(row, [member.characterId], "dm");
    if (reason) excluded.push({ chatId: member.dmChatId, kind: "dm", reason });
    return {
      characterId: member.characterId,
      castId: member.castId,
      name: names.get(member.characterId) || member.castId,
      dm:
        reason || !row
          ? null
          : {
              chatId: row.id,
              name: row.name ?? row.id,
              kind: "dm",
              characterIds: idList(row.characterIds),
              label: `dm:${member.castId}`,
            },
      dmReason: reason,
    };
  });
  const groups: CmbRouteRoom[] = [];
  ensemble.groupConvoChatIds.forEach((chatId, index) => {
    const row = rows.get(chatId);
    const reason = roomProblem(row, memberIds, "group");
    if (reason || !row) {
      excluded.push({ chatId, kind: "group", reason: reason ?? "room-missing" });
      return;
    }
    groups.push({
      chatId,
      name: row.name ?? chatId,
      kind: "group",
      characterIds: idList(row.characterIds),
      label: `group-${index + 1}`,
    });
  });
  let nativePartner: CmbRouteRoom | null = null;
  const registered = new Set([
    ...groups.map((room) => room.chatId),
    ...members.flatMap((m) => (m.dm ? [m.dm.chatId] : [])),
  ]);
  if (rp.connectedChatId && !registered.has(rp.connectedChatId)) {
    const partner = (await chatRows(db, [rp.connectedChatId])).get(rp.connectedChatId);
    if (partner && partner.mode === "conversation" && partner.connectedChatId === rpChatId)
      nativePartner = {
        chatId: partner.id,
        name: partner.name ?? partner.id,
        kind: "native",
        characterIds: idList(partner.characterIds),
        label: "native",
      };
  }
  return {
    ok: true,
    topology: {
      ensembleId: ensemble.ensembleId,
      ensembleName: ensemble.name,
      rpChatId,
      members,
      groups,
      excluded,
      nativePartner,
    },
  };
}

/**
 * Everything a delivery depends on — which room each label and each member's DM point to, their
 * rosters and the default room — plus the policy revision. A change between generation start and
 * the post holds the delivery instead of reinterpreting it against the new mapping.
 */
export function cmbRoutesFingerprint(routes: Extract<CmbRoleplayRoutes, { state: "active" }>): string {
  const roster = (ids: string[]) => [...ids].sort();
  return JSON.stringify({
    ensembleId: routes.ensembleId,
    revision: routes.policy.revision,
    defaultOoc: routes.defaultOoc?.chatId ?? null,
    // Member order carries no meaning (group labels do), so a reordered cast is not a change.
    members: [...routes.members]
      .sort((a, b) => a.characterId.localeCompare(b.characterId))
      .map((member) => [
        member.characterId,
        member.castId,
        member.dm?.chatId ?? null,
        member.dm ? roster(member.dm.characterIds) : null,
      ]),
    groups: routes.groups.map((room) => [room.label, room.chatId, roster(room.characterIds)]),
  });
}

export function cmbDefaultOocCandidates(topology: CmbRoleplayTopology): CmbRouteRoom[] {
  return [
    ...(topology.nativePartner ? [topology.nativePartner] : []),
    ...topology.groups,
    ...topology.members.flatMap((member) => (member.dm ? [member.dm] : [])),
  ];
}

async function readChat(db: DB, chatId: string): Promise<ChatRow | null> {
  return (await chatRows(db, [chatId])).get(chatId) ?? null;
}

export async function resolveCmbRoleplayRoutes(db: DB, rpChatId: string): Promise<CmbRoleplayRoutes> {
  const rp = await readChat(db, rpChatId);
  if (!rp) return { state: "none" };
  const policy = readCmbConvoRoutesPolicy(parseChatMetadataRecord(rp.metadata));
  if (policy === null) return { state: "none" };
  if (policy === "invalid") return { state: "invalid", reason: "invalid-policy" };
  if (!policy.enabled) return { state: "off", policy };
  const inspected = await inspectCmbRoleplayTopology(db, rpChatId);
  if (!inspected.ok) return { state: "unavailable", policy, reason: inspected.reason };
  if (inspected.topology.ensembleId !== policy.ensembleId)
    return { state: "unavailable", policy, reason: "ensemble-changed" };
  const defaultOoc = policy.defaultOocChatId
    ? (cmbDefaultOocCandidates(inspected.topology).find((room) => room.chatId === policy.defaultOocChatId) ?? null)
    : null;
  return {
    state: "active",
    policy,
    ...inspected.topology,
    defaultOoc,
    defaultOocReason: policy.defaultOocChatId && !defaultOoc ? "default-room-unavailable" : null,
    sourceChatIds: [
      ...inspected.topology.members.flatMap((member) => (member.dm ? [member.dm.chatId] : [])),
      ...inspected.topology.groups.map((room) => room.chatId),
    ],
  };
}

export type CmbConversationRoute = {
  rpChatId: string;
  rpName: string;
  revision: number;
  memberCharacterIds: string[];
};

/** The active RP route a registered conversation may send Influence/Note to, or null. */
export async function resolveCmbConversationRoute(db: DB, convoChatId: string): Promise<CmbConversationRoute | null> {
  const config = await loadCmbConfig(db);
  if (!config) return null;
  const ensemble = config.ensembles.find(
    (item) =>
      item.groupConvoChatIds.includes(convoChatId) || item.members.some((member) => member.dmChatId === convoChatId),
  );
  if (!ensemble) return null;
  const routes = await resolveCmbRoleplayRoutes(db, ensemble.rpChatId);
  if (routes.state !== "active" || !routes.sourceChatIds.includes(convoChatId)) return null;
  const rp = await readChat(db, ensemble.rpChatId);
  return {
    rpChatId: ensemble.rpChatId,
    rpName: rp?.name ?? ensemble.rpChatId,
    revision: routes.policy.revision,
    memberCharacterIds: routes.members.map((member) => member.characterId),
  };
}

/**
 * Which conversation rooms may currently inject stored Influence/Note rows into a once-opted RP:
 * the mutually linked native partner plus, while active, the validated CMB rooms. Rows from any
 * other source are kept in storage but never injected.
 */
export async function resolveCmbRoleplaySourceChatIds(
  db: DB,
  rpChatId: string,
  routes: CmbRoleplayRoutes,
): Promise<Set<string>> {
  const allowed = new Set<string>(routes.state === "active" ? routes.sourceChatIds : []);
  const rp = await readChat(db, rpChatId);
  if (rp?.connectedChatId) {
    const partner = await readChat(db, rp.connectedChatId);
    if (partner && partner.mode === "conversation" && partner.connectedChatId === rpChatId) allowed.add(partner.id);
  }
  return allowed;
}

export async function readChatRoutesMetadata(db: DB, chatId: string): Promise<Record<string, unknown> | null> {
  const row = (await db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId)).limit(1))[0] as
    | { metadata: string }
    | undefined;
  return row ? parseChatMetadataRecord(row.metadata) : null;
}
