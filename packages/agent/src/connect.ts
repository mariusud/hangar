// `hangar join`: this Mac's agent dials out to a broker elsewhere and keeps one WebSocket open
// (decision 0005). Hosts open no port. When the socket drops, the agent keeps its devices and
// leases, reconnects with a growing pause, and says hello again so the broker can match leases.

import { WebSocket } from 'ws';
import { decodeMessage, encodeMessage, type AgentMessage, type BrokerMessage } from '@hangar/protocol';
// What the socket needs from an agent: the iOS Agent and the AndroidAgent both fit.
export type HostAgent = { hello(): Promise<void>; receive(m: BrokerMessage): void; start(): Promise<void>; stop(): Promise<void> };

export type JoinOptions<A extends HostAgent> = {
  url: string;
  token: string;
  log?: (line: string) => void;
  make: (send: (m: AgentMessage) => void, brokerUrl: string) => A;
};

export async function join<A extends HostAgent>(opts: JoinOptions<A>): Promise<{ agent: A; stop: () => Promise<void> }> {
  const log = opts.log ?? console.log;
  const base = opts.url.replace(/\/$/, '');
  let ws: WebSocket | null = null;
  let stopped = false;
  let pause = 1000;

  // Messages sent while the socket is down are dropped; the hello on reconnect resyncs state.
  const agent = opts.make((m) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage(m));
    }
  }, base);

  // Resolves on the first open. Rejects only when the broker refuses the token, which retrying
  // cannot fix; anything else (broker down, network gone) is retried.
  const connect = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const retry = (): void => {
        if (!stopped) {
          setTimeout(() => void connect().then(resolve, reject), pause);
          pause = Math.min(pause * 2, 30_000);
        }
      };
      const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/agent/connect`, { headers: { authorization: `Bearer ${opts.token}` } });
      socket.on('open', () => {
        ws = socket;
        pause = 1000;
        log(`Connected to ${base}`);
        void agent.hello();
        resolve();
      });
      socket.on('message', (raw: Buffer, isBinary) => agent.receive(decodeMessage<BrokerMessage>(raw, isBinary)));
      // ws emits no close after an HTTP answer to the upgrade.
      socket.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          reject(new Error('The broker refused this host token. Make a new one with `hangar join-token` on the broker.'));
          return;
        }
        log(`The broker answered HTTP ${res.statusCode}; retrying.`);
        retry();
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        if (ws === socket) {
          ws = null;
          log(`Lost the connection to ${base}; reconnecting.`);
        }
        retry();
      });
    });

  // The first connection is made before the pool starts, so a wrong URL or token shows at once.
  await connect();
  await agent.start();
  return {
    agent,
    stop: async () => {
      stopped = true;
      await agent.stop();
      ws?.close();
    },
  };
}
