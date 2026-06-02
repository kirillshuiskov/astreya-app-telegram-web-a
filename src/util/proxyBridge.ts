/**
 * Мост host ↔ iframe для proxy mode: сессия, MTProto telemetry, смена аккаунта.
 * В Web Worker нет window.parent — сообщения уходят в main thread через Worker.postMessage
 * (payload type proxyBridgeOut в connector), затем в parent SPA.
 */

/** Сообщения iframe → host */
export type BridgeMessage =
  | { type: 'tgweb:ready' }
  | { type: 'sessionRequest'; requestId: string }
  | { type: 'connectionState'; state: 'connectionStateConnecting' | 'connectionStateReady' | 'connectionStateDisconnected' }
  // Первичная синхронизация чатов завершена (whenFirstBatchDone → isSynced=true): чаты текущего
  // аккаунта реально загружены и отрисованы. Host снимает оверлей загрузки именно по нему, а не по
  // connectionStateReady (MTProto подключился, но чаты ещё не подгружены).
  | { type: 'syncComplete' }
  | { type: 'authState'; state: 'authorizationStateReady' | 'authorizationStateUnauthorized' | 'authorizationStateClosed' }
  | { type: 'mtprotoSenderLogs'; logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; dcId?: number; ts: number }> }
  | { type: 'accountChanged'; accountId: string; ok: boolean; error?: string };

/** Сообщения host → iframe */
export type BridgeIncomingMessage =
  | (SessionPayload & { type: 'sessionResponse' })
  | { type: 'setAccount'; accountId: string; workspaceId: string };

export type SessionPayload = {
  requestId: string;
  sessionData: unknown;
  proxyBase: string;
  deviceModel?: string;
  systemVersion?: string;
};

const SESSION_REQUEST_TIMEOUT_MS = 10000;

/**
 * Доверенное сообщение от parent в контексте iframe (same-origin + строго тот же объект window.parent).
 * Вынесено для покрытия unit-тестами без дублирования условий.
 */
export function isTrustedParentWindowMessage(
  event: Pick<MessageEvent, 'source' | 'origin'>,
  parentWindow: Window,
  expectedOrigin: string,
): boolean {
  return event.source === parentWindow && event.origin === expectedOrigin;
}

const sessionWaiters = new Map<string, {
  resolve: (p: SessionPayload) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const handlers = new Map<string, (payload: unknown) => void>();

/** Отправка в parent SPA или из worker в main → parent */
export function sendToParent(msg: BridgeMessage): void {
  try {
    if (typeof window === 'undefined') {
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({
        payloads: [{ type: 'proxyBridgeOut', msg: msg as Record<string, unknown> }],
      });
      return;
    }
    if (window.parent !== window) {
      window.parent.postMessage(msg, location.origin);
    }
  } catch {
    // игнорируем cross-origin / недоступный parent
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    if (!isTrustedParentWindowMessage(e, window.parent, location.origin)) return;
    const msg = e.data as BridgeIncomingMessage | undefined;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    if (msg.type === 'sessionResponse') {
      if (typeof msg.requestId !== 'string') return;
      const w = sessionWaiters.get(msg.requestId);
      if (w) {
        clearTimeout(w.timer);
        sessionWaiters.delete(msg.requestId);
        w.resolve(msg);
      }
      return;
    }

    const h = handlers.get(msg.type);
    h?.(msg);
  });
}

export function onParentMessage<T = unknown>(type: string, handler: (payload: T) => void): void {
  handlers.set(type, handler as (payload: unknown) => void);
}

/** Запрос session у host; без host — таймаут (вызывающий код делает fallback fetch) */
export function requestSessionFromParent(timeoutMs = SESSION_REQUEST_TIMEOUT_MS): Promise<Omit<SessionPayload, 'requestId'>> {
  return new Promise((resolveOuter, rejectOuter) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      sessionWaiters.delete(requestId);
      rejectOuter(new Error('session request timeout'));
    }, timeoutMs);

    sessionWaiters.set(requestId, {
      resolve: (p: SessionPayload) => {
        clearTimeout(timer);
        sessionWaiters.delete(requestId);
        const { requestId: _rid, type: _tp, ...rest } = p as SessionPayload & { type?: string };
        resolveOuter(rest as Omit<SessionPayload, 'requestId'>);
      },
      reject: (e: Error) => {
        clearTimeout(timer);
        sessionWaiters.delete(requestId);
        rejectOuter(e);
      },
      timer,
    });

    sendToParent({ type: 'sessionRequest', requestId });
  });
}
