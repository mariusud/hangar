import type { IncomingMessage, ServerResponse } from 'node:http';
import * as auth from '../auth.ts';
import type { Db } from '../db.ts';
import type { Hosts } from '../hosts.ts';
import { ApiError, type Leases } from '../leases/service.ts';
import type { Recordings } from '../recordings.ts';
import type { Metrics } from '../metrics.ts';
import type { Runs } from '../runs.ts';
import type { Oidc } from '../oidc.ts';
import type { Store } from '../store.ts';

export type Ctx = {
  db: Db;
  hosts: Hosts;
  leases: Leases;
  recordings: Recordings;
  runs: Runs;
  store: Store;
  oidc: Oidc | null;
  metrics: Metrics;
  publishImages: () => void;
  dataDir: string;
  consoleDir: string;
  internalUrl: () => string;
  publicUrl: () => string;
};

export type Req = IncomingMessage & { params: Record<string, string>; url: string };
type Handler = (req: Req, res: ServerResponse, ctx: Ctx) => Promise<void> | void;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: boolean };

export const routes: Route[] = [];

export function route(method: string, path: string, handler: Handler, opts: { auth?: boolean } = {}): void {
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

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function principal(req: IncomingMessage, ctx: Ctx): auth.Principal | null {
  return auth.authenticate(ctx.db, { authorization: req.headers.authorization, cookie: req.headers.cookie }, Date.now());
}

export function me(req: IncomingMessage, ctx: Ctx): auth.Principal {
  const p = principal(req, ctx);
  if (!p) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.');
  }
  return p;
}

export function operator(req: IncomingMessage, ctx: Ctx): auth.Principal {
  const p = me(req, ctx);
  if (p.role !== 'operator') {
    throw new ApiError(403, 'FORBIDDEN', 'Only operators can do this.');
  }
  return p;
}

export async function body<T>(req: IncomingMessage, limit = 1_000_000): Promise<T> {
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

export function query(req: Req): URLSearchParams {
  return new URL(req.url, 'http://x').searchParams;
}

export function sameTeam(ctx: Ctx, p: auth.Principal, accountId: string): boolean {
  return p.role === 'operator' || ctx.db.teamOf(accountId) === ctx.db.teamOf(p.accountId);
}
