import { describe, expect, it } from 'vitest';

import { isTrustedParentWindowMessage } from './proxyBridge';
import type { BridgeIncomingMessage, BridgeMessage } from './proxyBridge';

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

  it('сообщение не от parent-окна не доверяется', () => {
    const parent = {} as Window;
    expect(isTrustedParentWindowMessage(
      { source: {} as Window, origin: 'https://app.local' }, parent, 'https://app.local',
    )).toBe(false);
  });
});
