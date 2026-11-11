import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { ApiError } from './leases/service.ts';
import { handleMcp } from './mcp.ts';
import './routes/index.ts';
import { principal, routes, sendError, type Ctx } from './routes/util.ts';

export type { Ctx } from './routes/util.ts';
export { sendError } from './routes/util.ts';

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
