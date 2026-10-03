import type { LorebookEntry } from "@marinara-engine/shared";

export const CMB_PROVENANCE_GUIDANCE =
  "Record times are not in-world event dates. This is a retrieved fragment, not a complete or necessarily latest history. Do not infer missing dates or events.";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

/** Prompt-only annotation: never write this back to the entry or its embedding. */
export function withCmbProvenance(
  entry: Pick<LorebookEntry, "tag" | "dynamicState">,
  content: string,
  includeGuidance = true,
): string {
  if (entry.tag !== "convo-memory-bridge" || !content.trim()) return content;
  const bridge = record(record(entry.dynamicState)?.convoMemoryBridge);
  const source = bridge?.schemaVersion === 1 ? record(bridge.source) : null;
  const details: string[] = [];

  if (source?.kind === "native-memory-chunk") {
    const first = timestamp(source.firstMessageAt);
    const last = timestamp(source.lastMessageAt);
    details.push(
      first && last && first <= last
        ? `Source message record time (UTC): ${first} through ${last}.`
        : "Source message record time: unknown (missing or invalid metadata).",
    );
    const occurrences = source.occurrences;
    if (
      Array.isArray(occurrences) &&
      occurrences.length > 0 &&
      occurrences.length <= 32 &&
      occurrences.every((value) => {
        const item = record(value);
        return (
          item &&
          typeof item.chatRole === "string" &&
          ["rp", "group", "dm"].includes(item.chatRole) &&
          typeof item.chatId === "string" &&
          item.chatId.length > 0 &&
          item.chatId.length <= 256 &&
          item.chatId.trim() === item.chatId &&
          !/[\u0000-\u001f\u007f{}]/u.test(item.chatId)
        );
      })
    ) {
      const rooms = [
        ...new Set(
          occurrences.map((value) => {
            const item = value as Record<string, unknown>;
            return `${item.chatRole} chat ID ${JSON.stringify(item.chatId)}`;
          }),
        ),
      ];
      details.push(`Recorded source room(s): ${rooms.join("; ")}.`);
      if (rooms.length > 1) details.push("Multiple recorded occurrences; do not infer a unique original room.");
    } else {
      details.push("Source room: unknown (missing, invalid or oversized metadata).");
    }
  } else if (source?.kind === "manual") {
    const created = timestamp(source.createdAt);
    const edited = timestamp(source.lastEditedAt);
    details.push("Source: manually entered memory; no source chat asserted.");
    details.push(
      created && edited && created <= edited
        ? `Memory record created (UTC): ${created}; last edited (UTC): ${edited}.`
        : "Memory record time: unknown (missing or invalid metadata).",
    );
  } else {
    details.push("Source room and record time: unknown (unsupported or missing metadata).");
  }
  if (bridge?.sourceStatus === "missing")
    details.push("Original source is marked missing; it cannot be rechecked from this memory.");
  if (bridge?.ambiguousProvenance === true) details.push("Source attribution is marked ambiguous.");
  return [
    "[CMB memory provenance]",
    ...details,
    ...(includeGuidance ? [CMB_PROVENANCE_GUIDANCE] : []),
    "",
    content,
  ].join("\n");
}

/** A single proven source room; unknown/multi-room memories share the fallback bucket. */
export function cmbSourceRoom(entry: Pick<LorebookEntry, "tag" | "dynamicState">): string | null {
  if (entry.tag !== "convo-memory-bridge") return null;
  const bridge = record(record(entry.dynamicState)?.convoMemoryBridge);
  const source = bridge?.schemaVersion === 1 ? record(bridge.source) : null;
  if (
    bridge?.sourceStatus === "missing" ||
    bridge?.ambiguousProvenance === true ||
    source?.kind !== "native-memory-chunk" ||
    !Array.isArray(source.occurrences) ||
    source.occurrences.length === 0 ||
    source.occurrences.length > 32
  )
    return null;
  const first = record(source.occurrences[0]);
  const chatId = first?.chatId;
  return typeof chatId === "string" &&
    chatId.length > 0 &&
    chatId.length <= 256 &&
    chatId.trim() === chatId &&
    !/[\u0000-\u001f\u007f{}]/u.test(chatId) &&
    source.occurrences.every((value) => {
      const item = record(value);
      return item?.chatId === chatId && ["rp", "group", "dm"].includes(String(item?.chatRole));
    })
    ? chatId
    : null;
}

/** Only generated provenance headers, never history or a memory's body. */
export function dedupeCmbProvenanceGuidance(
  messages: Array<{ role: string; content: string; contextKind?: string }>,
): void {
  let included = false;
  for (const message of messages) {
    if (message.role !== "system" || message.contextKind === "history") continue;
    message.content = message.content.replace(
      /(\[CMB memory provenance\]\r?\n)((?:[ \t]*(?:Source message record time|Recorded source room\(s\)|Multiple recorded occurrences|Source room|Source:|Memory record|Original source is marked missing|Source attribution is marked ambiguous)[^\r\n]*\r?\n){1,8})([ \t]*Record times[^\r\n]*)(\r?\n[ \t]*\r?\n)/gu,
      (whole, header: string, details: string, guidance: string, gap: string) => {
        if (guidance.trim() !== CMB_PROVENANCE_GUIDANCE) return whole;
        if (!included) {
          included = true;
          return whole;
        }
        return header + details + gap.slice(gap.indexOf("\n") + 1);
      },
    );
  }
}

/** CMB transfers between rooms; the current room retains its native history/recall path. */
export function isCmbMemoryOnlyFromChat(entry: Pick<LorebookEntry, "tag" | "dynamicState">, chatId?: string): boolean {
  if (!chatId || entry.tag !== "convo-memory-bridge") return false;
  const bridge = record(record(entry.dynamicState)?.convoMemoryBridge);
  const source = bridge?.schemaVersion === 1 ? record(bridge.source) : null;
  return (
    bridge?.sourceStatus !== "missing" &&
    bridge?.ambiguousProvenance !== true &&
    source?.kind === "native-memory-chunk" &&
    timestamp(source.firstMessageAt) !== null &&
    timestamp(source.lastMessageAt) !== null &&
    String(source.firstMessageAt) <= String(source.lastMessageAt) &&
    Array.isArray(source.occurrences) &&
    source.occurrences.length > 0 &&
    source.occurrences.length <= 32 &&
    source.occurrences.every((value) => {
      const occurrence = record(value);
      return occurrence?.chatId === chatId && ["rp", "group", "dm"].includes(String(occurrence.chatRole));
    })
  );
}
