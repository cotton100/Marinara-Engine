export type ConversationMessageAuthorityErrorCode =
  | "message_not_found"
  | "message_chat_mismatch"
  | "message_not_assistant"
  | "active_swipe_not_found";

export class ConversationMessageAuthorityError extends Error {
  constructor(readonly code: ConversationMessageAuthorityErrorCode) {
    super(code);
    this.name = "ConversationMessageAuthorityError";
  }
}

export async function readAuthoritativeConversationMessage<
  TMessage extends { id: string; chatId: string; role: string; activeSwipeFound?: boolean },
>(args: {
  chatId: string;
  messageId: string;
  getMessageWithActiveSwipe: (messageId: string) => Promise<TMessage | null | undefined>;
}): Promise<TMessage> {
  const message = await args.getMessageWithActiveSwipe(args.messageId);
  if (!message) throw new ConversationMessageAuthorityError("message_not_found");
  if (message.chatId !== args.chatId) throw new ConversationMessageAuthorityError("message_chat_mismatch");
  if (message.role !== "assistant") throw new ConversationMessageAuthorityError("message_not_assistant");
  if (message.activeSwipeFound !== true) {
    throw new ConversationMessageAuthorityError("active_swipe_not_found");
  }
  return message;
}

export function replaceMessageSnapshot<TMessage extends { id: string }>(
  messages: readonly TMessage[],
  replacement: TMessage,
): TMessage[] {
  return messages.map((message) => (message.id === replacement.id ? replacement : message));
}
