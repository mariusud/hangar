import { createServer, type Server, type Socket } from 'node:net';
import type { AgentMessage } from '@devicepool/protocol';

type Tunnel = { servers: Server[]; port: number; ports: Record<string, number>; sockets: Map<number, Socket> };

export class Tunnels {
  private tunnels = new Map<string, Tunnel>();
  private send: (m: AgentMessage) => void;

  constructor(send: (m: AgentMessage) => void) {
    this.send = send;
  }

  port(leaseId: string): number | undefined {
    return this.tunnels.get(leaseId)?.port;
  }

  start(id: number, leaseId: string, ports: number[] = [], onOpen?: (port: number, extra: Record<string, number>) => Promise<void>): void {
    const existing = this.tunnels.get(leaseId);
    if (existing) {
      this.send({ type: 'response', id, ok: true, result: { port: existing.port, ports: existing.ports } });
      return;
    }
    const sockets = new Map<number, Socket>();
    const servers: Server[] = [];
    let next = 1;
    const listen = (target: number | undefined, wanted: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const server = createServer((socket) => {
          const conn = next++;
          sockets.set(conn, socket);
          this.send(target === undefined ? { type: 'tunnel.open', leaseId, conn } : { type: 'tunnel.open', leaseId, conn, port: target });
          socket.on('data', (data) => this.send({ type: 'tunnel.data', leaseId, conn, data }));
          socket.on('error', () => {});
          socket.on('close', () => {
            if (sockets.delete(conn)) {
              this.send({ type: 'tunnel.close', leaseId, conn });
            }
          });
        });
        servers.push(server);
        const bound = (): void => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : 0);
        };
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && wanted !== 0) {
            server.listen(0, '127.0.0.1', bound);
            return;
          }
          reject(err);
        });
        server.listen(wanted, '127.0.0.1', bound);
      });
    void (async () => {
      const port = await listen(undefined, 0);
      const extra: Record<string, number> = {};
      for (const p of ports) {
        extra[String(p)] = await listen(p, p);
      }
      await (onOpen?.(port, extra) ?? Promise.resolve());
      this.tunnels.set(leaseId, { servers, port, ports: extra, sockets });
      this.send({ type: 'response', id, ok: true, result: { port, ports: extra } });
    })().catch((err: Error) => {
      for (const server of servers) {
        server.close();
      }
      this.send({ type: 'response', id, ok: false, error: { code: 'TUNNEL_FAILED', message: err.message } });
    });
  }

  data(leaseId: string, conn: number, data: Uint8Array): void {
    this.tunnels.get(leaseId)?.sockets.get(conn)?.write(data);
  }

  close(leaseId: string, conn: number): void {
    this.tunnels.get(leaseId)?.sockets.get(conn)?.destroy();
  }

  stop(leaseId: string): void {
    const t = this.tunnels.get(leaseId);
    if (!t) {
      return;
    }
    this.tunnels.delete(leaseId);
    for (const server of t.servers) {
      server.close();
    }
    for (const socket of t.sockets.values()) {
      socket.destroy();
    }
    t.sockets.clear();
  }

  stopAll(): void {
    for (const leaseId of [...this.tunnels.keys()]) {
      this.stop(leaseId);
    }
  }
}
