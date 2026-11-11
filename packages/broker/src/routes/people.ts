import { randomUUID } from 'node:crypto';
import * as auth from '../auth.ts';
import { ApiError } from '../leases/service.ts';
import { mintMemberToken, type TokenRequest } from '../leases/tokens.ts';
import { accountFor } from '../oidc.ts';
import { body, json, me, operator, principal, query, route, type Ctx } from './util.ts';

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
  const { token, limits } = mintMemberToken(ctx.db, me(req, ctx), await body<TokenRequest>(req));
  json(res, 201, { token, limits, mcp: `claude mcp add --transport http hangar ${ctx.publicUrl()}/mcp --header "Authorization: Bearer ${token}"` });
});
