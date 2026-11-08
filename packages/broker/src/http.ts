// HTTP API, console and artifact downloads on node:http.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Action, DeviceClass, Op, PrivacyService } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db, ImageSpec, RecordingRow } from './db.ts';
import { imageId } from './images.ts';
import type { Hosts } from './hosts.ts';
import { ApiError, type Leases } from './leases/service.ts';
import { handleMcp } from './mcp.ts';
import { PART_FILES, RECORDING_PARTS, type RecordingPart, type Recordings } from './recordings.ts';
import type { Metrics } from './metrics.ts';
import { junit, testHistory, type Run, type RunRequest, type Runs } from './runs.ts';
import { accountFor, type Oidc } from './oidc.ts';
import type { Store } from './store.ts';

export type Ctx = {
  db: Db;
  hosts: Hosts;
  leases: Leases;
  recordings: Recordings;
  runs: Runs;
  store: Store;
  oidc: Oidc | null;
  metrics: Metrics;
  // Sends the declared images to every connected host.
  publishImages: () => void;
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
      await handleMcp(req, res, ctx.db, ctx.leases, ctx.recordings, ctx.internalUrl(), ctx.publicUrl());
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

// What the sign-in page offers, before anyone is signed in.
route('GET', '/v1/sign-in', (_req, res, ctx) => json(res, 200, { sso: Boolean(ctx.oidc), passwords: !ctx.oidc?.config.disablePasswords }), { auth: false });

const oidcRedirect = (ctx: Ctx): string => `${ctx.publicUrl()}/v1/oidc/callback`;

route(
  'GET',
  '/v1/oidc/start',
  async (req, res, ctx) => {
    if (!ctx.oidc) {
      throw new ApiError(404, 'NO_SSO', 'Single sign-on is not set up. An operator sets HANGAR_OIDC_ISSUER and HANGAR_OIDC_CLIENT_ID.');
    }
    res.writeHead(302, { location: await ctx.oidc.start(oidcRedirect(ctx), query(req).get('next') ?? '/') });
    res.end();
  },
  { auth: false },
);

route(
  'GET',
  '/v1/oidc/callback',
  async (req, res, ctx) => {
    if (!ctx.oidc) {
      throw new ApiError(404, 'NO_SSO', 'Single sign-on is not set up.');
    }
    const q = query(req);
    if (q.get('error')) {
      res.writeHead(302, { location: `/?error=sso&message=${encodeURIComponent(q.get('error_description') ?? q.get('error') ?? '')}` });
      res.end();
      return;
    }
    const { claims, next } = await ctx.oidc.finish(oidcRedirect(ctx), q.get('code') ?? '', q.get('state') ?? '');
    const accountId = accountFor(ctx.db, ctx.oidc.config, claims);
    ctx.db.audit('login.oidc', accountId, null);
    const session = auth.startSession(ctx.db, accountId, Date.now());
    res.writeHead(302, { 'set-cookie': auth.sessionCookie(session, ctx.publicUrl().startsWith('https')), location: next });
    res.end();
  },
  { auth: false },
);

route(
  'POST',
  '/v1/login',
  async (req, res, ctx) => {
    if (ctx.oidc?.config.disablePasswords) {
      throw new ApiError(403, 'PASSWORDS_OFF', 'Sign in with your company account; passwords are turned off here.');
    }
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
  json(res, 200, ctx.db.accounts().map((a) => ({ name: a.name, role: a.role, team: ctx.db.teamOf(a.id) })));
});

// Device images: an operator declares the apps and settings; every host builds the image once
// and keeps clones of it ready. Lease one with { "class": { "image": "<name>" } }.
route('GET', '/v1/images', (req, res, ctx) => {
  me(req, ctx);
  json(res, 200, ctx.db.images().map((spec) => ({ ...spec, id: imageId(spec) })));
});

route('PUT', '/v1/images/:name', async (req, res, ctx) => {
  operator(req, ctx);
  const name = req.params.name ?? '';
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(name)) {
    throw new ApiError(400, 'BAD_IMAGE_NAME', 'Image names are letters, digits, dots, dashes and underscores, up to 63 characters.');
  }
  const b = await body<{ apps?: string[]; locale?: string; appearance?: string }>(req);
  const apps: string[] = [];
  for (const ref of b.apps ?? []) {
    const build = ctx.db.getBuild(ref);
    if (!build) {
      throw new ApiError(404, 'BUILD_NOT_FOUND', `No build called ${ref}.`, 'Upload it first with POST /v1/builds, or list them at GET /v1/builds.');
    }
    apps.push(build.sha256);
  }
  if (b.locale !== undefined && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(b.locale)) {
    throw new ApiError(400, 'BAD_LOCALE', `${b.locale} is not a locale. Write it like nb_NO or en_US.`);
  }
  if (b.appearance !== undefined && b.appearance !== 'light' && b.appearance !== 'dark') {
    throw new ApiError(400, 'BAD_APPEARANCE', 'appearance is light or dark.');
  }
  const spec: ImageSpec = { name, apps };
  if (b.locale) {
    spec.locale = b.locale;
  }
  if (b.appearance) {
    spec.appearance = b.appearance;
  }
  ctx.db.saveImage(spec);
  ctx.publishImages();
  json(res, 200, { ...spec, id: imageId(spec) });
});

route('DELETE', '/v1/images/:name', (req, res, ctx) => {
  operator(req, ctx);
  if (!ctx.db.removeImage(req.params.name ?? '')) {
    throw new ApiError(404, 'IMAGE_NOT_FOUND', `No image called ${req.params.name}.`);
  }
  ctx.publishImages();
  res.writeHead(204).end();
});

// Teams: each has members and a quota, the most leases it holds at once. A request over the
// quota waits in the queue; it is never refused.
route('GET', '/v1/teams', (req, res, ctx) => {
  operator(req, ctx);
  const live = ctx.db.leasesIn(['preparing', 'active']);
  const accounts = ctx.db.accounts();
  json(
    res,
    200,
    ctx.db.teams().map((t) => ({
      ...t,
      members: accounts.filter((a) => ctx.db.teamOf(a.id) === t.id).length,
      activeLeases: live.filter((l) => l.teamId === t.id).length,
    })),
  );
});

function quotaOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError(400, 'BAD_QUOTA', 'A quota is a whole number of leases, or null for no limit.');
  }
  return n;
}

route('POST', '/v1/teams', async (req, res, ctx) => {
  const p = operator(req, ctx);
  const b = await body<{ name?: string; quota?: number | null }>(req);
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 60) {
    throw new ApiError(400, 'BAD_NAME', 'Give the team a name of up to 60 characters.');
  }
  if (ctx.db.teams().some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(409, 'TEAM_EXISTS', `There is already a team called ${name}.`);
  }
  const team = { id: randomUUID(), name, quota: quotaOf(b.quota) };
  ctx.db.saveTeam(team);
  ctx.db.audit(`team.create ${name}`, p.accountId, null);
  json(res, 201, team);
});

route('PATCH', '/v1/teams/:id', async (req, res, ctx) => {
  const p = operator(req, ctx);
  const team = ctx.db.teams().find((t) => t.id === req.params.id);
  if (!team) {
    throw new ApiError(404, 'TEAM_NOT_FOUND', `No team ${req.params.id}.`);
  }
  const b = await body<{ name?: string; quota?: number | null }>(req);
  const next = { ...team, ...(b.name ? { name: String(b.name).trim() } : {}), ...('quota' in b ? { quota: quotaOf(b.quota) } : {}) };
  ctx.db.saveTeam(next);
  ctx.db.audit(`team.update ${next.name} quota=${next.quota ?? 'none'}`, p.accountId, null);
  void ctx.leases.tick();
  json(res, 200, next);
});

route('PUT', '/v1/people/:name/team', async (req, res, ctx) => {
  const p = operator(req, ctx);
  const account = ctx.db.accountByName(req.params.name ?? '');
  const { team: ref } = await body<{ team?: string }>(req);
  const team = ctx.db.teams().find((t) => t.id === ref || t.name.toLowerCase() === String(ref ?? '').toLowerCase());
  if (!account || !team) {
    throw new ApiError(404, 'NOT_FOUND', !account ? `No person called ${req.params.name}.` : `No team ${ref}.`);
  }
  ctx.db.setTeam(account.id, team.id);
  ctx.db.audit(`person.team ${account.name} ${team.name}`, p.accountId, null);
  json(res, 200, { name: account.name, team: team.id });
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
      platform: d.platform ?? 'ios-simulator',
      model: d.model,
      os: d.os,
      image: d.image ?? null,
      host: d.hostName,
      state: !d.connected ? 'offline' : held.has(d.deviceId) ? 'leased' : d.state,
    })),
  );
});

route('POST', '/v1/leases', async (req, res, ctx) => {
  const p = me(req, ctx);
  const b = await body<{ class?: DeviceClass; ttlSeconds?: number; maxSeconds?: number; record?: boolean }>(req);
  const lease = ctx.leases.create(p, b.class ?? {}, b);
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

// Runs and recordings belong to the team of the person who made them. Members see their team's;
// operators see all. Another team's looks the same as one that does not exist.
function sameTeam(ctx: Ctx, p: auth.Principal, accountId: string): boolean {
  return p.role === 'operator' || ctx.db.teamOf(accountId) === ctx.db.teamOf(p.accountId);
}

function teamRun(req: Req, ctx: Ctx): Run {
  const run = ctx.runs.get(req.params.id ?? '');
  if (!sameTeam(ctx, me(req, ctx), run.accountId)) {
    throw new ApiError(404, 'RUN_NOT_FOUND', `No run ${req.params.id}.`);
  }
  return run;
}

function teamRecording(req: Req, ctx: Ctx): RecordingRow {
  const recording = ctx.recordings.get(req.params.id ?? '');
  if (!sameTeam(ctx, me(req, ctx), recording.accountId)) {
    throw new ApiError(404, 'RECORDING_NOT_FOUND', `No recording ${req.params.id}.`);
  }
  return recording;
}

// Runs: a suite sharded over fresh devices, coordinated by the broker.
route('POST', '/v1/runs', async (req, res, ctx) => {
  const b = await body<RunRequest>(req, 15_000_000);
  json(res, 201, ctx.runs.view(ctx.runs.start(me(req, ctx), b)));
});

route('GET', '/v1/runs', (req, res, ctx) => {
  const p = me(req, ctx);
  json(res, 200, ctx.runs.list().filter((r) => sameTeam(ctx, p, r.accountId)).map((r) => ctx.runs.view(r)));
});

// Per test over the team's last 200 runs: passes, failures and flaky passes.
route('GET', '/v1/tests', (req, res, ctx) => {
  const p = me(req, ctx);
  json(res, 200, testHistory(ctx.db.recentRuns(200).filter((r) => sameTeam(ctx, p, r.accountId))));
});

route('GET', '/v1/runs/:id', (req, res, ctx) => {
  json(res, 200, ctx.runs.view(teamRun(req, ctx)));
});

// One event per change, until the run ends.
route('GET', '/v1/runs/:id/events', (req, res, ctx) => {
  const run = teamRun(req, ctx);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (r: typeof run): void => {
    res.write(`event: ${r.state}\ndata: ${JSON.stringify(ctx.runs.view(r))}\n\n`);
    if (r.state !== 'running') {
      res.end();
    }
  };
  send(run);
  ctx.runs.events.on(run.id, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    ctx.runs.events.off(run.id, send);
  });
});

route('GET', '/v1/runs/:id/junit.xml', (req, res, ctx) => {
  const run = teamRun(req, ctx);
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
  res.end(junit(run));
});

route('DELETE', '/v1/runs/:id', (req, res, ctx) => {
  json(res, 200, ctx.runs.view(ctx.runs.cancel(me(req, ctx), req.params.id ?? '')));
});

// Counts and timings for Prometheus. No names or ids, so it needs no token.
route(
  'GET',
  '/metrics',
  (_req, res, ctx) => {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(ctx.metrics.render());
  },
  { auth: false },
);

// Recordings

function recordingView(ctx: Ctx, r: RecordingRow): unknown {
  const files = `/v1/recordings/${r.id}`;
  return {
    id: r.id,
    leaseId: r.leaseId,
    state: r.state,
    owner: ctx.db.getAccount(r.accountId)?.name ?? 'unknown',
    device: r.device,
    startedAt: r.startedAt,
    durationMs: r.startedAt && r.endedAt ? r.endedAt - r.startedAt : null,
    bytes: r.bytes,
    error: r.error,
    url: `${ctx.publicUrl()}/recordings/${r.id}`,
    files: { video: `${files}/video.mp4`, log: `${files}/log.ndjson`, screenshot: `${files}/screenshot.png`, timeline: `${files}/timeline.json` },
  };
}

route('POST', '/v1/leases/:id/recording', async (req, res, ctx) => {
  json(res, 201, recordingView(ctx, await ctx.recordings.start(me(req, ctx), req.params.id ?? '')));
});

route('POST', '/v1/leases/:id/recording/stop', async (req, res, ctx) => {
  json(res, 200, recordingView(ctx, await ctx.recordings.stop(me(req, ctx), req.params.id ?? '')));
});

// Everyone signed in can watch the team's recordings: a bug link is for the whole team.
route('GET', '/v1/recordings', (req, res, ctx) => {
  const p = me(req, ctx);
  const all = query(req).get('all') === '1';
  const rows = ctx.db.recordings(all ? null : p.accountId).filter((r) => sameTeam(ctx, p, r.accountId));
  json(res, 200, rows.map((r) => recordingView(ctx, r)));
});

route('GET', '/v1/recordings/:id', (req, res, ctx) => {
  json(res, 200, recordingView(ctx, teamRecording(req, ctx)));
});

route('DELETE', '/v1/recordings/:id', async (req, res, ctx) => {
  await ctx.recordings.delete(me(req, ctx), req.params.id ?? '');
  res.writeHead(204).end();
});

const FILE_PARTS: Record<string, RecordingPart | 'timeline'> = {
  'video.mp4': 'video',
  'log.ndjson': 'log',
  'screenshot.png': 'screenshot',
  'timeline.json': 'timeline',
};

route('GET', '/v1/recordings/:id/:file', async (req, res, ctx) => {
  const part = FILE_PARTS[req.params.file ?? ''];
  if (!part) {
    throw new ApiError(404, 'NOT_FOUND', 'A recording has video.mp4, log.ndjson, screenshot.png and timeline.json.');
  }
  const key = ctx.recordings.key(teamRecording(req, ctx).id, part);
  const size = await ctx.store.size(key);
  if (size === null) {
    throw new ApiError(404, 'NOT_FOUND', `This recording has no ${req.params.file}.`);
  }
  const type = part === 'timeline' ? 'application/json' : PART_FILES[part].type;
  // Browsers seek in a video with range requests.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    const slice = await ctx.store.open(key, { start, end });
    if (!slice) {
      throw new ApiError(404, 'NOT_FOUND', `This recording has no ${req.params.file}.`);
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
    await pipeline(slice.stream, res);
    return;
  }
  const file = await ctx.store.open(key);
  if (!file) {
    throw new ApiError(404, 'NOT_FOUND', `This recording has no ${req.params.file}.`);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  await pipeline(file.stream, res);
});

route(
  'PUT',
  '/v1/uploads/recordings/:id/:part',
  async (req, res, ctx) => {
    const part = req.params.part ?? '';
    if (!(RECORDING_PARTS as readonly string[]).includes(part)) {
      throw new ApiError(404, 'NOT_FOUND', 'No such part.');
    }
    await ctx.recordings.upload(req, req.params.id ?? '', part, query(req).get('t') ?? '');
    res.writeHead(204).end();
  },
  { auth: false },
);

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
    const file = await ctx.store.open(`builds/${build.sha256}`);
    if (!file) {
      throw new ApiError(404, 'NOT_FOUND', 'The build file is gone from storage.');
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': build.size });
    await pipeline(file.stream, res);
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
  await ctx.store.saved(`builds/${sha256}`);
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
