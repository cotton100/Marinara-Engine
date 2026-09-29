import { normalizeTextForMatch } from "@marinara-engine/shared";

import { cmbRoutesFingerprint, type CmbRoleplayRoutes, type CmbRouteRoom } from "../conversation/cmb-convo-routes.js";

export type RoleplayOocMessage = {
  text: string;
  /** Explicit group reference from `<ooc room="...">` (CMB routes only). */
  room: string | null;
  /** Explicit speaker from `<ooc from="...">` (CMB routes only). */
  from: string | null;
  /** The generation's own speaker when it is known to speak for exactly one character. */
  speakerCharacterId: string | null;
};

const LEGACY_OOC_RE = /<ooc>([\s\S]*?)<\/ooc>/gi;
const MANAGED_OOC_RE = /<ooc(\s[^>]*)?>([\s\S]*?)<\/ooc>/gi;
const ATTRIBUTE_RE = /([a-z]+)\s*=\s*"([^"]*)"/gi;

/** Strip `<ooc>` blocks from an RP reply. Attributes are only understood on the CMB-managed path. */
export function extractRoleplayOocMessages(
  response: string,
  options: { managed: boolean; speakerCharacterId: string | null },
): { response: string; messages: RoleplayOocMessage[] } {
  const pattern = options.managed ? MANAGED_OOC_RE : LEGACY_OOC_RE;
  const messages: RoleplayOocMessage[] = [];
  for (const match of response.matchAll(pattern)) {
    const text = (options.managed ? match[2] : match[1])!.trim();
    if (!text) continue;
    const attributes = new Map<string, string>();
    if (options.managed && match[1]) {
      for (const attribute of match[1].matchAll(ATTRIBUTE_RE))
        attributes.set(attribute[1]!.toLowerCase(), attribute[2]!.trim());
    }
    messages.push({
      text,
      room: attributes.get("room") || null,
      from: attributes.get("from") || null,
      speakerCharacterId: options.speakerCharacterId,
    });
  }
  if (!messages.length) return { response, messages };
  return {
    response: response
      .replace(pattern, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    messages,
  };
}

export type RoleplayOocDelivery =
  | { action: "post"; chatId: string; characterId: string; text: string }
  | { action: "hold"; reason: string; text: string };

function resolveSpeaker(
  message: RoleplayOocMessage,
  routes: Extract<CmbRoleplayRoutes, { state: "active" }>,
  activeCharacterIds: readonly string[],
): string | { hold: string } {
  const memberIds = routes.members.map((member) => member.characterId);
  if (message.from) {
    const key = normalizeTextForMatch(message.from);
    const matches = routes.members.filter(
      (member) => member.characterId === message.from || normalizeTextForMatch(member.name) === key,
    );
    if (matches.length !== 1) return { hold: "speaker-unresolved" };
    // A single-speaker generation cannot post as someone else.
    if (message.speakerCharacterId && message.speakerCharacterId !== matches[0]!.characterId)
      return { hold: "speaker-mismatch" };
    return matches[0]!.characterId;
  }
  if (message.speakerCharacterId)
    return memberIds.includes(message.speakerCharacterId) ? message.speakerCharacterId : { hold: "speaker-not-member" };
  // Never fall back to the first character: only a single present member is unambiguous.
  const present = memberIds.filter((id) => activeCharacterIds.includes(id));
  return present.length === 1 ? present[0]! : { hold: "speaker-unknown" };
}

function resolveRoom(
  message: RoleplayOocMessage,
  routes: Extract<CmbRoleplayRoutes, { state: "active" }>,
): CmbRouteRoom | { hold: string } {
  if (message.room) {
    const key = normalizeTextForMatch(message.room);
    const matches = routes.groups.filter(
      (room) => room.label === message.room || normalizeTextForMatch(room.name) === key,
    );
    return matches.length === 1 ? matches[0]! : { hold: "room-unknown" };
  }
  if (routes.defaultOoc) return routes.defaultOoc;
  return { hold: routes.defaultOocReason ?? "no-default-room" };
}

/**
 * Plan where each OOC message goes on the CMB-managed path. The routes are re-read right before
 * posting; any policy revision change, OFF, or room change holds instead of rerouting.
 */
export function planManagedRoleplayOoc(args: {
  messages: RoleplayOocMessage[];
  routesAtStart: Extract<CmbRoleplayRoutes, { state: "active" }>;
  routesNow: CmbRoleplayRoutes;
  activeCharacterIds: readonly string[];
}): RoleplayOocDelivery[] {
  const { routesAtStart, routesNow } = args;
  // The CMB mapping can change without a policy revision (a DM swapped, groups reordered), so the
  // whole room mapping is compared, not just the RP-side policy.
  const changed =
    routesNow.state !== "active" || cmbRoutesFingerprint(routesNow) !== cmbRoutesFingerprint(routesAtStart);
  return args.messages.map((message) => {
    if (changed) return { action: "hold", reason: "routes-changed", text: message.text };
    // Names are what the model was shown. With the mapping unchanged, the delivery is resolved
    // against the start snapshot, so a room or character renamed meanwhile cannot capture it.
    const routes = routesAtStart;
    const speaker = resolveSpeaker(message, routes, args.activeCharacterIds);
    if (typeof speaker !== "string") return { action: "hold", reason: speaker.hold, text: message.text };
    const room = resolveRoom(message, routes);
    if ("hold" in room) return { action: "hold", reason: room.hold, text: message.text };
    if (!room.characterIds.includes(speaker))
      return { action: "hold", reason: "speaker-not-in-room", text: message.text };
    return { action: "post", chatId: room.chatId, characterId: speaker, text: message.text };
  });
}

/**
 * A character's DM on the managed path goes to that character's own registered DM room. Anything
 * uncertain (route change, shared name, non-member, unusable room) is held, never rerouted.
 */
export function planCmbDirectMessage(args: {
  routesAtStart: Extract<CmbRoleplayRoutes, { state: "active" }>;
  routesNow: CmbRoleplayRoutes;
  requestedName: string;
  resolvedCharacterId: string | null | undefined;
  roleplayCharacters: ReadonlyArray<{ id: string; name: string }>;
  normalizeName: (value: string) => string;
}): { chatId: string } | { held: string } {
  const { routesAtStart, routesNow } = args;
  if (routesNow.state !== "active" || cmbRoutesFingerprint(routesNow) !== cmbRoutesFingerprint(routesAtStart))
    return { held: "routes-changed" };
  const key = args.normalizeName(args.requestedName);
  if (
    args.requestedName.trim() !== args.resolvedCharacterId &&
    args.roleplayCharacters.filter((character) => args.normalizeName(character.name) === key).length > 1
  )
    return { held: "speaker-unresolved" };
  const member = routesAtStart.members.find((item) => item.characterId === args.resolvedCharacterId);
  if (!member) return { held: "not-ensemble-member" };
  if (!member.dm) return { held: member.dmReason ?? "dm-unavailable" };
  return { chatId: member.dm.chatId };
}

/** Model-facing OOC instruction for the managed path; rooms are named by stable labels, never IDs. */
export function buildManagedRoleplayOocInstruction(
  routes: Extract<CmbRoleplayRoutes, { state: "active" }>,
  sanitize: (value: string) => string,
): string {
  const lines = [
    `<ooc_instruction>`,
    `Characters of this roleplay have out-of-character conversations with the user outside the story.`,
    `If a character genuinely wants to break the fourth wall or chat casually outside the story, they can use an <ooc> tag. Name the character who speaks:`,
    `<ooc from="Character Name">casual comment about what just happened</ooc>`,
  ];
  if (routes.defaultOoc)
    lines.push(
      `Without a room, it is posted to "${sanitize(routes.defaultOoc.name)}" (only if that character is in it).`,
    );
  else lines.push(`There is no default room, so an <ooc> tag without a room is not delivered.`);
  if (routes.groups.length) {
    lines.push(`To post in a group conversation instead, add its room reference:`);
    for (const room of routes.groups) lines.push(`- room="${room.label}": ${sanitize(room.name)}`);
    lines.push(`<ooc from="Character Name" room="${routes.groups[0]!.label}">message to the group</ooc>`);
  }
  lines.push(
    `A private direct message from a character goes to that character's own conversation with the user, not to a group.`,
    `The <ooc> text is removed from the roleplay response. Use this very sparingly; most responses should not include <ooc> tags.`,
    `</ooc_instruction>`,
  );
  return lines.join("\n");
}
