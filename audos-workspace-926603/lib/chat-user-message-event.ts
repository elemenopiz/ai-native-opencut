export interface ChatUserMessageHandlers {
  sendPendingMessage(content: string): void;
  /**
   * `title` is an optional friendly name the dispatching app supplies for the
   * conversation it just started (e.g. "Marcie · CRM"). Without it the
   * conversation falls back to a title derived from `content`, which for an
   * app-dispatched prompt is the bracketed context envelope — unreadable, and
   * identical across every consultation the app starts.
   */
  updateThreadMetadata(threadId: string, content: string, title?: string): void;
}

export function listenForChatUserMessages(
  target: EventTarget,
  handlers: ChatUserMessageHandlers,
): () => void {
  const onUserMessage = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
      return;
    }

    try {
      const contentValue = (detail as Record<string, unknown>).content;
      const content =
        typeof contentValue === 'string' ? contentValue.trim() : '';
      if (!content) return;

      if (!('threadId' in detail)) {
        handlers.sendPendingMessage(content);
        return;
      }

      const threadIdValue = (detail as Record<string, unknown>).threadId;
      if (typeof threadIdValue !== 'string' || !threadIdValue.trim()) return;

      const titleValue = (detail as Record<string, unknown>).title;
      const title =
        typeof titleValue === 'string' && titleValue.trim()
          ? titleValue.trim().slice(0, 80)
          : undefined;

      handlers.updateThreadMetadata(threadIdValue, content, title);
    } catch {
      // Ignore malformed event detail objects, including throwing accessors.
    }
  };

  target.addEventListener('audos:chat-user-message', onUserMessage);
  return () =>
    target.removeEventListener('audos:chat-user-message', onUserMessage);
}
