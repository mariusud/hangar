import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { AgentMessage } from '@hangar/protocol';
import * as auth from './auth.ts';
import { Db } from './db.ts';
import { Hosts, type HostLink } from './hosts.ts';
import { handle, type Ctx } from './http.ts';
import { Leases } from './leases/service.ts';
import { attachStreams } from './stream.ts';

export type { HostLink } from './hosts.ts';
export { ApiError } from './leases/service.ts';

export type BrokerOptions = {
  dataDir: string;
  port: number;
  host?: string;
  publicUrl?: string;
};

export type Broker = {
  server: Server;
  db: Db;
  hosts: Hosts;
  leases: Leases;
  url: string;
  attach(link: HostLink): { message(m: AgentMessage): void; closed(): void };
  welcomeLink(): string;
  close(): Promise<void>;
};

export async function startBroker(opts: BrokerOptions): Promise<Broker> {
  await mkdir(opts.dataDir, { recursive: true });
  const db = new Db(join(opts.dataDir, 'hangar.db'));
  const hosts = new Hosts();
  const leases = new Leases(db, hosts);
  hosts.onChange = () => void leases.tick();

  let url = '';
  const ctx: Ctx = {
    db,
    hosts,
    leases,
    dataDir: opts.dataDir,
    consoleDir: join(import.meta.dirname, '..', '..', 'console', 'src'),
    internalUrl: () => `http://127.0.0.1:${port}`,
    publicUrl: () => opts.publicUrl ?? url,
  };
  const server = createServer((req, res) => void handle(req, res, ctx));
  const closeStreams = attachStreams(server, db, hosts, leases);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  url = opts.publicUrl ?? `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : 'localhost'}:${port}`;

  const timer = setInterval(() => void leases.tick(), 1000);

  return {
    server,
    db,
    hosts,
    leases,
    url,
    attach: (link) => hosts.attach(link),
    // A one-use sign-in link for the first operator. Creates the account on first use of `up`.
    welcomeLink: () => {
      const admin = db.accounts().find((a) => a.role === 'operator') ?? auth.createAccount(db, 'admin', 'operator');
      const code = auth.mintToken(db, 'welcome', { accountId: admin.id, expiresAt: Date.now() + 30 * 60_000 });
      return `${ctx.publicUrl()}/welcome/${code}`;
    },
    close: async () => {
      clearInterval(timer);
      hosts.onChange = () => {};
      leases.stopped = true;
      closeStreams();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.sql.close();
    },
  };
}
