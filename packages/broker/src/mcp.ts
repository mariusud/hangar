// Remote MCP over streamable HTTP. Stateless: each request authenticates and gets a server bound
// to the caller. Tools are thin wrappers over the same lease service the REST API uses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Action, UiNode } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db } from './db.ts';
import { ApiError, type Leases } from './leases/service.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).describe('[x, y] as fractions of the screen, 0 to 1');
const selector = z
  .object({
    label: z.string().optional(),
    identifier: z.string().optional(),
    role: z.string().optional(),
    exact: z.boolean().optional(),
  })
  .describe('Match an element by label (substring unless exact), accessibility identifier, or role');
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), point: point.optional(), element: selector.optional() }),
  z.object({ type: z.literal('longPress'), point, durationMs: z.number().optional() }),
  z.object({ type: z.literal('swipe'), from: point, to: point, durationMs: z.number().optional() }),
  z.object({ type: z.literal('type'), text: z.string() }),
  z.object({ type: z.literal('key'), key: z.string().describe('return, backspace, tab, escape, up, down, left, right') }),
  z.object({ type: z.literal('button'), button: z.enum(['home', 'lock', 'siri']) }),
  z.object({ type: z.literal('waitFor'), element: selector, gone: z.boolean().optional(), timeoutMs: z.number().optional() }),
]);

export async function handleMcp(req: IncomingMessage, res: ServerResponse, db: Db, leases: Leases, internalUrl: string): Promise<void> {
  const p = auth.authenticate(db, { authorization: req.headers.authorization, cookie: req.headers.cookie }, Date.now());
  if (!p) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Pass Authorization: Bearer <token>. Make a token in the console under Connect.' } }));
    return;
  }
  const server = buildServer(p, db, leases, internalUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function buildServer(p: auth.Principal, db: Db, leases: Leases, internalUrl: string): McpServer {
  const server = new McpServer({ name: 'hangar', version: '0.0.0' });

  // Tools that act on a device accept leaseId, and fall back to the caller's only active lease.
  const pick = (leaseId?: string): string => {
    if (leaseId) {
      return leaseId;
    }
    const active = db.leasesOf(p.accountId).filter((l) => l.state === 'active');
    if (active.length === 1 && active[0]) {
      return active[0].id;
    }
    throw new ApiError(400, 'LEASE_REQUIRED', active.length ? 'You hold several devices. Pass leaseId.' : 'You hold no device. Call lease_device first.');
  };

  const safe = async (fn: () => Promise<Result>): Promise<Result> => {
    try {
      return await fn();
    } catch (err) {
      const e = err instanceof ApiError ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: e }], isError: true };
    }
  };
  const text = (value: unknown): Result => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

  const observe = async (id: string): Promise<Result> => {
    const ui = (await leases.op(p, id, { op: 'describe' })).result as { nodes: UiNode[] };
    const shot = await leases.op(p, id, { op: 'screenshot', format: 'jpeg', maxSize: 1000 });
    const elements = ui.nodes
      .filter((n) => n.role !== 'application' && (n.label || n.identifier))
      .map((n) => ({ role: n.role, label: n.label, identifier: n.identifier, value: n.value, enabled: n.enabled, center: [round(n.normalized.x + n.normalized.width / 2), round(n.normalized.y + n.normalized.height / 2)] }));
    return {
      content: [
        { type: 'image', data: shot.binary?.toString('base64') ?? '', mimeType: 'image/jpeg' },
        { type: 'text', text: JSON.stringify({ elements }, null, 1) },
      ],
    };
  };

  server.registerTool(
    'lease_device',
    {
      description: 'Lease a device for your exclusive use. Waits until one is free. The device is wiped when released. Returns the lease id.',
      inputSchema: {
        model: z.string().optional().describe('For example "iPhone 17". Leave out for any.'),
        os: z.string().optional().describe('For example "26.5". Leave out for any.'),
        ttlSeconds: z.number().optional().describe('Ends unless renewed within this time. Default 600.'),
      },
    },
    ({ model, os, ttlSeconds }) =>
      safe(async () => {
        const lease = leases.create(p, { ...(model ? { model } : {}), ...(os ? { os } : {}) }, ttlSeconds ? { ttlSeconds } : {});
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
    'list_leases',
    { description: 'Your recent leases and their states.', inputSchema: {} },
    () => safe(async () => text(db.leasesOf(p.accountId, 20).map((l) => leases.view(l)))),
  );

  server.registerTool(
    'observe',
    { description: 'Screenshot plus the elements on screen, each with a center point you can tap.', inputSchema: { leaseId: z.string().optional() } },
    ({ leaseId }) => safe(() => observe(pick(leaseId))),
  );

  server.registerTool(
    'act',
    {
      description: 'Run input actions in order: tap (by element or point), longPress, swipe, type, key, button, waitFor. Returns a fresh observation unless observe is false.',
      inputSchema: { leaseId: z.string().optional(), actions: z.array(action).min(1), observe: z.boolean().optional() },
    },
    ({ leaseId, actions, observe: shouldObserve }) =>
      safe(async () => {
        const id = pick(leaseId);
        const { result } = await leases.op(p, id, { op: 'actions', actions: actions as Action[] });
        const results = result as { ok: boolean; error?: { message: string } }[];
        const failed = results.find((r) => !r.ok);
        const summary: Content = { type: 'text', text: failed ? `Stopped at action ${results.indexOf(failed) + 1}: ${failed.error?.message}` : `Ran ${results.length} action(s).` };
        if (shouldObserve === false) {
          return { content: [summary], ...(failed ? { isError: true } : {}) };
        }
        const obs = await observe(id);
        return { content: [summary, ...obs.content], ...(failed ? { isError: true } : {}) };
      }),
  );

  server.registerTool(
    'install_build',
    { description: 'Install a registered build (uploaded by CI or an operator) by name or sha256.', inputSchema: { build: z.string(), leaseId: z.string().optional() } },
    ({ build, leaseId }) =>
      safe(async () => {
        const b = db.getBuild(build);
        if (!b) {
          throw new ApiError(404, 'BUILD_NOT_FOUND', `No build called ${build}. Registered: ${db.builds().map((x) => x.name).join(', ') || 'none'}.`);
        }
        const code = auth.mintToken(db, 'artifact', { expiresAt: Date.now() + 10 * 60_000 });
        const { result } = await leases.op(p, pick(leaseId), {
          op: 'install',
          artifactUrl: `${internalUrl}/v1/artifacts/${b.sha256}?t=${code}`,
          sha256: b.sha256,
        });
        return text(result);
      }),
  );

  server.registerTool(
    'launch_app',
    { description: 'Launch an installed app by bundle id.', inputSchema: { bundleId: z.string(), leaseId: z.string().optional() } },
    ({ bundleId, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'launch', bundleId }), text(`Launched ${bundleId}.`))),
  );

  server.registerTool(
    'terminate_app',
    { description: 'Stop a running app by bundle id.', inputSchema: { bundleId: z.string(), leaseId: z.string().optional() } },
    ({ bundleId, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'terminate', bundleId }), text(`Stopped ${bundleId}.`))),
  );

  server.registerTool(
    'open_url',
    { description: 'Open a URL or deep link on the device.', inputSchema: { url: z.string(), leaseId: z.string().optional() } },
    ({ url, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'openUrl', url }), text(`Opened ${url}.`))),
  );

  return server;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
