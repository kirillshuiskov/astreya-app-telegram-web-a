import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { BridgeIncomingMessage, BridgeMessage } from './proxyBridge';

import { isTrustedParentWindowMessage, requestSessionFromParent } from './proxyBridge';

describe('openPeer protocol', () => {
  it('openPeer — валидное входящее сообщение от host', () => {
    const msg: BridgeIncomingMessage = { type: 'openPeer', peerId: '42', username: 'ivan' };
    expect(msg.type).toBe('openPeer');
  });

  it('openPeer допускает peer без username (частый случай у лидов)', () => {
    const msg: BridgeIncomingMessage = { type: 'openPeer', peerId: '42' };
    expect(msg.peerId).toBe('42');
  });

  it('openPeerResult — исходящее сообщение с причиной отказа', () => {
    const msg: BridgeMessage = {
      type: 'openPeerResult', peerId: '42', ok: false, reason: 'chat_not_loaded',
    };
    expect(msg.ok).toBe(false);
  });

  it('peerChanged — исходящее сообщение о смене открытого чата', () => {
    const msg: BridgeMessage = { type: 'peerChanged', peerId: '42' };
    expect(msg.peerId).toBe('42');
  });

  it('setTheme — входящее сообщение о теме host SPA', () => {
    const msg: BridgeIncomingMessage = { type: 'setTheme', theme: 'dark' };
    expect(msg.type).toBe('setTheme');
  });
});

// Anti-injection: любое окно того же origin может слать нам postMessage, поэтому
// доверяем строго тому же объекту window.parent И совпадению origin.
describe('isTrustedParentWindowMessage', () => {
  const origin = 'http://localhost:5173';
  const fakeParent = {} as Window;

  it('принимает только совпадение source с parent и origin', () => {
    expect(
      isTrustedParentWindowMessage({ source: fakeParent, origin }, fakeParent, origin),
    ).toBe(true);
  });

  it('отклоняет чужой source (anti-injection)', () => {
    const other = {} as Window;
    expect(
      isTrustedParentWindowMessage({ source: other, origin }, fakeParent, origin),
    ).toBe(false);
  });

  it('отклоняет неверный origin', () => {
    expect(
      isTrustedParentWindowMessage(
        { source: fakeParent, origin: 'https://evil.example' },
        fakeParent,
        origin,
      ),
    ).toBe(false);
  });
});

describe('requestSessionFromParent', () => {
  let originalParent: Window;

  beforeEach(() => {
    vi.useFakeTimers();
    originalParent = window.parent;
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'parent', {
      value: originalParent,
      configurable: true,
      writable: true,
    });
  });

  it('отклоняется по таймауту если нет sessionResponse', async () => {
    const p = requestSessionFromParent(1000);
    const assertion = expect(p).rejects.toThrow('session request timeout');
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('резолвится после sessionResponse от того же объекта window.parent', async () => {
    const fakeParent = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(window, 'parent', {
      value: fakeParent,
      configurable: true,
      writable: true,
    });

    const p = requestSessionFromParent(5000);

    await Promise.resolve();
    await Promise.resolve();
    expect(fakeParent.postMessage).toHaveBeenCalled();

    const outgoing = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      requestId: string;
    };
    expect(typeof outgoing.requestId).toBe('string');

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: fakeParent,
        data: {
          type: 'sessionResponse',
          requestId: outgoing.requestId,
          sessionData: { k: 1 },
          proxyBase: '/tg-proxy',
          deviceModel: 'm',
          systemVersion: 's',
        },
      }),
    );

    await expect(p).resolves.toEqual({
      sessionData: { k: 1 },
      proxyBase: '/tg-proxy',
      deviceModel: 'm',
      systemVersion: 's',
    });
  });

  it('игнорирует sessionResponse с неверным source и ждёт таймаут', async () => {
    const fakeParent = { postMessage: vi.fn() } as unknown as Window;
    const intruder = {} as Window;
    Object.defineProperty(window, 'parent', {
      value: fakeParent,
      configurable: true,
      writable: true,
    });

    const p = requestSessionFromParent(800);
    await Promise.resolve();
    await Promise.resolve();

    const outgoing = (fakeParent.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      requestId: string;
    };

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: intruder,
        data: {
          type: 'sessionResponse',
          requestId: outgoing.requestId,
          sessionData: {},
          proxyBase: '/x',
        },
      }),
    );

    const assertion = expect(p).rejects.toThrow('session request timeout');
    await vi.advanceTimersByTimeAsync(801);
    await assertion;
  });
});
