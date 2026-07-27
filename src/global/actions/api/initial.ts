import type { ActionReturnType } from '../../types';
import { ManagementProgress } from '../../../types';

import {
  CUSTOM_BG_CACHE_NAME,
  LANG_CACHE_NAME,
  LOCK_SCREEN_ANIMATION_DURATION_MS,
  MEDIA_CACHE_NAME,
  MEDIA_CACHE_NAME_AVATARS,
  MEDIA_PROGRESSIVE_CACHE_NAME,
} from '../../../config';
import { updateAppBadge } from '../../../util/appBadge';
import { PASSCODE_IDB_STORE } from '../../../util/browser/idb';
import { toCredentialRequestOptions } from '../../../util/browser/passkeys';
import {
  IS_WEBAUTHN_SUPPORTED,
  IS_WEBM_SUPPORTED, MAX_BUFFER_SIZE, PLATFORM_ENV,
} from '../../../util/browser/windowEnvironment';
import * as cacheApi from '../../../util/cacheApi';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { ACCOUNT_SLOT, getAccountsInfo } from '../../../util/multiaccount';
import { unsubscribe } from '../../../util/notifications';
import { clearEncryptedSession, encryptSession, forgetPasscode } from '../../../util/passcode';
import { parseInitialLocationHash, resetInitialLocationHash, resetLocationHash } from '../../../util/routing';
import { pause } from '../../../util/schedulers';
import {
  clearStoredSession,
  loadStoredSession,
  storeSession,
} from '../../../util/sessions';
import { forceWebsync } from '../../../util/websync';
import {
  callApi, callApiLocal, initApi, setShouldEnableDebugLog,
} from '../../../api/gramjs';
import {
  sendToParent,
  onParentMessage,
  requestSessionFromParent,
} from '../../../util/proxyBridge';
import {
  removeGlobalFromCache, removeSharedStateFromCache, serializeGlobal, serializeShared,
} from '../../cache';
import {
  addActionHandler, getActions, getGlobal, setGlobal,
} from '../../index';
import {
  clearGlobalForLockScreen, updateManagementProgress, updatePasscodeSettings,
} from '../../reducers';
import { updateAuth } from '../../reducers/auth';
import { selectChat, selectCurrentChat, selectUser } from '../../selectors';
import { selectSharedSettings } from '../../selectors/sharedState';
import { destroySharedStatePort } from '../../shared/sharedStateConnector';

/** Последний запуск proxy init — для setAccount без повторной регистрации handler */
let lastProxyGramJsInit: (() => Promise<void>) | undefined;

let exclusiveChain = Promise.resolve();

/** Очередь: гонка init vs setAccount недопустима */
function runExclusive(fn: () => Promise<void>): Promise<void> {
  const next = exclusiveChain.then(() => fn());
  exclusiveChain = next.then(() => undefined).catch(() => undefined);
  return next;
}

async function requestSessionWithFallback(): Promise<{
  sessionData: any;
  proxyBase: string;
  deviceModel?: string;
  systemVersion?: string;
}> {
  try {
    return await requestSessionFromParent(10000);
  } catch {
    const r = await fetch('/tg-session', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`tg-session_http_${r.status}`);
    return r.json();
  }
}

if (typeof window !== 'undefined' && (window as any).__tgConfig?.proxyMode) {
  (globalThis as any).__tgProxyBridge = true;
  onParentMessage<{ accountId: string; workspaceId: string }>('setAccount', (msg) => {
    void runExclusive(async () => {
      try {
        // noLogOut=true — КРИТИЧНО: при смене аккаунта нельзя слать auth.LogOut, иначе серверная
        // сессия предыдущего аккаунта инвалидируется (AUTH_KEY_UNREGISTERED при возврате на него).
        // Локальный кэш чистим (noClearLocalDb=false по умолчанию), чтобы данные старого аккаунта
        // не подмешались к новому.
        await callApi('destroy', true);
        if (!lastProxyGramJsInit) {
          throw new Error('proxy_session_not_initialized');
        }
        await lastProxyGramJsInit();
        sendToParent({ type: 'accountChanged', accountId: msg.accountId, ok: true });
      } catch (err: unknown) {
        sendToParent({
          type: 'accountChanged',
          accountId: msg.accountId,
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        });
      }
    });
  });

  onParentMessage<{ peerId: string; username?: string }>('openPeer', (msg) => {
    void (async () => {
      const actions = getActions();
      try {
        // Username резолвится на сервере — работает и для диалога, которого нет
        // в загруженном списке чатов. Для пиров без username остаётся openChat по id.
        if (msg.username) {
          // openChatByUsername — асинхронный action-хендлер (chats.ts): диспетчер
          // (handleAction в teactn.tsx) возвращает реальный Promise, который резолвится
          // только после фактического fetchChatByUsername. Дожидаемся его, иначе
          // сообщим хосту ok:true раньше, чем чат реально открылся (или не открылся).
          await actions.openChatByUsername({ username: msg.username });
          // openChatByUsername не бросает исключение на "user does not exist" — молча
          // делает openPreviousChat + showNotification (chats.ts). Единственный честный
          // способ узнать исход — проверить, что открытым чатом реально стал запрошенный.
          const openedChat = selectCurrentChat(getGlobal());
          const isResolved = Boolean(openedChat?.usernames?.some((u) => u.username === msg.username));
          if (!isResolved) {
            sendToParent({
              type: 'openPeerResult', peerId: msg.peerId, ok: false, reason: 'not_found',
            });
            return;
          }
          sendToParent({ type: 'openPeerResult', peerId: msg.peerId, ok: true });
          return;
        }
        // Гейт намеренно шире, чем «диалог загружен»: родной openChat умеет
        // восстанавливаться сам — при отсутствии чата он берёт selectUser(global, id)
        // и дёргает fetchChat({type:'user'}) (src/global/actions/api/chats.ts:250-259).
        // Пользователи попадают в стейт куда шире диалогов (отправители сообщений,
        // контакты, поиск), поэтому проверка только по selectChat отсекала бы
        // пиров, которые на самом деле открылись бы.
        const global = getGlobal();
        if (!selectChat(global, msg.peerId) && !selectUser(global, msg.peerId)) {
          sendToParent({
            type: 'openPeerResult', peerId: msg.peerId, ok: false, reason: 'chat_not_loaded',
          });
          return;
        }
        actions.openChat({ id: msg.peerId });
        sendToParent({ type: 'openPeerResult', peerId: msg.peerId, ok: true });
      } catch (err: unknown) {
        sendToParent({
          type: 'openPeerResult', peerId: msg.peerId, ok: false, reason: 'error',
        });
      }
    })();
  });
}

// Сообщаем хосту о смене открытого чата. Обработчиков у processOpenChatOrThread
// уже несколько (ui/chats.ts, ui/misc.ts, ui/reactions.ts) — добавляем свой,
// ничего не перехватывая и не меняя UI. Через это действие проходит ЛЮБОЕ
// открытие чата, включая клик по нативному списку: именно этот случай хост
// иначе не видит, и кружок в рейле продолжает гореть.
addActionHandler('processOpenChatOrThread', (global, actions, payload): ActionReturnType => {
  if (!(globalThis as any).__tgProxyBridge) return;
  const { chatId } = payload;
  if (!chatId) return;
  sendToParent({ type: 'peerChanged', peerId: String(chatId) });
});

addActionHandler('initApi', (global, actions): ActionReturnType => {
  const initialLocationHash = parseInitialLocationHash();
  const {
    shouldAllowHttpTransport,
    shouldForceHttpTransport,
    shouldDebugExportedSenders,
    shouldCollectDebugLogs,
    language,
  } = selectSharedSettings(global);

  const hasTestParam = window.location.search.includes('test') || initialLocationHash?.tgWebAuthTest === '1';

  const isTestServer = global.config?.isTestServer;
  const accountsInfo = getAccountsInfo();
  const accountIds = Object.values(accountsInfo)
    .filter((info) => info.isTest === isTestServer)
    .map(({ userId }) => userId)
    .filter(Boolean);

  // Proxy mode: инжектируем sessionData из сервера вместо loadStoredSession()
  const isProxyMode = Boolean((window as any).__tgConfig?.proxyMode);

  const buildGramJsInitArgs = (
    override?: { sessionData?: any; proxyBase?: string; deviceModel?: string; systemVersion?: string },
  ) => ({
    userAgent: navigator.userAgent,
    platform: PLATFORM_ENV,
    sessionData: override?.sessionData ?? loadStoredSession(),
    isWebmSupported: IS_WEBM_SUPPORTED,
    maxBufferSize: MAX_BUFFER_SIZE,
    webAuthToken: initialLocationHash?.tgWebAuthToken,
    dcId: initialLocationHash?.tgWebAuthDcId ? Number(initialLocationHash?.tgWebAuthDcId) : undefined,
    mockScenario: initialLocationHash?.mockScenario,
    shouldAllowHttpTransport,
    shouldForceHttpTransport,
    shouldDebugExportedSenders,
    langCode: language,
    isTestServerRequested: hasTestParam,
    accountIds,
    hasPasskeySupport: IS_WEBAUTHN_SUPPORTED,
    proxyBase: override?.proxyBase,
    deviceModel: override?.deviceModel,
    systemVersion: override?.systemVersion,
  });

  const runProxyGramJsInit = async () => {
    sendToParent({ type: 'tgweb:ready' });
    const sessionPayload = await requestSessionWithFallback();
    await initApi(actions.apiUpdate, buildGramJsInitArgs(sessionPayload));
  };

  lastProxyGramJsInit = runProxyGramJsInit;

  if (isProxyMode) {
    void runExclusive(runProxyGramJsInit);
  } else {
    void initApi(actions.apiUpdate, buildGramJsInitArgs());
  }

  void setShouldEnableDebugLog(Boolean(shouldCollectDebugLogs));
});

addActionHandler('setAuthPhoneNumber', (global, actions, payload): ActionReturnType => {
  const { phoneNumber } = payload;

  void callApi('provideAuthPhoneNumber', phoneNumber.replace(/[^\d]/g, ''));

  return updateAuth(global, {
    isLoading: true,
    errorKey: undefined,
  });
});

addActionHandler('setAuthCode', (global, actions, payload): ActionReturnType => {
  const { code } = payload;

  void callApi('provideAuthCode', code);

  return updateAuth(global, {
    isLoading: true,
    errorKey: undefined,
  });
});

addActionHandler('setAuthPassword', (global, actions, payload): ActionReturnType => {
  const { password } = payload;

  void callApi('provideAuthPassword', password);

  return updateAuth(global, {
    isLoading: true,
    errorKey: undefined,
  });
});

addActionHandler('loginWithPasskey', async (global, actions, payload): Promise<void> => {
  const passkeyOption = global.auth.passkeyOption;
  if (!passkeyOption) return;

  const credential = await navigator.credentials.get(toCredentialRequestOptions(passkeyOption)).catch((e: unknown) => {
    actions.showNotification({
      message: {
        key: 'PasskeyLoginError',
      },
      tabId: getCurrentTabId(),
    });
  });
  if (!credential) return;

  const publicKeyCredential = credential as PublicKeyCredential;
  callApi('restartAuthWithPasskey', publicKeyCredential.toJSON() as AuthenticationResponseJSON);
});

addActionHandler('uploadProfilePhoto', async (global, actions, payload): Promise<void> => {
  const {
    file, isFallback, isVideo, videoTs, bot,
    tabId = getCurrentTabId(),
  } = payload;

  global = updateManagementProgress(global, ManagementProgress.InProgress, tabId);
  setGlobal(global);

  const result = await callApi('uploadProfilePhoto', file, isFallback, isVideo, videoTs, bot);
  if (!result) return;

  global = getGlobal();
  global = updateManagementProgress(global, ManagementProgress.Complete, tabId);
  setGlobal(global);

  const userId = bot?.id ?? global.currentUserId;
  if (!userId) return;

  actions.loadFullUser({ userId });
});

addActionHandler('signUp', (global, actions, payload): ActionReturnType => {
  const { firstName, lastName } = payload;

  void callApi('provideAuthRegistration', { firstName, lastName });

  return updateAuth(global, {
    isLoading: true,
    errorKey: undefined,
  });
});

addActionHandler('returnToAuthPhoneNumber', (global): ActionReturnType => {
  void callApi('restartAuth');

  return updateAuth(global, {
    errorKey: undefined,
  });
});

addActionHandler('goToAuthQrCode', (global): ActionReturnType => {
  void callApi('restartAuthWithQr');

  return updateAuth(global, {
    isLoadingQrCode: true,
    errorKey: undefined,
  });
});

addActionHandler('saveSession', (global, actions, payload): ActionReturnType => {
  if (global.passcode.isScreenLocked) {
    return;
  }

  const { sessionData } = payload;
  if (sessionData) {
    storeSession(sessionData);
  } else {
    clearStoredSession();
  }
});

addActionHandler('signOut', async (global, actions, payload): Promise<void> => {
  if ('hangUp' in actions) actions.hangUp({ tabId: getCurrentTabId() });
  if ('leaveGroupCall' in actions) actions.leaveGroupCall({ tabId: getCurrentTabId() });

  try {
    resetInitialLocationHash();
    resetLocationHash();
    await unsubscribe();
    await Promise.race([callApi('destroy'), pause(3000)]);
    await forceWebsync(false);
  } catch (err) {
    // Do nothing
  }

  actions.reset();

  if (payload?.forceInitApi) {
    actions.initApi();
  }
});

addActionHandler('requestChannelDifference', (global, actions, payload): ActionReturnType => {
  const { chatId } = payload;

  void callApi('requestChannelDifference', chatId);
});

addActionHandler('reset', (global, actions): ActionReturnType => {
  clearStoredSession(ACCOUNT_SLOT);
  clearEncryptedSession();

  void cacheApi.clear(MEDIA_CACHE_NAME);
  void cacheApi.clear(MEDIA_CACHE_NAME_AVATARS);
  void cacheApi.clear(MEDIA_PROGRESSIVE_CACHE_NAME);
  void cacheApi.clear(CUSTOM_BG_CACHE_NAME);

  removeGlobalFromCache();
  destroySharedStatePort();

  // Check if there are any accounts left
  const accounts = getAccountsInfo();
  if (!Object.values(accounts).length) {
    PASSCODE_IDB_STORE.clear();
    removeSharedStateFromCache();
  }

  const langCachePrefix = LANG_CACHE_NAME.replace(/\d+$/, '');
  const langCacheVersion = Number((LANG_CACHE_NAME.match(/\d+$/) || ['0'])[0]);
  for (let i = 0; i < langCacheVersion; i++) {
    void cacheApi.clear(`${langCachePrefix}${i === 0 ? '' : i}`);
  }

  updateAppBadge(0);

  actions.initShared({ force: true });
  Object.values(global.byTabId).forEach(({ id: otherTabId, isMasterTab }) => {
    actions.init({ tabId: otherTabId, isMasterTab });
  });
});

addActionHandler('disconnect', (): ActionReturnType => {
  void callApiLocal('disconnect');
});

addActionHandler('destroyConnection', (): ActionReturnType => {
  void callApiLocal('destroy', true, true);
});

addActionHandler('loadNearestCountry', async (global): Promise<void> => {
  if (global.connectionState !== 'connectionStateReady') {
    return;
  }

  const authNearestCountry = await callApi('fetchNearestCountry');

  global = getGlobal();
  global = updateAuth(global, {
    nearestCountry: authNearestCountry,
  });
  setGlobal(global);
});

addActionHandler('setDeviceToken', (global, actions, payload): ActionReturnType => {
  const { token } = payload;
  return {
    ...global,
    push: {
      deviceToken: token,
      subscribedAt: Date.now(),
    },
  };
});

addActionHandler('deleteDeviceToken', (global): ActionReturnType => {
  return {
    ...global,
    push: undefined,
  };
});

addActionHandler('lockScreen', async (global): Promise<void> => {
  const sessionJson = JSON.stringify({ ...loadStoredSession(), userId: global.currentUserId });
  const globalJson = serializeGlobal(global);
  const sharedStateJson = serializeShared(global.sharedState);

  await encryptSession(sessionJson, globalJson, sharedStateJson);
  forgetPasscode();
  clearStoredSession();
  updateAppBadge(0);

  global = getGlobal();
  global = updatePasscodeSettings(
    global,
    {
      isScreenLocked: true,
      invalidAttemptsCount: 0,
      timeoutUntil: undefined,
    },
  );
  setGlobal(global);

  setTimeout(() => {
    global = getGlobal();
    global = clearGlobalForLockScreen(global);
    setGlobal(global);
  }, LOCK_SCREEN_ANIMATION_DURATION_MS);

  try {
    await unsubscribe();
    await callApi('destroy', true);
  } catch (err) {
    // Do nothing
  }
});
