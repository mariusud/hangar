// Sign-in through the team's own identity provider (decision 0004): OpenID Connect with the
// authorization code flow and PKCE. The broker talks only to the issuer it is configured with.
//
// A person who signs in for the first time gets a member account named after their email. With
// a groups mapping, their team (and operator role) follows the groups claim on every sign-in.

import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from 'node:crypto';
import type { Db } from './db.ts';
import { ApiError } from './leases/service.ts';

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  // Group name to team name. A group mapped to "operator" makes its members operators.
  groups?: Record<string, string>;
  // Turns off name-and-password sign-in once everyone signs in through the provider.
  disablePasswords?: boolean;
};

// Reads HANGAR_OIDC_ISSUER, HANGAR_OIDC_CLIENT_ID, HANGAR_OIDC_CLIENT_SECRET, HANGAR_OIDC_GROUPS
// (JSON, such as {"mobile-qa":"QA","platform":"operator"}) and HANGAR_OIDC_ONLY=1.
export function oidcFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | undefined {
  if (!env.HANGAR_OIDC_ISSUER || !env.HANGAR_OIDC_CLIENT_ID) {
    return undefined;
  }
  let groups: Record<string, string> | undefined;
  if (env.HANGAR_OIDC_GROUPS) {
    try {
      groups = JSON.parse(env.HANGAR_OIDC_GROUPS);
    } catch {
      throw new Error('HANGAR_OIDC_GROUPS is not valid JSON. Write it like {"mobile-qa":"QA"}.');
    }
  }
  return {
    issuer: env.HANGAR_OIDC_ISSUER.replace(/\/$/, ''),
    clientId: env.HANGAR_OIDC_CLIENT_ID,
    ...(env.HANGAR_OIDC_CLIENT_SECRET ? { clientSecret: env.HANGAR_OIDC_CLIENT_SECRET } : {}),
    ...(groups ? { groups } : {}),
    ...(env.HANGAR_OIDC_ONLY === '1' ? { disablePasswords: true } : {}),
  };
}

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
type Pending = { verifier: string; nonce: string; next: string; expiresAt: number };
export type Claims = { iss: string; aud: string | string[]; exp: number; nonce?: string; sub: string; email?: string; name?: string; preferred_username?: string; groups?: string[] };

const b64url = (b: Buffer): string => b.toString('base64url');

export class Oidc {
  readonly config: OidcConfig;
  private discovery: Promise<Discovery> | null = null;
  private pending = new Map<string, Pending>();

  constructor(config: OidcConfig) {
    this.config = config;
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const res = await fetch(`${this.config.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        throw new ApiError(502, 'OIDC_UNREACHABLE', `The identity provider at ${this.config.issuer} did not answer (HTTP ${res.status}).`);
      }
      const d: Discovery = await res.json();
      if (d.issuer.replace(/\/$/, '') !== this.config.issuer) {
        throw new ApiError(502, 'OIDC_ISSUER_MISMATCH', `The provider calls itself ${d.issuer}, not ${this.config.issuer}.`);
      }
      return d;
    })();
    this.discovery.catch(() => {
      this.discovery = null;
    });
    return this.discovery;
  }

  // The URL to send the browser to. `next` is a path on this console, never another site.
  async start(redirectUri: string, next: string): Promise<string> {
    const d = await this.discover();
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    const now = Date.now();
    for (const [k, p] of this.pending) {
      if (p.expiresAt < now) {
        this.pending.delete(k);
      }
    }
    this.pending.set(state, { verifier, nonce, next: next.startsWith('/') && !next.startsWith('//') ? next : '/', expiresAt: now + 10 * 60_000 });
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  // Exchanges the code and checks the ID token. Returns its claims and where to go next.
  async finish(redirectUri: string, code: string, state: string): Promise<{ claims: Claims; next: string }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expiresAt < Date.now()) {
      throw new ApiError(400, 'OIDC_STATE', 'This sign-in took too long or was already used. Start it again.');
    }
    const d = await this.discover();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: this.config.clientId, code_verifier: p.verifier });
    if (this.config.clientSecret) {
      form.set('client_secret', this.config.clientSecret);
    }
    const res = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(10_000) });
    const tokens: { id_token?: string; error?: string; error_description?: string } = await res.json().catch(() => ({}));
    if (!res.ok || !tokens.id_token) {
      throw new ApiError(401, 'OIDC_TOKEN', `The identity provider refused the sign-in: ${tokens.error_description ?? tokens.error ?? `HTTP ${res.status}`}.`);
    }
    const claims = await this.verifyIdToken(tokens.id_token, d.jwks_uri);
    if (claims.nonce !== p.nonce) {
      throw new ApiError(401, 'OIDC_NONCE', 'The ID token does not belong to this sign-in.');
    }
    return { claims, next: p.next };
  }

  private async verifyIdToken(jwt: string, jwksUri: string): Promise<Claims> {
    const [h, pl, sig] = jwt.split('.');
    if (!h || !pl || !sig) {
      throw new ApiError(401, 'OIDC_TOKEN', 'The ID token is malformed.');
    }
    const header: { alg?: string; kid?: string } = JSON.parse(Buffer.from(h, 'base64url').toString());
    const algs: Record<string, string> = { RS256: 'sha256', ES256: 'sha256', RS384: 'sha384', RS512: 'sha512' };
    const hash = header.alg ? algs[header.alg] : undefined;
    if (!hash) {
      throw new ApiError(401, 'OIDC_TOKEN', `ID tokens signed with ${header.alg ?? 'nothing'} are not accepted.`);
    }
    const jwks: { keys: (JsonWebKey & { kid?: string })[] } = await (await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) })).json();
    const jwk = jwks.keys.find((k) => !header.kid || k.kid === header.kid);
    if (!jwk) {
      throw new ApiError(401, 'OIDC_TOKEN', 'The provider has no key for this ID token.');
    }
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = verify(hash, Buffer.from(`${h}.${pl}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(sig, 'base64url'));
    if (!ok) {
      throw new ApiError(401, 'OIDC_TOKEN', 'The ID token signature does not verify.');
    }
    const claims: Claims = JSON.parse(Buffer.from(pl, 'base64url').toString());
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss.replace(/\/$/, '') !== this.config.issuer || !aud.includes(this.config.clientId) || claims.exp * 1000 < Date.now() - 60_000) {
      throw new ApiError(401, 'OIDC_TOKEN', 'The ID token is for another issuer or client, or has expired.');
    }
    return claims;
  }
}

// The account for these claims: found by issuer and subject, else created. Groups, when mapped,
// set the team and role each time, so a change at the provider shows on the next sign-in.
export function accountFor(db: Db, config: OidcConfig, claims: Claims): string {
  const name = claims.email ?? claims.preferred_username ?? claims.name ?? claims.sub;
  let accountId = db.identity(config.issuer, claims.sub);
  if (!accountId) {
    const taken = db.accountByName(name);
    accountId = randomUUID();
    db.insertAccount({ id: accountId, name: taken ? `${name} (${claims.sub.slice(0, 6)})` : name, role: 'member', passwordHash: null });
    db.linkIdentity(config.issuer, claims.sub, accountId);
  }
  if (config.groups) {
    const mapped = (claims.groups ?? []).map((g) => config.groups?.[g]).filter((t): t is string => Boolean(t));
    db.setRole(accountId, mapped.includes('operator') ? 'operator' : 'member');
    const teamName = mapped.find((t) => t !== 'operator');
    if (teamName) {
      let team = db.teams().find((t) => t.name.toLowerCase() === teamName.toLowerCase());
      if (!team) {
        team = { id: randomUUID(), name: teamName, quota: null };
        db.saveTeam(team);
      }
      db.setTeam(accountId, team.id);
    }
  }
  return accountId;
}
