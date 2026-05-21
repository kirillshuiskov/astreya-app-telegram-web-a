import { sendToParent } from '../../../util/proxyBridge';

export type LoggerLevel = 'error' | 'warn' | 'info' | 'debug';

let _level: LoggerLevel;

const BRIDGE_BUFFER_CAP = 200;
const BRIDGE_FLUSH_MS = 5000;

/** Не отправляем в host чувствительные MTProto данные */
function sanitizeForBridge(message: string): string | null {
  const m = message.trim();
  if (!m) return null;
  const lower = m.toLowerCase();
  if (/auth[_\s-]?key|server_salt|encrypted\s+messages?\s+put/i.test(lower)) return null;
  if (/[0-9a-f]{48,}/i.test(m)) return null;
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
}

function extractDcId(message: string): number | undefined {
  const patterns = [
    /for dc\s+(\d+)/i,
    /dc\s*[=:]\s*(\d+)/i,
    /dcid=(\d+)/i,
    /\bdc\s+(\d+)\b/i,
  ];
  for (const re of patterns) {
    const x = message.match(re);
    if (x) return Number(x[1]);
  }
  return undefined;
}

type ColorKey = LoggerLevel | 'start' | 'end';

export default class Logger {
  private static bridgeBuffer: Array<{ level: 'info' | 'warn' | 'error'; message: string; dcId?: number; ts: number }> = [];

  private static bridgeFlushTimer: ReturnType<typeof setInterval> | undefined;

  static LEVEL_MAP = new Map<LoggerLevel, Set<LoggerLevel>>([
    ['error', new Set(['error'])],
    ['warn', new Set(['error', 'warn'])],
    ['info', new Set(['error', 'warn', 'info'])],
    ['debug', new Set(['error', 'warn', 'info', 'debug'])],
  ]);

  colors: Record<ColorKey, string>;

  messageFormat: string;

  constructor(level?: LoggerLevel) {
    if (!_level) {
      _level = level || 'debug';
    }

    this.colors = {
      start: '%c',
      warn: 'color : #ff00ff',
      info: 'color : #ffff00',
      debug: 'color : #00ffff',
      error: 'color : #ff0000',
      end: '',
    };
    this.messageFormat = '[%t] [%l] - [%m]';
  }

  static setLevel(level: LoggerLevel) {
    _level = level;
  }

  private static ensureBridgeFlushInterval() {
    if (Logger.bridgeFlushTimer !== undefined) return;
    if (typeof self === 'undefined' || !(self as unknown as { __tgProxyBridge?: boolean }).__tgProxyBridge) {
      return;
    }
    Logger.bridgeFlushTimer = setInterval(() => Logger.flushBridgeBuffer(), BRIDGE_FLUSH_MS);
  }

  private static pushBridgeRecord(level: 'info' | 'warn' | 'error', rawMessage: string) {
    if (typeof self === 'undefined' || !(self as unknown as { __tgProxyBridge?: boolean }).__tgProxyBridge) {
      return;
    }
    const message = sanitizeForBridge(rawMessage);
    if (!message) return;
    const dcId = extractDcId(rawMessage);
    Logger.bridgeBuffer.push({ level, message, dcId, ts: Date.now() });
    while (Logger.bridgeBuffer.length > BRIDGE_BUFFER_CAP) {
      Logger.bridgeBuffer.shift();
    }
    Logger.ensureBridgeFlushInterval();
  }

  static flushBridgeBuffer() {
    if (!Logger.bridgeBuffer.length) return;
    const logs = Logger.bridgeBuffer.splice(0, Logger.bridgeBuffer.length);
    sendToParent({ type: 'mtprotoSenderLogs', logs });
  }

  canSend(level: LoggerLevel) {
    if (!_level) return false;
    return Logger.LEVEL_MAP.get(_level)!.has(level);
  }

  warn(message: string) {
    this._log('warn', message, this.colors.warn);
  }

  info(message: string) {
    this._log('info', message, this.colors.info);
  }

  debug(message: string) {
    this._log('debug', message, this.colors.debug);
  }

  error(message: string) {
    this._log('error', message, this.colors.error);
  }

  format(message: string, level: LoggerLevel) {
    return this.messageFormat.replace('%t', new Date().toISOString())
      .replace('%l', level.toUpperCase())
      .replace('%m', message);
  }

  _log(level: LoggerLevel, message: string, color: string) {
    if (!_level) {
      return;
    }
    if (this.canSend(level)) {
      // eslint-disable-next-line no-console
      console.log(this.colors.start + this.format(message, level), color);
    }
    // В телеметрию только заметные уровни (без debug — шум)
    if (level === 'info' || level === 'warn' || level === 'error') {
      Logger.pushBridgeRecord(level, message);
    }
  }
}
