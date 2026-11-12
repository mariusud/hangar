import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { AgentMessage } from '@hangar/protocol';
import * as auth from './auth.ts';
import { Db } from './db.ts';
import { Hosts, type HostLink } from './hosts.ts';
import { imagesMessage, sealStoredSecrets } from './images.ts';
import { handle, type Ctx } from './http.ts';
import { Leases } from './leases/service.ts';
import { Metrics } from './metrics.ts';
import { Recordings } from './recordings.ts';
import { Runs } from './runs.ts';
import { closeWindowNight } from './reports.ts';
import { onWindowClosed } from './schedule.ts';
import { Store, type S3Config } from './store.ts';
import { Oidc, type OidcConfig } from './oidc.ts';
import { attachAgents } from './agents.ts';
import { attachStreams } from './stream.ts';
import { attachTunnels } from './tunnel.ts';

export type { HostLink } from './hosts.ts';
export { ApiError } from './leases/service.ts';
export { Db } from './db.ts';
export { oidcFromEnv, type OidcConfig } from './oidc.ts';
export { s3FromEnv, type S3Config } from './store.ts';

export function mintHostToken(db: Db): string {
  return auth.mintToken(db, 'host', { label: 'join' });
}

export type BrokerOptions = {
  dataDir: string;
  port: number;
  host?: string;
  publicUrl?: string;
  oidc?: OidcConfig;
  s3?: S3Config;
};

export type Broker = {
  server: Server;
  db: Db;
  hosts: Hosts;
  leases: Leases;
  url: string;
  attach(link: HostLink): { message(m: AgentMessage): void; closed(): void };
  welcomeLink(): string;
  adminToken(label: string): string;
  joinToken(): string;
  close(): Promise<void>;
};

export async function startBroker(opts: BrokerOptions): Promise<Broker> {
  await mkdir(opts.dataDir, { recursive: true });
  const db = new Db(join(opts.dataDir, 'hangar.db'));
  sealStoredSecrets(db);
  const hosts = new Hosts();
  const leases = new Leases(db, hosts);
  hosts.onChange = () => void leases.tick();
  const stopNights = onWindowClosed((w) => void closeWindowNight(db, w));
  hosts.onHello = (held, link) => {
    for (const leaseId of held) {
      const lease = db.getLease(leaseId);
      // A held device sits on its run lease, which has ended; the hold decides when it is wiped.
      const isHeld = db.holds().some((h) => h.hostLeaseId === leaseId);
      if (!isHeld && (!lease || lease.state === 'ended')) {
        link.send({ type: 'lease.end', leaseId });
      }
    }
    link.send(imagesMessage(db, internalUrl()));
  };

  let url = '';
  let port = opts.port;
  // Paths agents fetch from go out without a host; each agent resolves them against the address it reached the broker at.
  const internalUrl = (): string => '';
  const store = new Store(opts.dataDir, opts.s3);
  const recordings = new Recordings(db, leases, store, internalUrl);
  const metrics = new Metrics(db, hosts, leases);
  const publicUrl = (): string => opts.publicUrl ?? url;
  const runs = new Runs(db, leases, recordings, internalUrl, publicUrl);
  const ctx: Ctx = {
    db,
    hosts,
    leases,
    recordings,
    runs,
    store,
    oidc: opts.oidc ? new Oidc(opts.oidc) : null,
    metrics,
    publishImages: () => hosts.broadcast(() => imagesMessage(db, internalUrl())),
    dataDir: opts.dataDir,
    consoleDir: join(import.meta.dirname, '..', '..', 'console', 'src'),
    internalUrl,
    publicUrl,
  };
  const server = createServer((req, res) => void handle(req, res, ctx));
  const upgrades = [attachStreams(db, hosts, leases, metrics), attachTunnels(db, hosts, leases), attachAgents(db, hosts)];
  server.on('upgrade', (req, socket, head) => {
    if (!upgrades.some((u) => u.upgrade(req, socket, head))) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', resolve);
  });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : opts.port;
  url = opts.publicUrl ?? `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : 'localhost'}:${port}`;

  const timer = setInterval(() => void leases.tick(), 1000);
  const sweep = (): void => void recordings.sweep().catch((err: Error) => console.error(`Recording cleanup failed: ${err.message}`));
  sweep();
  const sweeper = setInterval(sweep, 3600_000);

  return {
    server,
    db,
    hosts,
    leases,
    url,
    attach: (link) => hosts.attach(link),
    joinToken: () => mintHostToken(db),
    adminToken: (label) => {
      const admin = db.accounts().find((a) => a.role === 'operator') ?? auth.createAccount(db, 'admin', 'operator');
      return auth.mintToken(db, 'member', { accountId: admin.id, label, scopes: ['operator', 'install:upload'] });
    },
    welcomeLink: () => {
      const admin = db.accounts().find((a) => a.role === 'operator') ?? auth.createAccount(db, 'admin', 'operator');
      const code = auth.mintToken(db, 'welcome', { accountId: admin.id, expiresAt: Date.now() + 30 * 60_000 });
      return `${ctx.publicUrl()}/welcome/${code}`;
    },
    close: async () => {
      clearInterval(timer);
      clearInterval(sweeper);
      stopNights();
      hosts.onChange = () => {};
      leases.stopped = true;
      for (const u of upgrades) {
        u.close();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.sql.close();
    },
  };
}
