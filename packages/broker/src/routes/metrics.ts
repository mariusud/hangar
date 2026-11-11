import { route } from './util.ts';

// Counts and timings for Prometheus. No names or ids, so it needs no token.
route(
  'GET',
  '/metrics',
  (_req, res, ctx) => {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(ctx.metrics.render());
  },
  { auth: false },
);
