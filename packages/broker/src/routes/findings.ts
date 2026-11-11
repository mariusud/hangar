import { pipeline } from 'node:stream/promises';
import type { Principal } from '../auth.ts';
import type { NightRow } from '../db.ts';
import { findingView, parseFinding } from '../findings.ts';
import { ApiError } from '../leases/service.ts';
import { buildReport, closeNight, nightDetails, nightView, openNight, parseBooking, reportMarkdown } from '../reports.ts';
import { body, json, me, query, route, type Ctx, type Req } from './util.ts';

route('POST', '/v1/leases/:id/findings', async (req, res, ctx) => {
  const p = me(req, ctx);
  const input = parseFinding(await body<unknown>(req));
  const row = await ctx.recordings.findings.report(p, req.params.id ?? '', input);
  json(res, 201, findingView(ctx.db, row, ctx.publicUrl()));
});

route('GET', '/v1/leases/:id/findings', (req, res, ctx) => {
  const lease = ctx.leases.get(me(req, ctx), req.params.id ?? '');
  json(res, 200, ctx.db.findingsOf({ leaseIds: [lease.id] }).map((f) => findingView(ctx.db, f, ctx.publicUrl())));
});

route('GET', '/v1/findings/:id', (req, res, ctx) => {
  json(res, 200, findingView(ctx.db, ctx.recordings.findings.get(me(req, ctx), req.params.id ?? ''), ctx.publicUrl()));
});

route('POST', '/v1/findings/:id/open-again', async (req, res, ctx) => {
  const p = me(req, ctx);
  const { waitSeconds } = await body<{ waitSeconds?: unknown }>(req);
  json(res, 201, await ctx.recordings.findings.openAgain(p, req.params.id ?? '', ctx.publicUrl(), { waitMs: waitMsOf(waitSeconds) }));
});

function waitMsOf(v: unknown): number {
  if (v === undefined || v === null) {
    return 300_000;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 3600) {
    throw new ApiError(400, 'BAD_WAIT', '`waitSeconds` is a number of seconds from 1 to 3600, or left out for 300.');
  }
  return v * 1000;
}

route('GET', '/v1/findings/:id/screenshot.png', async (req, res, ctx) => {
  const finding = ctx.recordings.findings.get(me(req, ctx), req.params.id ?? '');
  const file = finding.data.screenshot ? await ctx.store.open(ctx.recordings.findings.screenshotKey(finding.id)) : null;
  if (!file) {
    throw new ApiError(404, 'NOT_FOUND', 'This finding has no screenshot.');
  }
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': file.size });
  await pipeline(file.stream, res);
});

function teamNight(p: Principal, ctx: Ctx, id: string): NightRow {
  const night = ctx.db.getNight(id);
  if (!night || (p.role !== 'operator' && night.teamId !== ctx.db.teamOf(p.accountId))) {
    throw new ApiError(404, 'NIGHT_NOT_FOUND', `No night ${id}.`);
  }
  return night;
}

route('GET', '/v1/nights', (req, res, ctx) => {
  const p = me(req, ctx);
  const q = query(req);
  const state = q.get('state');
  if (state !== null && state !== 'open' && state !== 'closed') {
    throw new ApiError(400, 'BAD_QUERY', '`state` is open or closed.');
  }
  const booking = q.get('booking');
  const rows = ctx.db.nights({
    ...(p.role === 'operator' ? {} : { teamId: ctx.db.teamOf(p.accountId) }),
    ...(booking ? { booking } : {}),
    ...(state ? { state } : {}),
  });
  json(res, 200, rows.map((n) => nightView(ctx.db, n, ctx.publicUrl())));
});

route('POST', '/v1/nights', async (req, res, ctx) => {
  const p = me(req, ctx);
  const { booking } = await body<{ booking?: unknown }>(req);
  json(res, 201, nightView(ctx.db, openNight(ctx.db, p, parseBooking(booking)), ctx.publicUrl()));
});

route('GET', '/v1/nights/:id', (req, res, ctx) => {
  const night = teamNight(me(req, ctx), ctx, req.params.id ?? '');
  const d = nightDetails(ctx.db, night, ctx.publicUrl());
  json(res, 200, { ...d.night, leases: d.leases, findings: d.findings, runs: d.runs });
});

route('POST', '/v1/nights/:id/close', (req, res, ctx) => {
  const p = me(req, ctx);
  const night = teamNight(p, ctx, req.params.id ?? '');
  json(res, 200, nightView(ctx.db, closeNight(ctx.db, night.id, { by: p.accountId }), ctx.publicUrl()));
});

route('GET', '/v1/nights/:id/report', (req: Req, res, ctx) => {
  const night = teamNight(me(req, ctx), ctx, req.params.id ?? '');
  const format = query(req).get('format') ?? 'json';
  if (format !== 'json' && format !== 'md') {
    throw new ApiError(400, 'BAD_FORMAT', '`format` is json or md.');
  }
  const report = buildReport(nightDetails(ctx.db, night, ctx.publicUrl()), Date.now());
  if (format === 'json') {
    json(res, 200, report);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
  res.end(reportMarkdown(report));
});
