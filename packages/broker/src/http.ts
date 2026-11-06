// HTTP API, console and artifact downloads on node:http.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Action, DeviceClass, Op, PrivacyService } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db } from './db.ts';
import type { Hosts } from './hosts.ts';
import { ApiError, type Leases } from './leases/service.ts';
import { handleMcp } from './mcp.ts';

export type Ctx = {
  db: Db;
  hosts: Hosts;
  leases: Leases;
  dataDir: string;
  consoleDir: string;
  // Where agents in this process download artifacts from.
  internalUrl: () => string;
  publicUrl: () => string;
};

type Req = IncomingMessage & { params: Record<string, string>; url: string };
type Handler = (req: Req, res: ServerResponse, ctx: Ctx) => Promise<void> | void;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: boolean };

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler, opts: { auth?: boolean } = {}): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:(\w+)/g, (_, k: string) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ method, pattern, keys, handler, auth: opts.auth ?? true });
}

export async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/mcp') {
      await handleMcp(req, res, ctx.db, ctx.leases, ctx.internalUrl());
      return;
    }
    for (const r of routes) {
      const match = r.method === req.method ? r.pattern.exec(url.pathname) : null;
      if (!match) {
        continue;
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1] ?? '')]));
      if (r.auth && !principal(req, ctx)) {
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.', 'In the console, open the invite link you were sent. From code, pass `Authorization: Bearer <token>`.');
      }
      await r.handler(Object.assign(req, { params, url: req.url ?? '/' }), res, ctx);
      return;
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/v1/')) {
      await serveConsole(url.pathname, res, ctx);
      return;
    }
    throw new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${url.pathname}.`);
  } catch (err) {
    sendError(res, err);
  }
}

export function sendError(res: ServerResponse, err: unknown): void {
  const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
  if (e.status === 500) {
    console.error(err);
  }
  if (!res.headersSent) {
    json(res, e.status, { error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } });
  } else {
    res.end();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function principal(req: IncomingMessage, ctx: Ctx): auth.Principal | null {
  return auth.authenticate(ctx.db, { authorization: req.headers.authorization, cookie: req.headers.cookie }, Date.now());
}

function me(req: IncomingMessage, ctx: Ctx): auth.Principal {
  const p = principal(req, ctx);
  if (!p) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.');
  }
  return p;
}

function operator(req: IncomingMessage, ctx: Ctx): auth.Principal {
  const p = me(req, ctx);
  if (p.role !== 'operator') {
    throw new ApiError(403, 'FORBIDDEN', 'Only operators can do this.');
  }
  return p;
}

async function body<T>(req: IncomingMessage, limit = 1_000_000): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new ApiError(413, 'BODY_TOO_LARGE', `Request body is over ${limit} bytes.`);
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) {
    return {} as T;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new ApiError(400, 'BAD_JSON', 'The request body is not valid JSON.');
  }
}

function query(req: Req): URLSearchParams {
  return new URL(req.url, 'http://x').searchParams;
}

// Accounts and sign-in

route(
  'GET',
  '/welcome/:code',
  (req, res, ctx) => {
    const token = auth.lookupToken(ctx.db, req.params.code ?? '', Date.now());
    if (!token || token.kind !== 'welcome' || !token.accountId || !ctx.db.useToken(token.hash, Date.now())) {
      res.writeHead(302, { location: '/?error=link-used' });
      res.end();
      return;
    }
    const session = auth.startSession(ctx.db, token.accountId, Date.now());
    res.writeHead(302, { 'set-cookie': auth.sessionCookie(session, ctx.publicUrl().startsWith('https')), location: '/?welcome=1' });
    res.end();
  },
  { auth: false },
);

route(
  'POST',
  '/v1/invites/:code/accept',
  async (req, res, ctx) => {
    const { name, password } = await body<{ name?: string; password?: string }>(req);
    if (!name?.trim() || !password || password.length < 8) {
      throw new ApiError(400, 'BAD_REQUEST', 'Pick a name and a password of at least 8 characters.');
    }
    const token = auth.lookupToken(ctx.db, req.params.code ?? '', Date.now());
    if (!token || token.kind !== 'invite') {
      throw new ApiError(404, 'INVITE_INVALID', 'This invite link has expired or was already used.', 'Ask whoever invited you for a new link.');
    }
    if (ctx.db.accountByName(name.trim())) {
      throw new ApiError(409, 'NAME_TAKEN', `Someone is already called ${name.trim()}.`, 'Pick another name.');
    }
    if (!ctx.db.useToken(token.hash, Date.now())) {
      throw new ApiError(404, 'INVITE_INVALID', 'This invite link was already used.');
    }
    const role = token.scopes.includes('role:operator') ? 'operator' : 'member';
    const account = auth.createAccount(ctx.db, name.trim(), role);
    ctx.db.setPassword(account.id, await auth.hashPassword(password));
    const session = auth.startSession(ctx.db, account.id, Date.now());
    res.writeHead(200, { 'set-cookie': auth.sessionCookie(session, ctx.publicUrl().startsWith('https')), 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: account.name, role }));
  },
  { auth: false },
);

route(
  'POST',
  '/v1/login',
  async (req, res, ctx) => {
    const { name, password } = await body<{ name?: string; password?: string }>(req);
    const account = name ? ctx.db.accountByName(name) : null;
    if (!account?.passwordHash || !password || !(await auth.checkPassword(password, account.passwordHash))) {
      throw new ApiError(401, 'BAD_CREDENTIALS', 'That name and password do not match.', 'An operator can send you a new invite link if you forgot it.');
    }
    const session = auth.startSession(ctx.db, account.id, Date.now());
    res.writeHead(200, { 'set-cookie': auth.sessionCookie(session, ctx.publicUrl().startsWith('https')), 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: account.name, role: account.role }));
  },
  { auth: false },
);

route('POST', '/v1/logout', (req, res, ctx) => {
  const session = auth.readCookie(req.headers.cookie, auth.SESSION_COOKIE);
  if (session) {
    ctx.db.deleteSession(auth.sha256(session));
  }
  res.writeHead(204, { 'set-cookie': `${auth.SESSION_COOKIE}=; Path=/; Max-Age=0` });
  res.end();
});

route(
  'GET',
  '/v1/me',
  (req, res, ctx) => {
    const p = principal(req, ctx);
    json(res, 200, p ? { name: p.name, role: p.role, scopes: p.scopes } : null);
  },
  { auth: false },
);

route('POST', '/v1/invites', async (req, res, ctx) => {
  operator(req, ctx);
  const { role } = await body<{ role?: 'member' | 'operator' }>(req);
  const code = auth.mintToken(ctx.db, 'invite', {
    scopes: role === 'operator' ? ['role:operator'] : [],
    expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
  });
  json(res, 201, { url: `${ctx.publicUrl()}/invite/${code}`, expiresInDays: 7 });
});

route('GET', '/v1/people', (req, res, ctx) => {
  operator(req, ctx);
  json(res, 200, ctx.db.accounts().map((a) => ({ name: a.name, role: a.role })));
});

route('POST', '/v1/tokens', async (req, res, ctx) => {
  const p = me(req, ctx);
  const { label, scopes } = await body<{ label?: string; scopes?: string[] }>(req);
  const allowed = (scopes ?? []).filter((s) => s === 'install:upload');
  if (allowed.length && p.role !== 'operator') {
    throw new ApiError(403, 'FORBIDDEN', 'Only operators can make tokens that upload apps.');
  }
  const token = auth.mintToken(ctx.db, 'member', { accountId: p.accountId, label: label ?? null, scopes: allowed });
  json(res, 201, { token, mcp: `claude mcp add --transport http hangar ${ctx.publicUrl()}/mcp --header "Authorization: Bearer ${token}"` });
});

// Devices and leases

route('GET', '/v1/devices', (_req, res, ctx) => {
  const held = new Map(ctx.db.leasesIn(['preparing', 'active']).map((l) => [l.deviceId, l]));
  json(
    res,
    200,
    ctx.hosts.devices().map((d) => ({
      model: d.model,
      os: d.os,
      host: d.hostName,
      state: !d.connected ? 'offline' : held.has(d.deviceId) ? 'leased' : d.state,
    })),
  );
});

route('POST', '/v1/leases', async (req, res, ctx) => {
  const p = me(req, ctx);
  const b = await body<{ class?: DeviceClass; ttlSeconds?: number; maxSeconds?: number }>(req);
  const lease = ctx.leases.create(p, b.class ?? {}, b);
  const wait = Number(query(req).get('wait') ?? 0);
  if (wait > 0) {
    json(res, 201, ctx.leases.view(await waitFor(ctx, lease.id, Math.min(wait, 600) * 1000)));
    return;
  }
  json(res, 201, ctx.leases.view(lease));
});

async function waitFor(ctx: Ctx, id: string, ms: number): Promise<import('./leases/machine.ts').Lease> {
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
  const send = (l: import('./leases/machine.ts').Lease): void => {
    res.write(`event: ${l.state}\ndata: ${JSON.stringify(ctx.leases.view(l))}\n\n`);
    if (l.state === 'ended') {
      res.end();
    }
  };
  send(lease);
  ctx.leases.events.on(lease.id, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    ctx.leases.events.off(lease.id, send);
  });
});

route('POST', '/v1/leases/:id/renew', async (req, res, ctx) => {
  const { ttlSeconds } = await body<{ ttlSeconds?: number }>(req);
  json(res, 200, ctx.leases.view(ctx.leases.renew(me(req, ctx), req.params.id ?? '', ttlSeconds)));
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

// Points a React Native debug build at the lease's Metro tunnel. `hangar run ios` opens the tunnel.
route('POST', '/v1/leases/:id/metro', async (req, res, ctx) => {
  const { bundleId } = await body<{ bundleId?: string }>(req);
  if (!bundleId) {
    throw new ApiError(400, 'BAD_BUNDLE_ID', 'Send the app\'s `bundleId`.');
  }
  json(res, 200, (await op(req, ctx, { op: 'useMetro', bundleId })).result ?? {});
});

// Device presets. The agent checks the values; the broker only picks the fields it forwards.
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

// Maestro flows on the leased device. The flows folder comes as a base64 tar, up to 10 MB.
route('POST', '/v1/leases/:id/maestro', async (req, res, ctx) => {
  const b = await body<{ archive?: string; flows?: string[]; env?: Record<string, string> }>(req, 15_000_000);
  if (!b.archive || !Array.isArray(b.flows)) {
    throw new ApiError(400, 'BAD_FLOWS', 'Send `archive` (a base64 tar of the flows folder) and `flows` (paths inside it).');
  }
  json(res, 200, (await op(req, ctx, { op: 'maestro', archive: b.archive, flows: b.flows.map(String), env: b.env ?? {} })).result ?? {});
});

// Builds and artifacts

route('POST', '/v1/builds', async (req, res, ctx) => {
  const p = me(req, ctx);
  if (!p.scopes.includes('install:upload')) {
    throw new ApiError(403, 'UPLOAD_NOT_ALLOWED', 'Uploading a build needs the install:upload permission.');
  }
  json(res, 201, await saveUpload(req, ctx, query(req).get('name') ?? 'upload'));
});

route('GET', '/v1/builds', (_req, res, ctx) => {
  json(res, 200, ctx.db.builds());
});

route(
  'GET',
  '/v1/artifacts/:sha',
  async (req, res, ctx) => {
    const t = query(req).get('t') ?? '';
    const token = auth.lookupToken(ctx.db, t, Date.now());
    if (!token || token.kind !== 'artifact' || !ctx.db.useToken(token.hash, Date.now())) {
      throw new ApiError(403, 'FORBIDDEN', 'This download link is not valid.');
    }
    const build = ctx.db.getBuild(req.params.sha ?? '');
    if (!build) {
      throw new ApiError(404, 'NOT_FOUND', 'No such artifact.');
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': build.size });
    await pipeline(createReadStream(build.path), res);
  },
  { auth: false },
);

const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

async function saveUpload(req: IncomingMessage, ctx: Ctx, name: string): Promise<{ sha256: string; name: string; size: number }> {
  const dir = join(ctx.dataDir, 'builds');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.upload-${process.pid}-${Date.now()}`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > MAX_UPLOAD) {
            throw new ApiError(413, 'BODY_TOO_LARGE', 'Builds are limited to 4 GB.');
          }
          hash.update(chunk as Buffer);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  if (size === 0) {
    await rm(tmp, { force: true });
    throw new ApiError(400, 'EMPTY_UPLOAD', 'The upload was empty. Send a zipped or tarred .app as the request body.');
  }
  const sha256 = hash.digest('hex');
  const path = join(dir, sha256);
  await rename(tmp, path);
  ctx.db.insertBuild(sha256, name, path, size);
  return { sha256, name, size };
}

// Console

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveConsole(pathname: string, res: ServerResponse, ctx: Ctx): Promise<void> {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(ctx.consoleDir, rel);
  const isFile = await stat(file).then((s) => s.isFile(), () => false);
  if (!isFile || !file.startsWith(ctx.consoleDir)) {
    // Routes like /invite/... and /leases/... are handled by the single page.
    file = join(ctx.consoleDir, 'index.html');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(await readFile(file));
}
