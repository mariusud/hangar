import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RecordingRow } from '../db.ts';
import { ApiError } from '../leases/service.ts';
import { PART_FILES, RECORDING_PARTS, isBrokerPart, type BrokerPart, type RecordingPart } from '../recordings.ts';
import { body, json, me, query, route, sameTeam, type Ctx, type Req } from './util.ts';

function teamRecording(req: Req, ctx: Ctx): RecordingRow {
  const view = query(req).get('view');
  if (view !== null && checkViewLink(viewKey(ctx), req.params.id ?? '', view, Date.now())) {
    return ctx.recordings.get(req.params.id ?? '');
  }
  const p = me(req, ctx);
  const recording = ctx.recordings.get(req.params.id ?? '');
  if (!sameTeam(ctx, p, recording.accountId)) {
    throw new ApiError(404, 'RECORDING_NOT_FOUND', `No recording ${req.params.id}.`);
  }
  return recording;
}

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
    files: { video: `${files}/video.mp4`, log: `${files}/log.ndjson`, screenshot: `${files}/screenshot.png`, timeline: `${files}/timeline.json`, appLog: `${files}/applog.json`, network: `${files}/network.json` },
  };
}

route('POST', '/v1/leases/:id/recording', async (req, res, ctx) => {
  json(res, 201, recordingView(ctx, await ctx.recordings.start(me(req, ctx), req.params.id ?? '')));
});

route('POST', '/v1/leases/:id/recording/stop', async (req, res, ctx) => {
  json(res, 200, recordingView(ctx, await ctx.recordings.stop(me(req, ctx), req.params.id ?? '')));
});

route('GET', '/v1/recordings', (req, res, ctx) => {
  const p = me(req, ctx);
  const all = query(req).get('all') === '1';
  const rows = ctx.db.recordings(all ? null : p.accountId).filter((r) => sameTeam(ctx, p, r.accountId));
  json(res, 200, rows.map((r) => recordingView(ctx, r)));
});

route(
  'GET',
  '/v1/recordings/:id',
  (req, res, ctx) => {
    json(res, 200, recordingView(ctx, teamRecording(req, ctx)));
  },
  { auth: false },
);

route('DELETE', '/v1/recordings/:id', async (req, res, ctx) => {
  await ctx.recordings.delete(me(req, ctx), req.params.id ?? '');
  res.writeHead(204).end();
});

const FILE_PARTS: Record<string, RecordingPart | BrokerPart> = {
  'video.mp4': 'video',
  'log.ndjson': 'log',
  'screenshot.png': 'screenshot',
  'timeline.json': 'timeline',
  'applog.json': 'applog',
  'network.json': 'network',
};

route('GET', '/v1/recordings/:id/:file', async (req, res, ctx) => {
  const part = FILE_PARTS[req.params.file ?? ''];
  if (!part) {
    throw new ApiError(404, 'NOT_FOUND', 'A recording has video.mp4, log.ndjson, screenshot.png, timeline.json, applog.json and network.json.');
  }
  const key = ctx.recordings.key(teamRecording(req, ctx).id, part);
  const size = await ctx.store.size(key);
  if (size === null) {
    throw new ApiError(404, 'NOT_FOUND', `This recording has no ${req.params.file}.`);
  }
  const type = isBrokerPart(part) ? 'application/json' : PART_FILES[part].type;
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
}, { auth: false });

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

const VIEW_LINK_DAYS = 7;
const viewKeys = new Map<string, Buffer>();

function viewKey(ctx: Ctx): Buffer {
  const known = viewKeys.get(ctx.dataDir);
  if (known) {
    return known;
  }
  const file = join(ctx.dataDir, 'view-link.key');
  try {
    writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) {
      throw err;
    }
  }
  const key = readFileSync(file);
  viewKeys.set(ctx.dataDir, key);
  return key;
}

function viewSignature(key: Buffer, recordingId: string, expiresAt: number): string {
  return createHmac('sha256', key).update(`recording-view\n${recordingId}\n${expiresAt}`).digest('base64url');
}

export function signViewLink(key: Buffer, recordingId: string, expiresAt: number): string {
  return `${expiresAt}.${viewSignature(key, recordingId, expiresAt)}`;
}

export function checkViewLink(key: Buffer, recordingId: string, view: string, now: number): boolean {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(view);
  if (!match) {
    return false;
  }
  const expiresAt = Number(match[1]);
  if (expiresAt <= now) {
    return false;
  }
  const expected = Buffer.from(viewSignature(key, recordingId, expiresAt));
  const given = Buffer.from(match[2] ?? '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

route('POST', '/v1/recordings/:id/share', async (req, res, ctx) => {
  const p = me(req, ctx);
  const recording = ctx.recordings.get(req.params.id ?? '');
  if (!sameTeam(ctx, p, recording.accountId)) {
    throw new ApiError(404, 'RECORDING_NOT_FOUND', `No recording ${req.params.id}.`);
  }
  const { days } = await body<{ days?: number }>(req);
  const length = days ?? VIEW_LINK_DAYS;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > 30) {
    throw new ApiError(400, 'BAD_DAYS', 'A view-only link lasts 1 to 30 days. Leave out `days` for 7.');
  }
  const expiresAt = Date.now() + length * 24 * 60 * 60_000;
  const view = signViewLink(viewKey(ctx), recording.id, expiresAt);
  json(res, 201, { url: `${ctx.publicUrl()}/recordings/${recording.id}?view=${view}`, view, expiresAt });
});
