import { z } from 'zod';
import type { ToolDeps } from './util.ts';

export function registerLeaseTools({ server, p, db, leases, pick, safe, text }: ToolDeps): void {
  server.registerTool(
    'lease_device',
    {
      description: 'Lease a device for your exclusive use. Waits until one is free. The device is wiped when released. Returns the lease id.',
      inputSchema: {
        platform: z.enum(['ios-simulator', 'android-emulator']).optional().describe('Leave out for any.'),
        model: z.string().optional().describe('For example "iPhone 17". Leave out for any.'),
        os: z.string().optional().describe('For example "26.5". Leave out for any.'),
        image: z.string().optional().describe('A device image by name, with apps and settings already in place. See GET /v1/images.'),
        ttlSeconds: z.number().positive().optional().describe('Ends unless renewed within this time. Leave out to end only when idle or at the longest-lease limit.'),
        idleSeconds: z.number().positive().optional().describe('Ends after this long without a device action or keepalive. Leave out for the most your token allows.'),
        maxSeconds: z.number().positive().optional().describe('Ends this long after it starts, whatever happens. Leave out for the most your token allows.'),
        purpose: z.string().max(80).optional().describe('What you will do on the device, in a few words, such as "check the login flow". People watching the fleet see it.'),
      },
    },
    ({ platform, model, os, image, ttlSeconds, idleSeconds, maxSeconds, purpose }) =>
      safe(async () => {
        const lease = leases.create(
          p,
          { ...(platform ? { platform } : {}), ...(model ? { model } : {}), ...(os ? { os } : {}), ...(image ? { image } : {}) },
          { ttlSeconds: ttlSeconds ?? null, ...(idleSeconds ? { idleSeconds } : {}), ...(maxSeconds ? { maxSeconds } : {}), via: purpose ? `MCP: ${purpose}` : 'MCP' },
        );
        const until = Date.now() + 120_000;
        let current = lease;
        while (current.state === 'queued' || current.state === 'preparing') {
          if (Date.now() > until) {
            return text({ leaseId: lease.id, state: current.state, note: 'Still waiting for a device. Call get_lease to check.' });
          }
          await new Promise((r) => setTimeout(r, 500));
          current = leases.get(p, lease.id);
        }
        return text({ leaseId: lease.id, ...leases.view(current) });
      }),
  );

  server.registerTool(
    'release_device',
    { description: 'Release a lease. The device is wiped and goes back to the pool.', inputSchema: { leaseId: z.string().optional() } },
    ({ leaseId }) => safe(async () => text(leases.view(leases.release(p, pick(leaseId))))),
  );

  server.registerTool(
    'renew_lease',
    { description: 'Keep a lease alive for another ttlSeconds (default: the lease TTL).', inputSchema: { leaseId: z.string().optional(), ttlSeconds: z.number().optional() } },
    ({ leaseId, ttlSeconds }) => safe(async () => text(leases.view(leases.renew(p, pick(leaseId), ttlSeconds)))),
  );

  server.registerTool(
    'keepalive',
    {
      description: 'Tell Hangar you are still using the device without touching it, for example while you think or wait for a build. Counts as activity, so the lease does not end as idle.',
      inputSchema: { leaseId: z.string().optional() },
    },
    ({ leaseId }) => safe(async () => text(leases.view(leases.keepalive(p, pick(leaseId))))),
  );

  server.registerTool(
    'reattach_lease',
    {
      description: 'Pick up a lease again after a restart or a lost connection, with the same token that made it. Call list_leases to find its id.',
      inputSchema: { leaseId: z.string() },
    },
    ({ leaseId }) => safe(async () => text(leases.view(leases.reattach(p, leaseId)))),
  );

  server.registerTool(
    'list_leases',
    { description: 'Your recent leases and their states.', inputSchema: {} },
    () => safe(async () => text(db.leasesOf(p.accountId, 20).map((l) => leases.view(l)))),
  );
}
