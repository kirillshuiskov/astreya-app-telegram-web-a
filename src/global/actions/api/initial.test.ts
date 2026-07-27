import {
  beforeAll, beforeEach, describe, expect, it, vi,
} from 'vitest';

// `initial.ts` pulls in a large chunk of the app's dependency graph (GramJS worker
// connector, IndexedDB stores, BroadcastChannel-based multiaccount bookkeeping, etc.)
// through modules it never actually invokes at import time for the two handlers under
// test here (`openPeer`, `processOpenChatOrThread`). None of that machinery is exercised
// by this file — `addActionHandler`/`onParentMessage` are mocked to just *register*
// handlers, so their real bodies never run. Mocking every direct import at this seam
// keeps the test isolated and deterministic without touching production code.
vi.mock('../../../types', () => ({ ManagementProgress: { Idle: 0, InProgress: 1, Complete: 2 } }));
vi.mock('../../../config', () => ({
  CUSTOM_BG_CACHE_NAME: 'custom-bg',
  LANG_CACHE_NAME: 'lang0',
  LOCK_SCREEN_ANIMATION_DURATION_MS: 0,
  MEDIA_CACHE_NAME: 'media',
  MEDIA_CACHE_NAME_AVATARS: 'media-avatars',
  MEDIA_PROGRESSIVE_CACHE_NAME: 'media-progressive',
}));
vi.mock('../../../util/appBadge', () => ({ updateAppBadge: vi.fn() }));
vi.mock('../../../util/browser/idb', () => ({ PASSCODE_IDB_STORE: { clear: vi.fn() } }));
vi.mock('../../../util/browser/passkeys', () => ({ toCredentialRequestOptions: vi.fn() }));
vi.mock('../../../util/browser/windowEnvironment', () => ({
  IS_WEBAUTHN_SUPPORTED: false,
  IS_WEBM_SUPPORTED: false,
  MAX_BUFFER_SIZE: 0,
  PLATFORM_ENV: 'test',
}));
vi.mock('../../../util/cacheApi', () => ({ clear: vi.fn() }));
vi.mock('../../../util/establishMultitabRole', () => ({ getCurrentTabId: vi.fn(() => 0) }));
vi.mock('../../../util/multiaccount', () => ({ ACCOUNT_SLOT: 0, getAccountsInfo: vi.fn(() => ({})) }));
vi.mock('../../../util/notifications', () => ({ unsubscribe: vi.fn() }));
vi.mock('../../../util/passcode', () => ({
  clearEncryptedSession: vi.fn(),
  encryptSession: vi.fn(),
  forgetPasscode: vi.fn(),
}));
vi.mock('../../../util/routing', () => ({
  parseInitialLocationHash: vi.fn(() => undefined),
  resetInitialLocationHash: vi.fn(),
  resetLocationHash: vi.fn(),
}));
vi.mock('../../../util/schedulers', () => ({ pause: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../util/sessions', () => ({
  clearStoredSession: vi.fn(),
  loadStoredSession: vi.fn(),
  storeSession: vi.fn(),
}));
vi.mock('../../../util/websync', () => ({ forceWebsync: vi.fn() }));
vi.mock('../../../api/gramjs', () => ({
  callApi: vi.fn(),
  callApiLocal: vi.fn(),
  initApi: vi.fn(),
  setShouldEnableDebugLog: vi.fn(),
}));
vi.mock('../../cache', () => ({
  removeGlobalFromCache: vi.fn(),
  removeSharedStateFromCache: vi.fn(),
  serializeGlobal: vi.fn(),
  serializeShared: vi.fn(),
}));
vi.mock('../../reducers', () => ({
  clearGlobalForLockScreen: vi.fn(),
  updateManagementProgress: vi.fn(),
  updatePasscodeSettings: vi.fn(),
}));
vi.mock('../../reducers/auth', () => ({ updateAuth: vi.fn() }));
vi.mock('../../selectors/sharedState', () => ({ selectSharedSettings: vi.fn(() => ({})) }));
vi.mock('../../shared/sharedStateConnector', () => ({ destroySharedStatePort: vi.fn() }));

// Controlled seams: the bridge protocol, the action-dispatch surface and the two
// selectors the `openPeer` handler consults.
vi.mock('../../../util/proxyBridge', () => ({
  sendToParent: vi.fn(),
  onParentMessage: vi.fn(),
  requestSessionFromParent: vi.fn(),
}));
vi.mock('../../index', () => ({
  addActionHandler: vi.fn(),
  getActions: vi.fn(),
  getGlobal: vi.fn(() => ({})),
  setGlobal: vi.fn(),
}));
vi.mock('../../selectors', () => ({
  selectChat: vi.fn(),
  selectCurrentChat: vi.fn(),
  selectUser: vi.fn(),
}));

type OpenPeerMsg = { peerId: string; username?: string };
type ActionHandler = (global: unknown, actions: unknown, payload: unknown) => unknown;

describe('initial.ts proxy-mode bridge handlers', () => {
  let sendToParentMock: ReturnType<typeof vi.fn>;
  let onParentMessageMock: ReturnType<typeof vi.fn>;
  let addActionHandlerMock: ReturnType<typeof vi.fn>;
  let selectChatMock: ReturnType<typeof vi.fn>;
  let selectCurrentChatMock: ReturnType<typeof vi.fn>;
  let selectUserMock: ReturnType<typeof vi.fn>;
  let mockActions: { openChatByUsername: ReturnType<typeof vi.fn>; openChat: ReturnType<typeof vi.fn> };

  let openPeerHandler: (msg: OpenPeerMsg) => void;
  let processOpenChatOrThreadHandler: ActionHandler;

  beforeAll(async () => {
    // Module-level `if (... __tgConfig?.proxyMode)` gate in initial.ts must see this
    // before the module is evaluated, exactly like the real host does via __tgConfig.
    (window as any).__tgConfig = { proxyMode: true };

    const proxyBridge = await import('../../../util/proxyBridge');
    const globalIndex = await import('../../index');
    const selectors = await import('../../selectors');

    sendToParentMock = proxyBridge.sendToParent as unknown as ReturnType<typeof vi.fn>;
    onParentMessageMock = proxyBridge.onParentMessage as unknown as ReturnType<typeof vi.fn>;
    addActionHandlerMock = globalIndex.addActionHandler as unknown as ReturnType<typeof vi.fn>;
    selectChatMock = selectors.selectChat as unknown as ReturnType<typeof vi.fn>;
    selectCurrentChatMock = selectors.selectCurrentChat as unknown as ReturnType<typeof vi.fn>;
    selectUserMock = selectors.selectUser as unknown as ReturnType<typeof vi.fn>;

    mockActions = {
      openChatByUsername: vi.fn(() => Promise.resolve()),
      openChat: vi.fn(),
    };
    (globalIndex.getActions as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockActions);

    // Importing the module under test triggers its top-level registration calls,
    // which we captured above via the mocked addActionHandler/onParentMessage.
    await import('./initial');

    const openPeerCall = onParentMessageMock.mock.calls.find((call: any[]) => call[0] === 'openPeer');
    if (!openPeerCall) throw new Error('openPeer handler was not registered');
    openPeerHandler = openPeerCall[1];

    const processCall = addActionHandlerMock.mock.calls
      .find((call: any[]) => call[0] === 'processOpenChatOrThread');
    if (!processCall) throw new Error('processOpenChatOrThread handler was not registered');
    processOpenChatOrThreadHandler = processCall[1];
  });

  beforeEach(() => {
    sendToParentMock.mockClear();
    mockActions.openChatByUsername.mockClear().mockResolvedValue(undefined);
    mockActions.openChat.mockClear();
    selectChatMock.mockReset();
    selectCurrentChatMock.mockReset();
    selectUserMock.mockReset();
    (globalThis as any).__tgProxyBridge = true;
  });

  describe('openPeer', () => {
    it('username branch: resolves and reports ok:true once the chat is actually open', async () => {
      selectCurrentChatMock.mockReturnValue({ id: '42', usernames: [{ username: 'ivan' }] });

      openPeerHandler({ peerId: '42', username: 'ivan' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(mockActions.openChatByUsername).toHaveBeenCalledWith({ username: 'ivan' });
      expect(sendToParentMock).toHaveBeenCalledTimes(1);
      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'openPeerResult', peerId: '42', ok: true });
    });

    it('username branch: unresolvable username does NOT report ok:true (Finding 1 fix)', async () => {
      // Production behaviour of openChatByUsername on "user does not exist": it does not
      // throw — it silently falls back to openPreviousChat + a notification (chats.ts).
      // The only honest signal is whether the currently open chat actually matches the
      // requested username after the await settles.
      mockActions.openChatByUsername.mockResolvedValue(undefined);
      selectCurrentChatMock.mockReturnValue({ id: '1', usernames: [{ username: 'someone_else' }] });

      openPeerHandler({ peerId: '42', username: 'ghost' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(sendToParentMock).toHaveBeenCalledTimes(1);
      expect(sendToParentMock).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
      expect(sendToParentMock).toHaveBeenCalledWith({
        type: 'openPeerResult', peerId: '42', ok: false, reason: 'not_found',
      });
    });

    it('username branch: no currently open chat at all does NOT report ok:true', async () => {
      mockActions.openChatByUsername.mockResolvedValue(undefined);
      selectCurrentChatMock.mockReturnValue(undefined);

      openPeerHandler({ peerId: '42', username: 'ghost' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(sendToParentMock).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('id branch: known chat opens via openChat and reports ok:true', async () => {
      selectChatMock.mockReturnValue({ id: '42' });
      selectUserMock.mockReturnValue(undefined);

      openPeerHandler({ peerId: '42' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(mockActions.openChat).toHaveBeenCalledWith({ id: '42' });
      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'openPeerResult', peerId: '42', ok: true });
    });

    it('id branch: chat missing but user known still opens via openChat and reports ok:true (widened gate)', async () => {
      // openChat self-heals when the chat isn't loaded yet but the user is known:
      // it falls back to selectUser + fetchChat({type:'user'}) (chats.ts:250-259).
      // Users are far more commonly present in state than chats (message senders,
      // contacts, search results), so the gate must not reject on selectChat alone.
      selectChatMock.mockReturnValue(undefined);
      selectUserMock.mockReturnValue({ id: '42' });

      openPeerHandler({ peerId: '42' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(mockActions.openChat).toHaveBeenCalledWith({ id: '42' });
      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'openPeerResult', peerId: '42', ok: true });
    });

    it('id branch: both chat and user missing reports chat_not_loaded and does not call openChat', async () => {
      selectChatMock.mockReturnValue(undefined);
      selectUserMock.mockReturnValue(undefined);

      openPeerHandler({ peerId: '99' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(mockActions.openChat).not.toHaveBeenCalled();
      expect(sendToParentMock).toHaveBeenCalledWith({
        type: 'openPeerResult', peerId: '99', ok: false, reason: 'chat_not_loaded',
      });
    });

    it('catch path: a thrown error while opening the chat reports reason:error', async () => {
      selectChatMock.mockReturnValue({ id: '42' });
      mockActions.openChat.mockImplementation(() => {
        throw new Error('boom');
      });

      openPeerHandler({ peerId: '42' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(sendToParentMock).toHaveBeenCalledTimes(1);
      expect(sendToParentMock).toHaveBeenCalledWith({
        type: 'openPeerResult', peerId: '42', ok: false, reason: 'error',
      });
    });
  });

  describe('processOpenChatOrThread → peerChanged', () => {
    it('emits peerChanged with the chat id coerced to a string', () => {
      processOpenChatOrThreadHandler({}, mockActions, { chatId: 123 });

      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'peerChanged', peerId: '123' });
    });

    it('stays silent when __tgProxyBridge is not set (non-iframe context)', () => {
      (globalThis as any).__tgProxyBridge = false;

      processOpenChatOrThreadHandler({}, mockActions, { chatId: '123' });

      expect(sendToParentMock).not.toHaveBeenCalled();
    });

    it('stays silent when chatId is absent from the payload', () => {
      processOpenChatOrThreadHandler({}, mockActions, {});

      expect(sendToParentMock).not.toHaveBeenCalled();
    });
  });
});
