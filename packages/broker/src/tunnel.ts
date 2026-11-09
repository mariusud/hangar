
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import * as auth from './auth.ts';
import type { Db } from './db.ts';
import type { Hosts } from './hosts.ts';
import type { Leases } from './leases/service.ts';
import type { Upgrades } from './stream.ts';

const KIND = { open: 1, data: 2, close: 3 } as const;

function frame(kind: number, conn: number, data?: Uint8Array): Buffer {
  const b = Buffer.allocUnsafe(5 + (data?.length ?? 0));
  b[0] = kind;
  b.writeUInt32BE(conn, 1);
  if (data) {
    b.set(data, 5);
  }
  return b;
}

export function attachTunnels(db: Db, hosts: Hosts, leases: Leases): Upgrades {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const clients = new Map<string, WebSocket>();

  hosts.onTunnel = (m) => {
    const ws = clients.get(m.leaseId);
    if (!ws) {
      return;
    }
    if (m.type === 'tunnel.open') {
      ws.send(frame(KIND.open, m.conn));
    } else if (m.type === 'tunnel.data') {
      ws.send(frame(KIND.data, m.conn, m.data));
    } else {
      ws.send(frame(KIND.close, m.conn));
    }
  };

  leases.events.on('any', (lease: { id: string; state: string }) => {
    if (lease.state === 'ended') {
      clients.get(lease.id)?.close(4000, 'lease ended');
      clients.delete(lease.id);
    }
  });

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(req.url ?? '/', 'http://x');
    const match = /^\/v1\/leases\/([^/]+)\/tunnel$/.exec(url.pathname);
    if (!match?.[1]) {
      return false;
    }
    const leaseId = decodeURIComponent(match[1]);
    const token = url.searchParams.get('token');
    const p = auth.authenticate(db, { authorization: req.headers.authorization ?? (token ? `Bearer ${token}` : undefined), cookie: req.headers.cookie }, Date.now());
    let device: string | null = null;
    try {
      device = p && leases.get(p, leaseId).principalId === p.accountId ? leases.deviceOf(p, leaseId) : null;
    } catch {
      device = null;
    }
    if (!p || !device) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    const deviceId = device;
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.get(leaseId)?.close(4001, 'replaced by a newer tunnel');
      clients.set(leaseId, ws);
      hosts
        .request(deviceId, (id) => ({ type: 'tunnel.start', id, leaseId }), 10_000)
        .then((res) => {
          if (!res.ok) {
            ws.close(4002, res.error.message.slice(0, 120));
            return;
          }
          ws.send(JSON.stringify({ type: 'ready', ...(res.result as { port: number }) }));
        })
        .catch((err: Error) => ws.close(4002, err.message.slice(0, 120)));

      ws.on('message', (data: Buffer, isBinary) => {
        if (!isBinary || data.length < 5) {
          return;
        }
        const conn = data.readUInt32BE(1);
        if (data[0] === KIND.data) {
          hosts.notify(deviceId, { type: 'tunnel.data', leaseId, conn, data: data.subarray(5) });
        } else if (data[0] === KIND.close) {
          hosts.notify(deviceId, { type: 'tunnel.close', leaseId, conn });
        }
      });
      ws.on('close', () => {
        if (clients.get(leaseId) === ws) {
          clients.delete(leaseId);
          hosts.notify(deviceId, { type: 'tunnel.stop', leaseId });
        }
      });
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
