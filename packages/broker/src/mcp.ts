
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as auth from './auth.ts';
import type { Db } from './db.ts';
import type { Recordings } from './recordings.ts';
import { ApiError, type Leases } from './leases/service.ts';
import { TOOLS } from './tools/index.ts';
import type { Result } from './tools/util.ts';

export async function handleMcp(req: IncomingMessage, res: ServerResponse, db: Db, leases: Leases, recordings: Recordings, internalUrl: string, publicUrl: string): Promise<void> {
  const p = auth.authenticate(db, { authorization: req.headers.authorization, cookie: req.headers.cookie }, Date.now());
  if (!p) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Pass Authorization: Bearer <token>. Make a token in the console under Connect.' } }));
    return;
  }
  const server = buildServer(p, db, leases, recordings, internalUrl, publicUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function buildServer(p: auth.Principal, db: Db, leases: Leases, recordings: Recordings, internalUrl: string, publicUrl: string): McpServer {
  const server = new McpServer({ name: 'hangar', version: '0.0.0' });

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

  const install = async (leaseId: string, build: string): Promise<unknown> => {
    const b = db.getBuild(build);
    if (!b) {
      throw new ApiError(404, 'BUILD_NOT_FOUND', `No build called ${build}. Registered: ${db.builds().map((x) => x.name).join(', ') || 'none'}.`);
    }
    const code = auth.mintToken(db, 'artifact', { expiresAt: Date.now() + 10 * 60_000 });
    const { result } = await leases.op(p, leaseId, { op: 'install', artifactUrl: `${internalUrl}/v1/artifacts/${b.sha256}?t=${code}`, sha256: b.sha256 });
    return result;
  };

  const deps = { server, p, db, leases, recordings, internalUrl, publicUrl, pick, safe, text, install };
  for (const register of TOOLS) {
    register(deps);
  }
  return server;
}
