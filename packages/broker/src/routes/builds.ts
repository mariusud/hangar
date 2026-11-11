import { pipeline } from 'node:stream/promises';
import * as auth from '../auth.ts';
import { ApiError } from '../leases/service.ts';
import { saveUpload } from './uploads.ts';
import { json, me, query, route } from './util.ts';

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
