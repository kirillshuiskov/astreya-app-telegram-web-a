/**
 * Универсальная точка входа для B2B-автоматизации (рассылка через форк).
 *
 * Два транспорта над одной реализацией:
 *  - window.__b2b.*           — для Playwright/Orbita, который открывает форк
 *                                напрямую и вызывает API через page.evaluate(...).
 *  - postMessage 'b2b:send'   — для chats iframe (host оборачивает форк), на случай
 *                                если из host-страницы захочется тоже запускать send.
 *
 * Сюда добавляем только методы, нужные для отправки сообщений и для опроса
 * состояния аккаунта (auth invalidated). Логика UI/DOM не дергается — всё идёт
 * через callApi → MTProto worker, так же как делает сам клиент при ручном send.
 */

import { callApi } from '../api/gramjs';
import { onParentMessage, sendToParent } from './proxyBridge';

type SendInput = { username: string; text: string };

type SendResult =
  | { ok: true; messageId: number | undefined }
  | { ok: false; error: string };

type AuthInvalidSnapshot = { errorType: string; code: number; ts: number };

const NON_ALPHANUM_LEADING = /^[^a-zA-Z0-9_]+/;

function normalizeUsername(raw: string): string {
  return String(raw || '').trim().replace(NON_ALPHANUM_LEADING, '');
}

async function sendMessageByUsername({ username, text }: SendInput): Promise<SendResult> {
  try {
    const normalized = normalizeUsername(username);
    if (!normalized) return { ok: false, error: 'invalid_username' };
    const messageText = String(text ?? '');
    if (!messageText.length) return { ok: false, error: 'empty_text' };

    const resolved = await callApi('getChatByUsername', normalized);
    if (!resolved?.chat) return { ok: false, error: 'username_not_found' };

    const result = await callApi('sendMessage', {
      chat: resolved.chat,
      text: messageText,
    });

    if (!result) return { ok: false, error: 'send_failed' };
    const messageId = (result as any)?.id as number | undefined;
    return { ok: true, messageId };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err || 'unknown_error') };
  }
}

// Path A — window-эндпоинт для page.evaluate из browser-worker
if (typeof window !== 'undefined') {
  (window as any).__b2b = {
    sendMessageByUsername,
    /** Сводка по последнему перехваченному auth-killing ошибочному ответу MTProto. */
    getAuthInvalid(): AuthInvalidSnapshot | undefined {
      return (window as any).__b2bAuthInvalid;
    },
  };
}

// Path B — incoming command от host (parent) через существующий proxyBridge
onParentMessage<{ requestId: string } & SendInput>('b2b:send', async (msg) => {
  const r = await sendMessageByUsername({ username: msg.username, text: msg.text });
  sendToParent({
    type: 'b2b:sendResult',
    requestId: msg.requestId,
    ...r,
  } as any);
});
