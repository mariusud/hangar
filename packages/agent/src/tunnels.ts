import { createServer, type Server, type Socket } from 'node:net';
import type { AgentMessage } from '@hangar/protocol';

type Tunnel = { server: Server; port: number; sockets: Map<number, Socket> };

export class Tunnels {
  private tunnels = new Map<string, Tunnel>();
  private send: (m: AgentMessage) => void;

  constructor(send: (m: AgentMessage) => void) {
    this.send = send;
  }

  port(leaseId: string): number | undefined {
    return this.tunnels.get(leaseId)?.port;
  }

  start(id: number, leaseId: string, onOpen?: (port: number) => Promise<void>): void {
    const existing = this.tunnels.get(leaseId);
    if (existing) {
      this.send({ type: 'response', id, ok: true, result: { port: existing.port } });
      return;
    }
    const sockets = new Map<number, Socket>();
    let next = 1;
    const server = createServer((socket) => {
      const conn = next++;
      sockets.set(conn, socket);
      this.send({ type: 'tunnel.open', leaseId, conn });
      socket.on('data', (data) => this.send({ type: 'tunnel.data', leaseId, conn, data }));
      socket.on('error', () => {});
      socket.on('close', () => {
        if (sockets.delete(conn)) {
          this.send({ type: 'tunnel.close', leaseId, conn });
        }
      });
    });
    server.on('error', (err) => this.send({ type: 'response', id, ok: false, error: { code: 'TUNNEL_FAILED', message: err.message } }));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      this.tunnels.set(leaseId, { server, port, sockets });
      void (onOpen?.(port) ?? Promise.resolve()).then(
        () => this.send({ type: 'response', id, ok: true, result: { port } }),
        (err: Error) => this.send({ type: 'response', id, ok: false, error: { code: 'TUNNEL_FAILED', message: err.message } }),
      );
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
    t.server.close();
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
