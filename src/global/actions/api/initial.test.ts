import {
  beforeAll, beforeEach, describe, expect, it, vi,
} from 'vitest';

// `initial.ts` тянет за собой большой кусок зависимостей приложения (GramJS worker
// connector, IndexedDB-стор, BroadcastChannel-бухгалтерия мультиаккаунта и т.п.)
// через модули, которые ни разу не вызываются при импорте для двух хендлеров,
// проверяемых здесь (`openPeer`, `processOpenChatOrThread`). Ни одна из этих машин
// в тесте не задействуется — `addActionHandler`/`onParentMessage` замоканы так,
// чтобы только *регистрировать* хендлеры, их реальные тела не выполняются.
// Мокаем каждый прямой импорт на этом шве — тест остаётся изолированным и
// детерминированным, продакшен-код не трогаем.
vi.mock('../../../types', () => ({ ManagementProgress: { Idle: 0, InProgress: 1, Complete: 2 } }));
vi.mock('../../../config', () => ({
  CUSTOM_BG_CACHE_NAME: 'custom-bg',
  LANG_CACHE_NAME: 'lang0',
  LOCK_SCREEN_ANIMATION_DURATION_MS: 0,
  MEDIA_CACHE_NAME: 'media',
  MEDIA_CACHE_NAME_AVATARS: 'media-avatars',
  MEDIA_PROGRESSIVE_CACHE_NAME: 'media-progressive',
  TMP_CHAT_ID: '0',
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

// Управляемые швы: протокол моста, поверхность диспетчера экшенов и три
// селектора, которые использует хендлер `openPeer`.
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
  let mockActions: {
    openChatByUsername: ReturnType<typeof vi.fn>;
    openChat: ReturnType<typeof vi.fn>;
    setSharedSettingOption: ReturnType<typeof vi.fn>;
  };

  let openPeerHandler: (msg: OpenPeerMsg) => void;
  let setThemeHandler: (msg: { theme?: unknown }) => void;
  let processOpenChatOrThreadHandler: ActionHandler;

  beforeAll(async () => {
    // Модульный гейт `if (... __tgConfig?.proxyMode)` в initial.ts должен увидеть
    // это до вычисления модуля — точно так же, как реальный host выставляет __tgConfig.
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
      setSharedSettingOption: vi.fn(),
    };
    (globalIndex.getActions as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockActions);

    // Импорт тестируемого модуля запускает его регистрацию верхнего уровня,
    // которую мы перехватили выше через замоканные addActionHandler/onParentMessage.
    await import('./initial');

    const openPeerCall = onParentMessageMock.mock.calls.find((call: any[]) => call[0] === 'openPeer');
    if (!openPeerCall) throw new Error('openPeer handler was not registered');
    openPeerHandler = openPeerCall[1];

    const setThemeCall = onParentMessageMock.mock.calls.find((call: any[]) => call[0] === 'setTheme');
    if (!setThemeCall) throw new Error('setTheme handler was not registered');
    setThemeHandler = setThemeCall[1];

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
    mockActions.setSharedSettingOption.mockClear();
    (globalThis as any).__tgProxyBridge = true;
  });

  describe('setTheme', () => {
    // Тема форка и тема хоста живут в разных документах: хост вешает класс на свой
    // <html>, форк — на свой, и по умолчанию форк слушает СИСТЕМУ
    // (shouldUseSystemTheme: true в initialState). Пока хост не диктует тему явно,
    // iframe остаётся светлым при тёмном приложении просто потому, что светлая
    // тема стоит в ОС.
    it('применяет тему хоста и снимает следование системной', () => {
      setThemeHandler({ theme: 'dark' });

      expect(mockActions.setSharedSettingOption).toHaveBeenCalledWith({
        theme: 'dark',
        shouldUseSystemTheme: false,
      });
    });

    it('принимает light так же явно, как dark', () => {
      setThemeHandler({ theme: 'light' });

      expect(mockActions.setSharedSettingOption).toHaveBeenCalledWith({
        theme: 'light',
        shouldUseSystemTheme: false,
      });
    });

    it('игнорирует неизвестное значение темы, не трогая настройки', () => {
      // Мост — публичная postMessage-поверхность: соседняя вкладка того же origin
      // может прислать что угодно. Мусор не должен попадать в shared settings, откуда
      // он уедет в кэш и переживёт перезагрузку.
      setThemeHandler({ theme: 'sepia' });
      setThemeHandler({});

      expect(mockActions.setSharedSettingOption).not.toHaveBeenCalled();
    });
  });

  describe('openPeer', () => {
    it('ветка username: резолвится и репортит ok:true только когда чат реально открыт', async () => {
      selectCurrentChatMock.mockReturnValue({ id: '42', usernames: [{ username: 'ivan' }] });

      openPeerHandler({ peerId: '42', username: 'ivan' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(mockActions.openChatByUsername).toHaveBeenCalledWith({ username: 'ivan' });
      expect(sendToParentMock).toHaveBeenCalledTimes(1);
      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'openPeerResult', peerId: '42', ok: true });
    });

    it('ветка username: сравнение регистронезависимое — открытый чат матчится с иным регистром username', async () => {
      // Telegram-юзернеймы регистронезависимы (selectChatByUsername, isCurrentChat
      // в самом openChatByUsername, chats.ts); хост хранит юзернейм лида как ввели,
      // без нормализации регистра. Без учёта регистра успешно открытый чат
      // репортился бы как not_found из-за одной буквы (см. финальное ревью, Finding 1).
      selectCurrentChatMock.mockReturnValue({ id: '42', usernames: [{ username: 'Ivan_Petrov' }] });

      openPeerHandler({ peerId: '42', username: 'ivan_petrov' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'openPeerResult', peerId: '42', ok: true });
    });

    it('ветка username: нерезолвящийся username НЕ репортит ok:true (Finding 1 предыдущего раунда)', async () => {
      // Реальное поведение openChatByUsername при "user does not exist": исключение
      // не бросается — тихий фолбэк на openPreviousChat + уведомление (chats.ts).
      // Единственный честный сигнал — реально ли открытый чат совпадает с запрошенным
      // username после того, как await устоялся.
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

    it('ветка username: полностью пустой текущий чат тоже НЕ репортит ok:true', async () => {
      mockActions.openChatByUsername.mockResolvedValue(undefined);
      selectCurrentChatMock.mockReturnValue(undefined);

      openPeerHandler({ peerId: '42', username: 'ghost' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(sendToParentMock).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('ветка id: известный чат открывается через openChat и репортит ok:true', async () => {
      selectChatMock.mockReturnValue({ id: '42' });
      selectUserMock.mockReturnValue(undefined);

      openPeerHandler({ peerId: '42' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(mockActions.openChat).toHaveBeenCalledWith({ id: '42' });
      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'openPeerResult', peerId: '42', ok: true });
    });

    it('ветка id: чата нет, но пользователь известен — всё равно открывается и репортит ok:true (расширенный гейт)', async () => {
      // openChat умеет восстанавливаться сам, когда чат ещё не загружен, но
      // пользователь уже известен: берёт selectUser + fetchChat({type:'user'})
      // (chats.ts:250-259). Пользователи в стейте встречаются гораздо чаще чатов
      // (отправители сообщений, контакты, поиск), поэтому гейт не должен отсекать
      // по одному только selectChat.
      selectChatMock.mockReturnValue(undefined);
      selectUserMock.mockReturnValue({ id: '42' });

      openPeerHandler({ peerId: '42' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(mockActions.openChat).toHaveBeenCalledWith({ id: '42' });
      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'openPeerResult', peerId: '42', ok: true });
    });

    it('ветка id: и чат, и пользователь отсутствуют — chat_not_loaded, openChat не вызывается', async () => {
      selectChatMock.mockReturnValue(undefined);
      selectUserMock.mockReturnValue(undefined);

      openPeerHandler({ peerId: '99' });

      await vi.waitFor(() => expect(sendToParentMock).toHaveBeenCalled());

      expect(mockActions.openChat).not.toHaveBeenCalled();
      expect(sendToParentMock).toHaveBeenCalledWith({
        type: 'openPeerResult', peerId: '99', ok: false, reason: 'chat_not_loaded',
      });
    });

    it('catch-путь: исключение при открытии чата репортит reason:error', async () => {
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
    it('эмитит peerChanged с chatId, приведённым к строке', () => {
      processOpenChatOrThreadHandler({}, mockActions, { chatId: 123 });

      expect(sendToParentMock).toHaveBeenCalledWith({ type: 'peerChanged', peerId: '123' });
    });

    it('молчит, если __tgProxyBridge не выставлен (контекст не iframe)', () => {
      (globalThis as any).__tgProxyBridge = false;

      processOpenChatOrThreadHandler({}, mockActions, { chatId: '123' });

      expect(sendToParentMock).not.toHaveBeenCalled();
    });

    it('молчит, если chatId отсутствует в payload', () => {
      processOpenChatOrThreadHandler({}, mockActions, {});

      expect(sendToParentMock).not.toHaveBeenCalled();
    });

    it('молчит на плейсхолдере TMP_CHAT_ID (Finding 2 финального ревью)', () => {
      // openChatByUsername синхронно открывает временный пустой чат с id=TMP_CHAT_ID
      // ('0'), чтобы UI не «подвисал» до резолва реального пира (chats.ts:3878).
      // Этот TMP-open тоже идёт через processOpenChatOrThread — без фильтра свой же
      // openPeer(username) слал бы хосту фиктивный peerChanged('0') перед настоящим.
      // Родной openChat фильтрует эту же константу (chats.ts:236).
      processOpenChatOrThreadHandler({}, mockActions, { chatId: '0' });

      expect(sendToParentMock).not.toHaveBeenCalled();
    });
  });
});
