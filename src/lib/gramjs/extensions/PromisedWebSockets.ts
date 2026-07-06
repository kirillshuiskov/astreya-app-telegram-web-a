import { Mutex } from 'async-mutex';

import { concat } from '../../../util/encoding/buffer';

const closeError = new Error('WebSocket was closed');
const CONNECTION_TIMEOUT = 3000;
const MAX_TIMEOUT = 30000;

export default class PromisedWebSockets {
  private readonly mutex = new Mutex();

  private closed: boolean;

  private timeout: number;

  private stream: Uint8Array;

  private canRead?: boolean | Promise<boolean>;

  private resolveRead: ((value?: any) => void) | undefined;

  private client: WebSocket | undefined;

  private website?: string;

  private disconnectedCallback: () => void;

  constructor(disconnectedCallback: () => void) {
    this.client = undefined;
    this.closed = true;
    this.stream = new Uint8Array(0);
    this.disconnectedCallback = disconnectedCallback;
    this.timeout = CONNECTION_TIMEOUT;
  }

  async readExactly(number: number) {
    let readData = new Uint8Array(0);

    while (true) {
      const thisTime = await this.read(number);
      readData = concat(readData, thisTime);
      number -= thisTime.length;
      if (!number) {
        return readData;
      }
    }
  }

  async read(number: number) {
    if (this.closed) {
      throw closeError;
    }
    await this.canRead;
    if (this.closed) {
      throw closeError;
    }
    const toReturn = this.stream.slice(0, number);
    this.stream = this.stream.slice(number);
    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }

    return toReturn;
  }

  async readAll() {
    if (this.closed || !await this.canRead) {
      throw closeError;
    }
    const toReturn = this.stream;
    this.stream = new Uint8Array(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });

    return toReturn;
  }

  private static readonly DC_MAP: Record<string, number> = {
    '149.154.175.50': 1, '149.154.167.50': 2, '149.154.175.100': 3,
    '149.154.167.91': 4, '149.154.171.5': 5,
    '2001:b28:f23d:f001::a': 1, '2001:67c:4e8:f002::a': 2,
    '2001:b28:f23f:f003::a': 3, '2001:67c:4e8:f004::a': 4,
    '2001:b28:f23f:f005::a': 5,
    'zws1.web.telegram.org': 1, 'zws2.web.telegram.org': 2,
    'zws3.web.telegram.org': 3, 'zws4.web.telegram.org': 4,
    'zws5.web.telegram.org': 5,
    'zws1-1.web.telegram.org': 1, 'zws2-1.web.telegram.org': 2,
    'zws3-1.web.telegram.org': 3, 'zws4-1.web.telegram.org': 4,
    'zws5-1.web.telegram.org': 5,
  };

  private static resolveDcId(ip: string): number | undefined {
    const fromMap = PromisedWebSockets.DC_MAP[ip];
    if (fromMap) return fromMap;
    // Fallback для DC-хостов формата zwsN.web.telegram.org и zwsN-1.web.telegram.org (downloadDC).
    // Без него non-home соединения уходили на /tg-proxy/dc2 и ломали auth (-404 / AUTH_BYTES_INVALID).
    const m = String(ip).match(/^zws(\d)(?:-\d)?\.web\.telegram\.org$/);
    return m ? parseInt(m[1], 10) : undefined;
  }

  getWebSocketLink(ip: string, port: number, isTestServer?: boolean, isPremium?: boolean) {
    const proxyBase = (self as any).__tgProxyBase as string | undefined;
    if (proxyBase) {
      const dcId = PromisedWebSockets.resolveDcId(ip) ?? 2;
      // Определяем протокол по контексту воркера: blob:-воркеры смотрят в href родителя.
      // Cookie отправляется браузером автоматически — token в URL не нужен.
      const proto = (() => {
        try {
          const loc = (self as any).location;
          if (!loc) return 'wss:';
          if (loc.protocol === 'blob:') {
            return (loc.href as string).startsWith('blob:https:') ? 'wss:' : 'ws:';
          }
          return loc.protocol === 'https:' ? 'wss:' : 'ws:';
        } catch { return 'wss:'; }
      })();
      return `${proto}//${proxyBase}/tg-proxy/dc${dcId}/apiws`;
    }
    if (port === 443) {
      return `wss://${ip}:${port}/apiws${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
    } else {
      return `ws://${ip}:${port}/apiws${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
    }
  }

  connect(port: number, ip: string, isTestServer = false, isPremium = false) {
    this.stream = new Uint8Array(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    this.closed = false;
    this.website = this.getWebSocketLink(ip, port, isTestServer, isPremium);
    this.client = new WebSocket(this.website, 'binary');
    this.client.binaryType = 'arraybuffer';

    return new Promise((resolve, reject) => {
      if (!this.client) return;
      let hasResolved = false;
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

      this.client.onopen = () => {
        this.receive();
        resolve(this);
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };

      this.client.onerror = (error) => {
        // eslint-disable-next-line no-console
        console.error('WebSocket error', error);
        reject(error);
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };

      this.client.onclose = (event) => {
        const { code, reason, wasClean } = event;
        if (code !== 1000) {
          // eslint-disable-next-line no-console
          console.error(`Socket ${ip} closed. Code: ${code}, reason: ${reason}, was clean: ${wasClean}`);
        }

        this.resolveRead?.(false);
        this.closed = true;
        if (this.disconnectedCallback) {
          this.disconnectedCallback();
        }
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };

      timeout = setTimeout(() => {
        if (hasResolved) return;

        reject(new Error('WebSocket connection timeout'));
        this.resolveRead?.(false);
        this.closed = true;
        if (this.disconnectedCallback) {
          this.disconnectedCallback();
        }
        this.client?.close();
        this.timeout *= 2;
        this.timeout = Math.min(this.timeout, MAX_TIMEOUT);
        timeout = undefined;
      }, this.timeout);

      // CONTEST
      // Seems to not be working, at least in a web worker

      self.addEventListener('offline', () => {
        this.close();
        this.resolveRead?.(false);
      });
    });
  }

  write(data: Uint8Array) {
    if (this.closed) {
      throw closeError;
    }
    this.client?.send(new Uint8Array(data));
  }

  close() {
    this.client?.close();
    this.closed = true;
  }

  receive() {
    if (!this.client) return;
    this.client.onmessage = async (message) => {
      await this.mutex.runExclusive(async () => {
        const data = message.data instanceof ArrayBuffer
          ? new Uint8Array(message.data)
          : new Uint8Array(await new Response(message.data).arrayBuffer());
        this.stream = concat(this.stream, data);
        this.resolveRead?.(true);
      });
    };
  }
}
