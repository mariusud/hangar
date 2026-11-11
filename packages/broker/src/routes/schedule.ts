import { bookingView, createBooking, findBooking, floors, mayManage, removeBooking, type BookingRequest } from '../leases/bookings.ts';
import { ApiError } from '../leases/service.ts';
import { mintMemberToken, type TokenRequest } from '../leases/tokens.ts';
import { body, json, me, operator, route } from './util.ts';

route('GET', '/v1/bookings', (req, res, ctx) => {
  me(req, ctx);
  const now = Date.now();
  json(res, 200, { timeZone: ctx.leases.timeZone, bookings: ctx.db.bookings().map((b) => bookingView(ctx.db, b, ctx.leases.timeZone, now)) });
});

route('POST', '/v1/bookings', async (req, res, ctx) => {
  const p = me(req, ctx);
  const booking = createBooking(ctx.db, ctx.hosts, p, await body<BookingRequest>(req), Date.now());
  json(res, 201, bookingView(ctx.db, booking, ctx.leases.timeZone, Date.now()));
});

route('GET', '/v1/bookings/:name', (req, res, ctx) => {
  me(req, ctx);
  json(res, 200, bookingView(ctx.db, findBooking(ctx.db, req.params.name ?? ''), ctx.leases.timeZone, Date.now()));
});

// Leases from the booking end at the next tick, with reason window_closed.
route('DELETE', '/v1/bookings/:name', (req, res, ctx) => {
  const booking = removeBooking(ctx.db, me(req, ctx), req.params.name ?? '');
  void ctx.leases.tick();
  json(res, 200, { removed: booking.name });
});

// A token that leases only from this booking, only while its window is open.
route('POST', '/v1/bookings/:name/tokens', async (req, res, ctx) => {
  const p = me(req, ctx);
  const booking = findBooking(ctx.db, req.params.name ?? '');
  if (!mayManage(ctx.db, p, booking)) {
    throw new ApiError(403, 'FORBIDDEN', 'Only people on the booking’s team can make tokens for it.');
  }
  const b = await body<TokenRequest>(req);
  const { token, limits, priority } = mintMemberToken(ctx.db, p, { ...b, priority: undefined, label: typeof b.label === 'string' ? b.label : `booking ${booking.name}` }, booking.id);
  ctx.db.audit(`booking.token ${booking.name}`, p.accountId, null);
  json(res, 201, { token, limits, priority, booking: bookingView(ctx.db, booking, ctx.leases.timeZone, Date.now()), mcp: `${ctx.publicUrl()}/mcp` });
});

route('GET', '/v1/ci-floors', (req, res, ctx) => {
  me(req, ctx);
  json(res, 200, floors(ctx.db, ctx.hosts));
});

route('PUT', '/v1/ci-floors/:host', async (req, res, ctx) => {
  const p = operator(req, ctx);
  const host = req.params.host ?? '';
  const { floor } = await body<{ floor?: number | null }>(req);
  if (floor !== null && (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 0)) {
    throw new ApiError(400, 'BAD_FLOOR', '`floor` is how many of the Mac’s devices bookings never take, a whole number from 0, or null for the default.');
  }
  if (![...ctx.hosts.hosts.values()].some((h) => h.name === host) && !ctx.db.ciFloors().has(host)) {
    throw new ApiError(404, 'NO_SUCH_HOST', `No Mac called ${host}.`, `Macs: ${[...ctx.hosts.hosts.values()].map((h) => h.name).join(', ') || 'none connected'}.`);
  }
  ctx.db.setCiFloor(host, floor);
  ctx.db.audit(`ci_floor ${host} ${floor ?? 'default'}`, p.accountId, null);
  void ctx.leases.tick();
  json(res, 200, floors(ctx.db, ctx.hosts).find((f) => f.host === host));
});
