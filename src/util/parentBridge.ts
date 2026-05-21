// Двусторонний postMessage-мост между TG Web A iframe и родительским SPA.
// Форк → родитель: события о новых сообщениях, смене чата, статусе.
// Родитель → форк: команды (openChat, ping).

const BRIDGE_ACTIVE = window.parent !== window;

export type BridgeOutEvent =
  | { type: 'tgweb:ready' }
  | { type: 'tgweb:chatChanged'; chatId: string | undefined }
  | { type: 'tgweb:newMessage'; chatId: string; messageId: number; fromId?: string }
  | { type: 'tgweb:unreadCount'; chatId: string; count: number }
  | { type: 'tgweb:pong' };

export type BridgeInCommand =
  | { type: 'tgweb:openChat'; chatId: string }
  | { type: 'tgweb:ping' };

export function sendToParent(event: BridgeOutEvent): void {
  if (!BRIDGE_ACTIVE) return;
  try {
    window.parent.postMessage(event, '*');
  } catch {
    // cross-origin blocked — игнорируем
  }
}

export function onParentCommand(handler: (cmd: BridgeInCommand) => void): () => void {
  if (!BRIDGE_ACTIVE) return () => {};
  const listener = (e: MessageEvent) => {
    if(!e.data || typeof e.data.type !== 'string') return;
    if(!e.data.type.startsWith('tgweb:')) return;
    handler(e.data as BridgeInCommand);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
