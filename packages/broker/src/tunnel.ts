
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
      const port = m.port === undefined ? undefined : Buffer.from([m.port >> 8, m.port & 0xff]);
      ws.send(frame(KIND.open, m.conn, port));
    } else if (m.type === 'tunnel.data') {
      ws.send(frame(KIND.data, m.conn, m.data));
    } else {
      ws.send(frame(KIND.close, m.conn));
    }
  };

  leases.events.on('any', (lease: { id: string; state: string; hostLeaseId?: string }) => {
    if (lease.state === 'ended') {
      const hostId = lease.hostLeaseId ?? lease.id;
      clients.get(hostId)?.close(4000, 'lease ended');
      clients.delete(hostId);
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
    const ports = [...new Set((url.searchParams.get('ports') ?? '').split(',').filter(Boolean).map(Number))];
    if (ports.length > 8 || ports.some((n) => !Number.isInteger(n) || n < 1 || n > 65535)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return true;
    }
    const p = auth.authenticate(db, { authorization: req.headers.authorization ?? (token ? `Bearer ${token}` : undefined), cookie: req.headers.cookie }, Date.now());
    let device: string | null = null;
    try {
      device = p && leases.get(p, leaseId).principalId === p.accountId ? leases.deviceOf(p, leaseId) : null;
    } catch {
      device = null;
    }
    if (!p || !device || !auth.leaseTokenAllows(p, url.pathname)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    const deviceId = device;
    const hostId = leases.hostLeaseId(leases.get(p, leaseId));
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.get(hostId)?.close(4001, 'replaced by a newer tunnel');
      clients.set(hostId, ws);
      void (async () => {
        try {
          const res = await hosts.request(deviceId, (id) => ({ type: 'tunnel.start', id, leaseId: hostId, ports }), 10_000);
          if (!res.ok) {
            ws.close(4002, res.error.message.slice(0, 120));
            return;
          }
          ws.send(JSON.stringify({ type: 'ready', ...(res.result as { port: number; ports?: Record<string, number> }) }));
        } catch (err) {
          ws.close(4002, (err instanceof Error ? err.message : String(err)).slice(0, 120));
        }
      })();

      ws.on('message', (data: Buffer, isBinary) => {
        if (!isBinary || data.length < 5) {
          return;
        }
        const conn = data.readUInt32BE(1);
        if (data[0] === KIND.data) {
          hosts.notify(deviceId, { type: 'tunnel.data', leaseId: hostId, conn, data: data.subarray(5) });
        } else if (data[0] === KIND.close) {
          hosts.notify(deviceId, { type: 'tunnel.close', leaseId: hostId, conn });
        }
      });
      ws.on('close', () => {
        if (clients.get(hostId) === ws) {
          clients.delete(hostId);
          hosts.notify(deviceId, { type: 'tunnel.stop', leaseId: hostId });
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
