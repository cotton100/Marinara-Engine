export type AppDeepLink = { type: "chat"; chatId: string } | { type: "noodle" };

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function parseAppDeepLinkHash(hash: string): AppDeepLink | null {
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (rawHash === "noodle") return { type: "noodle" };

  const params = new URLSearchParams(rawHash);
  if ([...params.keys()].some((key) => key !== "chat")) return null;

  const chatIds = params.getAll("chat");
  if (chatIds.length !== 1 || !CHAT_ID_PATTERN.test(chatIds[0])) return null;

  return { type: "chat", chatId: chatIds[0] };
}

export function getHashlessAppUrl(location: Pick<Location, "pathname" | "search">): string {
  return `${location.pathname}${location.search}`;
}
