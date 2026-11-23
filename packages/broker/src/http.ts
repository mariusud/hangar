import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { assertSameOrigin } from './auth.ts';
import { ApiError } from './leases/service.ts';
import { handleMcp } from './mcp.ts';
import './routes/index.ts';
import { principal, routes, sendError, type Ctx } from './routes/util.ts';

export type { Ctx } from './routes/util.ts';
export { sendError } from './routes/util.ts';

export async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    assertSameOrigin(req, ctx.publicUrl());
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
      await serveConsole(url.pathname, req.headers.host, res, ctx);
      return;
    }
    throw new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${url.pathname}.`);
  } catch (err) {
    sendError(res, err);
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function consoleHeaders(host: string | undefined): Record<string, string> {
  const socket = host && /^[\w.:[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : '';
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src 'self'${socket}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': policy };
}

export async function serveConsole(pathname: string, host: string | undefined, res: ServerResponse, ctx: Ctx): Promise<void> {
  const root = resolve(ctx.consoleDir);
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, rel);
  let isFile = false;
  try {
    isFile = (await stat(file)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile || !file.startsWith(root + sep)) {
    file = join(root, 'index.html');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...consoleHeaders(host) });
  res.end(await readFile(file));
}
