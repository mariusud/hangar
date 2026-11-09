
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { decodeMessage, encodeMessage, type AgentMessage } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db } from './db.ts';
import type { Hosts } from './hosts.ts';
import type { Upgrades } from './stream.ts';

export function attachAgents(db: Db, hosts: Hosts): Upgrades {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/v1/agent/connect') {
      return false;
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const token = auth.lookupToken(db, bearer, Date.now());
    if (token?.kind !== 'host') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\nThis host token is not valid. Make a new one with `hangar join-token` on the broker.');
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handlers = hosts.attach({ send: (m) => ws.send(encodeMessage(m)), close: () => ws.close() });
      ws.on('message', (raw: Buffer, isBinary) => {
        let m: AgentMessage;
        try {
          m = decodeMessage<AgentMessage>(raw, isBinary);
        } catch {
          return;
        }
        handlers.message(m);
      });
      ws.on('close', () => handlers.closed());
      let alive = true;
      ws.on('pong', () => (alive = true));
      const ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 15_000);
      ws.on('close', () => clearInterval(ping));
    });
    return true;
  };

  return {
    upgrade,
    close: () => {
      for (const ws of wss.clients) {
        ws.terminate();
      }
    },
  };
}
