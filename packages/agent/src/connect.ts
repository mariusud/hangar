import { WebSocket } from 'ws';
import { decodeMessage, encodeMessage, type AgentMessage, type BrokerMessage } from '@devicepool/protocol';
export type HostAgent = { hello(): Promise<void>; receive(m: BrokerMessage): void; start(): Promise<void>; stop(): Promise<void>; endOverdue?(now: number, graceMs: number): void };

export const GRACE_MS = 60_000;

export function overdue(deadlines: Map<string, number>, now: number, graceMs: number = GRACE_MS): string[] {
  return [...deadlines].filter(([, deadline]) => now > deadline + graceMs).map(([leaseId]) => leaseId);
}

export function brokerAddress(url: string): string {
  const isFull = /^https?:\/\/[^/]/i.test(url) && URL.canParse(url);
  if (!isFull) {
    throw new Error(`Use a full address such as http://studio-mini.local:7420 (you gave "${url}").`);
  }
  return url.replace(/\/$/, '');
}

export function reasonOf(err: unknown): string {
  const code = err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null;
  const known: Record<string, string> = { ECONNREFUSED: 'connection refused', ENOTFOUND: 'no such host', EAI_AGAIN: 'no such host', ETIMEDOUT: 'timed out', EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable', ECONNRESET: 'connection reset' };
  const reason = code ? known[code] : undefined;
  if (reason) {
    return reason;
  }
  return err instanceof Error && err.message ? err.message : 'unknown error';
}

export const NOTICE_INTERVAL_MS = 60_000;

export function retryNotifier(log: (line: string) => void, now: () => number, intervalMs: number = NOTICE_INTERVAL_MS): { notice: (url: string, reason: string) => void; reset: () => void } {
  let last: number | null = null;
  return {
    notice: (url, reason) => {
      const at = now();
      if (last === null || at - last >= intervalMs) {
        last = at;
        log(`Cannot reach ${url} (${reason}). Trying again.`);
      }
    },
    reset: () => {
      last = null;
    },
  };
}

export type JoinOptions<A extends HostAgent> = {
  url: string;
  token: string;
  log?: (line: string) => void;
  now?: () => number;
  make: (send: (m: AgentMessage) => void, brokerUrl: string) => A;
};

export async function join<A extends HostAgent>(opts: JoinOptions<A>): Promise<{ agent: A; stop: () => Promise<void> }> {
  const log = opts.log ?? console.log;
  const base = brokerAddress(opts.url);
  let ws: WebSocket | null = null;
  let isStopped = false;
  let pause = 1000;
  let isOffline = false;
  const now = opts.now ?? Date.now;
  const retries = retryNotifier(log, now);

  const agent = opts.make((m) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage(m));
    }
  }, base);

  const connect = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const retry = (): void => {
        if (!isStopped) {
          setTimeout(() => void connect().then(resolve, reject), pause);
          pause = Math.min(pause * 2, 30_000);
        }
      };
      const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/agent/connect`, { headers: { authorization: `Bearer ${opts.token}` } });
      socket.on('open', () => {
        ws = socket;
        pause = 1000;
        isOffline = false;
        retries.reset();
        log(`Connected to ${base}`);
        void agent.hello();
        resolve();
      });
      socket.on('message', (raw: Buffer, isBinary) => agent.receive(decodeMessage<BrokerMessage>(raw, isBinary)));
      // ws emits no close after an HTTP answer to the upgrade.
      socket.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          reject(new Error('The broker refused this host token. Make a new one with `devicepool join-token` on the broker.'));
          return;
        }
        retries.notice(base, `the broker answered HTTP ${res.statusCode}`);
        retry();
      });
      socket.on('error', (err) => retries.notice(base, reasonOf(err)));
      socket.on('close', () => {
        if (ws === socket) {
          ws = null;
          isOffline = true;
          log(`Lost the connection to ${base}; reconnecting.`);
        }
        retry();
      });
    });

  await connect();
  await agent.start();
  const watchdog = setInterval(() => {
    if (isOffline) {
      agent.endOverdue?.(now(), GRACE_MS);
    }
  }, 5000);
  watchdog.unref();
  return {
    agent,
    stop: async () => {
      isStopped = true;
      clearInterval(watchdog);
      await agent.stop();
      ws?.close();
    },
  };
}
