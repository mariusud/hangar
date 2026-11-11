import { ORIENTATIONS, type DeviceToolOp, type Orientation, type Point } from '@hangar/protocol';
import { ApiError } from '../leases/service.ts';
import { body, json, me, query, route, type Ctx, type Req } from './util.ts';

async function op(req: Req, ctx: Ctx, o: DeviceToolOp): Promise<unknown> {
  return (await ctx.leases.op(me(req, ctx), req.params.id ?? '', o)).result ?? {};
}

export function pageQuery(q: URLSearchParams): { bundleId?: string; since?: number; limit?: number } {
  const out: { bundleId?: string; since?: number; limit?: number } = {};
  const bundleId = q.get('bundleId');
  if (bundleId) {
    out.bundleId = bundleId;
  }
  for (const key of ['since', 'limit'] as const) {
    const raw = q.get(key);
    if (raw === null || raw === '') {
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new ApiError(400, 'BAD_QUERY', `${key} is a whole number, such as the \`next\` of the previous answer.`);
    }
    out[key] = n;
  }
  return out;
}

export function isOrientation(v: unknown): v is Orientation {
  return ORIENTATIONS.some((o) => o === v);
}

function isPoint(v: unknown): v is Point {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 1);
}

route('GET', '/v1/leases/:id/log', async (req, res, ctx) => {
  json(res, 200, await op(req, ctx, { op: 'appLog', ...pageQuery(query(req)) }));
});

route('POST', '/v1/leases/:id/js', async (req, res, ctx) => {
  const b = await body<{ expression?: unknown; bundleId?: unknown }>(req);
  if (typeof b.expression !== 'string' || !b.expression.trim()) {
    throw new ApiError(400, 'BAD_EXPRESSION', 'Send `expression`, a JavaScript expression such as "navigator.product".');
  }
  json(res, 200, await op(req, ctx, { op: 'jsEvaluate', expression: b.expression, ...(typeof b.bundleId === 'string' && b.bundleId ? { bundleId: b.bundleId } : {}) }));
});

route('GET', '/v1/leases/:id/js/console', async (req, res, ctx) => {
  json(res, 200, await op(req, ctx, { op: 'jsConsole', ...pageQuery(query(req)) }));
});

route('GET', '/v1/leases/:id/network', async (req, res, ctx) => {
  json(res, 200, await op(req, ctx, { op: 'network', ...pageQuery(query(req)) }));
});

route('POST', '/v1/leases/:id/orientation', async (req, res, ctx) => {
  const { orientation } = await body<{ orientation?: unknown }>(req);
  if (!isOrientation(orientation)) {
    throw new ApiError(400, 'BAD_ORIENTATION', `Send \`orientation\`: one of ${ORIENTATIONS.join(', ')}.`);
  }
  json(res, 200, await op(req, ctx, { op: 'orientation', orientation }));
});

route('POST', '/v1/leases/:id/gestures', async (req, res, ctx) => {
  const b = await body<{ gesture?: unknown; center?: unknown; scale?: unknown; degrees?: unknown; durationMs?: unknown }>(req);
  if ((b.gesture !== 'pinch' && b.gesture !== 'rotate') || !isPoint(b.center)) {
    throw new ApiError(400, 'BAD_GESTURE', 'Send `gesture` (pinch or rotate) and `center` ([x, y] as fractions of the screen).');
  }
  const o: DeviceToolOp = { op: 'gesture', gesture: b.gesture, center: b.center };
  if (typeof b.scale === 'number') {
    o.scale = b.scale;
  }
  if (typeof b.degrees === 'number') {
    o.degrees = b.degrees;
  }
  if (typeof b.durationMs === 'number') {
    o.durationMs = b.durationMs;
  }
  json(res, 200, await op(req, ctx, o));
});
