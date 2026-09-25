import type { LorebookEntry } from "@marinara-engine/shared";

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
export function withCmbProvenance(entry: Pick<LorebookEntry, "tag" | "dynamicState">, content: string): string {
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
    "Record times are not in-world event dates. This is a retrieved fragment, not a complete or necessarily latest history. Do not infer missing dates or events.",
    "",
    content,
  ].join("\n");
}
