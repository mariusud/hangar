import type { Action, DeviceClass, Op, PrivacyService } from '@hangar/protocol';
import * as auth from '../auth.ts';
import { isLimitRole, LIMIT_ROLES } from '../leases/limits.ts';
import { ApiError } from '../leases/service.ts';
import { caps, limitsOf, seconds } from '../leases/tokens.ts';
import { saveUpload } from './uploads.ts';
import { body, json, me, operator, query, route, type Ctx, type Req } from './util.ts';

route('POST', '/v1/leases', async (req, res, ctx) => {
  const p = me(req, ctx);
  const b = await body<{ class?: DeviceClass; ttlSeconds?: number; maxSeconds?: number; idleSeconds?: number; record?: boolean; via?: string }>(req);
  const lease = ctx.leases.create(p, b.class ?? {}, {
    ...(b.ttlSeconds ? { ttlSeconds: b.ttlSeconds } : {}),
    ...(b.maxSeconds ? { maxSeconds: b.maxSeconds } : {}),
    ...(b.idleSeconds ? { idleSeconds: b.idleSeconds } : {}),
    ...(typeof b.via === 'string' ? { via: b.via } : {}),
  });
  if (b.record) {
    ctx.recordings.want(p, lease.id);
  }
  const wait = Number(query(req).get('wait') ?? 0);
  if (wait > 0) {
    json(res, 201, ctx.leases.view(await waitFor(ctx, lease.id, Math.min(wait, 600) * 1000)));
    return;
  }
  json(res, 201, ctx.leases.view(lease));
});

async function waitFor(ctx: Ctx, id: string, ms: number): Promise<import('../leases/machine.ts').Lease> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      ctx.leases.events.off(id, onChange);
      const current = ctx.db.getLease(id);
      if (current) {
        resolve(current);
      }
    };
    const onChange = (l: { state: string }): void => {
      if (l.state === 'active' || l.state === 'ended') {
        done();
      }
    };
    const timer = setTimeout(done, ms);
    ctx.leases.events.on(id, onChange);
    const current = ctx.db.getLease(id);
    if (current && (current.state === 'active' || current.state === 'ended')) {
      done();
    }
  });
}

route('GET', '/v1/leases', (req, res, ctx) => {
  const p = me(req, ctx);
  const all = query(req).get('all') === '1' && p.role === 'operator';
  const list = all ? ctx.db.recentLeases() : ctx.db.leasesOf(p.accountId);
  json(res, 200, list.map((l) => ctx.leases.view(l)));
});

route('GET', '/v1/leases/:id', async (req, res, ctx) => {
  const p = me(req, ctx);
  const wait = Number(query(req).get('wait') ?? 0);
  const lease = ctx.leases.get(p, req.params.id ?? '');
  json(res, 200, ctx.leases.view(wait > 0 ? await waitFor(ctx, lease.id, Math.min(wait, 600) * 1000) : lease));
});

route('GET', '/v1/leases/:id/events', (req, res, ctx) => {
  const p = me(req, ctx);
  const lease = ctx.leases.get(p, req.params.id ?? '');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (l: import('../leases/machine.ts').Lease): void => {
    res.write(`event: ${l.state === 'active' && l.ending ? 'lease_ending' : l.state}\ndata: ${JSON.stringify(ctx.leases.view(l))}\n\n`);
    if (l.state === 'ended') {
      res.end();
    }
  };
  send(lease);
  ctx.leases.events.on(lease.id, send);
  const disconnected = ctx.leases.connected(p, lease.id);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    disconnected();
    clearInterval(ping);
    ctx.leases.events.off(lease.id, send);
  });
});

route('POST', '/v1/leases/:id/renew', async (req, res, ctx) => {
  const { ttlSeconds } = await body<{ ttlSeconds?: number }>(req);
  json(res, 200, ctx.leases.view(ctx.leases.renew(me(req, ctx), req.params.id ?? '', ttlSeconds)));
});

route('POST', '/v1/leases/:id/keepalive', (req, res, ctx) => {
  json(res, 200, ctx.leases.view(ctx.leases.keepalive(me(req, ctx), req.params.id ?? '')));
});

route('POST', '/v1/leases/:id/attach', (req, res, ctx) => {
  json(res, 200, ctx.leases.view(ctx.leases.reattach(me(req, ctx), req.params.id ?? '')));
});

route('GET', '/v1/lease-limits', (req, res, ctx) => {
  const p = me(req, ctx);
  json(res, 200, { caps: caps(ctx.db), mine: limitsOf(ctx.db, p) });
});

route('PUT', '/v1/lease-limits/:role', async (req, res, ctx) => {
  const p = operator(req, ctx);
  const role = req.params.role;
  if (!isLimitRole(role)) {
    throw new ApiError(404, 'NO_SUCH_ROLE', `No role ${role}.`, `Roles: ${LIMIT_ROLES.join(', ')}.`);
  }
  const b = await body<{ idleSeconds?: number | null; maxSeconds?: number | null; graceSeconds?: number | null }>(req);
  // Fields left out keep their value; null goes back to the built-in cap.
  const was = ctx.db.leaseLimitCaps().find((r) => r.role === role) ?? { role, idleMs: null, maxMs: null, graceMs: null };
  const row = {
    role,
    idleMs: 'idleSeconds' in b ? seconds(b.idleSeconds, 'idleSeconds') : was.idleMs,
    maxMs: 'maxSeconds' in b ? seconds(b.maxSeconds, 'maxSeconds') : was.maxMs,
    graceMs: 'graceSeconds' in b ? seconds(b.graceSeconds, 'graceSeconds') : was.graceMs,
  };
  ctx.db.setLeaseLimitCap(row);
  ctx.db.audit(`lease_limits.${role} idle=${row.idleMs ?? 'default'} max=${row.maxMs ?? 'default'} grace=${row.graceMs ?? 'default'}`, p.accountId, null);
  json(res, 200, caps(ctx.db)[role]);
});

route('DELETE', '/v1/leases/:id', (req, res, ctx) => {
  json(res, 200, ctx.leases.view(ctx.leases.release(me(req, ctx), req.params.id ?? '')));
});

async function op(req: Req, ctx: Ctx, o: Op): Promise<{ result?: unknown; binary?: Buffer }> {
  return ctx.leases.op(me(req, ctx), req.params.id ?? '', o);
}

route('GET', '/v1/leases/:id/screenshot', async (req, res, ctx) => {
  const format = query(req).get('format') === 'jpeg' ? 'jpeg' : 'png';
  const maxSize = Number(query(req).get('maxSize')) || undefined;
  const { binary } = await op(req, ctx, { op: 'screenshot', format, ...(maxSize ? { maxSize } : {}) });
  res.writeHead(200, { 'content-type': `image/${format}`, 'cache-control': 'no-store' });
  res.end(binary);
});

route('GET', '/v1/leases/:id/ui', async (req, res, ctx) => {
  const { result } = await op(req, ctx, { op: 'describe' });
  if (query(req).get('screenshot') === '1') {
    const { binary } = await op(req, ctx, { op: 'screenshot', format: 'jpeg', maxSize: 1000 });
    json(res, 200, { ...(result as object), screenshot: binary?.toString('base64') });
    return;
  }
  json(res, 200, result);
});

route('POST', '/v1/leases/:id/actions', async (req, res, ctx) => {
  const b = await body<{ actions?: Action[]; observe?: boolean }>(req);
  if (!Array.isArray(b.actions) || b.actions.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Send `actions`: a list such as [{ "type": "tap", "element": { "label": "Sign in" } }].');
  }
  const { result } = await op(req, ctx, { op: 'actions', actions: b.actions });
  if (b.observe) {
    const ui = await op(req, ctx, { op: 'describe' });
    const shot = await op(req, ctx, { op: 'screenshot', format: 'jpeg', maxSize: 1000 });
    json(res, 200, { results: result, ui: ui.result, screenshot: shot.binary?.toString('base64') });
    return;
  }
  json(res, 200, { results: result });
});

route('POST', '/v1/leases/:id/apps', async (req, res, ctx) => {
  const p = me(req, ctx);
  let build: { sha256: string } | null;
  if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
    const { build: ref } = await body<{ build?: string }>(req);
    build = ref ? ctx.db.getBuild(ref) : null;
    if (!build) {
      throw new ApiError(404, 'BUILD_NOT_FOUND', `No build called ${ref}.`, 'Upload one with `hangar install ./MyApp.app`, or list them at GET /v1/builds.');
    }
  } else {
    if (!p.scopes.includes('install:upload')) {
      throw new ApiError(403, 'UPLOAD_NOT_ALLOWED', 'Uploading an app needs the install:upload permission, because an app runs code on the Mac.', 'Ask an operator, or install a registered build with { "build": "<name>" }.');
    }
    build = await saveUpload(req, ctx, query(req).get('name') ?? 'upload');
  }
  const code = auth.mintToken(ctx.db, 'artifact', { expiresAt: Date.now() + 10 * 60_000 });
  const { result } = await op(req, ctx, {
    op: 'install',
    artifactUrl: `${ctx.internalUrl()}/v1/artifacts/${build.sha256}?t=${code}`,
    sha256: build.sha256,
  });
  json(res, 200, result);
});

route('POST', '/v1/leases/:id/apps/:bundleId/launch', async (req, res, ctx) => {
  const { args } = await body<{ args?: string[] }>(req);
  json(res, 200, (await op(req, ctx, { op: 'launch', bundleId: req.params.bundleId ?? '', ...(args ? { args } : {}) })).result ?? {});
});

route('POST', '/v1/leases/:id/apps/:bundleId/terminate', async (req, res, ctx) => {
  json(res, 200, (await op(req, ctx, { op: 'terminate', bundleId: req.params.bundleId ?? '' })).result ?? {});
});

route('DELETE', '/v1/leases/:id/apps/:bundleId', async (req, res, ctx) => {
  json(res, 200, (await op(req, ctx, { op: 'uninstall', bundleId: req.params.bundleId ?? '' })).result ?? {});
});

route('POST', '/v1/leases/:id/open-url', async (req, res, ctx) => {
  const { url } = await body<{ url?: string }>(req);
  if (!url || !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    throw new ApiError(400, 'BAD_URL', 'Send `url` with a scheme, such as https://example.com or myapp://home.');
  }
  json(res, 200, (await op(req, ctx, { op: 'openUrl', url })).result ?? {});
});

route('POST', '/v1/leases/:id/metro', async (req, res, ctx) => {
  const { bundleId } = await body<{ bundleId?: string }>(req);
  if (!bundleId) {
    throw new ApiError(400, 'BAD_BUNDLE_ID', 'Send the app\'s `bundleId`.');
  }
  json(res, 200, (await op(req, ctx, { op: 'useMetro', bundleId })).result ?? {});
});

route('POST', '/v1/leases/:id/push', async (req, res, ctx) => {
  const b = await body<{ bundleId?: string; payload?: Record<string, unknown> }>(req);
  json(res, 200, (await op(req, ctx, { op: 'push', bundleId: String(b.bundleId ?? ''), payload: b.payload ?? {} })).result ?? {});
});

route('POST', '/v1/leases/:id/permissions', async (req, res, ctx) => {
  const b = await body<{ bundleId?: string; service?: PrivacyService; action?: 'grant' | 'revoke' | 'reset' }>(req);
  json(res, 200, (await op(req, ctx, { op: 'permission', bundleId: String(b.bundleId ?? ''), service: b.service ?? 'all', action: b.action ?? 'grant' })).result ?? {});
});

route('POST', '/v1/leases/:id/location', async (req, res, ctx) => {
  const b = await body<{ lat?: number; lon?: number }>(req);
  json(res, 200, (await op(req, ctx, { op: 'location', lat: Number(b.lat), lon: Number(b.lon) })).result ?? {});
});

route('DELETE', '/v1/leases/:id/location', async (req, res, ctx) => {
  json(res, 200, (await op(req, ctx, { op: 'clearLocation' })).result ?? {});
});

route('POST', '/v1/leases/:id/appearance', async (req, res, ctx) => {
  const b = await body<{ mode?: 'light' | 'dark' }>(req);
  json(res, 200, (await op(req, ctx, { op: 'appearance', mode: b.mode === 'dark' ? 'dark' : 'light' })).result ?? {});
});

route('POST', '/v1/leases/:id/locale', async (req, res, ctx) => {
  const b = await body<{ bundleId?: string; language?: string }>(req);
  json(res, 200, (await op(req, ctx, { op: 'locale', bundleId: String(b.bundleId ?? ''), language: String(b.language ?? '') })).result ?? {});
});

route('POST', '/v1/leases/:id/maestro', async (req, res, ctx) => {
  const b = await body<{ archive?: string; flows?: string[]; env?: Record<string, string> }>(req, 15_000_000);
  if (!b.archive || !Array.isArray(b.flows)) {
    throw new ApiError(400, 'BAD_FLOWS', 'Send `archive` (a base64 tar of the flows folder) and `flows` (paths inside it).');
  }
  json(res, 200, (await op(req, ctx, { op: 'maestro', archive: b.archive, flows: b.flows.map(String), env: b.env ?? {} })).result ?? {});
});
